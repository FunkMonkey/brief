/**
 * Original code by Christopher Finke, "OPML Support" extension. Used with permisson.
 */

Components.utils.import('resource://brief/common.jsm');
Components.utils.import('resource://gre/modules/PlacesUtils.jsm');
Components.utils.import('resource://gre/modules/Services.jsm');

IMPORT_COMMON(this);


let opml = {

    importOPML: function() {
        let bundle = document.getElementById('options-bundle');

        let fp = Cc['@mozilla.org/filepicker;1'].createInstance(Ci.nsIFilePicker);
        fp.appendFilter(bundle.getString('OPMLFiles'),'*.opml');
        fp.appendFilter(bundle.getString('XMLFiles'),'*.opml; *.xml; *.rdf; *.html; *.htm');
        fp.appendFilter(bundle.getString('allFiles'),'*');

        fp.init(window, bundle.getString('selectFile'), Ci.nsIFilePicker.modeOpen);

        let res = fp.show();

        if (res == Ci.nsIFilePicker.returnOK) {
            // Read any xml file by using XMLHttpRequest.
            // Any character code is converted to native unicode automatically.
            let fix = Cc['@mozilla.org/docshell/urifixup;1'].getService(Ci.nsIURIFixup);
            let url = fix.createFixupURI(fp.file.path, fix.FIXUP_FLAG_ALLOW_KEYWORD_LOOKUP);

            let reader = new XMLHttpRequest();
            reader.open('GET', url.spec, false);
            reader.overrideMimeType('application/xml');
            reader.send(null);
            let opmldoc = reader.responseXML;

            if (opmldoc.documentElement.localName == 'parsererror') {
                Services.prompt.alert(window, bundle.getString('invalidFileAlertTitle'),
                                      bundle.getString('invalidFileAlertText'));
                return;
            }

            let results = [];

            // At this point, we have an XML doc in opmldoc
            let nodes = opmldoc.getElementsByTagName('body')[0].childNodes;

            for (let i = 0; i < nodes.length; i++) {
                if (nodes[i].nodeName == 'outline')
                    results = this.importNode(results, nodes[i]);
            }

            // Now we have the structure of the file in an array.
            let carr = {folders : 0, links : 0, feeds : 0};

            for (let i = 0; i < results.length; i++)
                carr = this.countItems(results[i], carr);

            let transactions = [];

            let homeFolder = document.getElementById('extensions.brief.homeFolder').value;
            this.importLevel(results, homeFolder, transactions);

            let aggregatedTrans = new PlacesAggregatedTransaction('Import feeds',
                                                                  transactions);
            PlacesUtils.transactionManager.doTransaction(aggregatedTrans);
        }
    },

    importLevel: function(aNodes, aCreateIn, aTransactions) {
        for (let i = 0; i < aNodes.length; i++) {
            let node = aNodes[i];

            switch (node.type) {
            case 'folder':
                let childItemsTransactions = [];
                this.importLevel(node.children, null, childItemsTransactions);

                let trans = new PlacesCreateFolderTransaction(node.title, aCreateIn, -1,
                                                              null, childItemsTransactions);
                aTransactions.push(trans);
                break;

            case 'feed':
                let siteURI = null, feedURI = null;

                try {
                     feedURI = Services.io.newURI(node.feedURL, null, null);
                }
                catch (ex) {
                    log('Brief\nFailed to import feed ' + node.title +
                        '\nInvalid URI: ' + node.feedURL);
                    break;
                }

                try {
                    siteURI = Services.io.newURI(node.url, null, null);
                }
                catch (ex) {
                    // We can live without siteURI.
                }

                trans = new PlacesCreateLivemarkTransaction(feedURI, siteURI,
                                                            node.title, aCreateIn);
                aTransactions.push(trans)
                break;

            case 'link':
                try {
                    var uri = Services.io.newURI(node.url, null, null);
                }
                catch (ex) {
                    break;
                }
                trans = new PlacesCreateBookmarkTransaction(uri, aCreateIn, -1, node.title);
                aTransactions.push(trans);
                break;
            }
        }
    },

    countItems: function (arr, carr) {
        if (arr.type == 'folder') {
            carr.folders++;

            for (let i = 0; i < arr.children.length; i++)
                carr = this.countItems(arr.children[i], carr);
        }
        else if (arr.type == 'link') {
            carr.links++;
        }
        else if (arr.type == 'feed') {
            carr.feeds++;
        }

        return carr;
    },

    importNode: function(results, node) {
        let hash = {};
        hash.title = node.getAttribute('text');
        hash.keyword = '';

        if (node.childNodes.length > 0 || (!node.hasAttribute('xmlUrl')
            && !node.hasAttribute('htmlUrl') && !node.hasAttribute('url'))) {

            hash.type = 'folder';
            hash.children = [];

            let children = node.childNodes;

            for (let i = 0; i < children.length; i++) {
                if (children[i].nodeName == 'outline')
                    hash.children = this.importNode(hash.children, children[i]);
            }

            results.push(hash);
        }
        else {
            if (node.getAttribute('type') == 'link') {
                hash.type = 'link';
                hash.url = node.getAttribute('url');
                hash.keyword = node.getAttribute('keyword');
            }
            else {
                hash.type = 'feed';
                hash.feedURL = node.getAttribute('xmlUrl');
                hash.url = node.getAttribute('htmlUrl');
            }

            hash.desc = node.getAttribute('description');

            results.push(hash);
        }

        return results;
    },

    exportOPML: function() {
        let filePrefix = 'feeds';
        let title = 'Feeds';

        let file = this.promptForFile(filePrefix);

        if (file) {
            let folder = document.getElementById('extensions.brief.homeFolder').value;

            let options = PlacesUtils.history.getNewQueryOptions();
            let query = PlacesUtils.history.getNewQuery();
            query.setFolders([folder], 1);
            options.excludeItems = true;
            let result = PlacesUtils.history.executeQuery(query, options);

            let data = '';
            data += '<?xml version="1.0" encoding="UTF-8"?>' + '\n';
            data += '<opml version="1.0">' + '\n';
            data += '\t' + '<head>' + '\n';
            data += '\t\t' + '<title>' + title + ' OPML Export</title>' + '\n';
            data += '\t\t' + '<dateCreated>' + new Date().toString() + '</dateCreated>' + '\n';
            data += '\t' + '</head>' + '\n';
            data += '\t' + '<body>' + '\n';

            data = this.addFolderToOPML(data, result.root, 0, true);

            data += '\t' + '</body>' + '\n';
            data += '</opml>';

            // convert to utf-8 from native unicode
            let converter = Cc['@mozilla.org/intl/scriptableunicodeconverter']
                            .getService(Ci.nsIScriptableUnicodeConverter);
            converter.charset = 'UTF-8';
            data = converter.ConvertFromUnicode(data);

            let outputStream = Cc['@mozilla.org/network/file-output-stream;1']
                               .createInstance(Ci.nsIFileOutputStream);
            outputStream.init(file, 0x04 | 0x08 | 0x20, 420, 0 );
            outputStream.write(data, data.length);
            outputStream.close();
        }
    },


    addFolderToOPML: function(dataString, folder, level, isBase) {
        level++;

        if (!isBase) {
            dataString += '\t';

            for (let i = 1; i < level; i++)
                dataString += '\t';

            let name = PlacesUtils.bookmarks.getItemTitle(folder.itemId);
            dataString += '<outline text="' + this.cleanXMLText(name) + '">' + '\n';
        }

        folder.containerOpen = true;

        for (let i = 0; i < folder.childCount; i++) {
            let node = folder.getChild(i);

            if (node.type != Ci.nsINavHistoryResultNode.RESULT_TYPE_FOLDER)
                continue;

            if (PlacesUtils.livemarks.isLivemark(node.itemId)) {
                dataString += '\t\t';

                for (let j = 1; j < level; j++)
                    dataString += '\t';

                let name = PlacesUtils.bookmarks.getItemTitle(node.itemId);
                let url = PlacesUtils.livemarks.getSiteURI(node.itemId).spec;
                let feedURL = PlacesUtils.livemarks.getFeedURI(node.itemId).spec

                dataString += '<outline type="rss" version="RSS" '           +
                              'text="'          + this.cleanXMLText(name)    +
                              '" htmlUrl="'     + this.cleanXMLText(url)     +
                              '" xmlUrl="'      + this.cleanXMLText(feedURL) +
                              '"/>' + "\n";
            }
            else if (node instanceof Ci.nsINavHistoryContainerResultNode) {
                dataString = this.addFolderToOPML(dataString, node, level, false);
            }
        }

        folder.containerOpen = false;

        if (!isBase) {
            dataString += '\t';

            for (let i = 1; i < level; i++)
                dataString += '\t';

            dataString += '</outline>' + '\n';
        }

        return dataString;
    },

    promptForFile: function (filePrefix) {
        let bundle = document.getElementById('options-bundle');

        let fp = Cc['@mozilla.org/filepicker;1'].createInstance(Ci.nsIFilePicker);
        fp.init(window, bundle.getString('saveAs'), Ci.nsIFilePicker.modeSave);

        fp.appendFilter(bundle.getString('OPMLFiles'),'*.opml');
        fp.appendFilter(bundle.getString('XMLFiles'),'*.opml; *.xml; *.rdf; *.html; *.htm');
        fp.appendFilter(bundle.getString('allFiles'),'*');

        fp.defaultString = filePrefix + '.opml';

        let result = fp.show();

        if (result == Ci.nsIFilePicker.returnCancel)
            return false;
        else
            return fp.file;
    },

    cleanXMLText: function(str) {
        let res = [
            {find : '&', replace : '&amp;'},
            {find : '"', replace : '&quot;'},
            {find : '<', replace : '&lt;'},
            {find : '>', replace : '&gt;'}
        ]

        for (let i = 0; i < res.length; i++){
            let re = new RegExp(res[i].find, 'g');
            str = str.replace(re, res[i].replace);
        }

        return str;
    }

}
