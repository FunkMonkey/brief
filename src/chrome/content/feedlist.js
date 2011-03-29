const THROBBER_URL = 'chrome://brief/skin/throbber.gif';
const ERROR_ICON_URL = 'chrome://brief/skin/icons/error.png';

let ViewList = {

    get richlistbox() {
        delete this.richlistbox;
        return this.richlistbox = getElement('view-list');
    },

    get selectedItem() {
        return this.richlistbox.selectedItem;
    },

    set selectedItem(aItem) {
        this.richlistbox.selectedItem = aItem;
        return aItem;
    },

    init: function ViewList_init() {
        // The select event was suppressed because richlistbox initiates selection
        // during document load, before the feed view browser is ready.
        this.richlistbox.suppressOnSelect = false;
        this.richlistbox.selectedIndex = -1;

        this.refreshItem('unread-folder');
        this.refreshItem('starred-folder');
    },

    deselect: function ViewList_deselect() {
        this.richlistbox.selectedIndex = -1;
    },

    onSelect: function ViewList_onSelect(aEvent) {
        if (!this.selectedItem)
            return;

        TagList.deselect();
        FeedList.deselect();

        let title = this.selectedItem.lastChild.value;
        let query = new Query();

        switch (this.selectedItem.id) {
            case 'all-items-folder':
                query.deleted = Storage.ENTRY_STATE_NORMAL;
                break;

            case 'unread-folder':
                query.deleted = Storage.ENTRY_STATE_NORMAL;
                query.read = false;
                break;

            case 'starred-folder':
                query.deleted = Storage.ENTRY_STATE_NORMAL;
                query.starred = true;

                Storage.getAllTags(function(tags) {
                    if (tags.length)
                        TagList.show();
                })
                break;

            case 'trash-folder':
                query.deleted = Storage.ENTRY_STATE_TRASHED;
                break;
        }

        gCurrentView = new FeedView(title, query);
    },

    refreshItem: function ViewList_refreshItem(aItemID) {
        let query = new Query({
            deleted: Storage.ENTRY_STATE_NORMAL,
            read: false,
            starred: (aItemID == 'starred-folder') ? true : undefined
        })

        query.getEntryCount(function(unreadCount) {
            let element = getElement(aItemID);

            element.lastChild.value = unreadCount;

            if (unreadCount > 0)
                element.classList.add('unread');
            else
                element.classList.remove('unread');
        })
    }

}


let TagList = {

    ready: false,

    tags: null,

    get selectedItem() {
        return this._listbox.selectedItem;
    },

    get _listbox() {
        delete this._listbox;
        return this._listbox = getElement('tag-list');
    },

    show: function TagList_show() {
        if (!this.ready)
            this._rebuild();

        if (this._listbox.hidden) {
            this._listbox.hidden = false;
            getElement('tag-list-splitter').hidden = false;
        }
    },

    hide: function TagList_hide() {
        if (!this._listbox.hidden) {
            this._listbox.hidden = true;
            getElement('tag-list-splitter').hidden = true;
        }
    },

    deselect: function TagList_deselect() {
        this._listbox.selectedIndex = -1;
    },

    onSelect: function TagList_onSelect(aEvent) {
        if (!this.selectedItem) {
            this.hide();
            return;
        }

        ViewList.deselect();
        FeedList.deselect();

        let query = new Query({
            deleted: Storage.ENTRY_STATE_NORMAL,
            tags: [this.selectedItem.id]
        })

        gCurrentView = new FeedView(this.selectedItem.id, query);
    },

    /**
     * Refreshes tag listitems.
     *
     * @param aTags            An array of tag strings.
     * @param aPossiblyAdded   Indicates that the tag may not be in the list of tags yet.
     * @param aPossiblyRemoved Indicates that there may be no remaining entries with
     *                         the tag.
     */
    refreshTags: function TagList_refreshTags(aTags, aPossiblyAdded, aPossiblyRemoved) {
        if (!this.ready)
            return;

        for (let tag in aTags) {
            if (aPossiblyAdded) {
                if (this.tags.indexOf(tag) == -1)
                    this._rebuild();
                else
                    this._refreshLabel(tag);
            }
            else if (aPossiblyRemoved) {
                let query = new Query({
                    tags: [tag]
                })

                query.hasMatches(function(hasMatches) {
                    if (hasMatches) {
                        this._refreshLabel(tag);
                    }
                    else {
                        this._rebuild();
                        if (gCurrentView.query.tags && gCurrentView.query.tags[0] === tag)
                            ViewList.selectedItem = getElement('starred-folder');
                    }
                }.bind(this))
            }
            else {
                this._refreshLabel(tag);
            }
        }
    },

    _rebuild: function TagList__rebuild() {
        while (this._listbox.hasChildNodes())
            this._listbox.removeChild(this._listbox.lastChild);

        this.tags = yield Storage.getAllTags(TagList__rebuild.resume);

        for (let i = 0; i < this.tags.length; i++) {
            let item = document.createElement('listitem');
            item.id = this.tags[i];
            item.className = 'listitem-iconic tag-list-item';
            item.setAttribute('image', 'chrome://brief/skin/icons/tag.png');
            this._listbox.appendChild(item);

            this._refreshLabel(this.tags[i]);
        }

        this.ready = true;
    }.gen(),

    _refreshLabel: function TagList__refreshLabel(aTagName) {
        let query = new Query({
            deleted: Storage.ENTRY_STATE_NORMAL,
            tags: [aTagName],
            read: false
        })

        query.getEntryCount(function(unreadCount) {
            let listitem = getElement(aTagName);
            let name = aTagName;
            if (unreadCount > 0) {
                name += ' (' + unreadCount +')';
                listitem.setAttribute('unread', true);
            }
            else {
                listitem.removeAttribute('unread');
            }

            listitem.setAttribute('label', name);
        })
    }

}


let FeedList = {

    get tree() {
        delete this.tree;
        return this.tree = getElement('feed-list');
    },

    get selectedItem() {
        return this.tree.selectedItem;
    },

    get selectedFeed() {
        return this.selectedItem ? Storage.getFeed(this.selectedItem.id) : null;
    },

    deselect: function FeedList_deselect() {
        this.tree.selectedItem = null;
    },

    onSelect: function FeedList_onSelect(aEvent) {
        if (!this.selectedItem)
            return;

        ViewList.deselect();
        TagList.deselect();

        let query = new Query({ deleted: Storage.ENTRY_STATE_NORMAL });

        if (this.selectedFeed.isFolder)
            query.folders = [this.selectedFeed.feedID];
        else
            query.feeds = [this.selectedFeed.feedID];

        gCurrentView = new FeedView(this.selectedFeed.title, query);
    },

    /**
     * Refresh the folder's label.
     *
     * @param aFolders
     *        An array of feed IDs.
     */
    refreshFolderTreeitems: function FeedList_refreshFolderTreeitems(aFolders) {
        aFolders.map(function(f) Storage.getFeed(f))
                .forEach(this._refreshLabel, this);
    },

    /**
     * Refresh the feed treeitem's label and favicon. Also refreshes folders
     * in the feed's parent chain.
     *
     * @param aFeeds
     *        An array of feed IDs.
     */
    refreshFeedTreeitems: function FeedList_refreshFeedTreeitems(aFeeds) {
        let feeds = aFeeds.map(function(f) Storage.getFeed(f));
        for (let feed in feeds) {
            this._refreshLabel(feed);
            this._refreshFavicon(feed.feedID);

            // Build an array of IDs of folders in the the parent chains of
            // the given feeds.
            let folders = [];
            let parentID = feed.parent;

            while (parentID != PrefCache.homeFolder) {
                if (folders.indexOf(parentID) == -1)
                    folders.push(parentID);
                parentID = Storage.getFeed(parentID).parent;
            }

            this.refreshFolderTreeitems(folders);
        }
    },

    _refreshLabel: function FeedList__refreshLabel(aFeed) {
        let query = new Query({
            deleted: Storage.ENTRY_STATE_NORMAL,
            folders: aFeed.isFolder ? [aFeed.feedID] : undefined,
            feeds: aFeed.isFolder ? undefined : [aFeed.feedID],
            read: false
        })

        query.getEntryCount(function(unreadCount) {
            let treeitem = getElement(aFeed.feedID);

            treeitem.setAttribute('title', aFeed.title);
            treeitem.setAttribute('unreadcount', unreadCount);

            if (unreadCount > 0)
                treeitem.classList.add('unread');
            else
                treeitem.classList.remove('unread');
        })
    },

    _refreshFavicon: function FeedList__refreshFavicon(aFeedID) {
        let feed = Storage.getFeed(aFeedID);
        let treeitem = getElement(aFeedID);

        let icon = '';
        if (treeitem.hasAttribute('loading'))
            icon = THROBBER_URL;
        else if (treeitem.hasAttribute('error'))
            icon = ERROR_ICON_URL;
        else if (PrefCache.showFavicons && feed.favicon != 'no-favicon')
            icon = feed.favicon;

        treeitem.setAttribute('icon', icon);
    },

    rebuild: function FeedList_rebuild() {
        this.lastSelectedID = this.selectedItem ? this.selectedItem.id : '';

        // Clear the existing tree.
        while (this.tree.hasChildNodes())
            this.tree.removeChild(this.tree.lastChild);

        this.feeds = Storage.getAllFeeds(true);

        // This a helper array used by _buildFolderChildren. As the function recurses,
        // the array stores folders in the parent chain of the currently processed folder.
        // This is how it tracks where to append the items.
        this._folderParentChain = [this.tree];

        this._buildFolderChildren(PrefCache.homeFolder);

        if (this.lastSelectedID) {
            let prevSelectedItem = getElement(this.lastSelectedID);
            if (prevSelectedItem) {
                this.tree.suppressOnSelect = true;
                this.tree.selectedItem = prevSelectedItem;
                this.tree.suppressOnSelect = false;
            }
            else {
                ViewList.selectedItem = getElement('all-items-folder');
            }

            this.lastSelectedID = '';
        }
    },

    /**
     * Recursively reads feeds from the database and builds the tree, starting from the
     * given folder.
     *
     * @param aParentFolder feedID of the folder.
     */
    _buildFolderChildren: function FeedList__buildFolderChildren(aParentFolder) {
        for (let feed in this.feeds) {
            if (feed.parent != aParentFolder)
                continue;

            let parent = this._folderParentChain[this._folderParentChain.length - 1];

            if (feed.isFolder) {
                let closedFolders = this.tree.getAttribute('closedFolders');
                let isOpen = !closedFolders.match(escape(feed.feedID));

                let folder = document.createElement('richtreefolder');
                folder.id = feed.feedID;
                folder.className = 'feed-folder';
                folder.contextMenu = 'folder-context-menu';
                folder.setAttribute('open', isOpen);

                parent.appendChild(folder);

                this.refreshFolderTreeitems([feed.feedID]);

                this._folderParentChain.push(folder);

                this._buildFolderChildren(feed.feedID);
            }
            else {
                let treeitem = document.createElement('richtreeitem');
                treeitem.id = feed.feedID;
                treeitem.className = 'feed-treeitem';
                treeitem.contextMenu = 'feed-context-menu';
                parent.appendChild(treeitem);

                this._refreshLabel(feed);
                this._refreshFavicon(feed.feedID);
            }
        }

        this._folderParentChain.pop();
    },


    observe: function FeedList_observe(aSubject, aTopic, aData) {
        switch (aTopic) {

            case 'brief:invalidate-feedlist':
                if (this.ignoreInvalidateNotification) {
                    FeedList.ignoreInvalidateNotification = false;
                }
                else {
                    this.persistFolderState();
                    this.rebuild();
                    ViewList.refreshItem('unread-folder');
                    ViewList.refreshItem('starred-folder');
                    async(gCurrentView.refresh, 0, gCurrentView);
                }
                break;

            case 'brief:feed-title-changed':
                let feed = Storage.getFeed(aData);
                if (feed.isFolder)
                    this.refreshFolderTreeitems([aData]);
                else
                    this.refreshFeedTreeitems([aData]);
                break;

            case 'brief:feed-favicon-changed':
                this._refreshFavicon(aData)
                break;

            case 'brief:feed-updated':
                let item = getElement(aData);
                item.removeAttribute('error');
                item.removeAttribute('loading');
                this._refreshFavicon(aData);
                refreshProgressmeter();
                break;

            case 'brief:feed-loading':
                item = getElement(aData);
                item.setAttribute('loading', true);
                this._refreshFavicon(aData);
                break;

            case 'brief:feed-error':
                item = getElement(aData);
                item.setAttribute('error', true);
                this._refreshFavicon(aData);
                break;

            case 'brief:feed-update-queued':
                refreshProgressmeter();
                break;

            case 'brief:feed-update-finished':
                refreshProgressmeter(aData);

                if (aData == 'canceled') {
                    for (let feed in Storage.getAllFeeds()) {
                        let item = getElement(feed.feedID);
                        if (item.hasAttribute('loading')) {
                            item.removeAttribute('loading');
                            this._refreshFavicon(feed.feedID);
                        }
                    }
                }
                break;

            case 'brief:custom-style-changed':
                gCurrentView.browser.loadURI(gTemplateURI.spec);
                break;
        }
    },


    onEntriesAdded: function FeedList_onEntriesAdded(aEntryList) {
        this.refreshFeedTreeitems(aEntryList.feedIDs);
        ViewList.refreshItem('unread-folder');
    },

    onEntriesUpdated: function FeedList_onEntriesUpdated(aEntryList) {
        this.refreshFeedTreeitems(aEntryList.feedIDs);
        ViewList.refreshItem('unread-folder');
        TagList.refreshTags(aEntryList.tags);
    },

    onEntriesMarkedRead: function FeedList_onEntriesMarkedRead(aEntryList, aNewState) {
        this.refreshFeedTreeitems(aEntryList.feedIDs);
        ViewList.refreshItem('unread-folder');
        ViewList.refreshItem('starred-folder');
        TagList.refreshTags(aEntryList.tags);
    },

    onEntriesStarred: function FeedList_onEntriesStarred(aEntryList, aNewState) {
        ViewList.refreshItem('starred-folder');
    },

    onEntriesTagged: function FeedList_onEntriesTagged(aEntryList, aNewState, aTag) {
        if (ViewList.selectedItem && ViewList.selectedItem.id == 'starred-folder')
            TagList.show();

        TagList.refreshTags([aTag], aNewState, !aNewState);
    },

    onEntriesDeleted: function FeedList_onEntriesDeleted(aEntryList, aNewState) {
        this.refreshFeedTreeitems(aEntryList.feedIDs);
        ViewList.refreshItem('unread-folder');
        ViewList.refreshItem('starred-folder');

        let entriesRestored = (aNewState == Storage.ENTRY_STATE_NORMAL);
        TagList.refreshTags(aEntryList.tags, entriesRestored, !entriesRestored);
    },


    persistFolderState: function FeedList_persistFolderState() {
        let folders = this.tree.getElementsByTagName('richtreefolder');
        let closedFolders = '';
        for (let i = 0; i < folders.length; i++) {
            if (folders[i].getAttribute('open') == 'false')
                closedFolders += folders[i].id;
        }

        FeedList.tree.setAttribute('closedFolders', escape(closedFolders));
    },

    removeItem: function FeedList_removeItem(aElement) {
        let itemToSelect = null;

        if (this.selectedItem == aElement)
            itemToSelect = aElement.nextSibling || aElement.previousSibling || aElement.parentNode;

        aElement.parentNode.removeChild(aElement);

        if (itemToSelect)
            this.tree.selectedItem = itemToSelect;
    }

}



let ViewListContextMenu = {

    targetItem: null,

    get targetIsAllItemsFolder() this.targetItem.id == 'all-items-folder',
    get targetIsUnreadFolder()   this.targetItem.id == 'unread-folder',
    get targetIsStarredFolder()  this.targetItem.id == 'starred-folder',
    get targetIsTrashFolder()    this.targetItem.id == 'trash-folder',

    init: function ViewListContextMenu_init() {
        this.targetItem = ViewList.selectedItem;

        getElement('ctx-mark-special-folder-read').hidden = !this.targetIsUnreadFolder &&
                                                            !this.targetIsTrashFolder &&
                                                            !this.targetIsStarredFolder &&
                                                            !this.targetIsAllItemsFolder;
        getElement('ctx-mark-tag-read').hidden = !this.targetIsTag;
        getElement('ctx-restore-trashed').hidden = !this.targetIsTrashFolder;
        getElement('ctx-view-list-separator').hidden = !this.targetIsTag &&
                                                       !this.targetIsTrashFolder &&
                                                       !this.targetIsUnreadFolder;
        getElement('ctx-delete-tag').hidden = !this.targetIsTag;
        getElement('ctx-empty-unread-folder').hidden = !this.targetIsUnreadFolder;
        getElement('ctx-empty-trash').hidden = !this.targetIsTrashFolder;
    },

    markFolderRead: function ViewListContextMenu_markFolderRead() {
        let query = new Query();

        if (this.targetIsUnreadFolder) {
            query.deleted = Storage.ENTRY_STATE_NORMAL;
            query.read = false;
        }
        else if (this.targetIsStarredFolder) {
            query.deleted = Storage.ENTRY_STATE_NORMAL;
            query.starred = true;
        }
        else if (this.targetIsTrashFolder) {
            query.deleted = Storage.ENTRY_STATE_TRASHED;
        }

        query.markEntriesRead(true);
    },

    restoreTrashed: function ViewListContextMenu_restoreTrashed() {
        let query = new Query({
            deleted: Storage.ENTRY_STATE_TRASHED
        })
        query.deleteEntries(Storage.ENTRY_STATE_NORMAL);
    },

    emptyUnreadFolder: function ViewListContextMenu_emptyUnreadFolder() {
        let query = new Query({
            deleted: Storage.ENTRY_STATE_NORMAL,
            starred: false,
            read: false
        })
        query.deleteEntries(Storage.ENTRY_STATE_TRASHED);
    },

    emptyTrash: function gCurrentViewContextMenu_emptyTrash() {
        let query = new Query({
            deleted: Storage.ENTRY_STATE_TRASHED
        })
        query.deleteEntries(Storage.ENTRY_STATE_DELETED);
    }

}


let TagListContextMenu = {

    markTagRead: function TagListContextMenu_markTagRead() {
        let query = new Query({
            deleted: Storage.ENTRY_STATE_NORMAL,
            tags: [TagList.selectedItem.id]
        })
        query.markEntriesRead(true);
    },

    deleteTag: function TagListContextMenu_deleteTag() {
        let taggingService = Cc['@mozilla.org/browser/tagging-service;1'].
                             getService(Ci.nsITaggingService);

        let tag = TagList.selectedItem.id;

        let dialogTitle = gStringBundle.getString('confirmTagDeletionTitle');
        let dialogText = gStringBundle.getFormattedString('confirmTagDeletionText', [tag]);

        if (!Services.prompt.confirm(window, dialogTitle, dialogText))
            return;

        let query = new Query({
            tags: [tag]
        })

        query.getProperty('entryURL', true, function(urls) {
            for (let url in urls) {
                try {
                    var uri = NetUtil.newURI(url, null, null);
                }
                catch (ex) {
                    return;
                }
                taggingService.untagURI(uri, [tag]);
            }
        })
    }

}


let FeedContextMenu = {

    targetItem: null,

    get targetID()   this.targetItem.id,
    get targetFeed() Storage.getFeed(this.targetID),

    init: function FeedContextMenu_init() {
        this.targetItem = FeedList.selectedItem;

        getElement('ctx-open-website').disabled = !this.targetFeed.websiteURL;
    },


    markFeedRead: function FeedContextMenu_markFeedRead() {
        let query = new Query({
            feeds: [this.targetID],
            deleted: Storage.ENTRY_STATE_NORMAL
        })
        query.markEntriesRead(true);
    },


    updateFeed: function FeedContextMenu_updateFeed() {
        FeedUpdateService.updateFeeds([this.targetFeed]);
    },

    openWebsite: function FeedContextMenu_openWebsite() {
        let url = this.targetFeed.websiteURL;
        getTopWindow().gBrowser.loadOneTab(url);
    },


    emptyFeed: function FeedContextMenu_emptyFeed() {
        let query = new Query({
            deleted: Storage.ENTRY_STATE_NORMAL,
            starred: false,
            feeds: [this.targetID]
        })
        query.deleteEntries(Storage.ENTRY_STATE_TRASHED);
    },

    deleteFeed: function FeedContextMenu_deleteFeed() {
        let title = gStringBundle.getString('confirmFeedDeletionTitle');
        let text = gStringBundle.getFormattedString('confirmFeedDeletionText',
                                                    [this.targetFeed.title]);
        if (Services.prompt.confirm(window, title, text)) {
            FeedList.removeItem(this.targetItem);
            FeedList.ignoreInvalidateNotification = true;

            Components.utils.import('resource://gre/modules/PlacesUtils.jsm');

            let txn = new PlacesRemoveItemTransaction(this.targetFeed.bookmarkID);
            PlacesUtils.transactionManager.doTransaction(txn);
        }
    },

    showFeedProperties: function FeedContextMenu_showFeedProperties() {
        openDialog('chrome://brief/content/options/feed-properties.xul', 'FeedProperties',
                   'chrome,titlebar,toolbar,centerscreen,modal', this.targetID);
    }

}

let FolderContextMenu = {

    markFolderRead: function FolderContextMenu_markFolderRead() {
        let query = new Query({
            deleted: Storage.ENTRY_STATE_NORMAL,
            folders: [FeedList.selectedFeed.feedID]
        })
        query.markEntriesRead(true);
    },

    updateFolder: function FolderContextMenu_updateFolder() {
        let items = FeedList.selectedItem.getElementsByTagName('richtreeitem');
        let feeds = [];
        for (let i = 0; i < items.length; i++)
            feeds.push(Storage.getFeed(items[i].id));

        FeedUpdateService.updateFeeds(feeds);
    },

    emptyFolder: function FolderContextMenu_emptyFolder() {
        let query = new Query({
            deleted: Storage.ENTRY_STATE_NORMAL,
            starred: false,
            folders: [FeedList.selectedFeed.feedID]
        })
        query.deleteEntries(Storage.ENTRY_STATE_TRASHED);
    },

    deleteFolder: function FolderContextMenu_deleteFolder() {
        let item = FeedList.selectedItem;
        let feed = FeedList.selectedFeed;

        let title = gStringBundle.getString('confirmFolderDeletionTitle');
        let text = gStringBundle.getFormattedString('confirmFolderDeletionText',
                                                    [feed.title]);

        if (Services.prompt.confirm(window, title, text)) {
            FeedList.removeItem(item);
            FeedList.ignoreInvalidateNotification = true;

            Components.utils.import('resource://gre/modules/PlacesUtils.jsm');

            let txn = new PlacesRemoveItemTransaction(feed.bookmarkID);
            PlacesUtils.transactionManager.doTransaction(txn);
        }
    }

}
