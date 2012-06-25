const Cc = Components.classes;
const Ci = Components.interfaces;

document.addEventListener('DOMContentLoaded', onload, false);
document.addEventListener('unload', onunload, false);

var prefBranch = Cc['@mozilla.org/preferences-service;1'].
                   getService(Ci.nsIPrefService).
                   getBranch('extensions.brief.').
                   QueryInterface(Ci.nsIPrefBranch2);
var prefObserver = {
    observe: function(aSubject, aTopic, aData) {
        if (aTopic == 'nsPref:changed' && aData == 'homeFolder')
            buildHeader();
    }
}
prefBranch.addObserver('', prefObserver, false);

// We save a reference to the Options window for reusing it
var optionsWindow = null;


function onload() {
    buildHeader();

    document.removeEventListener('DOMContentLoaded', onload, false);
}

function onunload() {
    prefBranch.removeObserver('', prefObserver);
}

function buildHeader() {
    var bookmarks = Cc['@mozilla.org/browser/nav-bookmarks-service;1'].
                    getService(Ci.nsINavBookmarksService);
    var bundle = Cc['@mozilla.org/intl/stringbundle;1'].
                 getService(Ci.nsIStringBundleService).
                 createBundle('chrome://brief/locale/brief.properties');

    var folderID = prefBranch.getIntPref('homeFolder');
    var folderName = '<span id="home-folder">' + bookmarks.getItemTitle(folderID) +
                     '</span>';
    var string = bundle.formatStringFromName('howToSubscribeHeader', [folderName], 1);

    var subscribeHeader = document.getElementById('subscribe');
    subscribeHeader.innerHTML = string;

    var homeFolderSpan = document.getElementById('home-folder');
    homeFolderSpan.addEventListener('click', openOptions, false);
}

function openOptions() {
    if (optionsWindow && !optionsWindow.closed)
        optionsWindow.focus();
    else {
        var instantApply = Cc['@mozilla.org/preferences-service;1'].
                           getService(Ci.nsIPrefBranch).
                           getBoolPref('browser.preferences.instantApply');
        var modality = instantApply ? 'modal=no,dialog=no' : 'modal';
        var features = 'chrome,titlebar,toolbar,centerscreen,resizable,' + modality;

        optionsWindow = window.openDialog('chrome://brief/content/options/options.xul',
                                          'Brief options', features, 'feeds-pane');
    }
}

function openBrief() {
    var topWindow = window.QueryInterface(Ci.nsIInterfaceRequestor)
                           .getInterface(Ci.nsIWebNavigation)
                           .QueryInterface(Ci.nsIDocShellTreeItem)
                           .rootTreeItem
                           .QueryInterface(Ci.nsIInterfaceRequestor)
                           .getInterface(Ci.nsIDOMWindow);
    topWindow.Brief.open(true);
}
