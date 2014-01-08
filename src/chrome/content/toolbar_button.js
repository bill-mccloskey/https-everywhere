window.addEventListener("load", https_everywhere_load, true);

const CI = Components.interfaces;
const CC = Components.classes;

// LOG LEVELS ---
VERB=1;
DBUG=2;
INFO=3;
NOTE=4;
WARN=5;

HTTPSEverywhere = CC["@eff.org/https-everywhere;1"]
                      .getService(Components.interfaces.nsISupports)
                      .wrappedJSObject;

// avoid polluting global namespace
if (!httpsEverywhere) { var httpsEverywhere = {}; }

/**
 * JS Object for used to display toolbar hints to new users and change toolbar
 * UI for cases such as when the toolbar is disabled.
 *
 */
httpsEverywhere.toolbarButton = {

  /**
   * Used to determine if a hint has been previously shown.
   * TODO: Probably extraneous, look into removing
   */
  hintShown: false,

  /**
   * Initialize the toolbar button used to hint new users and update UI on
   * certain events.
   */
  init: function() {
    HTTPSEverywhere.log(DBUG, 'Removing listener for toolbarButton init.');
    window.removeEventListener('load', httpsEverywhere.toolbarButton.init, false);

    var tb = httpsEverywhere.toolbarButton;

    // make sure icon is proper color during init
    tb.changeIcon();

    // show ruleset counter when a tab is changed
    tb.updateRulesetsApplied();
    gBrowser.tabContainer.addEventListener(
      'TabSelect', 
      tb.updateRulesetsApplied, 
      false
    );

    // hook event for when page loads
    var onPageLoad = function() {
      // Timeout is used for a number of reasons.
      // 1) For Performance since we want to defer computation.
      // 2) Sometimes the page is loaded before all applied rulesets are
      //    calculated; in such a case, a half-second wait works.
      setTimeout(tb.updateRulesetsApplied, 500);
    };

    var appcontent = document.getElementById('appcontent');
    if (appcontent) {
      appcontent.addEventListener('load', onPageLoad, true);
    }

    // decide whether to show toolbar hint
    let hintPref = "extensions.https_everywhere.toolbar_hint_shown";
    if (!Services.prefs.getPrefType(hintPref) 
        || !Services.prefs.getBoolPref(hintPref)) { 
      // only run once
      Services.prefs.setBoolPref(hintPref, true);
      gBrowser.addEventListener("DOMContentLoaded", tb.handleShowHint, true);
    }
  },

  /**
   * Shows toolbar hint if previously not shown.
   */
  handleShowHint: function() {
    var tb = httpsEverywhere.toolbarButton;
    if (!tb.hintShown){
      tb.hintShown = true;
      const faqURL = "https://www.eff.org/https-everywhere/faq";
      var nBox = gBrowser.getNotificationBox();
      var strings = document.getElementById('HttpsEverywhereStrings');
      var msg = strings.getString('https-everywhere.toolbar.hint');
      var hint = nBox.appendNotification(
        msg, 
        'https-everywhere', 
        'chrome://https-everywhere/skin/https-everywhere-24.png', 
        nBox.PRIORITY_WARNING_MEDIUM,
	[],
	function(action) {
	  // see https://developer.mozilla.org/en-US/docs/XUL/Method/appendNotification#Notification_box_events
	  gBrowser.selectedTab = gBrowser.addTab(faqURL);
	}
      );
    }
    gBrowser.removeEventListener("DOMContentLoaded", tb.handleShowHint, true);
  },

  /**
   * Changes HTTPS Everywhere toolbar icon based on whether HTTPS Everywhere
   * is enabled or disabled.
   */
  changeIcon: function() {
    var enabled = HTTPSEverywhere.prefs.getBoolPref("globalEnabled");

    var toolbarbutton = document.getElementById('https-everywhere-button');
    if (enabled) {
      toolbarbutton.setAttribute('status', 'enabled');
    } else {
      toolbarbutton.setAttribute('status', 'disabled');
    }
  },

  /**
   * Update the rulesets applied counter for the current tab.
   */
  updateRulesetsApplied: function() {
    var toolbarbutton = document.getElementById('https-everywhere-button');
    var enabled = HTTPSEverywhere.prefs.getBoolPref("globalEnabled");
    if (!enabled) { 
      toolbarbutton.setAttribute('rulesetsApplied', 0);
      return;
    }

    var domWin = getDomWin();
    var alist = HTTPSEverywhere.getExpando(domWin,"applicable_rules", null);
    if (!alist) {
      return;
    }
    // Make sure the list is up to date
    alist.populate_list();

    var counter = 0;
    for (var x in alist.active) {
      if (!(x in alist.breaking)) {
        ++counter;
      }
    }
    for (var x in alist.moot) {
      if (!(x in alist.active)) {
        ++counter;
      }
    }

    toolbarbutton.setAttribute('rulesetsApplied', counter);
    HTTPSEverywhere.log(INFO, 'Setting icon counter to: ' + counter);
  }
};

// hook event for showing hint
HTTPSEverywhere.log(DBUG, 'Adding listener for toolbarButton init.');
window.addEventListener("load", httpsEverywhere.toolbarButton.init, false);

function https_everywhere_load() {
  window.removeEventListener('load', https_everywhere_load, true);
  // on first run, put the context menu in the addons bar
  try {
    var first_run;
    try {
      first_run = Services.prefs.getBoolPref("extensions.https_everywhere.firstrun_context_menu");
    } catch(e) {
      Services.prefs.setBoolPref("extensions.https_everywhere.firstrun_context_menu", true);
      first_run = true;
    }
    if(first_run) {
      Services.prefs.setBoolPref("extensions.https_everywhere.firstrun_context_menu", false);
      var navbar = document.getElementById("nav-bar");
      if(navbar.currentSet.indexOf("https-everywhere-button") == -1) {
        var set = navbar.currentSet+',https-everywhere-button';
        navbar.setAttribute('currentset', set);
        navbar.currentSet = set;
        document.persist('nav-bar', 'currentset');
      }
    }
  } catch(e) { }
}

function stitch_context_menu() {
  // the same menu appears both under Tools and via the toolbar button:
  var menu = document.getElementById("https-everywhere-menu");
  if (!menu.firstChild) {
    var popup = document.getElementById("https-everywhere-context");
    menu.appendChild(popup.cloneNode(true));
  }
}
function stitch_context_menu2() {
  // the same menu appears both under Tools and via the toolbar button:
  var menu = document.getElementById("https-everywhere-menu2");
  if (!menu.firstChild) {
    var popup = document.getElementById("https-everywhere-context");
    menu.appendChild(popup.cloneNode(true));
  }
}

var rulesetTestsMenuItem = null;

function show_applicable_list(menupopup) {
  var domWin = getDomWin();
  if (!(domWin instanceof CI.nsIDOMWindow)) {
    alert(domWin + " is not an nsIDOMWindow");
    return null;
  }

  var alist = HTTPSEverywhere.getExpando(domWin,"applicable_rules", null);
  var weird=false;
  
  if (!alist) {
    // This case occurs for error pages and similar.  We need a dummy alist
    // because populate_menu lives in there.  Would be good to refactor this
    // away.
    alist = new HTTPSEverywhere.ApplicableList(HTTPSEverywhere.log, document, domWin);
    weird = true;
  }
  alist.populate_menu(document, menupopup, weird);

  // should we also show the ruleset tests menu item?
  if(HTTPSEverywhere.prefs.getBoolPref("show_ruleset_tests")) {

    if(!rulesetTestsMenuItem) {
      let strings = document.getElementById('HttpsEverywhereStrings');
      let label = strings.getString('https-everywhere.menu.ruleset-tests');

      rulesetTestsMenuItem = this.document.createElement('menuitem');
      rulesetTestsMenuItem.setAttribute('command', 'https-everywhere-menuitem-ruleset-tests');
      rulesetTestsMenuItem.setAttribute('label', label);
    }

    if(!menupopup.contains(rulesetTestsMenuItem)) 
      menupopup.appendChild(rulesetTestsMenuItem);
  }
  
}

function toggle_rule(rule_id) {
  // toggle the rule state
  HTTPSEverywhere.https_rules.rulesetsByID[rule_id].toggle();
  reload_window();
}

function reload_window() {
  gBrowser.reloadTab(gBrowser.selectedTab);
}

function toggleEnabledState(){
	HTTPSEverywhere.toggleEnabledState();
	reload_window();	

  // Change icon depending on enabled state
  httpsEverywhere.toolbarButton.changeIcon();
}

function open_in_tab(url) {
  var wm = Components.classes["@mozilla.org/appshell/window-mediator;1"]
                     .getService(Components.interfaces.nsIWindowMediator);
  var recentWindow = wm.getMostRecentWindow("navigator:browser");
  recentWindow.delayedOpenTab(url, null, null, null, null);
}

function getDomWin() {
  return window.QueryInterface(Components.interfaces.nsIInterfaceRequestor)
               .getInterface(Components.interfaces.nsIWebNavigation)
               .QueryInterface(Components.interfaces.nsIDocShellTreeItem)
               .rootTreeItem
               .QueryInterface(Components.interfaces.nsIInterfaceRequestor)
               .getInterface(Components.interfaces.nsIDOMWindow);
}
