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

Components.utils.import('resource://gre/modules/XPCOMUtils.jsm');
Components.utils.import('resource://gre/modules/Services.jsm');

function BriefService() {
    Components.utils.import('resource://brief/Storage.jsm');
    this.registerCustomStyle();
}

BriefService.prototype = {

    // Registers %profile%/chrome directory under a resource URI.
    registerCustomStyle: function Brief_registerCustomStyle() {
        var resourceProtocolHandler = Services.io.getProtocolHandler('resource')
                                                 .QueryInterface(Ci.nsIResProtocolHandler);
        if (!resourceProtocolHandler.hasSubstitution('profile-chrome-dir')) {
            let chromeDir = Services.dirsvc.get('ProfD', Ci.nsIFile);
            chromeDir.append('chrome');
            let chromeDirURI = Services.io.newFileURI(chromeDir);
            resourceProtocolHandler.setSubstitution('profile-chrome-dir', chromeDirURI);
        }
    },

    // nsIObserver
    observe: function() {},

    classDescription: 'Service of Brief extension',
    classID: Components.ID('{943b2280-6457-11df-a08a-0800200c9a66}'),
    contractID: '@brief.mozdev.org/briefservice;1',
    QueryInterface: XPCOMUtils.generateQI([Ci.nsIObserver])
}

var NSGetFactory = XPCOMUtils.generateNSGetFactory([BriefService]);
