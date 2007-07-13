const BRIEF_URL = 'chrome://brief/content/brief.xul';
const BRIEF_FAVICON_URL = 'chrome://brief/skin/feed-icon-16x16.png';
var BriefQuery = Components.Constructor('@ancestor/brief/query;1', 'nsIBriefQuery',
                                        'setConditions');

var gBrief = {

    tab: null,           // Tab in which Brief is loaded
    statusIcon: null,    // Statusbar panel
    toolbarbutton: null, // Toolbar button

    prefs: null,

    openBrief: function gBrief_openBrief(aNewTab) {
        // If Brief is already open then select the existing tab.
        if (this.tab)
            gBrowser.selectedTab = this.tab;
        else if (aNewTab) {
            this.tab = gBrowser.loadOneTab(BRIEF_URL, null, null, null, false);
            var browser = gBrowser.getBrowserForTab(this.tab);
            browser.addEventListener('load', this.onBriefTabLoad, true);
        }
        else {
            gBrowser.loadURI(BRIEF_URL, null, null);
            this.tab = gBrowser.selectedTab;
            var browser = gBrowser.getBrowserForTab(this.tab);
            browser.addEventListener('load', this.onBriefTabLoad, true);
        }

        if (this.toolbarbutton)
            this.toolbarbutton.checked = true;
    },


    updateFeeds: function gBrief_updateFeeds() {
        var updateService = Cc['@ancestor/brief/updateservice;1'].
                            getService(Ci.nsIBriefUpdateService);
        updateService.fetchAllFeeds();
    },

    markFeedsAsRead: function gBrief_markFeedsAsRead() {
        var query = Cc['@ancestor/brief/query;1'].createInstance(Ci.nsIBriefQuery);
        query.deleted = Ci.nsIBriefQuery.ENTRY_STATE_ANY;
        var storageService = Cc['@ancestor/brief/storage;1'].getService(Ci.nsIBriefStorage);

        storageService.markEntriesRead(true, query);
    },


    updateStatuspanel: function gBrief_updateStatuspanel() {
        var counter = document.getElementById('brief-status-counter');
        var panel = document.getElementById('brief-status');

        var query = new BriefQuery(null, null, true);
        var storageService = Cc['@ancestor/brief/storage;1'].
                             getService(Ci.nsIBriefStorage);
        var unreadEntriesCount = storageService.getEntriesCount(query);

        counter.value = unreadEntriesCount;
        panel.setAttribute('unread', unreadEntriesCount > 0);
    },


    constructTooltip: function gBrief_constructTooltip(aEvent) {
        var bundle = document.getElementById('brief-bundle');
        var rows = document.getElementById('brief-tooltip-rows');
        var tooltip = aEvent.target;

        // Integer prefs are longs while Date is a long long.
        var now = Math.round(Date.now() / 1000);
        var lastUpdateTime = gBrief.prefs.getIntPref('update.lastUpdateTime');
        var elapsedTime = now - lastUpdateTime;
        var hours = Math.floor(elapsedTime / 3600);
        var minutes = Math.floor((elapsedTime - hours*3600) / 60);

        var label = document.getElementById('brief-tooltip-last-updated');
        if (hours > 1)
            label.value = bundle.getFormattedString('lastUpdatedWithHours', [hours, minutes]);
        else if (hours == 1)
            label.value = bundle.getFormattedString('lastUpdatedOneHour', [minutes]);
        else
            label.value = bundle.getFormattedString('lastUpdatedOnlyMinutes', [minutes]);

        while (rows.lastChild)
            rows.removeChild(rows.lastChild);

        var query = new BriefQuery(null, null, true);
        query.sortOrder = Ci.nsIBriefQuery.SORT_BY_FEED_ROW_INDEX;
        var storageService = Cc['@ancestor/brief/storage;1'].
                             getService(Ci.nsIBriefStorage);
        var unreadFeeds = storageService.getSerializedEntries(query).
                                         getPropertyAsAString('feeds').
                                         match(/[^ ]+/g);

        var noUnreadLabel = document.getElementById('brief-tooltip-no-unread');
        var value = bundle.getString('noUnreadFeedsTooltip');
        noUnreadLabel.setAttribute('value', value);
        noUnreadLabel.hidden = unreadFeeds;

        for (var i = 0; unreadFeeds && i < unreadFeeds.length; i++) {
            var row = document.createElement('row');
            row.setAttribute('class', 'unread-feed-row');
            row = rows.appendChild(row);

            var feedName = storageService.getFeed(unreadFeeds[i]).title;
            label = document.createElement('label');
            label.setAttribute('class', 'unread-feed-name');
            label.setAttribute('crop', 'right');
            label.setAttribute('value', feedName);
            row.appendChild(label);

            var query = new BriefQuery(unreadFeeds[i], null, true);
            var unreadCount = storageService.getEntriesCount(query);
            label = document.createElement('label');
            label.setAttribute('class', 'unread-entries-count');
            label.setAttribute('value', unreadCount);
            row.appendChild(label);

            value = unreadCount > 1 ? bundle.getString('manyUnreadEntries')
                                    : bundle.getString('singleUnreadEntry');
            label = document.createElement('label');
            label.setAttribute('class', 'unread-entries-desc');
            label.setAttribute('value', value);
            row.appendChild(label);
        }
    },


    onBriefButtonClick: function gBrief_onBriefButtonClick(aEvent) {
        // Clicking the button when Brief is open in current tab "unpresses" it and
        // closes Brief.
        if (gBrowser.selectedTab == this.tab && aEvent.button == 0) {
            gBrowser.removeCurrentTab();
            return;
        }

        var openInNewTab = this.prefs.getBoolPref('openInNewTab');

        if ((aEvent.button == 0 && !openInNewTab) || (aEvent.button == 1 && openInNewTab))
            gBrief.openBrief(false);

        else if ((aEvent.button == 0 && openInNewTab) || (aEvent.button == 1 && !openInNewTab))
            gBrief.openBrief(true);
    },

    onBriefTabLoad: function gBrief_onBriefTabLoad(aEvent) {
        if (this.currentURI.spec == BRIEF_URL)
            setTimeout(function(){ gBrief.tab.setAttribute('image', BRIEF_FAVICON_URL); }, 0);
        else {
            gBrief.tab = null;
            if (gBrief.toolbarbutton)
                gBrief.toolbarbutton.checked = false;
            this.removeEventListener('load', gBrief.onBriefTabLoad, true);
        }
    },

    onTabClose: function gBrief_onTabClose(aEvent) {
        if (aEvent.originalTarget == gBrief.tab)
            gBrief.tab = null;
    },

    onTabSelect: function gBrief_onTabSelect(aEvent) {
        if (gBrief.toolbarbutton)
            gBrief.toolbarbutton.checked = (aEvent.originalTarget == gBrief.tab);
    },

    onTabRestored: function gBrief_onTabRestored(aEvent) {
        var restoredTab = aEvent.originalTarget;
        var browser = gBrowser.getBrowserForTab(restoredTab);
        if (browser.currentURI.spec == BRIEF_URL) {
            gBrief.tab = restoredTab;
            var browser = gBrowser.getBrowserForTab(gBrief.tab);
            browser.addEventListener('load', gBrief.onBriefTabLoad, true);
            if (gBrief.toolbarbutton)
                gBrief.toolbarbutton.checked = (gBrowser.selectedTab == restoredTab);

            setTimeout(function(){ gBrief.tab.setAttribute('image', BRIEF_FAVICON_URL); }, 0);
        }
    },

    handleEvent: function gBrief_handleEvent(aEvent) {
        switch (aEvent.type) {
        case 'load':
            window.removeEventListener('load', this, false);

            /*rdfObserver.initBookmarks();
            Cc['@mozilla.org/rdf/rdf-service;1'].
            getService(Ci.nsIRDFService).
            GetDataSource('rdf:bookmarks').
            AddObserver(rdfObserver);*/

            // Cache frequently used elements.
            this.toolbarbutton = document.getElementById('brief-button');
            this.statusIcon = document.getElementById('brief-status');

            this.prefs = Cc['@mozilla.org/preferences-service;1'].
                         getService(Ci.nsIPrefService).
                         getBranch('extensions.brief.').
                         QueryInterface(Ci.nsIPrefBranch2);
            this.prefs.addObserver('', this, false);

            var firstRun = this.prefs.getBoolPref('firstRun');
            if (firstRun)
                // The timeout is necessary to avoid adding the button while
                // initialization of various other stuff is still in progress because
                // changing content of the toolbar may interfere with that.
                setTimeout(this.onFirstRun, 0);

            var showStatusIcon = this.prefs.getBoolPref('showStatusbarIcon');
            if (showStatusIcon) {
                this.statusIcon.hidden = false;
                this.updateStatuspanel();
            }

            // Observe changes to the feed database in order to keep the statusbar
            // icon up-to-date.
            var observerService = Cc['@mozilla.org/observer-service;1'].
                                  getService(Ci.nsIObserverService);
            observerService.addObserver(this, 'brief:feed-updated', false);
            observerService.addObserver(this, 'brief:sync-to-livemarks', false);
            observerService.addObserver(this, 'brief:entry-status-changed', false);

            // Stores the tab in which Brief is loaded so we can ensure only
            // instance can be open at a time. This is a UI choice, not a technical
            // limitation.
            // These listeners are responsible for observing if and in which tab
            // Brief is loaded as well as for maintaining correct checked state
            // of the toolbarbutton.
            window.addEventListener('TabClose', this.onTabClose, false);
            window.addEventListener('TabSelect', this.onTabSelect, false);
            window.addEventListener('SSTabRestored', this.onTabRestored, false);

            window.addEventListener('unload', this, false);
            break;

        case 'unload':
            this.prefs.removeObserver('', this);

            var observerService = Cc['@mozilla.org/observer-service;1'].
                                  getService(Ci.nsIObserverService);
            observerService.removeObserver(this, 'brief:feed-updated');
            observerService.removeObserver(this, 'brief:entry-status-changed');
            observerService.removeObserver(this, 'brief:sync-to-livemarks');
            break;
        }
    },


    onFirstRun: function gBrief_onFirstRun() {
        // Add the toolbar button to the Navigation Bar.
        var navbar = document.getElementById('nav-bar');
        var newset = navbar.currentSet.replace('urlbar-container,',
                                               'brief-button,urlbar-container,');
        navbar.currentSet = newset;
        navbar.setAttribute('currentset', newset);
        document.persist('nav-bar', 'currentset');
        BrowserToolboxCustomizeDone(true);

        gBrief.prefs.setBoolPref('firstRun', false);
    },


    observe: function gBrief_observe(aSubject, aTopic, aData) {
        switch (aTopic) {
        case 'brief:sync-to-livemarks':
            if (!this.statusIcon.hidden)
                this.updateStatuspanel();
            break;

        case 'brief:feed-updated':
            if (aSubject.QueryInterface(Ci.nsIVariant) > 0 && !this.statusIcon.hidden)
                this.updateStatuspanel();
            break;

        case 'brief:entry-status-changed':
            if ((aData == 'read' || aData == 'unread' || aData == 'deleted') &&
               !this.statusIcon.hidden) {
                this.updateStatuspanel();
            }
            break;

        case 'nsPref:changed':
            switch (aData) {
            case 'showStatusbarIcon':
                var newValue = this.prefs.getBoolPref('showStatusbarIcon');
                var statusIcon = document.getElementById('brief-status');
                statusIcon.hidden = !newValue;
                if (newValue)
                    this.updateStatuspanel();
                break;
          }
            break;
        }
    }

}

window.addEventListener('load', gBrief, false);


function dump(aMessage) {
    var consoleService = Cc['@mozilla.org/consoleservice;1']
                         .getService(Ci.nsIConsoleService);
    consoleService.logStringMessage('Brief:\n' + aMessage);
}
