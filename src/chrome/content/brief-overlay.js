const Brief = {

    VERSION: '1.5.4',
    FIRST_RUN_PAGE_URL: 'chrome://brief/content/firstrun.xhtml',
    RELEASE_NOTES_URL: 'http://brief.mozdev.org/versions/1.5.4.html',

    BRIEF_URL: 'chrome://brief/content/brief.xul',
    BRIEF_FAVICON_URL: 'chrome://brief/skin/feed-icon-16x16.png',

    get statusCounter() document.getElementById('brief-status-counter'),

    get toolbarbutton() document.getElementById('brief-button'),

    get prefs() {
        delete this.prefs;
        return this.prefs = Cc['@mozilla.org/preferences-service;1'].
                            getService(Ci.nsIPrefService).
                            getBranch('extensions.brief.').
                            QueryInterface(Ci.nsIPrefBranch2);
    },

    get storage() {
        var tempScope = {};
        Components.utils.import('resource://brief/Storage.jsm', tempScope);

        delete this.storage;
        return this.storage = tempScope.Storage;
    },

    get query() {
        let tempScope = {};
        Components.utils.import('resource://brief/Storage.jsm', tempScope);

        delete this.query;
        return this.query = tempScope.Query
    },

    open: function Brief_open(aInCurrentTab) {
        var loading = gBrowser.webProgress.isLoadingDocument;
        var blank = (gBrowser.currentURI.spec == 'about:blank');
        var briefTab = this.getBriefTab();

        if (briefTab)
            gBrowser.selectedTab = briefTab;
        else if (blank && !loading || aInCurrentTab)
            gBrowser.loadURI(this.BRIEF_URL, null, null);
        else
            gBrowser.loadOneTab(this.BRIEF_URL, { inBackground: false });
    },

    getBriefTab: function Brief_getBriefTab() {
        var tabs = gBrowser.tabs;
        for (let i = 0; i < tabs.length; i++) {
            if (gBrowser.getBrowserForTab(tabs[i]).currentURI.spec == this.BRIEF_URL)
                return tabs[i];
        }

        return null;
    },


    doCommand: function Brief_doCommand(aCommand) {
        if (gBrowser.currentURI.spec == this.BRIEF_URL) {
            let win = gBrowser.contentDocument.defaultView.wrappedJSObject;
            win.Commands[aCommand]();
        }
    },


    updateAllFeeds: function Brief_updateAllFeeds() {
        var tempScope = {};
        Components.utils.import('resource://brief/FeedUpdateService.jsm', tempScope);
        tempScope.FeedUpdateService.updateAllFeeds();
    },

    markFeedsAsRead: function Brief_markFeedsAsRead() {
        new this.query().markEntriesRead(true);
    },

    toggleUnreadCounter: function Brief_toggleUnreadCounter() {
        var menuitem = document.getElementById('brief-show-unread-counter');
        var checked = menuitem.getAttribute('checked') == 'true';
        Brief.prefs.setBoolPref('showUnreadCounter', !checked);
    },

    showOptions: function cmd_showOptions() {
        var prefBranch = Cc['@mozilla.org/preferences-service;1'].
                         getService(Ci.nsIPrefBranch);
        var instantApply = prefBranch.getBoolPref('browser.preferences.instantApply');
        var features = 'chrome,titlebar,toolbar,centerscreen,resizable,';
        features += instantApply ? 'modal=no,dialog=no' : 'modal';

        window.openDialog('chrome://brief/content/options/options.xul', 'Brief options',
                          features);
    },


    updateStatus: function Brief_updateStatus() {
        if (!Brief.toolbarbutton || !Brief.prefs.getBoolPref('showUnreadCounter'))
            return;

        var query = new Brief.query({
            deleted: Brief.storage.ENTRY_STATE_NORMAL,
            read: false
        });
        var unreadEntriesCount = query.getEntryCount();

        Brief.statusCounter.value = unreadEntriesCount;
        Brief.statusCounter.hidden = unreadEntriesCount == 0;
    },


    constructTooltip: function Brief_constructTooltip(aEvent) {
        var bundle = document.getElementById('brief-bundle');
        var rows = document.getElementById('brief-tooltip-rows');
        var tooltip = aEvent.target;

        // Integer prefs are longs while Date is a long long.
        var now = Math.round(Date.now() / 1000);
        var lastUpdateTime = Brief.prefs.getIntPref('update.lastUpdateTime');
        var elapsedTime = now - lastUpdateTime;
        var hours = Math.floor(elapsedTime / 3600);
        var minutes = Math.floor((elapsedTime - hours * 3600) / 60);

        var label = document.getElementById('brief-tooltip-last-updated');
        if (hours > 1)
            label.value = bundle.getFormattedString('lastUpdatedWithHours', [hours, minutes]);
        else if (hours == 1)
            label.value = bundle.getFormattedString('lastUpdatedOneHour', [minutes]);
        else
            label.value = bundle.getFormattedString('lastUpdatedOnlyMinutes', [minutes]);

        while (rows.lastChild)
            rows.removeChild(rows.lastChild);

        var query = new this.query({
            deleted: this.storage.ENTRY_STATE_NORMAL,
            read: false,
            sortOrder: this.query.SORT_BY_FEED_ROW_INDEX,
            sortDirection: this.query.SORT_ASCENDING
        })
        var unreadFeeds = query.getProperty('feedID', true)
                               .map(function(e) e.feedID);

        var noUnreadLabel = document.getElementById('brief-tooltip-no-unread');
        var value = bundle.getString('noUnreadFeedsTooltip');
        noUnreadLabel.setAttribute('value', value);
        noUnreadLabel.hidden = unreadFeeds.length;

        for (let i = 0; unreadFeeds && i < unreadFeeds.length; i++) {
            let row = document.createElement('row');
            row.setAttribute('class', 'unread-feed-row');
            row = rows.appendChild(row);

            let feedName = this.storage.getFeed(unreadFeeds[i]).title;
            label = document.createElement('label');
            label.setAttribute('class', 'unread-feed-name');
            label.setAttribute('crop', 'right');
            label.setAttribute('value', feedName);
            row.appendChild(label);

            let query = new this.query({
                deleted: this.storage.ENTRY_STATE_NORMAL,
                feeds: [unreadFeeds[i]],
                read: false
            })
            let unreadCount = query.getEntryCount();

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

    onTabLoad: function Brief_onTabLoad(aEvent) {
        if (aEvent.target && aEvent.target.documentURI == Brief.BRIEF_URL)
            gBrowser.setIcon(Brief.getBriefTab(), Brief.BRIEF_FAVICON_URL);
    },

    handleEvent: function Brief_handleEvent(aEvent) {
        switch (aEvent.type) {
        case 'load':
            window.removeEventListener('load', this, false);

            if (this.prefs.getBoolPref('firstRun')) {
                this.onFirstRun();
            }
            else {
                let prevVersion = this.prefs.getCharPref('lastVersion');
                let verComparator = Cc['@mozilla.org/xpcom/version-comparator;1']
                                    .getService(Ci.nsIVersionComparator);

                // If Brief has been updated, load the new version info page.
                if (verComparator.compare(prevVersion, this.VERSION) < 0) {
                    setTimeout(function() {
                        gBrowser.loadOneTab(Brief.RELEASE_NOTES_URL, {
                            relatedToCurrent: false,
                            inBackground: false
                        });
                    }, 0);

                    this.prefs.setCharPref('lastVersion', this.VERSION);
                }
            }

            if (!this.toolbarbutton && !this.prefs.getBoolPref('firefox4ToolbarbuttonMigrated')) {
                let navbar = document.getElementById('nav-bar');
                navbar.insertItem('brief-button', null, null, false);
                navbar.setAttribute('currentset', navbar.currentSet);
                document.persist('nav-bar', 'currentset');
            }

            this.prefs.setBoolPref('firefox4ToolbarbuttonMigrated', true);

            if (this.toolbarbutton) {
                let showCounter = this.prefs.getBoolPref('showUnreadCounter');
                this.statusCounter.hidden = !showCounter;

                let menuitem = document.getElementById('brief-show-unread-counter');
                menuitem.setAttribute('checked', showCounter);

                // Because Brief's toolbarbutton doesn't use toolbarbutton's binding content,
                // we must manually set the label in "icons and text" toolbar mode.
                let label = this.toolbarbutton.getElementsByClassName('toolbarbutton-text')[0];
                label.value = this.toolbarbutton.label;
            }

            this.updateStatus();

            if (this.prefs.getBoolPref('hideChrome'))
                XULBrowserWindow.inContentWhitelist.push(this.BRIEF_URL);

            // Observe changes to the feed database in order to keep
            // the status panel up-to-date.
            var observerService = Cc['@mozilla.org/observer-service;1']
                                  .getService(Ci.nsIObserverService);
            observerService.addObserver(this, 'brief:invalidate-feedlist', false);

            gBrowser.addEventListener('pageshow', this.onTabLoad, false);

            this.prefs.addObserver('', this, false);
            this.storage.addObserver(this);

            window.addEventListener('unload', this, false);
            break;

        case 'unload':
            this.prefs.removeObserver('', this);
            this.storage.removeObserver(this);

            var observerService = Cc['@mozilla.org/observer-service;1']
                                  .getService(Ci.nsIObserverService);
            observerService.removeObserver(this, 'brief:invalidate-feedlist');
            break;
        }
    },


    observe: function Brief_observe(aSubject, aTopic, aData) {
        switch (aTopic) {
        case 'brief:invalidate-feedlist':
            this.updateStatus();
            break;

        case 'nsPref:changed':
            if (aData == 'showUnreadCounter') {
                let newValue = this.prefs.getBoolPref('showUnreadCounter');
                this.statusCounter.hidden = !newValue;

                let menuitem = document.getElementById('brief-show-unread-counter');
                menuitem.setAttribute('checked', newValue);

                if (newValue)
                    this.updateStatus();
            }
            break;
        }
    },


    onEntriesAdded: function Brief_onEntriesAdded(aEntryList) {
        setTimeout(this.updateStatus, 0);
    },

    onEntriesUpdated: function Brief_onEntriesUpdated(aEntryList) {
        setTimeout(this.updateStatus, 0);
    },

    onEntriesMarkedRead: function Brief_onEntriesMarkedRead(aEntryList, aState) {
        setTimeout(this.updateStatus, 0);
    },

    onEntriesDeleted: function Brief_onEntriesDeleted(aEntryList, aState) {
        if (aEntryList.containsUnread())
            setTimeout(this.updateStatus, 0);
    },

    onEntriesTagged: function() { },
    onEntriesStarred: function() { },


    onFirstRun: function Brief_onFirstRun() {
        // Add the toolbar button at the end of the Navigation Bar.
        var navbar = document.getElementById('nav-bar');
        if (!navbar.currentSet.match('brief-button')) {
            navbar.insertItem('brief-button', null, null, false);
            navbar.setAttribute('currentset', navbar.currentSet);
            document.persist('nav-bar', 'currentset');
        }

        // Create the default feeds folder.
        var name = Cc['@mozilla.org/intl/stringbundle;1']
                   .getService(Ci.nsIStringBundleService)
                   .createBundle('chrome://brief/locale/brief.properties')
                   .GetStringFromName('defaultFeedsFolderName');
        var bookmarks = PlacesUtils.bookmarks;
        var folderID = bookmarks.createFolder(bookmarks.bookmarksMenuFolder, name,
                                              bookmarks.DEFAULT_INDEX);
        Brief.prefs.setIntPref('homeFolder', folderID);

        // Load the first run page.
        setTimeout(function() {
            gBrowser.loadOneTab(Brief.FIRST_RUN_PAGE_URL, {
                relatedToCurrent: false,
                inBackground: false
            });
        }, 0)

        Brief.prefs.setBoolPref('firstRun', false);
        Brief.prefs.setCharPref('lastVersion', Brief.VERSION);
        Brief.prefs.setBoolPref('firefox4ToolbarbuttonMigrated', true);
    },

    QueryInterface: function Brief_QueryInterface(aIID) {
        if (aIID.equals(Ci.nsISupports) || aIID.equals(Ci.nsIDOMEventListener))
            return this;
        throw Components.results.NS_ERROR_NO_INTERFACE;
    }

}

window.addEventListener('load', Brief, false);
