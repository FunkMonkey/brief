const TEMPLATE_URL = 'resource://brief-content/feedview-template.html';
const GUIDE_PAGE_URL = 'http://brief.mozdev.org/guide/guide.html';
const LAST_MAJOR_VERSION = '1.2';
const RELEASE_NOTES_URL = 'http://brief.mozdev.org/versions/1.2.html';

var Cc = Components.classes;
var Ci = Components.interfaces;

const gStorage = Cc['@ancestor/brief/storage;1'].getService(Ci.nsIBriefStorage);
const gUpdateService = Cc['@ancestor/brief/updateservice;1'].getService(Ci.nsIBriefUpdateService);
var QuerySH = Components.Constructor('@ancestor/brief/query;1', 'nsIBriefQuery', 'setEntries');
var Query = Components.Constructor('@ancestor/brief/query;1', 'nsIBriefQuery');

const ENTRY_STATE_NORMAL = Ci.nsIBriefQuery.ENTRY_STATE_NORMAL;
const ENTRY_STATE_TRASHED = Ci.nsIBriefQuery.ENTRY_STATE_TRASHED;
const ENTRY_STATE_DELETED = Ci.nsIBriefQuery.ENTRY_STATE_DELETED;
const ENTRY_STATE_ANY = Ci.nsIBriefQuery.ENTRY_STATE_ANY;

var gPrefBranch = Cc['@mozilla.org/preferences-service;1'].
                    getService(Ci.nsIPrefService).
                    getBranch('extensions.brief.').
                    QueryInterface(Ci.nsIPrefBranch2);

__defineGetter__('gTemplateURI', function() {
    delete this.gTemplateURI;
    return this.gTemplateURI = Cc['@mozilla.org/network/io-service;1'].
                               getService(Ci.nsIIOService).
                               newURI(TEMPLATE_URL, null, null);
});

__defineGetter__('gTopWindow', function() {
    delete this.gTopWindow;
    return this.gTopWindow = window.QueryInterface(Ci.nsIInterfaceRequestor).
                                    getInterface(Ci.nsIWebNavigation).
                                    QueryInterface(Ci.nsIDocShellTreeItem).
                                    rootTreeItem.
                                    QueryInterface(Ci.nsIInterfaceRequestor).
                                    getInterface(Ci.nsIDOMWindow);
});


function init() {
    gPrefs.register();
    initToolbarsAndStrings();

    document.addEventListener('keypress', onKeyPress, true);

    // This listener has to use capturing, because it handles persisting of open/collapsed
    // folder state. If the tree is scrolled as a result of collapsing a folder, we can
    // no longer find the target of the click event, because event.clientY points to
    // where it used to be before scrolling occurred. Therefore, we have to catch the
    // click event before the folder is actually collapsed.
    gFeedList.tree.addEventListener('click', gFeedList.onClick, true);

    var observerService = Cc['@mozilla.org/observer-service;1'].
                          getService(Ci.nsIObserverService);

    observerService.addObserver(gFeedList, 'brief:feed-update-queued', false);
    observerService.addObserver(gFeedList, 'brief:feed-update-canceled', false);
    observerService.addObserver(gFeedList, 'brief:feed-updated', false);
    observerService.addObserver(gFeedList, 'brief:feed-loading', false);
    observerService.addObserver(gFeedList, 'brief:feed-error', false);
    observerService.addObserver(gFeedList, 'brief:invalidate-feedlist', false);
    observerService.addObserver(gFeedList, 'brief:feed-title-changed', false);

    // This notification doesn't really fit in gFeedList, but there's no point in
    // seting up a new observer object just for it.
    observerService.addObserver(gFeedList, 'brief:custom-style-changed', false);

    gStorage.addObserver(gFeedList);

    if (gPrefs.homeFolder)
        async(gFeedList.rebuild, 0, gFeedList);
    else
        showHomeFolderPicker();

    async(loadHomeview);

    async(gStorage.syncWithLivemarks, 2000, gStorage);
}


function initToolbarsAndStrings() {
    getElement('headlines-checkbox').checked = gPrefs.showHeadlinesOnly;
    getElement('filter-unread-checkbox').checked = gPrefs.filterUnread;
    getElement('filter-starred-checkbox').checked = gPrefs.filterStarred;

    // Cache the strings, so they don't have to retrieved every time when
    // refreshing the feed view.
    var bundle = getElement('main-bundle');
    FeedView.prototype.todayStr = bundle.getString('today');
    FeedView.prototype.yesterdayStr = bundle.getString('yesterday');
    FeedView.prototype.authorPrefixStr = bundle.getString('authorIntroductionPrefix') + ' ';
    FeedView.prototype.updatedStr = bundle.getString('entryWasUpdated');
    FeedView.prototype.markAsReadStr = bundle.getString('markEntryAsRead');
    FeedView.prototype.markAsUnreadStr = bundle.getString('markEntryAsUnread');
}


function unload() {
    var observerService = Cc['@mozilla.org/observer-service;1'].
                          getService(Ci.nsIObserverService);
    observerService.removeObserver(gFeedList, 'brief:feed-updated');
    observerService.removeObserver(gFeedList, 'brief:feed-loading');
    observerService.removeObserver(gFeedList, 'brief:feed-error');
    observerService.removeObserver(gFeedList, 'brief:feed-update-queued');
    observerService.removeObserver(gFeedList, 'brief:feed-update-canceled');
    observerService.removeObserver(gFeedList, 'brief:invalidate-feedlist');
    observerService.removeObserver(gFeedList, 'brief:feed-title-changed');
    observerService.removeObserver(gFeedList, 'brief:custom-style-changed');

    gPrefs.unregister();
    gStorage.removeObserver(gFeedList);
    gFeedView.detach();
}


var gCommands = {

    toggleSidebar: function cmd_toggleSidebar() {
        var pane = getElement('left-pane');
        var splitter = getElement('left-pane-splitter');
        var button = getElement('toggle-sidebar');
        var bundle = getElement('main-bundle');

        pane.hidden = splitter.hidden = !pane.hidden;

        var tooltiptext = pane.hidden ? bundle.getString('showSidebarTooltip')
                                      : bundle.getString('hideSidebarTooltip');
        button.setAttribute('tooltiptext', tooltiptext);
        button.setAttribute('sidebarHidden', pane.hidden);

        if (!gFeedList.treeReady)
            gFeedList.rebuild();
    },

    updateAllFeeds: function cmd_updateAllFeeds() {
        gUpdateService.updateAllFeeds();
    },

    stopUpdating: function cmd_stopUpdating() {
        gUpdateService.stopUpdating();
        getElement('update-buttons-deck').selectedIndex = 0;
    },

    openOptions: function cmd_openOptions(aPaneID) {
        var prefBranch = Cc['@mozilla.org/preferences-service;1'].
                         getService(Ci.nsIPrefBranch);
        var instantApply = prefBranch.getBoolPref('browser.preferences.instantApply');
        var features = 'chrome,titlebar,toolbar,centerscreen,resizable,';
        features += instantApply ? 'modal=no,dialog=no' : 'modal';

        window.openDialog('chrome://brief/content/options/options.xul', 'Brief options',
                          features, aPaneID);
    },

    markViewRead: function cmd_markViewRead(aEvent) {
        gFeedView.query.markEntriesRead(true);
    },

    switchHeadlinesView: function cmd_switchHeadlinesView() {
        var newState = !gPrefs.showHeadlinesOnly;
        gPrefBranch.setBoolPref('feedview.showHeadlinesOnly', newState);
        getElement('headlines-checkbox').checked = newState;
    },

    showAllEntries: function cmd_showAllEntries() {
        gPrefBranch.setBoolPref('feedview.filterUnread', false);
        getElement('filter-unread-checkbox').checked = false;

        gPrefBranch.setBoolPref('feedview.filterStarred', false);
        getElement('filter-starred-checkbox').checked = false;

        gFeedView.refresh();
    },

    toggleUnreadEntriesFilter: function cmd_toggleUnreadEntriesFilter() {
        gPrefBranch.setBoolPref('feedview.filterUnread', !gPrefs.filterUnread);
        getElement('filter-unread-checkbox').checked = gPrefs.filterUnread;
        gFeedView.refresh();
    },

    toggleStarredEntriesFilter: function cmd_toggleStarredEntriesFilter() {
        gPrefBranch.setBoolPref('feedview.filterStarred', !gPrefs.filterStarred);
        getElement('filter-starred-checkbox').checked = gPrefs.filterStarred;
        gFeedView.refresh();
    },

    switchSelectedEntryRead: function cmd_switchSelectedEntryRead() {
        if (gFeedView.selectedEntry) {
            var newState = !gFeedView.selectedElement.hasAttribute('read');
            this.markEntryRead(gFeedView.selectedEntry, newState);
        }
    },

    markEntryRead: function cmd_markEntryRead(aEntry, aNewState) {
        var query = new QuerySH([aEntry]);
        query.markEntriesRead(aNewState);

        if (gPrefs.autoMarkRead && !aNewState)
            gFeedView.entriesMarkedUnread.push(aEntry);
    },

    deleteSelectedEntry: function cmd_deleteSelectedEntry() {
        if (gFeedView.selectedEntry)
            this.deleteEntry(gFeedView.selectedEntry);
    },

    deleteEntry: function cmd_deleteEntry(aEntry) {
        var query = new QuerySH([aEntry]);
        query.deleteEntries(ENTRY_STATE_TRASHED);
    },

    restoreSelectedEntry: function cmd_restoreSelectedEntry() {
        if (gFeedView.selectedEntry)
            this.restoreEntry(gFeedView.selectedEntry);
    },

    restoreEntry: function cmd_restoreEntry(aEntry) {
        var query = new QuerySH([aEntry]);
        query.deleteEntries(ENTRY_STATE_NORMAL);
    },

    switchSelectedEntryStarred: function cmd_switchSelectedEntryStarred() {
        if (gFeedView.selectedEntry) {
            var newState = !gFeedView.selectedElement.hasAttribute('starred');
            this.starEntry(gFeedView.selectedEntry, newState);
        }
    },

    starEntry: function cmd_starEntry(aEntry, aNewState) {
        var query = new QuerySH([aEntry]);
        query.starEntries(aNewState);
    },

    switchSelectedEntryCollapsed: function cmd_switchSelectedEntryCollapsed() {
        if (gFeedView.selectedEntry && gPrefs.showHeadlinesOnly) {
            var selectedElement = gFeedView.selectedElement;
            var newState = !selectedElement.hasAttribute('collapsed');
            gFeedView.collapseEntry(gFeedView.selectedEntry, newState, true);
        }
    },


    openSelectedEntryLink: function cmd_openSelectedEntryLink(aForceNewTab) {
        if (gFeedView.selectedEntry) {
            var newTab = gPrefBranch.getBoolPref('feedview.openEntriesInTabs') || aForceNewTab;
            gCommands.openEntryLink(gFeedView.selectedElement, newTab);
        }
    },

    openEntryLink: function cmd_openEntryLink(aEntryElement, aNewTab) {
        var url = aEntryElement.getAttribute('entryURL');
        gCommands.openLink(url, aNewTab);

        if (!aEntryElement.hasAttribute('read')) {
            aEntryElement.setAttribute('read', true);
            let entryID = parseInt(aEntryElement.id);
            let query = new QuerySH([entryID]);
            query.markEntriesRead(true);
        }
    },

    openLink: function cmd_openLink(aURL, aNewTab) {
        if (aNewTab) {
            var prefBranch = Cc['@mozilla.org/preferences-service;1'].
                             getService(Ci.nsIPrefBranch);
            var whereToOpen = prefBranch.getIntPref('browser.link.open_newwindow');
            if (whereToOpen == 2)
                openDialog('chrome://browser/content/browser.xul', '_blank', 'chrome,all,dialog=no', aURL);
            else
                gTopWindow.gBrowser.loadOneTab(aURL);
        }
        else {
            gFeedView.browser.loadURI(aURL);
        }
    },

    displayShortcuts: function cmd_displayShortcuts() {
        var height = Math.min(window.screen.availHeight, 580);
        var features = 'chrome,centerscreen,titlebar,resizable,width=500,height=' + height;
        var url = 'chrome://brief/content/keyboard-shortcuts.xhtml';

        window.openDialog(url, 'Brief shortcuts', features);
    }
}


function loadHomeview() {
    var query = new Query();
    query.deleted = ENTRY_STATE_NORMAL;
    var title = getElement('all-items-folder').getAttribute('title');
    var view = new FeedView(title, query);

    if (!gPrefs.homeFolder) {
        getElement('feed-view').loadURI(GUIDE_PAGE_URL);
        getElement('feed-view-toolbar').hidden = true;
        gFeedView = view; // Set the view without attaching it.
        return;
    }

    var prevVersion = gPrefBranch.getCharPref('lastMajorVersion');
    var verComparator = Cc['@mozilla.org/xpcom/version-comparator;1'].
                        getService(Ci.nsIVersionComparator);

    // If Brief has been updated, load the new version info page.
    if (verComparator.compare(prevVersion, LAST_MAJOR_VERSION) < 0) {
        var browser = getElement('feed-view');
        browser.loadURI(RELEASE_NOTES_URL);
        gPrefBranch.setCharPref('lastMajorVersion', LAST_MAJOR_VERSION);

        getElement('feed-view-toolbar').hidden = true;
        gFeedView = view; // Set the view without attaching it.
    }
    else {
        view.attach();

        if (gFeedList.tree && gFeedList.tree.view) {
            gFeedList.ignoreSelectEvent = true;
            gFeedList.tree.view.selection.select(0);
            gFeedList.ignoreSelectEvent = false;
            gFeedList.tree.focus();
        }
    }
}


function refreshProgressmeter() {
    var progressmeter = getElement('update-progress');
    var progress = 100 * gUpdateService.completedFeedsCount /
                         gUpdateService.scheduledFeedsCount;
    progressmeter.value = progress;

    if (progress == 100) {
        async(function() { progressmeter.hidden = true }, 500);
        getElement('update-buttons-deck').selectedIndex = 0;
    }
}

function showHomeFolderPicker() {
    getElement('feed-list-deck').selectedIndex = 1;

    var query = PlacesUtils.history.getNewQuery();
    var options = PlacesUtils.history.getNewQueryOptions();
    query.setFolders([PlacesUIUtils.allBookmarksFolderId], 1);
    options.excludeItems = true;

    getElement('places-tree').load([query], options);
}

function onHomeFolderPickerSelect(aEvent) {
    var placesTree = getElement('places-tree');
    var okButton = getElement('confirm-home-folder');

    var selectedItem = PlacesUtils.getConcreteItemId(placesTree.selectedNode);
    if (selectedItem) {
        var selectedItemType = PlacesUtils.bookmarks.getItemType(selectedItem);
        okButton.disabled = selectedItemType != PlacesUtils.bookmarks.TYPE_FOLDER
                            || PlacesUtils.livemarks.isLivemark(selectedItem);
    }
}

function selectHomeFolder(aEvent) {
    var placesTree = getElement('places-tree');
    if (placesTree.currentIndex != -1) {
        var folderId = PlacesUtils.getConcreteItemId(placesTree.selectedNode);
        gPrefBranch.setIntPref('homeFolder', folderId);
        gFeedList.tree.view.selection.select(0);
    }
}


// Creates and manages a FeedView displaying the search results.
function performSearch(aEvent) {
    var searchbar = getElement('searchbar');

    if (!searchbar.searchInProgress)
        searchbar.previousView = gFeedView;

    searchbar.searchInProgress = true;

    var bundle = getElement('main-bundle');
    var titleOverride = bundle.getFormattedString('searchResults', [searchbar.value]);

    gFeedView.titleOverride = searchbar.value ? titleOverride : '';
    gFeedView.query.searchString = searchbar.value;
    gFeedView.refresh();
}

function finishSearch() {
    var searchbar = getElement('searchbar');

    if (!searchbar.searchInProgress)
        return;
    searchbar.searchInProgress = false;

    gFeedView.query.searchString = gFeedView.titleOverride = '';
    gFeedView.refresh();
}


/**
 * Space, Tab, and Backspace can't be captured using <key/> XUL elements, so we handle
 * them manually using a listener. Additionally, unlike other keys, they have to
 * be default-prevented.
 */
function onKeyPress(aEvent) {
    // Don't do anything if the user is typing in an input field.
    if (aEvent.originalTarget.localName == 'input')
        return;

    // Stop propagation of character keys in order to disable Find-As-You-Type.
    if (aEvent.charCode)
        aEvent.stopPropagation();

    // Brief takes over these shortcut keys, so we stop the default action.
    if (gPrefBranch.getBoolPref('assumeStandardKeys')) {

        if (aEvent.keyCode == aEvent.DOM_VK_TAB && !aEvent.ctrlKey) {
            gPrefBranch.setBoolPref('feedview.entrySelectionEnabled',
                                    !gPrefs.entrySelectionEnabled);
            aEvent.preventDefault();
        }
        else if (aEvent.charCode == aEvent.DOM_VK_SPACE) {
            if (gPrefs.entrySelectionEnabled)
                gFeedView.selectNextEntry();
            else
                gFeedView.scrollToNextEntry(true);

            aEvent.preventDefault();
        }
        else if (aEvent.keyCode == aEvent.DOM_VK_BACK_SPACE) {
            if (gPrefs.entrySelectionEnabled)
                gFeedView.selectPrevEntry();
            else
                gFeedView.scrollToPrevEntry(true);

            aEvent.preventDefault();
        }
    }
}


// Preferences cache and observer.
var gPrefs = {

    register: function gPrefs_register() {
        for each (pref in this._cachedPrefs)
            this._updateCachedPref(pref);

        gPrefBranch.addObserver('', this, false);
    },

    unregister: function gPrefs_unregister() {
        gPrefBranch.removeObserver('', this);
    },


    get homeFolder gPrefs_homeFolder() {
        var pref = gPrefBranch.getIntPref('homeFolder');
        return (pref != -1) ? pref : null;
    },

    _cachedPrefs:
    [
        { name: 'feedview.doubleClickMarks',       propName: 'doubleClickMarks' },
        { name: 'feedview.showHeadlinesOnly',      propName: 'showHeadlinesOnly' },
        { name: 'feedview.entrySelectionEnabled',  propName: 'entrySelectionEnabled' },
        { name: 'feedview.autoMarkRead',           propName: 'autoMarkRead' },
        { name: 'feedview.filterUnread',           propName: 'filterUnread' },
        { name: 'feedview.filterStarred',          propName: 'filterStarred' },
        { name: 'feedview.minInitialEntries',      propName: 'minInitialEntries'},
        { name: 'feedview.sortUnreadViewOldestFirst', propName: 'sortUnreadViewOldestFirst' }
    ],

    _updateCachedPref: function gPrefs__updateCachedPref(aPref) {
        switch (gPrefBranch.getPrefType(aPref.name)) {
            case Ci.nsIPrefBranch.PREF_STRING:
                this[aPref.propName] = gPrefBranch.getCharPref(aPref.name);
                break;
            case Ci.nsIPrefBranch.PREF_INT:
                this[aPref.propName] = gPrefBranch.getIntPref(aPref.name);
                break;
            case Ci.nsIPrefBranch.PREF_BOOL:
                this[aPref.propName] = gPrefBranch.getBoolPref(aPref.name);
                break;
        }
    },


    observe: function gPrefs_observe(aSubject, aTopic, aData) {
        if (aTopic != 'nsPref:changed')
            return;

        for each (pref in this._cachedPrefs) {
            if (aData == pref.name)
                this._updateCachedPref(pref);
        }

        switch (aData) {
            case 'feedview.autoMarkRead':
                gFeedView._markVisibleAsRead();
                break;

            case 'feedview.sortUnreadViewOldestFirst':
                if (gFeedView.query.unread)
                    gFeedView.refresh();
                break;

            case 'feedview.entrySelectionEnabled':
                if (gPrefs..entrySelectionEnabled)
                    gFeedView.selectEntry(gFeedView._getMiddleEntryElement());
                else
                    gFeedView.selectEntry(null);
                break;

            case 'feedview.showHeadlinesOnly':
                gFeedView._toggleHeadlinesView();
                break;
        }
    }

}


// ------- Utility functions --------

function getElement(aId) document.getElementById(aId);

/**
 * Executes given function asynchronously. All arguments besides
 * the first one are optional.
 */
function async(aFunction, aDelay, aObject, arg1, arg2) {
    function asc() {
        aFunction.call(aObject || this, arg1, arg2);
    }
    return setTimeout(asc, aDelay || 0);
}

function intersect(arr1, arr2) {
    var commonPart = [];
    for (let i = 0; i < arr1.length; i++) {
        if (arr2.indexOf(arr1[i]) != -1)
            commonPart.push(arr1[i]);
    }
    return commonPart;
}

function log(aMessage) {
  var consoleService = Cc['@mozilla.org/consoleservice;1'].
                       getService(Ci.nsIConsoleService);
  consoleService.logStringMessage(aMessage);
}
