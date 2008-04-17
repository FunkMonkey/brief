const BRIEF_URL = 'chrome://brief/content/brief.xul';
const BRIEF_FAVICON_URL = 'chrome://brief/skin/feed-icon-16x16.png';
var BriefQuery = Components.Constructor('@ancestor/brief/query;1', 'nsIBriefQuery',
                                        'setConstraints');

const gBrief = {

    tab: null,  // Tab in which Brief is loaded

    get statusIcon gBrief_statusIcon() {
        delete this.statusIcon;
        return this.statusIcon = document.getElementById('brief-status');
    },

    get toolbarbutton gBrief_toolbarbutton() {
        delete this.toolbarbutton;
        return this.toolbarbutton = document.getElementById('brief-button');
    },

    get prefs gBrief_prefs() {
        delete this.prefs;
        return this.prefs = Cc['@mozilla.org/preferences-service;1'].
                            getService(Ci.nsIPrefService).
                            getBranch('extensions.brief.').
                            QueryInterface(Ci.nsIPrefBranch2);
    },

    get storage gBrief_storage() {
        delete this.storage;
        return this.storage = Cc['@ancestor/brief/storage;1'].
                              getService(Ci.nsIBriefStorage);
    },

    get updateService gBrief_updateService() {
        delete this.updateService;
        return this.updateService = Cc['@ancestor/brief/updateservice;1'].
                                    getService(Ci.nsIBriefUpdateService);
    },


    open: function gBrief_open(aNewTab) {
        if (this.toolbarbutton)
            this.toolbarbutton.checked = true;

        // If Brief is already open then select the existing tab.
        if (this.tab)
            gBrowser.selectedTab = this.tab;
        else if (aNewTab)
            gBrowser.loadOneTab(BRIEF_URL, null, null, null, false, false);
        else
            gBrowser.loadURI(BRIEF_URL, null, null);
    },

    toggle: function gBrief_toggle() {
        if (this.tab == gBrowser.selectedTab)
            gBrowser.removeTab(this.tab);
        else
            gBrief.open(this.shouldOpenInNewTab());
    },

    shouldOpenInNewTab: function gBrief_shouldOpenInNewTab() {
        var openInNewTab = this.prefs.getBoolPref('openInNewTab');
        var isLoading = gBrowser.webProgress.isLoadingDocument;
        var isBlank = (gBrowser.currentURI.spec == 'about:blank');
        return openInNewTab && (!isBlank || isLoading);
    },


    doCommand: function gBrief_doCommand(aCommand) {
        if (gBrowser.currentURI.spec != BRIEF_URL)
            return;

        var win = gBrowser.contentDocument.defaultView.wrappedJSObject;

        switch (aCommand) {
            case 'selectNextEntry':
                win.gFeedView.selectNextEntry();
                break;
            case 'selectPrevEntry':
                win.gFeedView.selectPrevEntry();
                break;
            case 'openSelectedEntryLinkInTab':
                win.gCommands.openSelectedEntryLink(true);
                break;
            case 'showNextPage':
                win.gFeedView.currentPage++;
                break;
            case 'showPrevPage':
                win.gFeedView.currentPage--;
                break;
            case 'markCurrentViewRead':
                win.gFeedView.query.markEntriesRead(true);
                break;
            case 'showAllEntries':
                win.gCommands.changeViewConstraint('all');
                break;
            case 'showUnreadEntries':
                win.gCommands.changeViewConstraint('unread');
                break;
            case 'showStarredEntries':
                win.gCommands.changeViewConstraint('starred');
                break;
            case 'focusSearchbar':
                var searchbar = win.document.getElementById('searchbar');
                searchbar.focus();
                break;
            case 'toggleEntrySelection':
                var oldValue = this.prefs.getBoolPref('feedview.entrySelectionEnabled');
                this.prefs.setBoolPref('feedview.entrySelectionEnabled', !oldValue);
                break;

            default:
                win.gCommands[aCommand]();
                break;
        }
    },


    markFeedsAsRead: function gBrief_markFeedsAsRead() {
        var query = Cc['@ancestor/brief/query;1'].createInstance(Ci.nsIBriefQuery);
        query.deleted = Ci.nsIBriefQuery.ENTRY_STATE_ANY;
        query.markEntriesRead(true);
    },


    updateStatuspanel: function gBrief_updateStatuspanel() {
        var counter = document.getElementById('brief-status-counter');
        var panel = document.getElementById('brief-status');

        var query = new BriefQuery(null, null, true);
        var unreadEntriesCount = query.getEntryCount();

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
        query.sortDirection = Ci.nsIBriefQuery.SORT_ASCENDING;
        var unreadFeeds = query.getSimpleEntryList().getProperty('feeds');

        var noUnreadLabel = document.getElementById('brief-tooltip-no-unread');
        var value = bundle.getString('noUnreadFeedsTooltip');
        noUnreadLabel.setAttribute('value', value);
        noUnreadLabel.hidden = unreadFeeds;

        for (var i = 0; unreadFeeds && i < unreadFeeds.length; i++) {
            var row = document.createElement('row');
            row.setAttribute('class', 'unread-feed-row');
            row = rows.appendChild(row);

            var feedName = this.storage.getFeed(unreadFeeds[i]).title;
            label = document.createElement('label');
            label.setAttribute('class', 'unread-feed-name');
            label.setAttribute('crop', 'right');
            label.setAttribute('value', feedName);
            row.appendChild(label);

            var query = new BriefQuery([unreadFeeds[i]], null, true);
            var unreadCount = query.getEntryCount();
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
        if (aEvent.button != 0 && aEvent.button != 1)
            return;

        // Clicking the button when Brief is open in current tab
        // "unpresses" it and closes Brief.
        if (gBrowser.selectedTab == this.tab && aEvent.button == 0)
            gBrowser.removeCurrentTab();
        else if (aEvent.button == 1 || gBrief.shouldOpenInNewTab())
            gBrief.open(true);
        else
            gBrief.open(false);
    },

    onTabLoad: function gBrief_onTabLoad(aEvent) {
        var targetDoc = aEvent.target;

        if (targetDoc && targetDoc.documentURI == BRIEF_URL) {

            if (!gBrief.tab) {
                var targetBrowser = gBrowser.getBrowserForDocument(targetDoc);
                var tabs = gBrowser.mTabs;
                for (var i = 0; i < tabs.length; i++) {
                    if (tabs[i].linkedBrowser == targetBrowser) {
                        gBrief.tab = tabs[i];
                        break;
                    }
                }
            }

            gBrowser.setIcon(gBrief.tab, BRIEF_FAVICON_URL);
            if (gBrief.toolbarbutton)
                gBrief.toolbarbutton.checked = (gBrowser.selectedTab == gBrief.tab);
        }

        else if (gBrief.tab && gBrief.tab.linkedBrowser.currentURI.spec != BRIEF_URL) {
            gBrief.tab = null;
            if (gBrief.toolbarbutton)
                gBrief.toolbarbutton.checked = (gBrowser.selectedTab == gBrief.tab);
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

    handleEvent: function gBrief_handleEvent(aEvent) {
        switch (aEvent.type) {
        case 'load':
            window.removeEventListener('load', this, false);

            var firstRun = this.prefs.getBoolPref('firstRun');
            if (firstRun) {
                // The timeout is necessary to avoid adding the button while
                // initialization of various other stuff is still in progress because
                // changing content of the toolbar may interfere with that.
                setTimeout(this.onFirstRun, 0);
            }

            var showStatusIcon = this.prefs.getBoolPref('showStatusbarIcon');
            if (showStatusIcon) {
                this.statusIcon.hidden = false;
                this.updateStatuspanel();
            }

            // Observe changes to the feed database in order to keep
            // the statusbar icon up-to-date.
            var observerService = Cc['@mozilla.org/observer-service;1'].
                                  getService(Ci.nsIObserverService);
            observerService.addObserver(this, 'brief:feed-updated', false);
            observerService.addObserver(this, 'brief:feed-error', false);
            observerService.addObserver(this, 'brief:invalidate-feedlist', false);
            observerService.addObserver(this, 'brief:entry-status-changed', false);
            observerService.addObserver(this, 'brief:feed-update-queued', false);

            // Stores the tab in which Brief is loaded so we can ensure only
            // instance can be open at a time. This is an UI choice, not a technical
            // limitation.
            // These listeners are responsible for observing in which tab Brief is loaded
            // as well as for maintaining correct checked state of the toolbarbutton.
            gBrowser.addEventListener('TabClose', this.onTabClose, false);
            gBrowser.addEventListener('TabSelect', this.onTabSelect, false);
            gBrowser.addEventListener('pageshow', this.onTabLoad, false);

            this.prefs.addObserver('', this, false);

            window.addEventListener('unload', this, false);
            break;

        case 'unload':
            this.prefs.removeObserver('', this);

            var observerService = Cc['@mozilla.org/observer-service;1'].
                                  getService(Ci.nsIObserverService);
            observerService.removeObserver(this, 'brief:feed-updated');
            observerService.removeObserver(this, 'brief:feed-error');
            observerService.removeObserver(this, 'brief:entry-status-changed');
            observerService.removeObserver(this, 'brief:invalidate-feedlist');
            observerService.removeObserver(this, 'brief:feed-update-queued');
            break;
        }
    },


    observe: function gBrief_observe(aSubject, aTopic, aData) {
        switch (aTopic) {
        case 'brief:invalidate-feedlist':
            if (!this.statusIcon.hidden)
                this.updateStatuspanel();
            break;

        case 'brief:entry-status-changed':
            if ((aData == 'read' || aData == 'unread' || aData == 'deleted') && !this.statusIcon.hidden)
                setTimeout(this.updateStatuspanel, 0);
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

        case 'brief:feed-update-queued':
            var single = Ci.nsIBriefUpdateService.UPDATING_SINGLE_FEED;
            if (this.updateService.status == single)
                return;

            // Only show the progressmeter if Brief isn't opened in the currently
            // selected tab (no need to show two progressmeters on screen).
            var progressmeter = document.getElementById('brief-progressmeter');
            if (gBrowser.selectedTab != this.tab)
                progressmeter.hidden = false;

            progressmeter.value = 100 * this.updateService.completedFeedsCount /
                                        this.updateService.totalFeedsCount;
            break;

        case 'brief:feed-updated':
            if (aSubject.QueryInterface(Ci.nsIVariant) > 0 && !this.statusIcon.hidden)
                this.updateStatuspanel();
            // Fall through...

        case 'brief:feed-error':
            var progressmeter = document.getElementById('brief-progressmeter');
            var progress = 100 * this.updateService.completedFeedsCount /
                                 this.updateService.totalFeedsCount;
            progressmeter.value = progress;

            if (progress == 100)
                setTimeout(function() { progressmeter.hidden = true }, 500);
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
    }

}

window.addEventListener('load', gBrief, false);
