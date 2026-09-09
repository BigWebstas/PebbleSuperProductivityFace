// Pure-JS SHA-256 / HMAC-SHA256 / PBKDF2-HMAC-SHA256.
//
// Written from scratch because the PebbleKit JS runtime's JS engine is not
// guaranteed to expose window.crypto.subtle (it varies by phone platform and
// Pebble app version). Operates on plain arrays of bytes (0-255 ints) so it
// has no dependency on TypedArray quirks in older engines.
(function (root) {
  'use strict';

  var K = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
  ];

  function rotr(x, n) {
    return (x >>> n) | (x << (32 - n));
  }

  // bytes: array of ints 0-255. Returns array of 32 bytes.
  function sha256(bytes) {
    var h0 = 0x6a09e667, h1 = 0xbb67ae85, h2 = 0x3c6ef372, h3 = 0xa54ff53a;
    var h4 = 0x510e527f, h5 = 0x9b05688c, h6 = 0x1f83d9ab, h7 = 0x5be0cd19;

    var bitLenHigh = 0;
    var bitLenLow = bytes.length * 8;
    // bytes.length * 8 can exceed 32 bits for huge inputs; we don't expect
    // that here (sync payloads are at most a few hundred KB), so keep this
    // simple with a high word that is always 0 in practice.

    var msg = bytes.slice();
    msg.push(0x80);
    while (msg.length % 64 !== 56) {
      msg.push(0);
    }
    msg.push((bitLenHigh >>> 24) & 0xff, (bitLenHigh >>> 16) & 0xff, (bitLenHigh >>> 8) & 0xff, bitLenHigh & 0xff);
    msg.push((bitLenLow >>> 24) & 0xff, (bitLenLow >>> 16) & 0xff, (bitLenLow >>> 8) & 0xff, bitLenLow & 0xff);

    var w = new Array(64);
    for (var offset = 0; offset < msg.length; offset += 64) {
      for (var t = 0; t < 16; t++) {
        var i = offset + t * 4;
        w[t] = ((msg[i] << 24) | (msg[i + 1] << 16) | (msg[i + 2] << 8) | msg[i + 3]) >>> 0;
      }
      for (t = 16; t < 64; t++) {
        var s0 = rotr(w[t - 15], 7) ^ rotr(w[t - 15], 18) ^ (w[t - 15] >>> 3);
        var s1 = rotr(w[t - 2], 17) ^ rotr(w[t - 2], 19) ^ (w[t - 2] >>> 10);
        w[t] = (w[t - 16] + s0 + w[t - 7] + s1) >>> 0;
      }

      var a = h0, b = h1, c = h2, d = h3, e = h4, f = h5, g = h6, h = h7;
      for (t = 0; t < 64; t++) {
        var S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
        var ch = (e & f) ^ (~e & g);
        var temp1 = (h + S1 + ch + K[t] + w[t]) >>> 0;
        var S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
        var maj = (a & b) ^ (a & c) ^ (b & c);
        var temp2 = (S0 + maj) >>> 0;

        h = g; g = f; f = e; e = (d + temp1) >>> 0;
        d = c; c = b; b = a; a = (temp1 + temp2) >>> 0;
      }

      h0 = (h0 + a) >>> 0; h1 = (h1 + b) >>> 0; h2 = (h2 + c) >>> 0; h3 = (h3 + d) >>> 0;
      h4 = (h4 + e) >>> 0; h5 = (h5 + f) >>> 0; h6 = (h6 + g) >>> 0; h7 = (h7 + h) >>> 0;
    }

    var out = [];
    [h0, h1, h2, h3, h4, h5, h6, h7].forEach(function (word) {
      out.push((word >>> 24) & 0xff, (word >>> 16) & 0xff, (word >>> 8) & 0xff, word & 0xff);
    });
    return out;
  }

  function hmacSha256(keyBytes, msgBytes) {
    var blockSize = 64;
    var key = keyBytes.slice();
    if (key.length > blockSize) {
      key = sha256(key);
    }
    while (key.length < blockSize) {
      key.push(0);
    }
    var oKeyPad = key.map(function (b) { return b ^ 0x5c; });
    var iKeyPad = key.map(function (b) { return b ^ 0x36; });
    return sha256(oKeyPad.concat(sha256(iKeyPad.concat(msgBytes))));
  }

  // PBKDF2-HMAC-SHA256. Returns `keyLen` bytes.
  function pbkdf2(passwordBytes, saltBytes, iterations, keyLen) {
    var hLen = 32;
    var numBlocks = Math.ceil(keyLen / hLen);
    var out = [];
    for (var i = 1; i <= numBlocks; i++) {
      var blockIndex = [(i >>> 24) & 0xff, (i >>> 16) & 0xff, (i >>> 8) & 0xff, i & 0xff];
      var u = hmacSha256(passwordBytes, saltBytes.concat(blockIndex));
      var t = u.slice();
      for (var j = 1; j < iterations; j++) {
        u = hmacSha256(passwordBytes, u);
        for (var k = 0; k < hLen; k++) {
          t[k] ^= u[k];
        }
      }
      out = out.concat(t);
    }
    return out.slice(0, keyLen);
  }

  function utf8ToBytes(str) {
    var bytes = [];
    for (var i = 0; i < str.length; i++) {
      var code = str.codePointAt(i);
      if (code > 0xffff) {
        i++;
      }
      if (code < 0x80) {
        bytes.push(code);
      } else if (code < 0x800) {
        bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
      } else if (code < 0x10000) {
        bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
      } else {
        bytes.push(
          0xf0 | (code >> 18),
          0x80 | ((code >> 12) & 0x3f),
          0x80 | ((code >> 6) & 0x3f),
          0x80 | (code & 0x3f)
        );
      }
    }
    return bytes;
  }

  var api = {
    sha256: sha256,
    hmacSha256: hmacSha256,
    pbkdf2: pbkdf2,
    utf8ToBytes: utf8ToBytes,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.SPCrypto = root.SPCrypto || {};
    root.SPCrypto.sha256lib = api;
  }
})(typeof self !== 'undefined' ? self : this);
