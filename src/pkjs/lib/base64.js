// Base64 encode/decode on byte arrays. Not relying on btoa/atob/Buffer since
// their availability in the PebbleKit JS runtime is not guaranteed.
(function (root) {
  'use strict';

  var CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

  function bytesToBase64(bytes) {
    var out = '';
    var i = 0;
    for (; i + 3 <= bytes.length; i += 3) {
      var n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
      out += CHARS[(n >> 18) & 63] + CHARS[(n >> 12) & 63] + CHARS[(n >> 6) & 63] + CHARS[n & 63];
    }
    var rem = bytes.length - i;
    if (rem === 1) {
      var n1 = bytes[i] << 16;
      out += CHARS[(n1 >> 18) & 63] + CHARS[(n1 >> 12) & 63] + '==';
    } else if (rem === 2) {
      var n2 = (bytes[i] << 16) | (bytes[i + 1] << 8);
      out += CHARS[(n2 >> 18) & 63] + CHARS[(n2 >> 12) & 63] + CHARS[(n2 >> 6) & 63] + '=';
    }
    return out;
  }

  function base64ToBytes(str) {
    str = str.replace(/[^A-Za-z0-9+/=]/g, '');
    var bytes = [];
    var buffer = 0;
    var bits = 0;
    for (var i = 0; i < str.length; i++) {
      var c = str[i];
      if (c === '=') {
        break;
      }
      var val = CHARS.indexOf(c);
      if (val === -1) {
        continue;
      }
      buffer = (buffer << 6) | val;
      bits += 6;
      if (bits >= 8) {
        bits -= 8;
        bytes.push((buffer >> bits) & 0xff);
      }
    }
    return bytes;
  }

  var api = { bytesToBase64: bytesToBase64, base64ToBytes: base64ToBytes };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.SPCrypto = root.SPCrypto || {};
    root.SPCrypto.base64 = api;
  }
})(typeof self !== 'undefined' ? self : this);
