// LOG LEVELS ---

VERB=1;
DBUG=2;
INFO=3;
NOTE=4;
WARN=5;

// PREFERENCE BRANCHES
PREFBRANCH_ROOT=0;
PREFBRANCH_RULE_TOGGLE=1;

//---------------

https_domains = {};              // maps domain patterns (with at most one
                                 // wildcard) to RuleSets

https_everywhere_blacklist = {}; // URLs we've given up on rewriting because
                                 // of redirection loops

https_blacklist_domains = {};    // domains for which there is at least one
                                 // blacklisted URL

//
const CI = Components.interfaces;
const CC = Components.classes;
const CU = Components.utils;
const CR = Components.results;
const Ci = Components.interfaces;
const Cc = Components.classes;
const Cu = Components.utils;
const Cr = Components.results;


const SERVICE_CTRID = "@eff.org/https-everywhere;1";
const SERVICE_ID=Components.ID("{32c165b4-fe5e-4964-9250-603c410631b4}");
const SERVICE_NAME = "Encrypts your communications with a number of major websites";

const LLVAR = "LogLevel";

const IOS = CC["@mozilla.org/network/io-service;1"].getService(CI.nsIIOService);
const OS = CC['@mozilla.org/observer-service;1'].getService(CI.nsIObserverService);
const LOADER = CC["@mozilla.org/moz/jssubscript-loader;1"].getService(CI.mozIJSSubScriptLoader);
const _INCLUDED = {};

// NoScript uses this blob to include js constructs that stored in the chrome/
// directory, but are not attached to the Firefox UI (normally, js located
// there is attached to an Overlay and therefore is part of the UI).

// Reasons for this: things in components/ directory cannot be split into
// separate files; things in chrome/ can be

const INCLUDE = function(name) {
  if (arguments.length > 1)
    for (var j = 0, len = arguments.length; j < len; j++)
      INCLUDE(arguments[j]);
  else if (!_INCLUDED[name]) {
    // we used to try/catch here, but that was less useful because it didn't
    // produce line numbers for syntax errors
    LOADER.loadSubScript("chrome://https-everywhere/content/code/"
            + name + ".js");
    _INCLUDED[name] = true;
  }
};

const DUMMY_OBJ = {};
DUMMY_OBJ.wrappedJSObject = DUMMY_OBJ;
const DUMMY_FUNC = function() {};
const DUMMY_ARRAY = [];

const OBSERVER_TOPIC_URI_REWRITE = "https-everywhere-uri-rewrite";

// XXX: Better plan for this?
// We need it to exist to make our updates of ChannelReplacement.js easier.
var ABE = {
  consoleDump: false,
  log: function(str) {
    https_everywhereLog(WARN, str);
  }
};

function xpcom_generateQI(iids) {
  var checks = [];
  for each (var iid in iids) {
    checks.push("CI." + iid.name + ".equals(iid)");
  }
  var src = checks.length
    ? "if (" + checks.join(" || ") + ") return this;\n"
    : "";
  return new Function("iid", src + "throw Components.results.NS_ERROR_NO_INTERFACE;");
}

INCLUDE('ChannelReplacement', 'HTTPSRules', 'HTTPS', 'Thread', 'ApplicableList');

Components.utils.import("resource://gre/modules/XPCOMUtils.jsm");

// This is black magic for storing Expando data w/ an nsIDOMWindow 
// See http://pastebin.com/qY28Jwbv , 
// https://developer.mozilla.org/en/XPCOM_Interface_Reference/nsIControllers

StorageController.prototype = {
  QueryInterface: XPCOMUtils.generateQI(
    [ Components.interfaces.nsISupports,
      Components.interfaces.nsIController ]),
  wrappedJSObject: null,  // Initialized by constructor
  supportsCommand: function (cmd) {return (cmd == this.command);},
  isCommandEnabled: function (cmd) {return (cmd == this.command);},
  onEvent: function(eventName) {return true;},
  doCommand: function() {return true;}
};

function StorageController(command) {
  this.command = command;
  this.data = {};
  this.wrappedJSObject = this;
}


function HTTPSEverywhere() {

  // Set up logging in each component:
  HTTPS.log = HTTPSRules.log = RuleWriter.log = this.log = https_everywhereLog;

  this.log = https_everywhereLog;
  this.wrappedJSObject = this;
  this.https_rules = HTTPSRules;
  this.INCLUDE=INCLUDE;
  this.ApplicableList = ApplicableList;
  
  this.prefs = this.get_prefs();
  this.rule_toggle_prefs = this.get_prefs(PREFBRANCH_RULE_TOGGLE);
  
  // We need to use observers instead of categories for FF3.0 for these:
  // https://developer.mozilla.org/en/Observer_Notifications
  // https://developer.mozilla.org/en/nsIObserverService.
  // https://developer.mozilla.org/en/nsIObserver
  // We also use the observer service to let other extensions know about URIs
  // we rewrite.
  this.obsService = CC["@mozilla.org/observer-service;1"]
                    .getService(Components.interfaces.nsIObserverService);
                    
  if(this.prefs.getBoolPref("globalEnabled")){
    this.obsService.addObserver(this, "profile-before-change", false);
    this.obsService.addObserver(this, "profile-after-change", false);
    this.obsService.addObserver(this, "sessionstore-windows-restored", false);
  }

  var pref_service = Components.classes["@mozilla.org/preferences-service;1"]
      .getService(Components.interfaces.nsIPrefBranchInternal);
  var branch = pref_service.QueryInterface(Components.interfaces.nsIPrefBranchInternal);

  branch.addObserver("extensions.https_everywhere.enable_mixed_rulesets",
                         this, false);
  branch.addObserver("security.mixed_content.block_active_content",
                         this, false);

  return;
}


/*
In recent versions of Firefox and HTTPS Everywhere, the call stack for performing an HTTP -> HTTPS rewrite looks like this:

1. HTTPSEverywhere.observe() gets a callback with the "http-on-modify-request" topic, and the channel as a subject

    2. HTTPS.replaceChannel() 

       3. HTTPSRules.rewrittenURI() 
            
           4. HTTPSRules.potentiallyApplicableRulesets uses <target host=""> elements to identify relevant rulesets

           foreach RuleSet:

               4. RuleSet.transformURI()

                   5. RuleSet.apply() does the tests and rewrites with RegExps, returning a string

               4. RuleSet.transformURI() makes a new uri object for the destination string, if required

    2. HTTPS.replaceChannel() calls channel.redirectTo() if a redirect is needed


In addition, the following other important tasks happen along the way:

HTTPSEverywhere.observe()    aborts if there is a redirect loop
                             finds a reference to the ApplicableList or alist that represents the toolbar context menu

HTTPS.replaceChannel()       notices redirect loops (and used to do much more complex XPCOM API work in the NoScript-based past)

HTTPSRules.rewrittenURI()    works around weird URI types like about: and http://user:pass@example.com/
                             and notifies the alist of what it should display for each ruleset

*/

// This defines for Mozilla what stuff HTTPSEverywhere will implement.

// ChannelEventSink used to be necessary in order to handle redirects (eg
// HTTP redirects) correctly.  It may now be obsolete? XXX

HTTPSEverywhere.prototype = {
  prefs: null,
  // properties required for XPCOM registration:
  classDescription: SERVICE_NAME,
  classID:          SERVICE_ID,
  contractID:       SERVICE_CTRID,

  _xpcom_factory: {
    createInstance: function (outer, iid) {
      if (outer != null)
        throw Components.results.NS_ERROR_NO_AGGREGATION;
      if (!HTTPSEverywhere.instance)
        HTTPSEverywhere.instance = new HTTPSEverywhere();
      return HTTPSEverywhere.instance.QueryInterface(iid);
    },

    QueryInterface: XPCOMUtils.generateQI(
      [ Components.interfaces.nsISupports,
        Components.interfaces.nsIModule,
        Components.interfaces.nsIFactory ])
  },

  // [optional] an array of categories to register this component in.
  _xpcom_categories: [
    {
      category: "app-startup",
    }
  ],

  // QueryInterface implementation, e.g. using the generateQI helper
  QueryInterface: XPCOMUtils.generateQI(
    [ Components.interfaces.nsIObserver,
      Components.interfaces.nsIMyInterface,
      Components.interfaces.nsISupports,
      Components.interfaces.nsISupportsWeakReference,
      Components.interfaces.nsIWebProgressListener,
      Components.interfaces.nsIWebProgressListener2,
      Components.interfaces.nsIChannelEventSink ]),

  wrappedJSObject: null,  // Initialized by constructor

  // An "expando" is an attribute glued onto something.  From NoScript.
  getExpando: function(domWin, key) {
    var c = domWin.controllers.getControllerForCommand("https-everywhere-storage");
    try {
      if (c) {
        c = c.wrappedJSObject;
        //this.log(DBUG, "Found a controller, returning data");
        return c.data[key];
      } else {
        this.log(INFO, "No controller attached to " + domWin);
        return null;
      }
    } catch(e) {
      // Firefox 3.5
      this.log(WARN,"exception in getExpando");
    }
  },

  setExpando: function(domWin, key, value) {
    var c = domWin.controllers.getControllerForCommand("https-everywhere-storage");
    try {
      if (!c) {
        this.log(DBUG, "Appending new StorageController for " + domWin);
        c = new StorageController("https-everywhere-storage");
        domWin.controllers.appendController(c);
      } else {
        c = c.wrappedJSObject;
      }
      c.data[key] = value;
    } catch(e) {
      this.log(WARN,"exception in setExpando");
    }
  },

  getWindowForChannel: function(channel) {
    // Obtain an nsIDOMWindow from a channel
    try {
      var nc = channel.notificationCallbacks ? channel.notificationCallbacks : channel.loadGroup.notificationCallbacks;
    } catch(e) {
      this.log(WARN,"no loadgroup notificationCallbacks for "+channel.URI.spec);
      return null;
    }
    if (!nc) {
      this.log(DBUG, "no window for " + channel.URI.spec);
      return null;
    }
    try {
      var domWin = nc.getInterface(CI.nsIDOMWindow);
    } catch(e) {
      this.log(INFO, "No window associated with request: " + channel.URI.spec);
      return null;
    }
    if (!domWin) {
      this.log(NOTE, "failed to get DOMWin for " + channel.URI.spec);
      return null;
    }
    domWin = domWin.top;
    return domWin;
  },

  // the lists get made when the urlbar is loading something new, but they
  // need to be appended to with reference only to the channel
  getApplicableListForChannel: function(channel) {
    var domWin = this.getWindowForChannel(channel);
    return this.getApplicableListForDOMWin(domWin, "on-modify-request w " + domWin);
  },

  newApplicableListForDOMWin: function(domWin) {
    if (!domWin || !(domWin instanceof CI.nsIDOMWindow)) {
      this.log(WARN, "Get alist without domWin");
      return null;
    }
    var dw = domWin.top;
    var alist = new ApplicableList(this.log,dw.document,dw);
    this.setExpando(dw,"applicable_rules",alist);
    return alist;
  },

  getApplicableListForDOMWin: function(domWin, where) {
    if (!domWin || !(domWin instanceof CI.nsIDOMWindow)) {
      //this.log(WARN, "Get alist without domWin");
      return null;
    }
    var dw = domWin.top;
    var alist= this.getExpando(dw,"applicable_rules",null);
    if (alist) {
      //this.log(DBUG,"get AL success in " + where);
      return alist;
    } else {
      //this.log(DBUG, "Making new AL in getApplicableListForDOMWin in " + where);
      alist = new ApplicableList(this.log,dw.document,dw);
      this.setExpando(dw,"applicable_rules",alist);
    }
    return alist;
  },

  observe: function(subject, topic, data) {
    // Top level glue for the nsIObserver API
    var channel = subject;
    //this.log(VERB,"Got observer topic: "+topic);

    if (topic == "http-on-modify-request") {
      if (!(channel instanceof CI.nsIHttpChannel)) return;
      
      this.log(DBUG,"Got http-on-modify-request: "+channel.URI.spec);
      var lst = this.getApplicableListForChannel(channel); // null if no window is associated (ex: xhr)
      if (channel.URI.spec in https_everywhere_blacklist) {
        this.log(DBUG, "Avoiding blacklisted " + channel.URI.spec);
        if (lst) lst.breaking_rule(https_everywhere_blacklist[channel.URI.spec]);
        else        this.log(NOTE,"Failed to indicate breakage in content menu");
        return;
      }
      HTTPS.replaceChannel(lst, channel);
    } else if (topic == "http-on-examine-response") {
         this.log(DBUG, "Got http-on-examine-response @ "+ (channel.URI ? channel.URI.spec : '') );
         HTTPS.handleSecureCookies(channel);
    } else if (topic == "http-on-examine-merged-response") {
         this.log(DBUG, "Got http-on-examine-merged-response ");
         HTTPS.handleSecureCookies(channel);
    } else if (topic == "cookie-changed") {
      // Javascript can add cookies via document.cookie that are insecure.
      if (data == "added" || data == "changed") {
        // subject can also be an nsIArray! bleh.
        try {
          subject.QueryInterface(CI.nsIArray);
          var elems = subject.enumerate();
          while (elems.hasMoreElements()) {
            var cookie = elems.getNext()
                            .QueryInterface(CI.nsICookie2);
            if (!cookie.isSecure) {
              HTTPS.handleInsecureCookie(cookie);
            }
          }
        } catch(e) {
          subject.QueryInterface(CI.nsICookie2);
          if(!subject.isSecure) {
            HTTPS.handleInsecureCookie(subject);
          }
        }
      }
    } else if (topic == "profile-before-change") {
      this.log(INFO, "Got profile-before-change");
      var catman = Components.classes["@mozilla.org/categorymanager;1"]
           .getService(Components.interfaces.nsICategoryManager);
      catman.deleteCategoryEntry("net-channel-event-sinks", SERVICE_CTRID, true);
      Thread.hostRunning = false;
    } else if (topic == "profile-after-change") {
      this.log(DBUG, "Got profile-after-change");
      
      if(this.prefs.getBoolPref("globalEnabled")){
        OS.addObserver(this, "cookie-changed", false);
        OS.addObserver(this, "http-on-modify-request", false);
        OS.addObserver(this, "http-on-examine-merged-response", false);
        OS.addObserver(this, "http-on-examine-response", false);
        
        var dls = CC['@mozilla.org/docloaderservice;1']
            .getService(CI.nsIWebProgress);
        dls.addProgressListener(this, CI.nsIWebProgress.NOTIFY_LOCATION);
        this.log(INFO,"ChannelReplacement.supported = "+ChannelReplacement.supported);

        HTTPSRules.init();

        Thread.hostRunning = true;
        var catman = Components.classes["@mozilla.org/categorymanager;1"]
           .getService(Components.interfaces.nsICategoryManager);
        // hook on redirections (non persistent, otherwise crashes on 1.8.x)
        catman.addCategoryEntry("net-channel-event-sinks", SERVICE_CTRID,
            SERVICE_CTRID, false, true);
      }
    } else if (topic == "sessionstore-windows-restored") {
      this.log(DBUG,"Got sessionstore-windows-restored");
    } else if (topic == "nsPref:changed") {
        // If the user toggles the Mixed Content Blocker settings, reload the rulesets
        // to enable/disable the mixedcontent ones
        switch (data) {
            case "security.mixed_content.block_active_content":
            case "extensions.https_everywhere.enable_mixed_rulesets":
                HTTPSRules.init();
                break;
        }
    }
    return;
  },

  // nsIChannelEventSink implementation
  // XXX This was here for rewrites in the past.  Do we still need it?
  onChannelRedirect: function(oldChannel, newChannel, flags) {  
    const uri = newChannel.URI;
    this.log(DBUG,"Got onChannelRedirect to "+uri.spec);
    if (!(newChannel instanceof CI.nsIHttpChannel)) {
      this.log(DBUG, newChannel + " is not an instance of nsIHttpChannel");
      return;
    }
    var alist = this.juggleApplicableListsDuringRedirection(oldChannel, newChannel);
    HTTPS.replaceChannel(alist,newChannel);
  },

  juggleApplicableListsDuringRedirection: function(oldChannel, newChannel) {
    // If the new channel doesn't yet have a list of applicable rulesets, start
    // with the old one because that's probably a better representation of how
    // secure the load process was for this page
    var domWin = this.getWindowForChannel(oldChannel);
    var old_alist = null;
    if (domWin) 
      old_alist = this.getExpando(domWin,"applicable_rules", null);
    domWin = this.getWindowForChannel(newChannel);
    if (!domWin) return null;
    var new_alist = this.getExpando(domWin,"applicable_rules", null);
    if (old_alist && !new_alist) {
      new_alist = old_alist;
      this.setExpando(domWin,"applicable_rules",new_alist);
    } else if (!new_alist) {
      new_alist = new ApplicableList(this.log, domWin.document, domWin);
      this.setExpando(domWin,"applicable_rules",new_alist);
    }
    return new_alist;
  },

  asyncOnChannelRedirect: function(oldChannel, newChannel, flags, callback) {
        this.onChannelRedirect(oldChannel, newChannel, flags);
        callback.onRedirectVerifyCallback(0);
  },

  get_prefs: function(prefBranch) {
    if(!prefBranch) prefBranch = PREFBRANCH_ROOT;

    // get our preferences branch object
    // FIXME: Ugly hack stolen from https
    var branch_name;
    if(prefBranch == PREFBRANCH_RULE_TOGGLE)
      branch_name = "extensions.https_everywhere.rule_toggle.";
    else
      branch_name = "extensions.https_everywhere.";
    var o_prefs = false;
    var o_branch = false;
    // this function needs to be called from inside https_everywhereLog, so
    // it needs to do its own logging...
    var econsole = Components.classes["@mozilla.org/consoleservice;1"]
      .getService(Components.interfaces.nsIConsoleService);

    o_prefs = Components.classes["@mozilla.org/preferences-service;1"]
                        .getService(Components.interfaces.nsIPrefService);

    if (!o_prefs)
    {
      econsole.logStringMessage("HTTPS Everywhere: Failed to get preferences-service!");
      return false;
    }

    o_branch = o_prefs.getBranch(branch_name);
    if (!o_branch)
    {
      econsole.logStringMessage("HTTPS Everywhere: Failed to get prefs branch!");
      return false;
    }

    if(prefBranch == PREFBRANCH_ROOT) {
      // make sure there's an entry for our log level
      try {
        o_branch.getIntPref(LLVAR);
      } catch (e) {
        econsole.logStringMessage("Creating new about:config https_everywhere.LogLevel variable");
        o_branch.setIntPref(LLVAR, WARN);
      }
    }

    return o_branch;
  },

  chrome_opener: function(uri, args) {
    // we don't use window.open, because we need to work around TorButton's 
    // state control
    args = args || 'chrome,centerscreen';
    return CC['@mozilla.org/appshell/window-mediator;1']
      .getService(CI.nsIWindowMediator) 
      .getMostRecentWindow('navigator:browser')
      .open(uri,'', args );
  },

  tab_opener: function(uri) {
    var gb = CC['@mozilla.org/appshell/window-mediator;1']
      .getService(CI.nsIWindowMediator) 
      .getMostRecentWindow('navigator:browser')
      .gBrowser;
    var tab = gb.addTab(uri);
    gb.selectedTab = tab;
    return tab;
  },

  toggleEnabledState: function() {
    if(this.prefs.getBoolPref("globalEnabled")){    
        try{    
            this.obsService.removeObserver(this, "profile-before-change");
            this.obsService.removeObserver(this, "profile-after-change");
            this.obsService.removeObserver(this, "sessionstore-windows-restored");      
            OS.removeObserver(this, "cookie-changed");
            OS.removeObserver(this, "http-on-modify-request");
            OS.removeObserver(this, "http-on-examine-merged-response");
            OS.removeObserver(this, "http-on-examine-response");  
            
            var catman = Components.classes["@mozilla.org/categorymanager;1"]
           .getService(Components.interfaces.nsICategoryManager);
            catman.deleteCategoryEntry("net-channel-event-sinks", SERVICE_CTRID, true);
                        
            var dls = CC['@mozilla.org/docloaderservice;1']
            .getService(CI.nsIWebProgress);
            dls.removeProgressListener(this);
            
            this.prefs.setBoolPref("globalEnabled", false);
        }
        catch(e){
            this.log(WARN, "Couldn't remove observers: " + e);          
        }
    }
    else{   
        try{      
            this.obsService.addObserver(this, "profile-before-change", false);
            this.obsService.addObserver(this, "profile-after-change", false);
            this.obsService.addObserver(this, "sessionstore-windows-restored", false);      
            OS.addObserver(this, "cookie-changed", false);
            OS.addObserver(this, "http-on-modify-request", false);
            OS.addObserver(this, "http-on-examine-merged-response", false);
            OS.addObserver(this, "http-on-examine-response", false);  
            
            var dls = CC['@mozilla.org/docloaderservice;1']
            .getService(CI.nsIWebProgress);
            dls.addProgressListener(this, CI.nsIWebProgress.NOTIFY_LOCATION);
            
            this.log(INFO,"ChannelReplacement.supported = "+ChannelReplacement.supported);

            if(!Thread.hostRunning)
                Thread.hostRunning = true;
            
            var catman = Components.classes["@mozilla.org/categorymanager;1"]
            .getService(Components.interfaces.nsICategoryManager);
            // hook on redirections (non persistent, otherwise crashes on 1.8.x)
            catman.addCategoryEntry("net-channel-event-sinks", SERVICE_CTRID,
                SERVICE_CTRID, false, true);            
            
            HTTPSRules.init();          
            this.prefs.setBoolPref("globalEnabled", true);
        }
        catch(e){
            this.log(WARN, "Couldn't add observers: " + e);         
        }
    }
  }
};

var prefs = 0;
var econsole = 0;
function https_everywhereLog(level, str) {
  if (prefs == 0) {
    prefs = HTTPSEverywhere.instance.get_prefs();
    econsole = Components.classes["@mozilla.org/consoleservice;1"]
               .getService(Components.interfaces.nsIConsoleService);
  } 
  try {
    var threshold = prefs.getIntPref(LLVAR);
  } catch (e) {
    econsole.logStringMessage( "HTTPS Everywhere: Failed to read about:config LogLevel");
    threshold = WARN;
  }
  if (level >= threshold) {
    dump(str+"\n");
    econsole.logStringMessage("HTTPS Everywhere: " +str);
  }
}

/**
* XPCOMUtils.generateNSGetFactory was introduced in Mozilla 2 (Firefox 4).
* XPCOMUtils.generateNSGetModule is for Mozilla 1.9.2 (Firefox 3.6).
*/
if (XPCOMUtils.generateNSGetFactory)
    var NSGetFactory = XPCOMUtils.generateNSGetFactory([HTTPSEverywhere]);
else
    var NSGetModule = XPCOMUtils.generateNSGetModule([HTTPSEverywhere]);

/* vim: set tabstop=4 expandtab: */
