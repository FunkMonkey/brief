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

Components.utils.import('resource://gre/modules/AddonManager.jsm');
Components.utils.import('resource://gre/modules/Services.jsm');

var gCustomStyleFile = null;
var gTextbox = null;

function init() {
    sizeToContent();

    gTextbox = document.getElementById('custom-style-textbox');

    var chromeDir = Services.dirsvc.get('ProfD', Ci.nsIFile);
    chromeDir.append('chrome');

    gCustomStyleFile = chromeDir.clone();
    gCustomStyleFile.append('brief-custom-style.css');

    if (!gCustomStyleFile.exists()) {
        gCustomStyleFile.create(Ci.nsIFile.NORMAL_FILE_TYPE, 777);

        AddonManager.getAddonByID('brief@mozdev.org', function(addon) {
            let uri = addon.getResourceURI('/defaults/data/example-custom-style.css');
            let cssText = fetchCSSText(uri);
            writeCustomCSSFile(cssText);
            gTextbox.value = cssText;
        })
    }
    else {
        populateTextbox();
    }
}


function populateTextbox() {
    let uri = Cc['@mozilla.org/network/protocol;1?name=file']
              .getService(Ci.nsIFileProtocolHandler)
              .newFileURI(gCustomStyleFile);
    gTextbox.value = fetchCSSText(uri);
}


function fetchCSSText(aURI) {
    var request = new XMLHttpRequest();
    request.open('GET', aURI.spec, false);
    request.overrideMimeType('text/css');
    request.send(null);

    return request.responseText;
}


function writeCustomCSSFile(aData) {
    var stream = Cc['@mozilla.org/network/file-output-stream;1']
                 .createInstance(Ci.nsIFileOutputStream);
    stream.init(gCustomStyleFile, 0x02 | 0x08 | 0x20, -1, 0); // write, create, truncate
    stream.write(aData, aData.length);
    stream.close();
}


function onAccept() {
    writeCustomCSSFile(gTextbox.value, gTextbox.value.length);

    Services.obs.notifyObservers(null, 'brief:custom-style-changed', '');
}
