const EXPORTED_SYMBOLS = ['Storage', 'Query'];

Components.utils.import('resource://brief/common.jsm');
Components.utils.import('resource://brief/StorageUtils.jsm');
Components.utils.import('resource://brief/FeedContainer.jsm');
Components.utils.import('resource://brief/FeedUpdateService.jsm');
Components.utils.import('resource://gre/modules/Services.jsm');
Components.utils.import('resource://gre/modules/XPCOMUtils.jsm');

IMPORT_COMMON(this);


const PURGE_ENTRIES_INTERVAL = 3600*24; // 1 day
const DELETED_FEEDS_RETENTION_TIME = 3600*24*7; // 1 week
const LIVEMARKS_SYNC_DELAY = 100;
const BACKUP_FILE_EXPIRATION_AGE = 3600*24*14; // 2 weeks
const DATABASE_VERSION = 13;

const FEEDS_TABLE_SCHEMA = [
    'feedID          TEXT UNIQUE',
    'feedURL         TEXT',
    'websiteURL      TEXT',
    'title           TEXT',
    'subtitle        TEXT',
    'imageURL        TEXT',
    'imageLink       TEXT',
    'imageTitle      TEXT',
    'favicon         TEXT',
    'bookmarkID      TEXT',
    'parent          TEXT',
    'rowIndex        INTEGER',
    'isFolder        INTEGER',
    'hidden          INTEGER DEFAULT 0',
    'lastUpdated     INTEGER DEFAULT 0',
    'oldestEntryDate INTEGER',
    'entryAgeLimit   INTEGER DEFAULT 0',
    'maxEntries      INTEGER DEFAULT 0',
    'updateInterval  INTEGER DEFAULT 0',
    'dateModified    INTEGER DEFAULT 0',
    'lastFaviconRefresh INTEGER DEFAULT 0',
    'markModifiedEntriesUnread INTEGER DEFAULT 1'
]

const ENTRIES_TABLE_SCHEMA = [
    'id            INTEGER PRIMARY KEY AUTOINCREMENT',
    'feedID        TEXT',
    'primaryHash   TEXT',
    'secondaryHash TEXT',
    'providedID    TEXT',
    'entryURL      TEXT',
    'date          INTEGER',
    'read          INTEGER DEFAULT 0',
    'updated       INTEGER DEFAULT 0',
    'starred       INTEGER DEFAULT 0',
    'deleted       INTEGER DEFAULT 0',
    'bookmarkID    INTEGER DEFAULT -1 '
]

const ENTRIES_TEXT_TABLE_SCHEMA = [
    'title   TEXT ',
    'content TEXT ',
    'authors TEXT ',
    'tags    TEXT '
]

const ENTRY_TAGS_TABLE_SCHEMA = [
    'tagName  TEXT    ',
    'entryID  INTEGER '
]

const REASON_FINISHED = Ci.mozIStorageStatementCallback.REASON_FINISHED;
const REASON_ERROR = Ci.mozIStorageStatementCallback.REASON_ERROR;

XPCOMUtils.defineLazyServiceGetter(this, 'Bookmarks', '@mozilla.org/browser/nav-bookmarks-service;1', 'nsINavBookmarksService');

XPCOMUtils.defineLazyGetter(this, 'Prefs', function() {
    return Services.prefs.getBranch('extensions.brief.').QueryInterface(Ci.nsIPrefBranch2);
})
XPCOMUtils.defineLazyGetter(this, 'Places', function() {
    Components.utils.import('resource://gre/modules/PlacesUtils.jsm');
    return PlacesUtils;
})


let Connection = null;

function Statement(aStatement, aDefaultParams) {
    StorageStatement.call(this, Connection, aStatement, aDefaultParams);
}

Statement.prototype = StorageStatement.prototype;


// Exported object exposing public properties.
const Storage = {

    ENTRY_STATE_NORMAL: 0,
    ENTRY_STATE_TRASHED: 1,
    ENTRY_STATE_DELETED: 2,

    /**
     * Returns a feed or a folder with given ID.
     *
     * @param aFeedID
     * @returns Feed object, without entries.
     */
    getFeed: function(aFeedID) {
        return StorageInternal.getFeed(aFeedID);
    },

    /**
     * Gets all feeds, without entries.
     *
     * @param aIncludeFolders [optional]
     * @returns array of Feed's.
     */
    getAllFeeds: function(aIncludeFolders) {
        return StorageInternal.getAllFeeds(aIncludeFolders);
    },

    /**
     * Gets a list of distinct tags for URLs of entries stored in the database.
     *
     * @returns Array of tag names.
     */
    getAllTags: function() {
        return StorageInternal.getAllTags();
    },

    /**
     * Evaluates provided entries, inserting any new items and updating existing
     * items when newer versions are found. Also updates feed's properties.
     *
     * @param aFeed
     *        Contains the feed and the entries to evaluate.
     * @param aCallback
     *        Callback after the database is updated.
     */
    processFeed: function(aFeed, aCallback) {
        return StorageInternal.processFeed(aFeed, aCallback);
    },

    /**
     * Saves feed settings: entryAgeLimit, maxEntries, updateInterval and
     * markModifiedEntriesUnread.
     *
     * @param aFeed
     *        Feed object whose properties to use to update the respective
     *        columns in the database.
     */
    setFeedOptions: function(aFeed) {
        return StorageInternal.setFeedOptions(aFeed);
    },

    /**
     * Synchronizes database with Live Bookmarks from home folder which ID is
     * specified by extensions.brief.homeFolder.
     * Feeds that were removed from the home folder remain in the database in the hidden
     * state for a certain amount of time in case they are added back.
     */
    syncWithLivemarks: function() {
        return StorageInternal.syncWithLivemarks();
    },

    /**
     * Registers an object to be notified of entry changes. A strong reference
     * is held to this object, so all observers have to be removed using
     * Storage.removeObserver().
     *
     * Observer must implement the following functions.
     *
     * Called when new entries are added to the database.
     *
     *     function onEntriesAdded(aEntryList)
     *
     * Called when properties of existing entries, such as title, content, authors
     * and date, are changed. When entries are updated, they can also be marked as unread.
     *
     *     function onEntriesUpdated(aEntryList);
     *
     * Called when the read/unread state of entries changes.
     *
     *     function onEntriesMarkedRead(aEntryList, aNewState);
     *
     * Called when URLs of entries are bookmarked/unbookmarked.
     *
     *     function onEntriesStarred(aEntryList, aNewState);
     *
     * Called when a tag is added or removed from entries.
     *
     *     function onEntriesTagged(aEntryList, aNewState, aTagName);
     *
     * Called when the deleted state of entries changes.
     *
     *     function onEntriesDeleted(aEntryList, aNewState);
     *
     */
    addObserver: function(aObserver) {
        return StorageInternal.addObserver(aObserver);
    },

    /**
     * Unregisters an observer object.
     */
    removeObserver: function(aObserver) {
        return StorageInternal.removeObserver(aObserver);
    }

}


let StorageInternal = {

    feedsAndFoldersCache: null,
    feedsCache:           null,


    init: function StorageInternal_init() {
        let profileDir = Services.dirsvc.get('ProfD', Ci.nsIFile);
        let databaseFile = profileDir.clone();
        databaseFile.append('brief.sqlite');
        let databaseIsNew = !databaseFile.exists();

        Connection = new StorageConnection(databaseFile);
        let schemaVersion = Connection.schemaVersion;

        // Remove the backup file after certain amount of time.
        let backupFile = profileDir.clone();
        backupFile.append('brief-backup-' + (schemaVersion - 1) + '.sqlite');
        if (backupFile.exists() && Date.now() - backupFile.lastModifiedTime > BACKUP_FILE_EXPIRATION_AGE)
            backupFile.remove(false);

        if (!Connection.connectionReady) {
            // The database was corrupted, back it up and create a new one.
            Services.storage.backupDatabaseFile(databaseFile, 'brief-backup.sqlite');
            Connection.close();
            databaseFile.remove(false);
            Connection = new StorageConnection(databaseFile);
            this.setupDatabase();
        }
        else if (databaseIsNew) {
            this.setupDatabase();
        }
        else if (schemaVersion < DATABASE_VERSION) {
            // Remove the old backup file.
            if (backupFile.exists())
                backupFile.remove(false);

            // Backup the database before migration.
            let newBackupFile = profileDir;
            let filename = 'brief-backup-' + schemaVersion + '.sqlite';
            newBackupFile.append(filename);
            if (!newBackupFile.exists())
                Services.storage.backupDatabaseFile(databaseFile, filename);

            // No support for migration from versions older than 1.2,
            // create a new database.
            if (schemaVersion < 9) {
                Connection.close();
                databaseFile.remove(false);
                Connection = new StorageConnection(databaseFile);
                this.setupDatabase();
            }
            else {
                this.upgradeDatabase();
            }
        }

        this.refreshFeedsCache();

        this.homeFolderID = Prefs.getIntPref('homeFolder');
        Prefs.addObserver('', this, false);

        Services.obs.addObserver(this, 'quit-application', false);
        Services.obs.addObserver(this, 'idle-daily', false);

        // This has to be on the end, in case getting bookmarks service throws.
        Bookmarks.addObserver(BookmarkObserver, false);
    },

    setupDatabase: function Database_setupDatabase() {
        Connection.executeSQL([
            'CREATE TABLE IF NOT EXISTS feeds (' + FEEDS_TABLE_SCHEMA.join(',') + ') ',
            'CREATE TABLE IF NOT EXISTS entries (' + ENTRIES_TABLE_SCHEMA.join(',') + ') ',
            'CREATE TABLE IF NOT EXISTS entry_tags (' + ENTRY_TAGS_TABLE_SCHEMA.join(',') + ') ',
            'CREATE VIRTUAL TABLE entries_text USING fts3 (' + ENTRIES_TEXT_TABLE_SCHEMA.join(',') + ')',

            'CREATE INDEX IF NOT EXISTS entries_date_index ON entries (date)                ',
            'CREATE INDEX IF NOT EXISTS entries_feedID_date_index ON entries (feedID, date) ',

            // Speed up lookup when checking for updates.
            'CREATE INDEX IF NOT EXISTS entries_primaryHash_index ON entries (primaryHash) ',

            // Speed up SELECTs in the bookmarks observer.
            'CREATE INDEX IF NOT EXISTS entries_bookmarkID_index ON entries (bookmarkID) ',
            'CREATE INDEX IF NOT EXISTS entries_entryURL_index ON entries (entryURL)     ',

            'CREATE INDEX IF NOT EXISTS entry_tagName_index ON entry_tags (tagName)',

            'PRAGMA journal_mode=WAL',

            'ANALYZE'
        ])

        Connection.schemaVersion = DATABASE_VERSION;
    },

    upgradeDatabase: function StorageInternal_upgradeDatabase() {
        switch (Connection.schemaVersion) {
            // To 1.5b2
            case 9:
                // Remove dead rows from entries_text.
                Connection.executeSQL('DELETE FROM entries_text                       '+
                                      'WHERE rowid IN (                               '+
                                      '     SELECT entries_text.rowid                 '+
                                      '     FROM entries_text LEFT JOIN entries       '+
                                      '          ON entries_text.rowid = entries.id   '+
                                      '     WHERE NOT EXISTS (                        '+
                                      '         SELECT id                             '+
                                      '         FROM entries                          '+
                                      '         WHERE entries_text.rowid = entries.id '+
                                      '     )                                         '+
                                     ')                                              ');

            // To 1.5b3
            case 10:
                Connection.executeSQL('ALTER TABLE feeds ADD COLUMN lastFaviconRefresh INTEGER DEFAULT 0');

            // To 1.5
            case 11:
                Connection.executeSQL('ANALYZE');

            case 12:
                Connection.executeSQL('PRAGMA journal_mode=WAL');
        }

        Connection.schemaVersion = DATABASE_VERSION;
    },


    // See Storage.
    getFeed: function StorageInternal_getFeed(aFeedID) {
        let foundFeed = null;
        let feeds = this.getAllFeeds(true);
        for (let i = 0; i < feeds.length; i++) {
            if (feeds[i].feedID == aFeedID) {
                foundFeed = feeds[i];
                break;
            }
        }
        return foundFeed;
    },

    // See Storage.
    getAllFeeds: function StorageInternal_getAllFeeds(aIncludeFolders) {
        // It's not worth the trouble to make this function asynchronous like the
        // rest of the IO, as in-memory cache is practically always available.
        // However, in the rare case when the cache has just been invalidated
        // and hasn't been refreshed yet, we must fall back to a synchronous query.
        if (!this.feedsCache) {
            this.feedsCache = [];
            this.feedsAndFoldersCache = [];

            for (let row in Stm.getAllFeeds.results) {
                let feed = new Feed();
                for (let column in row)
                    feed[column] = row[column];

                this.feedsAndFoldersCache.push(feed);
                if (!feed.isFolder)
                    this.feedsCache.push(feed);
            }
        }

        return aIncludeFolders ? this.feedsAndFoldersCache : this.feedsCache;
    },

    refreshFeedsCache: function StorageInternal_refreshFeedsCache(aNotify) {
        this.feedsCache = null;
        this.feedsAndFoldersCache = null;

        let feeds = [];
        let feedsAndFolders = [];

        Stm.getAllFeeds.executeAsync({
            handleResult: function(results) {
                for (let row in results) {
                    let feed = new Feed();

                    for (let column in row)
                        feed[column] = row[column];

                    feedsAndFolders.push(feed);
                    if (!feed.isFolder)
                        feeds.push(feed);
                }
            },

            handleCompletion: function(reason) {
                this.feedsCache = feeds;
                this.feedsAndFoldersCache = feedsAndFolders;

                if (aNotify)
                    Services.obs.notifyObservers(null, 'brief:invalidate-feedlist', '')
            }.bind(this)
        })
    },

    // See Storage.
    getAllTags: function StorageInternal_getAllTags() {
        return [row.tagName for each (row in Stm.getAllTags.results)];
    },


    // See Storage.
    processFeed: function StorageInternal_processFeed(aFeed, aCallback) {
        new FeedProcessor(aFeed, aCallback);
    },

    // See Storage.
    setFeedOptions: function StorageInternal_setFeedOptions(aFeed) {
        Stm.setFeedOptions.execute({
            'entryAgeLimit': aFeed.entryAgeLimit,
            'maxEntries': aFeed.maxEntries,
            'updateInterval': aFeed.updateInterval,
            'markUnread': aFeed.markModifiedEntriesUnread ? 1 : 0,
            'feedID': aFeed.feedID
        });

        // Update the cache if neccassary (it may not be if Feed instance that was
        // passed to us was itself taken from the cache).
        let feed = this.getFeed(aFeed.feedID);
        if (feed != aFeed) {
            feed.entryAgeLimit = aFeed.entryAgeLimit;
            feed.maxEntries = aFeed.maxEntries;
            feed.updateInterval = aFeed.updateInterval;
            feed.markModifiedEntriesUnread = aFeed.markModifiedEntriesUnread;
        }
    },

    // Moves items to Trash based on age and number limits.
    expireEntries: function StorageInternal_expireEntries(aFeed) {
        new Task(function() {
            // Delete entries exceeding the maximum amount specified by maxStoredEntries pref.
            if (Prefs.getBoolPref('database.limitStoredEntries')) {
                let query = new Query({
                    feeds: [aFeed.feedID],
                    deleted: Storage.ENTRY_STATE_NORMAL,
                    starred: false,
                    sortOrder: Query.prototype.SORT_BY_DATE,
                    offset: Prefs.getIntPref('database.maxStoredEntries')
                })

                query.deleteEntries(Storage.ENTRY_STATE_TRASHED, this.resume);
                yield;
            }

            // Delete old entries in feeds that don't have per-feed setting enabled.
            if (Prefs.getBoolPref('database.expireEntries') && !aFeed.entryAgeLimit) {
                let expirationAge = Prefs.getIntPref('database.entryExpirationAge');

                let query = new Query({
                    feeds: [aFeed.feedID],
                    deleted: Storage.ENTRY_STATE_NORMAL,
                    starred: false,
                    endDate: Date.now() - expirationAge * 86400000
                })

                query.deleteEntries(Storage.ENTRY_STATE_TRASHED, this.resume);
                yield;
            }

            // Delete old entries based on per-feed limit.
            if (aFeed.entryAgeLimit > 0) {
                let query = new Query({
                    feeds: [aFeed.feedID],
                    deleted: Storage.ENTRY_STATE_NORMAL,
                    starred: false,
                    endDate: Date.now() - aFeed.entryAgeLimit * 86400000
                })

                query.deleteEntries(Storage.ENTRY_STATE_TRASHED, this.resume);
            }
        })
    },

    // Permanently removes deleted items from database.
    purgeDeleted: function StorageInternal_purgeDeleted() {
        Stm.purgeDeletedEntriesText.params = {
            'deletedState': Storage.ENTRY_STATE_DELETED,
            'currentDate': Date.now(),
            'retentionTime': DELETED_FEEDS_RETENTION_TIME
        }

        Stm.purgeDeletedEntries.params = {
            'deletedState': Storage.ENTRY_STATE_DELETED,
            'currentDate': Date.now(),
            'retentionTime': DELETED_FEEDS_RETENTION_TIME
        }

        Stm.purgeDeletedFeeds.params = {
            'currentDate': Date.now(),
            'retentionTime': DELETED_FEEDS_RETENTION_TIME
        }

        Connection.executeAsync([Stm.purgeDeletedEntriesText,
                                 Stm.purgeDeletedEntries,
                                 Stm.purgeDeletedFeeds])

        // Prefs can only store longs while Date is a long long.
        let now = Math.round(Date.now() / 1000);
        Prefs.setIntPref('database.lastPurgeTime', now);
    },

    // nsIObserver
    observe: function StorageInternal_observe(aSubject, aTopic, aData) {
        switch (aTopic) {
            case 'quit-application':
                Bookmarks.removeObserver(BookmarkObserver);
                Prefs.removeObserver('', this);

                Services.obs.removeObserver(this, 'quit-application');
                Services.obs.removeObserver(this, 'idle-daily');

                BookmarkObserver.syncDelayTimer = null;
                break;

            case 'idle-daily':
                // Integer prefs are longs while Date is a long long.
                let now = Math.round(Date.now() / 1000);
                let lastPurgeTime = Prefs.getIntPref('database.lastPurgeTime');
                if (now - lastPurgeTime > PURGE_ENTRIES_INTERVAL)
                    this.purgeDeleted();
                break;

            case 'nsPref:changed':
                if (aData == 'homeFolder') {
                    this.homeFolderID = Prefs.getIntPref('homeFolder');
                    this.syncWithLivemarks();
                }
                break;
        }
    },


    // See Storage.
    syncWithLivemarks: function StorageInternal_syncWithLivemarks() {
        new LivemarksSync();
    },

    observers: [],

    // See Storage.
    addObserver: function StorageInternal_addObserver(aObserver) {
        this.observers.push(aObserver);
    },

    // See Storage.
    removeObserver: function StorageInternal_removeObserver(aObserver) {
        let index = this.observers.indexOf(aObserver);
        if (index !== -1)
            this.observers.splice(index, 1);
    },

    /**
     * Sets starred status of an entry.
     *
     * @param aState
     *        New state. TRUE for starred, FALSE for not starred.
     * @param aEntryID
     *        Subject entry.
     * @param aBookmarkID
     *        ItemId of the corresponding bookmark in Places database.
     * @param aDontNotify
     *        Don't notify observers.
     */
    starEntry: function StorageInternal_starEntry(aState, aEntryID, aBookmarkID, aDontNotify) {
        if (aState)
            Stm.starEntry.execute({ 'bookmarkID': aBookmarkID, 'entryID': aEntryID });
        else
            Stm.unstarEntry.execute({ 'id': aEntryID });

        if (aDontNotify)
            return;

        new Query(aEntryID).getEntryList(function(aList) {
            for (let observer in StorageInternal.observers)
                observer.onEntriesStarred(aList, aState);
        })
    },

    /**
     * Adds or removes a tag for an entry.
     *
     * @param aState
     *        TRUE to add the tag, FALSE to remove it.
     * @param aEntryID
     *        Subject entry.
     * @param aTagName
     *        Name of the tag.
     */
    tagEntry: function StorageInternal_tagEntry(aState, aEntryID, aTagName) {
        Connection.runTransaction(function() {
            let params = { 'entryID': aEntryID, 'tagName': aTagName };

            if (aState) {
                let alreadyTagged = Stm.checkTag.getSingleResult(params).alreadyExists;
                if (alreadyTagged)
                    return;

                Stm.tagEntry.execute(params);
            }
            else {
                Stm.untagEntry.execute(params);
            }

            // Update the serialized list of tags stored in entries_text table.
            Stm.setSerializedTagList.execute({
                'tags': Utils.getTagsForEntry(aEntryID).join(', '),
                'entryID': aEntryID
            })

            new Query(aEntryID).getEntryList(function(aList) {
                for (let observer in StorageInternal.observers)
                    observer.onEntriesTagged(aList, aState, aTagName);
            })
        })
    },

    QueryInterface: XPCOMUtils.generateQI([Ci.nsIObserver])

}


/**
 * Evaluates provided entries, inserting any new items and updating existing
 * items when newer versions are found. Also updates feed's properties.
 */
function FeedProcessor(aFeed, aCallback) {
    this.feed = aFeed;
    this.callback = aCallback;

    let storedFeed = StorageInternal.getFeed(aFeed.feedID);
    this.oldestEntryDate = storedFeed.oldestEntryDate;

    let newDateModified = new Date(aFeed.wrappedFeed.updated).getTime();
    let prevDateModified = storedFeed.dateModified;

    if (aFeed.entries.length && (!newDateModified || newDateModified > prevDateModified)) {
        this.remainingEntriesCount = aFeed.entries.length;

        this.updatedEntries = [];
        this.insertedEntries = [];

        this.updateEntry = new Statement(Stm.updateEntry);
        this.insertEntry = new Statement(Stm.insertEntry);
        this.updateEntryText = new Statement(Stm.updateEntryText);
        this.insertEntryText = new Statement(Stm.insertEntryText);

        this.oldestEntryDate = Date.now();

        aFeed.entries.forEach(this.processEntry, this);
    }
    else {
        aCallback(0);
    }

    let properties = {
        'websiteURL': aFeed.websiteURL,
        'subtitle': aFeed.subtitle,
        'favicon': aFeed.favicon,
        'lastUpdated': Date.now(),
        'lastFaviconRefresh': aFeed.lastFaviconRefresh,
        'dateModified': newDateModified,
        'oldestEntryDate': this.oldestEntryDate,
        'feedID': aFeed.feedID
    }

    Stm.updateFeed.params = properties;
    Stm.updateFeed.executeAsync();

    // Keep cache up to date.
    let cachedFeed = StorageInternal.getFeed(aFeed.feedID);
    for (let p in properties)
        cachedFeed[p] = properties[p];
}

FeedProcessor.prototype = {

    entriesToUpdateCount: 0,
    entriesToInsertCount: 0,

    processEntry: function FeedProcessor_processEntry(aEntry) {
        if (aEntry.date && aEntry.date < this.oldestEntryDate)
            this.oldestEntryDate = aEntry.date;

        // This function checks whether a downloaded entry is already in the database or
        // it is a new one. To do this we need a way to uniquely identify entries. Many
        // feeds don't provide unique identifiers for their entries, so we have to use
        // hashes for this purpose. There are two hashes.
        // The primary hash is used as a standard unique ID throughout the codebase.
        // Ideally, we just compute it from the GUID provided by the feed. Otherwise, we
        // use the entry's URL.
        // There is a problem, though. Even when a feed does provide its own GUID, it
        // seems to randomly get lost (maybe a bug in the parser?). This means that the
        // same entry may sometimes be hashed using the GUID and other times using the
        // URL. Different hashes lead to the entry being duplicated.
        // This is why we need a secondary hash, which is always based on the URL. If the
        // GUID is empty (either because it was lost or because it wasn't provided to
        // begin with), we look up the entry using the secondary hash.
        let providedID = aEntry.wrappedEntry.id;
        let primarySet = providedID ? [this.feed.feedID, providedID]
                                    : [this.feed.feedID, aEntry.entryURL];
        let secondarySet = [this.feed.feedID, aEntry.entryURL];

        // Special case for MediaWiki feeds: include the date in the hash. In
        // "Recent changes" feeds, entries for subsequent edits of a page differ
        // only in date (not in URL or GUID).
        let generator = this.feed.wrappedFeed.generator;
        if (generator && generator.agent.match('MediaWiki')) {
            primarySet.push(aEntry.date);
            secondarySet.push(aEntry.date);
        }

        let primaryHash = Utils.hashString(primarySet.join(''));
        let secondaryHash = Utils.hashString(secondarySet.join(''));

        // Look up if the entry is already present in the database.
        if (providedID) {
            var select = Stm.getEntryByPrimaryHash;
            select.params.primaryHash = primaryHash;
        }
        else {
            select = Stm.getEntryBySecondaryHash;
            select.params.secondaryHash = secondaryHash;
        }

        let storedID, storedDate, isEntryRead;
        let self = this;

        select.executeAsync({
            handleResult: function(aResults) {
                let row = aResults.next();
                storedID = row.id;
                storedDate = row.date;
                isEntryRead = row.read;
            },

            handleCompletion: function(aReason) {
                if (aReason == REASON_FINISHED) {
                    if (storedID) {
                        if (aEntry.date && storedDate < aEntry.date) {
                            self.addUpdateParams(aEntry, storedID, isEntryRead);
                        }
                    }
                    else {
                        self.addInsertParams(aEntry, primaryHash, secondaryHash);
                    }
                }

                if (!--self.remainingEntriesCount)
                    self.executeAndNotify();
            }
        })
    },

    addUpdateParams: function FeedProcessor_addUpdateParams(aEntry, aStoredEntryID, aIsRead) {
        let title = aEntry.title ? aEntry.title.replace(/<[^>]+>/g, '') : ''; // Strip tags
        let markUnread = StorageInternal.getFeed(this.feed.feedID).markModifiedEntriesUnread;

        this.updateEntry.paramSets.push({
            'date': aEntry.date,
            'read': markUnread || !aIsRead ? 0 : 1,
            'id': aStoredEntryID
        })

        this.updateEntryText.paramSets.push({
            'title': title,
            'content': aEntry.content || aEntry.summary,
            'authors': aEntry.authors,
            'id': aStoredEntryID
        })

        this.entriesToUpdateCount++;
        this.updatedEntries.push(aStoredEntryID);
    },

    addInsertParams: function FeedProcessor_addInsertParams(aEntry, aPrimaryHash, aSecondaryHash) {
        let title = aEntry.title ? aEntry.title.replace(/<[^>]+>/g, '') : ''; // Strip tags

        try {
            this.insertEntry.paramSets.push({
                'feedID': this.feed.feedID,
                'primaryHash': aPrimaryHash,
                'secondaryHash': aSecondaryHash,
                'providedID': aEntry.wrappedEntry.id,
                'entryURL': aEntry.entryURL,
                'date': aEntry.date || Date.now()
            })
        }
        catch (ex) {
            Connection.reportDatabaseError('Error updating feeds. Failed to bind parameters to insertEntry.');
            throw ex;
        }

        try {
            this.insertEntryText.paramSets.push({
                'title': title,
                'content': aEntry.content || aEntry.summary,
                'authors': aEntry.authors
            })
        }
        catch (ex) {
            this.insertEntry.paramSets.pop();
            Connection.reportDatabaseError('Error updating feeds. Failed to bind parameters to insertEntryText.');
            throw ex;
        }

        this.entriesToInsertCount++;
    },

    executeAndNotify: function FeedProcessor_executeAndNotify() {
        let self = this;

        if (this.entriesToInsertCount) {
            let getLastRowids = new Statement(Stm.getLastRowids);
            getLastRowids.params.count = this.entriesToInsertCount;
            let statements = [this.insertEntry, this.insertEntryText, getLastRowids];

            Connection.executeAsync(statements, {

                handleResult: function(aResults) {
                    for (let row in aResults)
                        self.insertedEntries.push(row.id);
                },

                handleCompletion: function(aReason) {
                    if (aReason == REASON_ERROR)
                        return;

                    new Query(self.insertedEntries).getEntryList(function(aList) {
                        for (let observer in StorageInternal.observers)
                            observer.onEntriesAdded(aList);

                        let feed = StorageInternal.getFeed(self.feed.feedID);
                        StorageInternal.expireEntries(feed);
                    })

                    // XXX This should be optimized and/or be asynchronous
                    // query.verifyBookmarksAndTags();
                }
            })
        }

        if (this.entriesToUpdateCount) {
            let statements = [this.updateEntry, this.updateEntryText];

            Connection.executeAsync(statements, function() {
                new Query(self.updatedEntries).getEntryList(function(aList) {
                    for (let observer in StorageInternal.observers)
                        observer.onEntriesUpdated(aList);
                })
            })
        }

        this.callback(this.entriesToInsertCount);
    }

}


/**
 * A query to the Brief's database. Constraints are AND-ed.
 *
 * @param aConstraints
 *        Entry ID, array of entry IDs, or object containing name-value pairs
 *        of query constraints.
 */
function Query(aConstraints) {
    if (!aConstraints)
        return;

    if (typeof aConstraints == 'number') {
        this.entries = [aConstraints];
    }
    else if (aConstraints.splice) {
        this.entries = aConstraints;
    }
    else {
        for (let constraint in aConstraints)
            this[constraint] = aConstraints[constraint];
    }
}

Query.prototype = {

    /**
     * Array of IDs of entries to be selected.
     */
    entries: undefined,

    /**
     * Array of IDs of feeds containing the entries to be selected.
     */
    feeds: undefined,

    /**
     * Array of IDs of folders containing the entries to be selected.
     */
    folders: undefined,

    /**
     * Array of tags which selected entries must have.
     */
    tags: undefined,

    /**
     * Read state of entries to be selected.
     */
    read: undefined,

    /**
     * Starred state of entries to be selected.
     */
    starred: undefined,

    /**
     * Deleted state of entries to be selected. See constants in StorageInternal.
     */
    deleted: undefined,

    /**
     * String that must be contained by title, content, authors or tags of the
     * selected entries.
     */
    searchString: undefined,

    /**
     * Date range for the selected entries.
     */
    startDate: undefined,
    endDate: undefined,

    /**
     * Maximum number of entries to be selected.
     */
    limit: undefined,

    /**
     * Specifies how many result entries to skip at the beggining of the result set.
     */
    offset: 0,

    /**
     * By which column to sort the results.
     */
    SORT_BY_DATE: 1,
    SORT_BY_TITLE: 2,
    SORT_BY_FEED_ROW_INDEX: 3,

    sortOrder: undefined,

    /**
     * Direction in which to sort the results.
     */
    SORT_DESCENDING: 0,
    SORT_ASCENDING: 1,

    sortDirection: 0,

    /**
     * Include hidden feeds i.e. the ones whose Live Bookmarks are no longer
     * to be found in Brief's home folder. This attribute is ignored if
     * the list of feeds is explicitly specified by Query.feeds.
     */
    includeHiddenFeeds: false,

    /**
     * Indicates if there are any entries that match this query.
     *
     * @param aCallback
     */
    hasMatches: function Query_hasMatches(aCallback) {
        let sql = 'SELECT EXISTS (SELECT entries.id ' + this._getQueryString(true) + ') AS found';

        new Statement(sql).executeAsync({
            handleResult: function(aResults) aCallback(aResults.next().found),
            handleError: this._onDatabaseError
        })
    },

    /**
     * Get a simple list of entries.
     *
     * @param aCallback
     *        Receives an array if IDs.
     */
    getEntries: function Query_getEntries(aCallback) {
        let entries = [];
        let sql = 'SELECT entries.id ' + this._getQueryString(true);

        new Statement(sql).executeAsync({
            handleResult: function(aResults) {
                // XXX Check performance.
                for (let row in aResults)
                    entries.push(row.id);
            },

            handleCompletion: function(aReason) {
                aCallback(entries);
            },

            handleError: this._onDatabaseError
        })
    },


    /**
     * Get entries with all their properties.
     *
     * @param aCallback
     *        Receives an array of Entry objects.
     */
    getFullEntries: function Query_getFullEntries(aCallback) {
        let sql = 'SELECT entries.id, entries.feedID, entries.entryURL, entries.date,   '+
                  '       entries.read, entries.starred, entries.updated,               '+
                  '       entries.bookmarkID, entries_text.title, entries_text.content, '+
                  '       entries_text.authors, entries_text.tags                       ';
        sql += this._getQueryString(true, true);

        let entries = [];

        new Statement(sql).executeAsync({
            handleResult: function(aResults) {
                for (let row in aResults) {
                    let entry = new Entry();

                    for (let column in row)
                        entry[column] = row[column]

                    entries.push(entry);
                }
            },

            handleCompletion: function(aReason) {
                aCallback(entries);
            },

            handleError: this._onDatabaseError
        })
    },


    /**
     * Get values of a single property of each of the entries.
     *
     * @param aPropertyName
     *        Name of the property.
     * @param aDistinct
     *        Don't include multiple entries with the same value.
     * @param aCallback
     *        Receives an array of values of the requested property.
     */
    getProperty: function Query_getProperty(aPropertyName, aDistinct, aCallback) {
        switch (aPropertyName) {
            case 'content':
            case 'title':
            case 'authors':
            case 'tags':
                var table = 'entries_text.';
                var getEntriesText = true;
                break;
            default:
                table = 'entries.';
        }

        let sql = 'SELECT entries.id, ' + table + aPropertyName +
                   this._getQueryString(true, getEntriesText);

        let values = [];

        new Statement(sql).executeAsync({

            handleResult: function(aResults) {
                for (let row in aResults) {
                    let value = row[aPropertyName];
                    if (aDistinct && values.indexOf(value) != -1)
                        continue;

                    values.push(value);
                }
            },

            handleCompletion: function(aReason) {
                aCallback(values);
            },

            handleError: this._onDatabaseError
        })
    },


    /**
     * Get the number of selected entries.
     *
     * @param aCallback
     */
    getEntryCount: function Query_getEntryCount(aCallback) {
        // Optimization: don't sort.
        let tempOrder = this.sortOrder;
        this.sortOrder = undefined;

        let sql = 'SELECT COUNT(1) AS count ' + this._getQueryString(true);

        new Statement(sql).executeAsync({
            handleResult: function(aResults) aCallback(aResults.next().count),
            handleError: this._onDatabaseError
        })

        this.sortOrder = tempOrder;
    },


    /**
     * Get an EntryList of entries.
     */
    getEntryList: function Query_getEntryList(aCallback) {
        let entryIDs = [];
        let feedIDs = [];
        let tags = [];

        let tempHidden = this.includeHiddenFeeds;
        this.includeHiddenFeeds = false;
        let sql = 'SELECT entries.id, entries.feedID, entries_text.tags '
                   + this._getQueryString(true, true);
        this.includeHiddenFeeds = tempHidden;

        new Statement(sql).executeAsync({
            handleResult: function(aResults) {
                for (let row in aResults) {
                    entryIDs.push(row.id);

                    if (feedIDs.indexOf(row.feedID) == -1)
                        feedIDs.push(row.feedID);

                    if (row.tags) {
                        let arr = row.tags.split(', ');
                        let newTags = arr.filter(function(t) tags.indexOf(t) === -1);
                        tags = tags.concat(newTags);
                    }
                }
            },

            handleCompletion: function(aReason) {
                let list = new EntryList();
                list.IDs = entryIDs;
                list.feedIDs = feedIDs;
                list.tags = tags;

                aCallback(list);
            }
        })
    },


    /**
     * Mark entries as read/unread.
     *
     * @param aState
     *        New state of entries (TRUE for read, FALSE for unread).
     */
    markEntriesRead: function Query_markEntriesRead(aState) {
        // Try not to include entries which already have the desired state,
        // but we can't omit them if a specific range of the selected entries
        // is meant to be marked.
        let tempRead = this.read;
        if (!this.limit && !this.offset)
            this.read = !aState;

        let sql = 'UPDATE entries SET read = :read, updated = 0 ' + this._getQueryString();
        let update = new Statement(sql);
        update.params.read = aState ? 1 : 0;

        this.getEntryList(function(aList) {
            this.read = tempRead;

            if (!aList.length)
                return;

            update.executeAsync(function() {
                for (let observer in StorageInternal.observers)
                    observer.onEntriesMarkedRead(aList, aState);
            })
        })
    },

    /**
     * Set the deleted state of the selected entries or remove them from the database.
     *
     * @param aState
     *        The new deleted state (as defined by constants in Storage)
     *        or instruction to physically remove the entries from the
     *        database (REMOVE_FROM_DATABASE constant below).
     *
     * @throws NS_ERROR_INVALID_ARG on invalid |aState| parameter.
     */
    REMOVE_FROM_DATABASE: 4,

    deleteEntries: function Query_deleteEntries(aState, aCallback) {
        switch (aState) {
            case Storage.ENTRY_STATE_NORMAL:
            case Storage.ENTRY_STATE_TRASHED:
            case Storage.ENTRY_STATE_DELETED:
                var sql = 'UPDATE entries SET deleted = ' + aState + this._getQueryString();
                break;
            case this.REMOVE_FROM_DATABASE:
                var sql = 'DELETE FROM entries ' + this._getQueryString();
                break;
            default:
                throw Components.results.NS_ERROR_INVALID_ARG;
        }

        this.getEntryList(function(aList) {
            if (!aList.length) {
                if (aCallback)
                    aCallback(aList);
                return;
            }

            new Statement(sql).executeAsync(function() {
                for (let observer in StorageInternal.observers)
                    observer.onEntriesDeleted(aList, aState);

                if (aCallback)
                    aCallback(aList);
            })
        })
    },


    /**
     * Bookmark/unbookmark URLs of the selected entries.
     *
     * @param state
     *        New state of entries. TRUE to bookmark, FALSE to unbookmark.
     *
     * This function bookmarks URIs of the selected entries. It doesn't star the entries
     * in the database or send notifications - that part is performed by the bookmark
     * observer.
     */
    bookmarkEntries: function Query_bookmarkEntries(aState) {
        let transactions = [];

        this.getFullEntries(function(entries) {
            for (let entry in entries) {
                let uri = Utils.newURI(entry.entryURL);
                if (!uri)
                    return;

                if (aState) {
                    let container = Places.unfiledBookmarksFolderId;
                    let trans = new PlacesCreateBookmarkTransaction(uri, container,
                                                                    -1, entry.title);
                    transactions.push(trans);
                }
                else {
                    let bookmarks = Bookmarks.getBookmarkIdsForURI(uri, {})
                                             .filter(Utils.isNormalBookmark);
                    if (bookmarks.length) {
                        for (let i = bookmarks.length - 1; i >= 0; i--)
                            transactions.push(new PlacesRemoveItemTransaction(bookmarks[i]));
                    }
                    else {
                        // If there are no bookmarks for an URL that is starred in our
                        // database, it means that the database is out of sync and we
                        // must update the database directly.
                        StorageInternal.starEntry(false, entry.id, bookmarks[0]);
                    }
                }
            }

            let aggregatedTrans = new PlacesAggregatedTransaction('', transactions);
            Places.transactionManager.doTransaction(aggregatedTrans);
        })
    },

    /**
     * Verifies entries' starred statuses and their tags.
     *
     * Normally, the starred status is automatically kept in sync with user's bookmarks,
     * but there's always a possibility that it goes out of sync, for example if
     * Brief is disabled or uninstalled. If an entry is starred but no bookmarks are
     * found for its URI, then a new bookmark is added. If an entry isn't starred,
     * but there is a bookmark for its URI, this function stars the entry.
     * Tags are verified in the same manner.
     */
    verifyBookmarksAndTags: function Query_verifyBookmarksAndTags() {
        this.getFullEntries(function(entries) {
            for (let entry in entries) {
                let uri = Utils.newURI(entry.entryURL);
                if (!uri)
                    return;

                let allBookmarks = Bookmarks.getBookmarkIdsForURI(uri, {});

                // Verify bookmarks.
                let normalBookmarks = allBookmarks.filter(Utils.isNormalBookmark);
                if (entry.starred && !normalBookmarks.length)
                    new Query(entry.id).bookmarkEntries(true);

                else if (!entry.starred && normalBookmarks.length)
                    StorageInternal.starEntry(true, entry.id, normalBookmarks[0]);

                // Verify tags.
                let storedTags = Utils.getTagsForEntry(entry.id);
                let currentTags = allBookmarks.map(function(id) Bookmarks.getFolderIdForItem(id))
                                              .filter(Utils.isTagFolder)
                                              .map(function(id) Bookmarks.getItemTitle(id));

                for (let tag in storedTags) {
                    if (currentTags.indexOf(tag) === -1)
                        Places.tagging.tagURI(uri, [tag]);
                }

                for (let tag in currentTags) {
                    if (storedTags.indexOf(tag) === -1)
                        StorageInternal.tagEntry(true, entry.id, tag);
                }
            }
        })
    },


    /**
     * Actual list of folders selected by the query, including subfolders
     * of folders specified by Query.folders.
     */
    _effectiveFolders: null,


    _onDatabaseError: function BriefQuery__onDatabaseError(aError) {
        // Ignore "SQL logic error or missing database" error which full-text search
        // throws when the query doesn't contain at least one non-excluded term.
        if (aError.result != 1) {
            Connection.reportDatabaseError('', aError);
            throw 'Database error';
        }
    },

    /**
     * Constructs SQL query constraints query's properties.
     *
     * @param aForSelect      Build a string optimized for a SELECT statement.
     * @param aGetFullEntries Forces including entries_text table (otherwise, it is
     *                        included only when it is used by the query constraints).
     * @returns String containing the part of an SQL statement after WHERE clause.
     */
    _getQueryString: function Query__getQueryString(aForSelect, aGetFullEntries) {
        let text = aForSelect ? ' FROM entries '
                              : ' WHERE entries.id IN (SELECT entries.id FROM entries ';

        if (!this.feeds && !this.includeHiddenFeeds)
            text += ' INNER JOIN feeds ON entries.feedID = feeds.feedID ';

        if (aGetFullEntries || this.searchString || this.sortOrder == this.SORT_BY_TITLE)
            text += ' INNER JOIN entries_text ON entries.id = entries_text.rowid ';

        if (this.tags)
            text += ' INNER JOIN entry_tags ON entries.id = entry_tags.entryID ';

        let constraints = [];

        if (this.folders) {
            if (!this.folders.length)
                throw Components.results.NS_ERROR_INVALID_ARG;

            /**
             * Compute the actual list of folders to be selected, including subfolders
             * of folders specified by Query.folders.
             */
            this._effectiveFolders = this.folders;
            this._traverseFolderChildren(StorageInternal.homeFolderID);

            let con = '(feeds.parent = "';
            con += this._effectiveFolders.join('" OR feeds.parent = "');
            con += '")';
            constraints.push(con);
        }

        if (this.feeds) {
            if (!this.feeds.length)
                throw Components.results.NS_ERROR_INVALID_ARG;

            let con = '(entries.feedID = "';
            con += this.feeds.join('" OR entries.feedID = "');
            con += '")';
            constraints.push(con);
        }

        if (this.entries) {
            if (!this.entries.length)
                throw Components.results.NS_ERROR_INVALID_ARG;

            let con = '(entries.id = ';
            con += this.entries.join(' OR entries.id = ');
            con += ')';
            constraints.push(con);
        }

        if (this.tags) {
            if (!this.tags.length)
                throw Components.results.NS_ERROR_INVALID_ARG;

            let con = '(entry_tags.tagName = "';
            con += this.tags.join('" OR entry_tags.tagName = "');
            con += '")';
            constraints.push(con);
        }

        if (this.searchString) {
            let con = 'entries_text MATCH \'' + this.searchString.replace("'",' ') + '\'';
            constraints.push(con);
        }

        if (this.read === true)
            constraints.push('entries.read = 1');
        else if (this.read === false)
            constraints.push('entries.read = 0');

        if (this.starred === true)
            constraints.push('entries.starred = 1');
        else if (this.starred === false)
            constraints.push('entries.starred = 0');

        if (this.deleted !== undefined)
            constraints.push('entries.deleted = ' + this.deleted);

        if (this.startDate !== undefined)
            constraints.push('entries.date >= ' + this.startDate);
        if (this.endDate !== undefined)
            constraints.push('entries.date <= ' + this.endDate);

        if (!this.includeHiddenFeeds && !this.feeds)
            constraints.push('feeds.hidden = 0');

        if (constraints.length)
            text += ' WHERE ' + constraints.join(' AND ') + ' ';

        if (this.sortOrder !== undefined) {
            switch (this.sortOrder) {
                case this.SORT_BY_FEED_ROW_INDEX:
                    var sortOrder = 'feeds.rowIndex ';
                    break;
                case this.SORT_BY_DATE:
                    sortOrder = 'entries.date ';
                    break;
                case this.SORT_BY_TITLE:
                    sortOrder = 'entries_text.title ';
                    break;
                default:
                    throw Components.results.NS_ERROR_ILLEGAL_VALUE;
            }

            let sortDir = (this.sortDirection == this.SORT_ASCENDING) ? 'ASC' : 'DESC';
            text += 'ORDER BY ' + sortOrder + sortDir;

            // Sort by rowid, so that entries that are equal in respect of primary
            // sorting criteria are always returned in the same (as opposed to
            // undefined) order.
            text += ', entries.rowid ' + sortDir;
        }

        if (this.limit !== undefined)
            text += ' LIMIT ' + this.limit;
        if (this.offset > 0) {
            if (this.limit === undefined)
                text += ' LIMIT -1 '
            text += ' OFFSET ' + this.offset;
        }

        if (!aForSelect)
            text += ') ';

        return text;
    },

    _traverseFolderChildren: function Query__traverseFolderChildren(aFolder) {
        let isEffectiveFolder = (this._effectiveFolders.indexOf(aFolder) != -1);

        for (let item in StorageInternal.getAllFeeds(true)) {
            if (item.parent == aFolder && item.isFolder) {
                if (isEffectiveFolder)
                    this._effectiveFolders.push(item.feedID);
                this._traverseFolderChildren(item.feedID);
            }
        }
    }

}


let BookmarkObserver = {

    livemarksSyncPending: false,
    batching: false,
    homeFolderContentModified: false,

    // nsINavBookmarkObserver
    onEndUpdateBatch: function BookmarkObserver_onEndUpdateBatch() {
        this.batching = false;
        if (this.homeFolderContentModified)
            this.delayedLivemarksSync();
        this.homeFolderContentModified = false;
    },

    // nsINavBookmarkObserver
    onBeginUpdateBatch: function BookmarkObserver_onBeginUpdateBatch() {
        this.batching = true;
    },

    // nsINavBookmarkObserver
    onItemAdded: function BookmarkObserver_onItemAdded(aItemID, aFolder, aIndex, aItemType) {
        if (aItemType == Bookmarks.TYPE_FOLDER && Utils.isInHomeFolder(aFolder)) {
            this.delayedLivemarksSync();
            return;
        }

        // Only care about plain bookmarks and tags.
        if (Utils.isLivemark(aFolder) || aItemType != Bookmarks.TYPE_BOOKMARK)
            return;

        // Find entries with the same URI as the added item and tag or star them.
        let url = Bookmarks.getBookmarkURI(aItemID).spec;
        let isTag = Utils.isTagFolder(aFolder);

        Utils.getEntriesByURL(url, function(aEntries) {
            for (let entry in aEntries) {
                if (isTag) {
                    let tagName = Bookmarks.getItemTitle(aFolder);
                    StorageInternal.tagEntry(true, entry, tagName, aItemID);
                }
                else {
                    StorageInternal.starEntry(true, entry, aItemID);
                }
            }
        })
    },


    // nsINavBookmarkObserver
    onBeforeItemRemoved: function BookmarkObserver_onBeforeItemRemoved(aItemID, aItemType) {},

    // nsINavBookmarkObserver
    onItemRemoved: function BookmarkObserver_onItemRemoved(aItemID, aFolder, aIndex, aItemType) {
        if (Utils.isLivemarkStored(aItemID) || aItemID == StorageInternal.homeFolderID) {
            this.delayedLivemarksSync();
            return;
        }

        // Only care about plain bookmarks and tags.
        if (Utils.isLivemark(aFolder) || aItemType != Bookmarks.TYPE_BOOKMARK)
            return;

        let isTag = Utils.isTagFolder(aFolder);

        if (isTag) {
            let tagName = Bookmarks.getItemTitle(aFolder);

            Utils.getEntriesByTagName(tagName, function(aEntries) {
                for (let entry in aEntries)
                    StorageInternal.tagEntry(false, entry, tagName);
            })
        }
        else {
            Utils.getEntriesByBookmarkID(aItemID, function(aEntries) {

                // Look for other bookmarks for this URI. If there is another
                // bookmark for this URI, don't unstar the entry, but update
                // its bookmarkID to point to that bookmark.
                if (aEntries.length) {
                    let uri = Utils.newURI(aEntries[0].url);
                    var bookmarks = Bookmarks.getBookmarkIdsForURI(uri, {}).
                                              filter(Utils.isNormalBookmark);
                }

                for (let entry in aEntries) {
                    if (bookmarks.length)
                        StorageInternal.starEntry(true, entry.id, bookmarks[0], true);
                    else
                        StorageInternal.starEntry(false, entry.id);
                }
            })
        }
    },

    // nsINavBookmarkObserver
    onItemMoved: function BookmarkObserver_onItemMoved(aItemID, aOldParent, aOldIndex,
                                                   aNewParent, aNewIndex, aItemType) {
        let wasInHome = Utils.isLivemarkStored(aItemID);
        let isInHome = aItemType == Bookmarks.TYPE_FOLDER && Utils.isInHomeFolder(aNewParent);
        if (wasInHome || isInHome)
            this.delayedLivemarksSync();
    },

    // nsINavBookmarkObserver
    onItemChanged: function BookmarkObserver_onItemChanged(aItemID, aProperty,
                                                           aIsAnnotationProperty, aNewValue,
                                                           aLastModified, aItemType) {
        switch (aProperty) {
        case 'title':
            let feed = Utils.getFeedByBookmarkID(aItemID);
            if (feed) {
                Stm.setFeedTitle.execute({ 'title': aNewValue, 'feedID': feed.feedID });
                feed.title = aNewValue; // Update the cache.

                Services.obs.notifyObservers(null, 'brief:feed-title-changed', feed.feedID);
            }
            else if (Utils.isTagFolder(aItemID)) {
                this.renameTag(aItemID, aNewValue);
            }
            break;

        case 'livemark/feedURI':
            if (Utils.isLivemarkStored(aItemID))
                this.delayedLivemarksSync();
            break;

        case 'uri':
            // Unstar any entries with the old URI.
            Utils.getEntriesByBookmarkID(aItemID, function(aEntries) {
                for (let entry in aEntries)
                    StorageInternal.starEntry(false, entry.id);
            })

            // Star any entries with the new URI.
            Utils.getEntriesByURL(aNewValue, function(aEntries) {
                for (let entry in aEntries)
                    StorageInternal.starEntry(true, entry, aItemID);
            })

            break;
        }
    },

    // nsINavBookmarkObserver
    onItemVisited: function BookmarkObserver_aOnItemVisited(aItemID, aVisitID, aTime) { },

    get syncDelayTimer() {
        if (!this.__syncDelayTimer)
            this.__syncDelayTimer = Cc['@mozilla.org/timer;1'].createInstance(Ci.nsITimer);
        return this.__syncDelayTimer;
    },

    delayedLivemarksSync: function BookmarkObserver_delayedLivemarksSync() {
        if (this.batching) {
            this.homeFolderContentModified = true;
        }
        else {
            if (this.livemarksSyncPending)
                this.syncDelayTimer.cancel();

            this.syncDelayTimer.init(this, LIVEMARKS_SYNC_DELAY, Ci.nsITimer.TYPE_ONE_SHOT);
            this.livemarksSyncPending = true;
        }
    },

    /**
     * Syncs tags when a tag folder is renamed by removing tags with the old name
     * and re-tagging the entries using the new one.
     *
     * @param aTagFolderID
     *        itemId of the tag folder that was renamed.
     * @param aNewName
     *        New name of the tag folder, i.e. new name of the tag.
     */
    renameTag: function BookmarkObserver_renameTag(aTagFolderID, aNewName) {
        // Get bookmarks in the renamed tag folder.
        let options = Places.history.getNewQueryOptions();
        let query = Places.history.getNewQuery();
        query.setFolders([aTagFolderID], 1);
        let result = Places.history.executeQuery(query, options);
        result.root.containerOpen = true;

        for (let i = 0; i < result.root.childCount; i++) {
            let tagID = result.root.getChild(i).itemId;
            let uri = Bookmarks.getBookmarkURI(tagID);

            Utils.getEntriesByURL(uri.spec, function(aEntries) {
                for (let entryID in aEntries) {
                    StorageInternal.tagEntry(true, entryID, aNewName);

                    let storedTags = Utils.getTagsForEntry(entryID);
                    let currentTags = Bookmarks.getBookmarkIdsForURI(uri, {})
                                               .map(function(id) Bookmarks.getFolderIdForItem(id))
                                               .filter(Utils.isTagFolder)
                                               .map(function(id) Bookmarks.getItemTitle(id));

                    for (let tag in storedTags) {
                        if (currentTags.indexOf(tag) === -1)
                            StorageInternal.tagEntry(false, entryID, tag);
                    }
                }
            })
        }

        result.root.containerOpen = false;
    },

    observe: function BookmarkObserver_observe(aSubject, aTopic, aData) {
        if (aTopic == 'timer-callback') {
            this.livemarksSyncPending = false;
            StorageInternal.syncWithLivemarks();
        }
    },

    QueryInterface: XPCOMUtils.generateQI([Ci.nsINavBookmarkObserver, Ci.nsIObserver])

}


/**
 * Synchronizes the list of feeds stored in the database with
 * the livemarks available in the Brief's home folder.
 */
function LivemarksSync() {
    if (!this.checkHomeFolder())
        return;

    let homeFolder = Prefs.getIntPref('homeFolder');
    let livemarks = [];
    let newLivemarks = [];

    // Get a list of folders and Live Bookmarks in the user's home folder.
    let options = Places.history.getNewQueryOptions();
    let query = Places.history.getNewQuery();
    query.setFolders([homeFolder], 1);
    options.excludeItems = true;
    let result = Places.history.executeQuery(query, options);
    this.traversePlacesQueryResults(result.root, livemarks);

    Connection.runTransaction(function() {
        // Get a list all feeds stored in the database.
        let sql = 'SELECT feedID, title, rowIndex, isFolder, parent, bookmarkID, hidden FROM feeds';

        let storedFeeds = [row for each (row in new Statement(sql).results)];

        for (let livemark in livemarks) {
            let feed = null;
            for (let storedFeed in storedFeeds) {
                if (storedFeed.feedID == livemark.feedID) {
                    feed = storedFeed;
                    break;
                }
            }

            if (feed) {
                feed.bookmarked = true;
                this.updateFeedFromLivemark(livemark, feed);
            }
            else {
                this.insertFeed(livemark);
                newLivemarks.push(livemark);
            }
        }

        storedFeeds.filter(function(feed) !feed.bookmarked && feed.hidden == 0)
                   .forEach(this.hideFeed, this);
    }, this)

    if (this.feedListChanged)
        StorageInternal.refreshFeedsCache(true);

    // Update the newly added feeds.
    if (newLivemarks.length) {
        let feeds = newLivemarks.filter(function(l) !l.isFolder)
                                .map(function(l) StorageInternal.getFeed(l.feedID));
        FeedUpdateService.updateFeeds(feeds);
    }
}

LivemarksSync.prototype = {

    feedListChanged: false,

    checkHomeFolder: function BookmarksSync_checkHomeFolder() {
        let folderValid = true;
        let homeFolder = Prefs.getIntPref('homeFolder');

        if (homeFolder == -1) {
            let hideAllFeeds = new Statement('UPDATE feeds SET hidden = :hidden');
            hideAllFeeds.execute({ 'hidden': Date.now() });

            StorageInternal.refreshFeedsCache(true);
            folderValid = false;
        }
        else {
            try {
                // This will throw if the home folder was deleted.
                Bookmarks.getItemTitle(homeFolder);
            }
            catch (e) {
                Prefs.clearUserPref('homeFolder');
                folderValid = false;
            }
        }

        return folderValid;
    },


    insertFeed: function BookmarksSync_insertFeed(aBookmark) {
        let sql = 'INSERT OR IGNORE INTO feeds                                                   ' +
                  '(feedID, feedURL, title, rowIndex, isFolder, parent, bookmarkID)              ' +
                  'VALUES (:feedID, :feedURL, :title, :rowIndex, :isFolder, :parent, :bookmarkID)';

        new Statement(sql).execute({
            'feedID': aBookmark.feedID,
            'feedURL': aBookmark.feedURL || null,
            'title': aBookmark.title,
            'rowIndex': aBookmark.rowIndex,
            'isFolder': aBookmark.isFolder ? 1 : 0,
            'parent': aBookmark.parent,
            'bookmarkID': aBookmark.bookmarkID
        })

        this.feedListChanged = true;
    },


    updateFeedFromLivemark: function BookmarksSync_updateFeedFromLivemark(aItem, aFeed) {
        let properties = ['rowIndex', 'parent', 'title', 'bookmarkID'];
        if (!aFeed.hidden && properties.every(function(p) aFeed[p] == aItem[p]))
            return;

        let sql = 'UPDATE feeds SET title = :title, rowIndex = :rowIndex, parent = :parent, ' +
                  '                 bookmarkID = :bookmarkID, hidden = 0                    ' +
                  'WHERE feedID = :feedID                                                   ';

        new Statement(sql).execute({
            'title': aItem.title,
            'rowIndex': aItem.rowIndex,
            'parent': aItem.parent,
            'bookmarkID': aItem.bookmarkID,
            'feedID': aItem.feedID
        })

        if (aItem.rowIndex != aFeed.rowIndex || aItem.parent != aFeed.parent || aFeed.hidden > 0) {
            this.feedListChanged = true;
        }
        else {
            let cachedFeed = StorageInternal.getFeed(aFeed.feedID);
            cachedFeed.title = aItem.title; // Update cache.
            Services.obs.notifyObservers(null, 'brief:feed-title-changed', aItem.feedID);
        }
    },


    hideFeed: function BookmarksSync_hideFeed(aFeed) {
        if (aFeed.isFolder) {
            let hideFolder = new Statement('DELETE FROM feeds WHERE feedID = :feedID');
            hideFolder.execute({ 'feedID': aFeed.feedID });
        }
        else {
            let hideFeed = new Statement('UPDATE feeds SET hidden = :hidden WHERE feedID = :feedID');
            hideFeed.execute({ 'hidden': Date.now(), 'feedID': aFeed.feedID });
        }

        this.feedListChanged = true;
    },


    traversePlacesQueryResults: function BookmarksSync_traversePlacesQueryResults(aContainer, aLivemarks) {
        aContainer.containerOpen = true;

        for (let i = 0; i < aContainer.childCount; i++) {
            let node = aContainer.getChild(i);

            if (node.type != Ci.nsINavHistoryResultNode.RESULT_TYPE_FOLDER)
                continue;

            let item = {};
            item.title = Bookmarks.getItemTitle(node.itemId);
            item.bookmarkID = node.itemId;
            item.rowIndex = aLivemarks.length;
            item.parent = aContainer.itemId.toFixed().toString();

            if (Utils.isLivemark(node.itemId)) {
                let feedURL = Places.livemarks.getFeedURI(node.itemId).spec;
                item.feedURL = feedURL;
                item.feedID = Utils.hashString(feedURL);
                item.isFolder = false;

                aLivemarks.push(item);
            }
            else {
                item.feedURL = '';
                item.feedID = node.itemId.toFixed().toString();
                item.isFolder = true;

                aLivemarks.push(item);

                if (node instanceof Ci.nsINavHistoryContainerResultNode)
                    this.traversePlacesQueryResults(node, aLivemarks);
            }
        }

        aContainer.containerOpen = false;
    }

}


// Cached statements.
let Stm = {

    get getAllFeeds() {
        let sql = 'SELECT feedID, feedURL, websiteURL, title, subtitle, dateModified,   ' +
                  '       favicon, lastUpdated, oldestEntryDate, rowIndex, parent,      ' +
                  '       isFolder, bookmarkID, entryAgeLimit, maxEntries,              ' +
                  '       updateInterval, markModifiedEntriesUnread, lastFaviconRefresh ' +
                  'FROM feeds                                                           ' +
                  'WHERE hidden = 0                                                     ' +
                  'ORDER BY rowIndex ASC                                                ';
        delete this.getAllFeeds;
        return this.getAllFeeds = new Statement(sql);
    },

    get getAllTags() {
        let sql = 'SELECT DISTINCT entry_tags.tagName                                    '+
                  'FROM entry_tags INNER JOIN entries ON entry_tags.entryID = entries.id '+
                  'WHERE entries.deleted = :deletedState                                 '+
                  'ORDER BY entry_tags.tagName                                           ';
        delete this.getAllTags;
        return this.getAllTags = new Statement(sql, { 'deletedState': Storage.ENTRY_STATE_NORMAL });
    },

    get updateFeed() {
        let sql = 'UPDATE feeds                                  ' +
                  'SET websiteURL = :websiteURL,                 ' +
                  '    subtitle = :subtitle,                     ' +
                  '    imageURL = :imageURL,                     ' +
                  '    imageLink = :imageLink,                   ' +
                  '    imageTitle = :imageTitle,                 ' +
                  '    favicon = :favicon,                       ' +
                  '    lastUpdated = :lastUpdated,               ' +
                  '    dateModified = :dateModified,             ' +
                  '    oldestEntryDate = :oldestEntryDate,       ' +
                  '    lastFaviconRefresh = :lastFaviconRefresh  ' +
                  'WHERE feedID = :feedID                        ';
        delete this.updateFeed;
        return this.updateFeed = new Statement(sql);
    },

    get setFeedTitle() {
        let sql = 'UPDATE feeds SET title = :title WHERE feedID = :feedID';
        delete this.setFeedTitle;
        return this.setFeedTitle = new Statement(sql);
    },

    get setFeedOptions() {
        let sql = 'UPDATE feeds                                ' +
                  'SET entryAgeLimit  = :entryAgeLimit,        ' +
                  '    maxEntries     = :maxEntries,           ' +
                  '    updateInterval = :updateInterval,       ' +
                  '    markModifiedEntriesUnread = :markUnread ' +
                  'WHERE feedID = :feedID                      ';
        delete this.setFeedOptions;
        return this.setFeedOptions = new Statement(sql);
    },

    get insertEntry() {
        let sql = 'INSERT INTO entries (feedID, primaryHash, secondaryHash, providedID, entryURL, date) ' +
                  'VALUES (:feedID, :primaryHash, :secondaryHash, :providedID, :entryURL, :date)        ';
        delete this.insertEntry;
        return this.insertEntry = new Statement(sql);
    },

    get insertEntryText() {
        let sql = 'INSERT INTO entries_text (title, content, authors) ' +
                  'VALUES(:title, :content, :authors)   ';
        delete this.insertEntryText;
        return this.insertEntryText = new Statement(sql);
    },

    get updateEntry() {
        let sql = 'UPDATE entries SET date = :date, read = :read, updated = 1 '+
                  'WHERE id = :id                                             ';
        delete this.updateEntry;
        return this.updateEntry = new Statement(sql);
    },

    get updateEntryText() {
        let sql = 'UPDATE entries_text SET title = :title, content = :content, '+
                  'authors = :authors WHERE rowid = :id                        ';
        delete this.updateEntryText;
        return this.updateEntryText = new Statement(sql);
    },

    get getLastRowids() {
        let sql = 'SELECT rowid FROM entries ORDER BY rowid DESC LIMIT :count';
        delete this.getLastRowids;
        return this.getLastRowids = new Statement(sql);
    },

    get purgeDeletedEntriesText() {
        let sql = 'DELETE FROM entries_text                                                 '+
                  'WHERE rowid IN (                                                         '+
                  '   SELECT entries.id                                                     '+
                  '   FROM entries INNER JOIN feeds ON entries.feedID = feeds.feedID        '+
                  '   WHERE (entries.deleted = :deletedState AND feeds.oldestEntryDate > entries.date) '+
                  '         OR (:currentDate - feeds.hidden > :retentionTime AND feeds.hidden != 0)    '+
                  ')                                                                                   ';
        delete this.purgeDeletedEntriesText;
        return this.purgeDeletedEntriesText = new Statement(sql);
    },

    get purgeDeletedEntries() {
        let sql = 'DELETE FROM entries                                                      '+
                  'WHERE id IN (                                                            '+
                  '   SELECT entries.id                                                     '+
                  '   FROM entries INNER JOIN feeds ON entries.feedID = feeds.feedID        '+
                  '   WHERE (entries.deleted = :deletedState AND feeds.oldestEntryDate > entries.date) '+
                  '         OR (:currentDate - feeds.hidden > :retentionTime AND feeds.hidden != 0)    '+
                  ')                                                                                   ';
        delete this.purgeDeletedEntries;
        return this.purgeDeletedEntries = new Statement(sql);
    },

    get purgeDeletedFeeds() {
        let sql = 'DELETE FROM feeds                                      '+
                  'WHERE :currentDate - feeds.hidden > :retentionTime AND '+
                  '      feeds.hidden != 0                                ';
        delete this.purgeDeletedFeeds;
        return this.purgeDeletedFeeds = new Statement(sql);
    },

    get getDeletedEntriesCount() {
        let sql = 'SELECT COUNT(1) AS entryCount FROM entries  ' +
                  'WHERE feedID = :feedID AND                  ' +
                  '      starred = 0 AND                       ' +
                  '      deleted = :deletedState               ';
        delete this.getDeletedEntriesCount;
        return this.getDeletedEntriesCount = new Statement(sql);
    },

    get getEntryByPrimaryHash() {
        let sql = 'SELECT id, date, read FROM entries WHERE primaryHash = :primaryHash';
        delete this.getEntryByPrimaryHash;
        return this.getEntryByPrimaryHash = new Statement(sql);
    },

    get getEntryBySecondaryHash() {
        let sql = 'SELECT id, date, read FROM entries WHERE secondaryHash = :secondaryHash';
        delete this.getEntryBySecondaryHash;
        return this.getEntryBySecondaryHash = new Statement(sql);
    },

    get selectEntriesByURL() {
        let sql = 'SELECT id FROM entries WHERE entryURL = :url';
        delete this.selectEntriesByURL;
        return this.selectEntriesByURL = new Statement(sql);
    },

    get selectEntriesByBookmarkID() {
        let sql = 'SELECT id, entryURL FROM entries WHERE bookmarkID = :bookmarkID';
        delete this.selectEntriesByBookmarkID;
        return this.selectEntriesByBookmarkID = new Statement(sql);
    },

    get selectEntriesByTagName() {
        let sql = 'SELECT id, entryURL FROM entries WHERE id IN (          '+
                  '    SELECT entryID FROM entry_tags WHERE tagName = :tagName '+
                  ')                                                       ';
        delete this.selectEntriesByTagName;
        return this.selectEntriesByTagName = new Statement(sql);
    },

    get starEntry() {
        let sql = 'UPDATE entries SET starred = 1, bookmarkID = :bookmarkID WHERE id = :entryID';
        delete this.starEntry;
        return this.starEntry = new Statement(sql);
    },

    get unstarEntry() {
        let sql = 'UPDATE entries SET starred = 0, bookmarkID = -1 WHERE id = :id';
        delete this.unstarEntry;
        return this.unstarEntry = new Statement(sql);
    },

    get checkTag() {
        let sql = 'SELECT EXISTS (                  '+
                  '    SELECT tagName               '+
                  '    FROM entry_tags              '+
                  '    WHERE tagName = :tagName AND '+
                  '          entryID = :entryID     '+
                  ') AS alreadyTagged               ';
        delete this.checkTag;
        return this.checkTag = new Statement(sql);
    },

    get tagEntry() {
        let sql = 'INSERT INTO entry_tags (entryID, tagName) '+
                  'VALUES (:entryID, :tagName)               ';
        delete this.tagEntry;
        return this.tagEntry = new Statement(sql);
    },

    get untagEntry() {
        let sql = 'DELETE FROM entry_tags WHERE entryID = :entryID AND tagName = :tagName';
        delete this.untagEntry;
        return this.untagEntry = new Statement(sql);
    },

    get getTagsForEntry() {
        let sql = 'SELECT tagName FROM entry_tags WHERE entryID = :entryID';
        delete this.getTagsForEntry;
        return this.getTagsForEntry = new Statement(sql);
    },

    get setSerializedTagList() {
        let sql = 'UPDATE entries_text SET tags = :tags WHERE rowid = :entryID';
        delete this.setSerializedTagList;
        return this.setSerializedTagList = new Statement(sql);
    }

}


let Utils = {

    getTagsForEntry: function getTagsForEntry(aEntryID) {
        Stm.getTagsForEntry.params = { 'entryID': aEntryID };
        return [row.tagName for each (row in Stm.getTagsForEntry.results)];
    },

    getFeedByBookmarkID: function getFeedByBookmarkID(aBookmarkID) {
        let foundFeed = null;
        for (let feed in StorageInternal.getAllFeeds(true)) {
            if (feed.bookmarkID == aBookmarkID) {
                foundFeed = feed;
                break;
            }
        }
        return foundFeed;
    },

    isLivemarkStored: function isLivemarkStored(aItemID) {
        return !!Utils.getFeedByBookmarkID(aItemID);
    },

    getEntriesByURL: function getEntriesByURL(aURL, aCallback) {
        let entries = [];

        Stm.selectEntriesByURL.params.url = aURL;
        Stm.selectEntriesByURL.executeAsync({
            handleResult: function(aResults) {
                for (let row in aResults)
                    entries.push(row.id);
            },

            handleCompletion: function(aReason) {
                aCallback(entries);
            }
        })
    },

    getEntriesByBookmarkID: function getEntriesByBookmarkID(aBookmarkID, aCallback) {
        let entries = [];

        Stm.selectEntriesByBookmarkID.params.bookmarkID = aBookmarkID;
        Stm.selectEntriesByBookmarkID.executeAsync({
            handleResult: function(aResults) {
                for (let row in aResults) {
                    entries.push({
                        id: row.id,
                        url: row.entryURL
                    })
                }
            },

            handleCompletion: function(aReason) {
                aCallback(entries);
            }
        })
    },

    getEntriesByTagName: function getEntriesByTagName(aTagName, aCallback) {
        let entries = [];

        Stm.selectEntriesByTagName.params.tagName = aTagName;
        Stm.selectEntriesByTagName.executeAsync({
            handleResult: function(aResults) {
                for (let row in aResults)
                    entries.push(row.id)
            },

            handleCompletion: function(aReason) {
                aCallback(entries);
            }
        })
    },

    newURI: function(aSpec) {
        try {
            var uri = Services.io.newURI(aSpec, null, null);
        }
        catch (ex) {
            uri = null;
        }
        return uri;
    },

    isBookmark: function(aItemID) {
        return (Bookmarks.getItemType(aItemID) === Bookmarks.TYPE_BOOKMARK);
    },

    isNormalBookmark: function(aItemID) {
        let parent = Bookmarks.getFolderIdForItem(aItemID);
        return !Utils.isLivemark(parent) && !Utils.isTagFolder(parent);
    },

    isLivemark: function(aItemID) {
        return Places.livemarks.isLivemark(aItemID);
    },

    isFolder: function(aItemID) {
        return (Bookmarks.getItemType(aItemID) === Bookmarks.TYPE_FOLDER);
    },

    isTagFolder: function(aItemID) {
        return (Bookmarks.getFolderIdForItem(aItemID) === Places.tagsFolderId);
    },

    // Returns TRUE if an item is a subfolder of Brief's home folder.
    isInHomeFolder: function(aItemID) {
        let homeID = StorageInternal.homeFolderID;
        if (homeID === -1)
            return false;

        if (homeID === aItemID)
            return true;

        let inHome = false;
        let parent = aItemID;
        while (parent !== Places.placesRootId) {
            parent = Bookmarks.getFolderIdForItem(parent);
            if (parent === homeID) {
                inHome = true;
                break;
            }
        }

        return inHome;
    },

    hashString: function(aString) {
        // nsICryptoHash can read the data either from an array or a stream.
        // Creating a stream ought to be faster than converting a long string
        // into an array using JS.
        let unicodeConverter = Cc['@mozilla.org/intl/scriptableunicodeconverter'].
                               createInstance(Ci.nsIScriptableUnicodeConverter);
        unicodeConverter.charset = 'UTF-8';
        let stream = unicodeConverter.convertToInputStream(aString);

        let hasher = Cc['@mozilla.org/security/hash;1'].createInstance(Ci.nsICryptoHash);
        hasher.init(Ci.nsICryptoHash.MD5);
        hasher.updateFromStream(stream, stream.available());
        let hash = hasher.finish(false);

        // Convert the hash to a hex-encoded string.
        let hexchars = '0123456789ABCDEF';
        let hexrep = new Array(hash.length * 2);
        for (let i = 0; i < hash.length; ++i) {
            hexrep[i * 2] = hexchars.charAt((hash.charCodeAt(i) >> 4) & 15);
            hexrep[i * 2 + 1] = hexchars.charAt(hash.charCodeAt(i) & 15);
        }
        return hexrep.join('');
    }

}


StorageInternal.init();
