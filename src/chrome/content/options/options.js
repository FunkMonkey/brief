const Cc = Components.classes;
const Ci = Components.interfaces;

function init() {
    sizeToContent();
    setTimeout(gMainPane.setUpFoldersTree, 0);

    gFeedsPane.initUpdateIntervalControls();
    gFeedsPane.updateExpirationDisabledState();
    gFeedsPane.updateStoredEntriesDisabledState();
    gDisplayPane.updateCustomStyleDisabledState();
}

function unload() {
    gFeedsPane.saveUpdateIntervalPref();
}


var gMainPane = {

    setUpFoldersTree: function() {
        var folderID = Cc['@mozilla.org/preferences-service;1'].
                       getService(Ci.nsIPrefBranch).
                       getCharPref('extensions.brief.liveBookmarksFolder');
        if (folderID) {
            var rdfService = Cc['@mozilla.org/rdf/rdf-service;1'].
                             getService(Ci.nsIRDFService);
            var folder = rdfService.GetResource(folderID);

            var foldersTree = document.getElementById('folders-tree');
            foldersTree.treeBoxObject.view.selection.selectEventsSuppressed = true;
            foldersTree.treeBoxObject.view.selection.clearSelection();
            foldersTree.selectResource(folder);
            var index = foldersTree.currentIndex;
            foldersTree.treeBoxObject.ensureRowIsVisible(index);
            foldersTree.treeBoxObject.view.selection.selectEventsSuppressed = false;
        }
    },

    onFolderSelected: function(aEvent) {
        var foldersTree = document.getElementById('folders-tree');
        var selectedIndex = foldersTree.currentIndex;
        if (selectedIndex != -1) {
            var resource = foldersTree.treeBuilder.getResourceAtIndex(selectedIndex);

            var pref = document.getElementById('extensions.brief.liveBookmarksFolder');
            pref.value = resource.Value;
        }
    }

}


var gFeedsPane = {

    updateIntervalDisabledState: function() {
        var textbox = document.getElementById('updateInterval');
        var checkbox = document.getElementById('checkForUpdates');
        var menulist = document.getElementById('update-time-menulist');

        textbox.disabled = menulist.disabled = !checkbox.checked;
    },

    initUpdateIntervalControls: function() {
        var pref = document.getElementById('extensions.brief.update.interval').value;
        var menulist = document.getElementById('update-time-menulist');
        var textbox = document.getElementById('updateInterval');

        var toDays = pref / (60*60*24);
        var toHours = pref / (60*60);
        var toMinutes = pref / 60;

        switch (true) {
            // The pref value is in seconds. If it is dividable by days then use the
            // number of days as the textbox value and select Days in the menulist.
            case Math.ceil(toDays) == toDays:
                menulist.selectedIndex = 2;
                textbox.value = toDays;
                break;
            // Analogically for hours...
            case Math.ceil(toHours) == toHours:
                menulist.selectedIndex = 1;
                textbox.value = toHours;
                break;
            // Otherwise use minutes, ceiling to the nearest integer if necessary.
            default:
                menulist.selectedIndex = 0;
                textbox.value = Math.ceil(toMinutes);
                break;
        }

        this.updateIntervalDisabledState();
    },

    saveUpdateIntervalPref: function() {
        var pref = document.getElementById('extensions.brief.update.interval');
        var textbox = document.getElementById('updateInterval');
        var menulist = document.getElementById('update-time-menulist');

        var intervalInSeconds;
        switch (menulist.selectedIndex) {
            case 0:
                intervalInSeconds = textbox.value * 60; // textbox.value is in minutes
                break;
            case 1:
                intervalInSeconds = textbox.value * 60*60; // textbox.value is in hours
                break;
            case 2:
                intervalInSeconds = textbox.value * 60*60*24; // textbox.value is in days
                break;
        }

        pref.valueFromPreferences = intervalInSeconds;
    },

    updateExpirationDisabledState: function() {
        var textbox = document.getElementById('expiration-textbox');
        var checkbox = document.getElementById('expiration-checkbox');

        textbox.disabled = !checkbox.checked;
    },

    updateStoredEntriesDisabledState: function() {
        var textbox = document.getElementById('stored-entries-textbox');
        var checkbox = document.getElementById('stored-entries-checkbox');

        textbox.disabled = !checkbox.checked;
    },

    onClearAllEntriesCmd: function(aEvent) {
        var promptService = Cc['@mozilla.org/embedcomp/prompt-service;1'].
                            getService(Ci.nsIPromptService);
        var prefBranch = Cc['@mozilla.org/preferences-service;1'].
                         getService(Ci.nsIPrefBranch);
        var keepStarred = prefBranch.getBoolPref('extensions.brief.database.keepStarredWhenClearing');

        var stringbundle = document.getElementById('main-bundle');
        var title = stringbundle.getString('confirmClearAllEntriesTitle');
        var text = stringbundle.getString('confirmClearAllEntriesText');
        var checkboxLabel = stringbundle.getString('confirmClearAllEntriesCheckbox');
        var checked = { value: keepStarred };

        var result = promptService.confirmCheck(window, title, text, checkboxLabel, checked);
        if (result) {
            var query = Cc['@ancestor/brief/query;1'].createInstance(Ci.nsIBriefQuery);
            query.deleted = Ci.nsIBriefQuery.ENTRY_STATE_ANY;
            query.unstarred = checked.value;
            query.includeHiddenFeeds = true;
            query.deleteEntries(Ci.nsIBriefStorage.ENTRY_STATE_DELETED);

            prefBranch.setBoolPref('extensions.brief.database.keepStarredWhenClearing', checked.value)
        }
    }

}


var gDisplayPane = {

    updateCustomStyleDisabledState: function() {
        var pathTextbox = document.getElementById('custom-style-path');
        var browseButton = document.getElementById('browse-custom-style');
        var enableCustomStyle = document.getElementById('custom-style-checkbox');

        pathTextbox.disabled = !enableCustomStyle.checked;
        browseButton.disabled = !enableCustomStyle.checked;
    },

    browseCustomStyle: function() {
        var picker = Cc['@mozilla.org/filepicker;1'].createInstance(Ci.nsIFilePicker);
        var stringbundle = document.getElementById('main-bundle');
        var pickerTitle = stringbundle.getString('stylePickerTitle');
        var pickerFilterName = stringbundle.getString('stylePickerExtFilterName');
        picker.init(window, pickerTitle, picker.modeOpen);
        picker.appendFilter(pickerFilterName, '*.css');
        picker.appendFilters(picker.filterAll);

        var result = picker.show();
        if (result == picker.returnOK) {
            var pathTextbox = document.getElementById('custom-style-path');
            pathTextbox.value = picker.file.path;
            var pref = document.getElementById('extensions.brief.feedview.customStylePath');
            pref.value = pathTextbox.value;
        }
    }

}

function dump(aMessage) {
  var consoleService = Cc['@mozilla.org/consoleservice;1'].
                       getService(Ci.nsIConsoleService);
  consoleService.logStringMessage(aMessage);
}
