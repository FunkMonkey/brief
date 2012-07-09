/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 *
 * This Source Code Form is "Incompatible With Secondary Licenses", as
 * defined by the Mozilla Public License, v. 2.0.
 */

const Cc = Components.classes;
const Ci = Components.interfaces;

Components.utils.import('resource://gre/modules/Services.jsm');

document.addEventListener('DOMContentLoaded', onload, false);
document.addEventListener('unload', onunload, false);

var prefBranch = Services.prefs.getBranch('extensions.brief.')
                               .QueryInterface(Ci.nsIPrefBranch2);
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
    var bundle = Services.strings.createBundle('chrome://brief/locale/brief.properties');

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
        var instantApply = Services.prefs.getBoolPref('browser.preferences.instantApply');
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
