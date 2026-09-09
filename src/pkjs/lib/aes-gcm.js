// Pure-JS AES-128/192/256 and AES-GCM (NIST SP 800-38D), operating on plain
// arrays of bytes (ints 0-255). See sha256.js for why this isn't using
// window.crypto.subtle.
//
// Correctness is verified against Node's native `crypto` module in
// scripts/test-crypto.js - run `node scripts/test-crypto.js` after any
// change to this file.
(function (root) {
  'use strict';

  var SBOX = [
    0x63,0x7c,0x77,0x7b,0xf2,0x6b,0x6f,0xc5,0x30,0x01,0x67,0x2b,0xfe,0xd7,0xab,0x76,
    0xca,0x82,0xc9,0x7d,0xfa,0x59,0x47,0xf0,0xad,0xd4,0xa2,0xaf,0x9c,0xa4,0x72,0xc0,
    0xb7,0xfd,0x93,0x26,0x36,0x3f,0xf7,0xcc,0x34,0xa5,0xe5,0xf1,0x71,0xd8,0x31,0x15,
    0x04,0xc7,0x23,0xc3,0x18,0x96,0x05,0x9a,0x07,0x12,0x80,0xe2,0xeb,0x27,0xb2,0x75,
    0x09,0x83,0x2c,0x1a,0x1b,0x6e,0x5a,0xa0,0x52,0x3b,0xd6,0xb3,0x29,0xe3,0x2f,0x84,
    0x53,0xd1,0x00,0xed,0x20,0xfc,0xb1,0x5b,0x6a,0xcb,0xbe,0x39,0x4a,0x4c,0x58,0xcf,
    0xd0,0xef,0xaa,0xfb,0x43,0x4d,0x33,0x85,0x45,0xf9,0x02,0x7f,0x50,0x3c,0x9f,0xa8,
    0x51,0xa3,0x40,0x8f,0x92,0x9d,0x38,0xf5,0xbc,0xb6,0xda,0x21,0x10,0xff,0xf3,0xd2,
    0xcd,0x0c,0x13,0xec,0x5f,0x97,0x44,0x17,0xc4,0xa7,0x7e,0x3d,0x64,0x5d,0x19,0x73,
    0x60,0x81,0x4f,0xdc,0x22,0x2a,0x90,0x88,0x46,0xee,0xb8,0x14,0xde,0x5e,0x0b,0xdb,
    0xe0,0x32,0x3a,0x0a,0x49,0x06,0x24,0x5c,0xc2,0xd3,0xac,0x62,0x91,0x95,0xe4,0x79,
    0xe7,0xc8,0x37,0x6d,0x8d,0xd5,0x4e,0xa9,0x6c,0x56,0xf4,0xea,0x65,0x7a,0xae,0x08,
    0xba,0x78,0x25,0x2e,0x1c,0xa6,0xb4,0xc6,0xe8,0xdd,0x74,0x1f,0x4b,0xbd,0x8b,0x8a,
    0x70,0x3e,0xb5,0x66,0x48,0x03,0xf6,0x0e,0x61,0x35,0x57,0xb9,0x86,0xc1,0x1d,0x9e,
    0xe1,0xf8,0x98,0x11,0x69,0xd9,0x8e,0x94,0x9b,0x1e,0x87,0xe9,0xce,0x55,0x28,0xdf,
    0x8c,0xa1,0x89,0x0d,0xbf,0xe6,0x42,0x68,0x41,0x99,0x2d,0x0f,0xb0,0x54,0xbb,0x16
  ];

  var RCON = [0x01,0x02,0x04,0x08,0x10,0x20,0x40,0x80,0x1b,0x36,0x6c,0xd8,0xab,0x4d];

  function xtime(a) {
    return ((a << 1) ^ ((a & 0x80) ? 0x1b : 0x00)) & 0xff;
  }

  function gmul(a, b) {
    var p = 0;
    for (var i = 0; i < 8; i++) {
      if (b & 1) {
        p ^= a;
      }
      var hi = a & 0x80;
      a = (a << 1) & 0xff;
      if (hi) {
        a ^= 0x1b;
      }
      b >>= 1;
    }
    return p & 0xff;
  }

  // key: array of 16/24/32 bytes. Returns expanded key as array of words (4-byte arrays).
  function keyExpansion(key) {
    var Nk = key.length / 4;
    var Nr = Nk + 6;
    var Nb = 4;
    var w = new Array(Nb * (Nr + 1));

    for (var i = 0; i < Nk; i++) {
      w[i] = [key[4 * i], key[4 * i + 1], key[4 * i + 2], key[4 * i + 3]];
    }

    for (i = Nk; i < Nb * (Nr + 1); i++) {
      var temp = w[i - 1].slice();
      if (i % Nk === 0) {
        temp = [temp[1], temp[2], temp[3], temp[0]].map(function (b) { return SBOX[b]; });
        temp[0] ^= RCON[i / Nk - 1];
      } else if (Nk > 6 && i % Nk === 4) {
        temp = temp.map(function (b) { return SBOX[b]; });
      }
      w[i] = w[i - Nk].map(function (b, idx) { return b ^ temp[idx]; });
    }
    return { w: w, Nr: Nr, Nb: Nb };
  }

  function addRoundKey(state, w, round, Nb) {
    for (var c = 0; c < Nb; c++) {
      for (var r = 0; r < 4; r++) {
        state[r][c] ^= w[round * Nb + c][r];
      }
    }
  }

  function subBytes(state) {
    for (var r = 0; r < 4; r++) {
      for (var c = 0; c < 4; c++) {
        state[r][c] = SBOX[state[r][c]];
      }
    }
  }

  function shiftRows(state) {
    for (var r = 1; r < 4; r++) {
      var row = state[r];
      state[r] = row.slice(r).concat(row.slice(0, r));
    }
  }

  function mixColumns(state) {
    for (var c = 0; c < 4; c++) {
      var a0 = state[0][c], a1 = state[1][c], a2 = state[2][c], a3 = state[3][c];
      state[0][c] = gmul(a0, 2) ^ gmul(a1, 3) ^ a2 ^ a3;
      state[1][c] = a0 ^ gmul(a1, 2) ^ gmul(a2, 3) ^ a3;
      state[2][c] = a0 ^ a1 ^ gmul(a2, 2) ^ gmul(a3, 3);
      state[3][c] = gmul(a0, 3) ^ a1 ^ a2 ^ gmul(a3, 2);
    }
  }

  // Encrypts exactly one 16-byte block. `expanded` from keyExpansion().
  function encryptBlock(expanded, blockBytes) {
    var Nb = expanded.Nb, Nr = expanded.Nr, w = expanded.w;
    var state = [[], [], [], []];
    for (var i = 0; i < 16; i++) {
      state[i % 4][(i / 4) | 0] = blockBytes[i];
    }

    addRoundKey(state, w, 0, Nb);
    for (var round = 1; round < Nr; round++) {
      subBytes(state);
      shiftRows(state);
      mixColumns(state);
      addRoundKey(state, w, round, Nb);
    }
    subBytes(state);
    shiftRows(state);
    addRoundKey(state, w, Nr, Nb);

    var out = new Array(16);
    for (i = 0; i < 16; i++) {
      out[i] = state[i % 4][(i / 4) | 0];
    }
    return out;
  }

  // ---------------- GF(2^128) multiplication for GHASH ----------------

  function ghashMul(x, y) {
    // x, y: 16-byte arrays, treated as 128-bit numbers, MSB-first, per
    // NIST SP 800-38D section 6.3 (bit-reflected: bit 0 is the MSB).
    var z = new Array(16).fill(0);
    var v = y.slice();

    for (var i = 0; i < 128; i++) {
      var byteIndex = i >> 3;
      var bitIndex = 7 - (i & 7);
      var xBit = (x[byteIndex] >> bitIndex) & 1;
      if (xBit) {
        for (var k = 0; k < 16; k++) {
          z[k] ^= v[k];
        }
      }
      var lsb = v[15] & 1;
      for (var b = 15; b > 0; b--) {
        v[b] = ((v[b] >> 1) | ((v[b - 1] & 1) << 7)) & 0xff;
      }
      v[0] = v[0] >> 1;
      if (lsb) {
        v[0] ^= 0xe1;
      }
    }
    return z;
  }

  function ghash(h, dataBlocks) {
    var y = new Array(16).fill(0);
    for (var i = 0; i < dataBlocks.length; i++) {
      for (var k = 0; k < 16; k++) {
        y[k] ^= dataBlocks[i][k];
      }
      y = ghashMul(y, h);
    }
    return y;
  }

  function toBlocks(bytes) {
    var blocks = [];
    for (var i = 0; i < bytes.length; i += 16) {
      var block = bytes.slice(i, i + 16);
      while (block.length < 16) {
        block.push(0);
      }
      blocks.push(block);
    }
    return blocks;
  }

  function incr32(counterBlock) {
    var out = counterBlock.slice();
    for (var i = 15; i >= 12; i--) {
      out[i] = (out[i] + 1) & 0xff;
      if (out[i] !== 0) {
        break;
      }
    }
    return out;
  }

  function gctr(expanded, icb, input) {
    if (input.length === 0) {
      return [];
    }
    var blocks = toBlocks(input);
    var out = [];
    var counter = icb;
    for (var i = 0; i < blocks.length; i++) {
      var keystream = encryptBlock(expanded, counter);
      var blockLen = i === blocks.length - 1 ? input.length - i * 16 : 16;
      for (var j = 0; j < blockLen; j++) {
        out.push(blocks[i][j] ^ keystream[j]);
      }
      counter = incr32(counter);
    }
    return out;
  }

  function be64(n) {
    // n: byte length (Number, safe for our payload sizes) -> 8-byte big-endian bit length.
    var bits = n * 8;
    var out = new Array(8).fill(0);
    for (var i = 7; i >= 0 && bits > 0; i--) {
      out[i] = bits & 0xff;
      bits = Math.floor(bits / 256);
    }
    return out;
  }

  // 12-byte (96-bit) IV only - the standard case, and what every mainstream
  // AES-GCM implementation (including Node's) defaults to.
  function buildJ0(h, iv) {
    if (iv.length === 12) {
      return iv.concat([0, 0, 0, 1]);
    }
    var blocks = toBlocks(iv);
    var lenBlock = new Array(8).fill(0).concat(be64(iv.length));
    return ghash(h, blocks.concat([lenBlock]));
  }

  function aesGcmEncrypt(key, iv, plaintext, aad) {
    aad = aad || [];
    var expanded = keyExpansion(key);
    var h = encryptBlock(expanded, new Array(16).fill(0));
    var j0 = buildJ0(h, iv);
    var icb = incr32(j0);

    var ciphertext = gctr(expanded, icb, plaintext);

    var aadBlocks = toBlocks(aad);
    var cBlocks = toBlocks(ciphertext);
    var lenBlock = be64(aad.length).concat(be64(ciphertext.length));
    var s = ghash(h, aadBlocks.concat(cBlocks, [lenBlock]));

    var encJ0 = encryptBlock(expanded, j0);
    var tag = s.map(function (b, i) { return b ^ encJ0[i]; });

    return { ciphertext: ciphertext, tag: tag };
  }

  function constantTimeEqual(a, b) {
    if (a.length !== b.length) {
      return false;
    }
    var diff = 0;
    for (var i = 0; i < a.length; i++) {
      diff |= a[i] ^ b[i];
    }
    return diff === 0;
  }

  // Throws if the tag doesn't verify.
  function aesGcmDecrypt(key, iv, ciphertext, tag, aad) {
    aad = aad || [];
    var expanded = keyExpansion(key);
    var h = encryptBlock(expanded, new Array(16).fill(0));
    var j0 = buildJ0(h, iv);

    var aadBlocks = toBlocks(aad);
    var cBlocks = toBlocks(ciphertext);
    var lenBlock = be64(aad.length).concat(be64(ciphertext.length));
    var s = ghash(h, aadBlocks.concat(cBlocks, [lenBlock]));

    var encJ0 = encryptBlock(expanded, j0);
    var expectedTag = s.map(function (b, i) { return b ^ encJ0[i]; });

    if (!constantTimeEqual(expectedTag, tag)) {
      throw new Error('AES-GCM authentication failed (bad key/password or corrupted data)');
    }

    var icb = incr32(j0);
    return gctr(expanded, icb, ciphertext);
  }

  var api = {
    encryptBlock: encryptBlock,
    keyExpansion: keyExpansion,
    aesGcmEncrypt: aesGcmEncrypt,
    aesGcmDecrypt: aesGcmDecrypt,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.SPCrypto = root.SPCrypto || {};
    root.SPCrypto.aesGcm = api;
  }
})(typeof self !== 'undefined' ? self : this);
