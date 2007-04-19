const XHTML_NS = 'http://www.w3.org/1999/xhtml';

/**
 * This object represents the main feed display. It stores and manages
 * the display parameters.
 *
 * @param aTitle  Title of the view which will be shown in the header.
 * @param aQuery  Query selecting entries to be displayed.
 */
function FeedView(aTitle, aQuery) {
    this.title = aTitle;

    this._flagsAreIntrinsic = aQuery.read || aQuery.unread || aQuery.starred ||
                              aQuery.unstarred || aQuery.deleted != ENTRY_STATE_NORMAL;
    this.query = aQuery;
    this.query.sortOrder = Ci.nsIBriefQuery.SORT_BY_DATE;

    // Clear the searchbar.
    if (!aQuery.searchString) {
        var searchbar = document.getElementById('searchbar');
        searchbar.setAttribute('showingDescription', true);
    }

    this.browser = document.getElementById('feed-view');
    this.document = this.browser.contentDocument;

    // If view is tied to specified intrinsic flags (e.g. special "Unread" view), hide
    // the UI to pick the flags from the user.
    var viewConstraintBox = document.getElementById('view-constraint-box');
    viewConstraintBox.hidden = this._flagsAreIntrinsic;

    this.browser.addEventListener('load', this._onLoad, false);

    // If the feed wasn't updated yet, do it now.
    var feed = gStorage.getFeed(aQuery.feeds);
    if (feed && !feed.everUpdated) {
        var updateService = Cc['@ancestor/brief/updateservice;1'].
                            getService(Ci.nsIBriefUpdateService);
        updateService.fetchFeed(this.feedId);
    }

    this._refresh();
}


FeedView.prototype = {

    // Title of the view which is displayed in the header.
    title: '',

    // This property is used to temporarily override the title without losing the old one.
    // It used for searching, when the search string is displayed in place of the title.
    titleOverride: '',

    // Indicates if the view was created with intrinsic flags which override the
    // feedview.shownEntries preference.
    _flagsAreIntrinsic: false,

    // Array of ids of displayed entries. This isn't used to specify which entries are
    // displayed but computed post-factum and used for determining if the view needs
    // to be refreshed.
    _entries: '',

    currentPage:   0,
    pageCount:     0,
    entriesCount:  0,

    // Key elements.
    browser:      null,
    document:     null,
    feedContent:  null,

    // Query that selects entries contained by the view. It is the query to pull ALL the
    // entries, not only the ones displayed on the current page.
    set query(aQuery) {
        this.__query = aQuery;
        return aQuery;
    },

    get query() {
        if (!this._flagsAreIntrinsic) {
            this.__query.unread = gPrefs.shownEntries == 'unread';
            this.__query.starred = gPrefs.shownEntries == 'starred';
            this.__query.deleted = gPrefs.shownEntries == 'trashed' ? ENTRY_STATE_TRASHED
                                                                    : ENTRY_STATE_NORMAL;
        }
        // XXX We should not have to reset the offset and limit every time.
        this.__query.limit = 0;
        this.__query.offset = 1;

        return this.__query;
    },

    // Indicates whether the feed view is currently displayed in the browser.
    get isActive() {
        return (this.browser.currentURI.spec == gTemplateURI.spec);
    },

    get isGlobalSearch() {
        return !this.query.folders && !this.query.feeds && !this._flagsAreIntrinsic &&
               this.query.searchString;
    },

    get isViewSearch() {
        return (this.query.folders || this.query.feeds || this._flagsAreIntrinsic) &&
                gFeedView.query.searchString;
    },

    ensure: function() {
        if (!this.isActive)
            return true;

        // Get arrays of previously viewed entries and the ones that should be viewed now.
        var prevEntries = this._entries;
        var currentEntries = gStorage.getSerializedEntries(this.query).
                                      getPropertyAsAUTF8String('entryIdList').
                                      match(/[^ ]+/g);

        if (!prevEntries || !currentEntries) {
            this._refresh();
            return false;
        }

        // We need to perform a full refresh if entries were added or more than one entry
        // was removed. We optimize for the common case when only one entry is removed and
        // in such case we refresh incrementally.
        // Because it is possible for some entries to be added and some removed at the
        // same time, simply comparing overall numbers is not enough and we need to check
        // all of them one by one.
        // First, let's see if any entries were removed.
        var removedEntry = null;
        var removedEntryIndex;
        for (var i = 0; i < prevEntries.length; i++) {
            if (currentEntries.indexOf(prevEntries[i]) == -1) {
                if (removedEntry) {
                    // One missing entry was already found and this is the second one,
                    // so we need to do a full refresh.
                    this._refresh();
                    return false;
                }
                removedEntry = prevEntries[i];
                removedEntryIndex = i;
            }
        }

        // Let's see if any entries were added.
        for (i = 0; i < currentEntries.length; i++) {
            if (prevEntries.indexOf(currentEntries[i]) == -1) {
                this._refresh();
                return false;
            }
        }

        if (removedEntry) {
            // If there are no more entries on this page and it the last page then perform
            // a full refresh.
            if (this.feedContent.childNodes.length == 1 && this.currentPage == this.pageCount) {
                this._refresh();
                return false;
            }

            // If the removed entry is on a different page than the currently shown one,
            // perform full refresh.
            var firstIndex = gPrefs.entriesPerPage * (this.currentPage - 1);
            var lastIndex = firstIndex + gPrefs.entriesPerPage;
            if (removedEntryIndex < firstIndex || removedEntryIndex > lastIndex) {
                this._refresh();
                return false;
            }

            this._refreshIncrementally(removedEntry);
            return false;
        }

        // Update the title.
        var title = this.titleOverride || this.title;
        var titleElement = this.document.getElementById('feed-title');
        if (titleElement.textContent != title) {
            titleElement.textContent = title;
            return false;
        }

        return true;
    },


    // Refreshes the feed view from scratch.
    _refresh: function() {
        this.browser.style.cursor = 'wait';

        this._computePages();

        // Load the template. The actual content building happens when the template
        // page is loaded - see _onLoad below.
        this.browser.loadURI(gTemplateURI.spec);

        // Store a list of ids of displayed entries. It is used to determine if
        // the view needs to be refreshed when database changes.
        this._entries = gStorage.getSerializedEntries(this.query).
                                 getPropertyAsAUTF8String('entryIdList').
                                 match(/[^ ]+/g);
    },


    // Refreshes the view when one entry is removed from the currently displayed page.
    _refreshIncrementally: function(aEntryId) {

        // Find the entry that be removed.
        var entry = this.feedContent.firstChild;
        while (entry.id != aEntryId)
            entry = entry.nextSibling;

        // Remove the entry. We don't do it directly, because we want to use jQuery
        // to to fade it gracefully and we can call it from here, because it's untrusted.
        var evt = document.createEvent('Events');
        evt.initEvent('RemoveEntry', false, false);
        entry.dispatchEvent(evt);

        this._computePages();

        // Pull the one entry (previously the first entry on the next page).
        var query = this.query;
        query.offset = gPrefs.entriesPerPage * this.currentPage - 1;
        query.limit = 1;
        var entry = gStorage.getEntries(query, {})[0];

        // Append the entry. If we're on the last page then there may have been no
        // futher entries to pull.
        if (entry)
            this._appendEntry(entry);

        this._entries = gStorage.getSerializedEntries(this.query).
                                 getPropertyAsAUTF8String('entryIdList').
                                 match(/[^ ]+/g);
    },


    _computePages: function() {
        this.entriesCount = gStorage.getEntriesCount(this.query);
        this.pageCount = Math.ceil(this.entriesCount / gPrefs.entriesPerPage);

        // This may happen for example when you are on the last page, and the
        // number of entries decreases (e.g. they are deleted).
        if (this.currentPage > this.pageCount)
            this.currentPage = this.pageCount;
        else if (this.currentPage == 0 && this.pageCount > 0)
            this.currentPage = 1;

        // Update the page commands and description
        var pageLabel = document.getElementById('page-desc');
        var prevPageButton = document.getElementById('prev-page');
        var nextPageButton = document.getElementById('next-page');

        prevPageButton.setAttribute('disabled', this.currentPage <= 1);
        nextPageButton.setAttribute('disabled', this.currentPage == this.pageCount);
        var stringbundle = document.getElementById('main-bundle');
        var params = [this.currentPage, this.pageCount];
        pageLabel.value = stringbundle.getFormattedString('pageNumberLabel', params);
    },


    // Listens to load events and builds the feed view page when necessary as
    // well as hides/unhides the feed view toolbar.
    _onLoad: function(aEvent) {
        var feedViewToolbar = document.getElementById('feed-view-toolbar');
        if (gFeedView.isActive) {
            feedViewToolbar.hidden = false;
            gFeedView._buildFeedView();
        }
        else {
            feedViewToolbar.hidden = true;
        }
    },


    // Generates and sets up the feed view page. Because we insert third-party
    // content in it (the entries are not served in plain text but in full HTML
    // markup) this page needs to be have a file:// URI to be unprivileged.
    // It is untrusted and all the interaction respects XPCNativeWrappers.
    _buildFeedView: function() {
        var doc = this.document = this.browser.contentDocument;

        // All file:// URIs are treated as same-origin which allows a script
        // running in a page to access local files via XHR. Because of it Firefox is
        // vulnerable to numerous attack vectors  (primarily when browsing locally
        // saved websites) and so are we, because we insert untrusted content into
        // the local template page. Same-origin policy is going to be tightened in
        // Firefox 3 (hopefully earlier) which will fix the problem.
        // Null-ing out XMLHttpRequest object is making the exploit harder but there
        // are ways around it.
        doc.defaultView.XMLHttpRequest = null;

        // Add listeners so that the content can communicate with chrome to perform
        // actions that require full privileges by sending custom events.
        doc.addEventListener('MarkEntryRead', brief.onMarkEntryRead, true);
        doc.addEventListener('StarEntry', brief.onStarEntry, true);
        doc.addEventListener('DeleteEntry', brief.onDeleteEntry, true);
        doc.addEventListener('RestoreEntry', brief.onRestoreEntry, true);

        // This is for marking entry read when user follows the link. We can't do it
        // by dispatching custom events like we do above, because for whatever
        // reason the binding handlers don't catch middle-clicks.
        doc.addEventListener('click', brief.onFeedViewClick, true);

        // Apply the CSS.
        var style = doc.getElementsByTagName('style')[0];
        style.textContent = gFeedViewStyle;

        // Build the header.
        var titleElement = doc.getElementById('feed-title');
        titleElement.textContent = this.titleOverride || this.title;

        // When a single, unfiltered feed is viewed, construct the feed's header.
        var feed = gStorage.getFeed(this.query.feeds);
        if (feed && !this.searchString) {

            // Create the link.
            var header = doc.getElementById('header');
            header.setAttribute('href', feed.websiteURL ? feed.websiteURL : feed.feedURL);

            // Create feed image.
            if (feed.imageURL) {
                var feedImage = doc.getElementById('feed-image');
                feedImage.setAttribute('src', feed.imageURL);
                if (feed.imageTitle)
                    feedImage.setAttribute('title', feed.imageTitle);
            }

            // Create feed subtitle.
            if (feed.subtitle)
                doc.getElementById('feed-subtitle').innerHTML = feed.subtitle;
        }

        this.feedContent = doc.getElementById('feed-content');

        // If the trash folder is displayed this attribute adjusts the visibility of the
        // button in article controls.
        if (this.query.deleted == ENTRY_STATE_TRASHED)
            this.feedContent.setAttribute('trash', true);

        if (!feed)
            this.feedContent.setAttribute('showFeedNames', true);

        // Pass the value of the pref.
        if (gPrefs.doubleClickMarks)
            this.feedContent.setAttribute('doubleClickMarks', true);

        // We have to hand the strings because stringbundles don't work with
        // unprivileged script.
        var stringbundle = document.getElementById('main-bundle');
        var markReadString = stringbundle.getString('markEntryAsRead');
        this.feedContent.setAttribute('markReadString', markReadString);
        var markEntryAsUnread = stringbundle.getString('markEntryAsUnread');
        this.feedContent.setAttribute('markUnreadString', markEntryAsUnread);

        // Get the entries and append them.
        var query = this.query;
        query.offset = gPrefs.entriesPerPage * (this.currentPage - 1);
        query.limit = gPrefs.entriesPerPage;

        var entries = gStorage.getEntries(query, {});
        for (var i = 0; i < entries.length; i++)
            this._appendEntry(entries[i]);

        // Restore default cursor which we changed to "wait" at the beginning of
        // the refresh.
        this.browser.style.cursor = 'auto';
    },


    _appendEntry: function(aEntry) {
        var articleContainer = this.document.createElementNS(XHTML_NS, 'div');
        articleContainer.className = 'article-container';

        // Safely pass the data so that binding constructor can use it.
        articleContainer.setAttribute('id', aEntry.id);
        articleContainer.setAttribute('entryURL', aEntry.entryURL);
        articleContainer.setAttribute('title', aEntry.title);
        articleContainer.setAttribute('summary', aEntry.summary);
        articleContainer.setAttribute('content', aEntry.content);
        articleContainer.setAttribute('date', aEntry.date);
        if (aEntry.read)
            articleContainer.setAttribute('read', true);
        if (aEntry.starred)
            articleContainer.setAttribute('starred', true);

        var feedName = gStorage.getFeed(aEntry.feedId).title;
        articleContainer.setAttribute('feedName', feedName);

        this.feedContent.appendChild(articleContainer);
    },


    showNextPage: function() {
        gFeedView.currentPage++;
        gFeedView._refresh();
    },

    showPrevPage: function() {
        gFeedView.currentPage--;
        gFeedView._refresh();
    }

}
