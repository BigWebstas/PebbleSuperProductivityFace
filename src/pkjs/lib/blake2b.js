// Dependency-free BLAKE2b (RFC 7693), unkeyed, sequential mode, output length
// 1-64 bytes. Needed as the building block for argon2id.js (Argon2's H0 and
// the H' variable-length hash are both defined in terms of BLAKE2b).
//
// 64-bit words are represented as [hi, lo] pairs of unsigned 32-bit numbers
// (matching the plain-32-bit-word style already used in sha256.js/
// aes-gcm.js), not BigInt: the Pebble build toolchain's bundler (an old
// acorn/webpack that predates ES2020) fails to even parse BigInt literal
// syntax, and the phone JS engines this targets can't be assumed to support
// the BigInt type at runtime either.
//
// Verified against hash-wasm's blake2b() output - see scripts/test-argon2.js.
'use strict';

// IV[i] = [hi, lo]
var IV = [
  [0x6a09e667, 0xf3bcc908], [0xbb67ae85, 0x84caa73b],
  [0x3c6ef372, 0xfe94f82b], [0xa54ff53a, 0x5f1d36f1],
  [0x510e527f, 0xade682d1], [0x9b05688c, 0x2b3e6c1f],
  [0x1f83d9ab, 0xfb41bd6b], [0x5be0cd19, 0x137e2179],
];

var SIGMA = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
  [14, 10, 4, 8, 9, 15, 13, 6, 1, 12, 0, 2, 11, 7, 5, 3],
  [11, 8, 12, 0, 5, 2, 15, 13, 10, 14, 3, 6, 7, 1, 9, 4],
  [7, 9, 3, 1, 13, 12, 11, 14, 2, 6, 5, 10, 4, 0, 15, 8],
  [9, 0, 5, 7, 2, 4, 10, 15, 14, 1, 11, 12, 6, 8, 3, 13],
  [2, 12, 6, 10, 0, 11, 8, 3, 4, 13, 7, 5, 15, 14, 1, 9],
  [12, 5, 1, 15, 14, 13, 4, 10, 0, 7, 6, 3, 9, 2, 8, 11],
  [13, 11, 7, 14, 12, 1, 3, 9, 5, 0, 15, 4, 8, 6, 2, 10],
  [6, 15, 14, 9, 11, 3, 0, 8, 12, 2, 13, 7, 1, 4, 10, 5],
  [10, 2, 8, 4, 7, 6, 1, 5, 15, 11, 9, 14, 3, 12, 13, 0],
];

// ---------------- 64-bit word helpers (each word: [hi, lo], both >>> 0) ----

function add64(a, b) {
  var lo = (a[1] >>> 0) + (b[1] >>> 0);
  var carry = lo > 0xffffffff ? 1 : 0;
  var loOut = lo >>> 0;
  var hi = ((a[0] >>> 0) + (b[0] >>> 0) + carry) >>> 0;
  return [hi, loOut];
}

function xor64(a, b) {
  return [(a[0] ^ b[0]) >>> 0, (a[1] ^ b[1]) >>> 0];
}

function not64(a) {
  return [(~a[0]) >>> 0, (~a[1]) >>> 0];
}

// Rotate-right by exactly 32, 24, 16, or 63 bits - the only amounts BLAKE2b
// and Argon2's GB function ever use.
function rotr32(a) {
  return [a[1], a[0]];
}
function rotr24(a) {
  var hi = ((a[0] >>> 24) | (a[1] << 8)) >>> 0;
  var lo = ((a[1] >>> 24) | (a[0] << 8)) >>> 0;
  return [hi, lo];
}
function rotr16(a) {
  var hi = ((a[0] >>> 16) | (a[1] << 16)) >>> 0;
  var lo = ((a[1] >>> 16) | (a[0] << 16)) >>> 0;
  return [hi, lo];
}
// rotr by 63 == rotl by 1.
function rotr63(a) {
  var hi = ((a[0] << 1) | (a[1] >>> 31)) >>> 0;
  var lo = ((a[1] << 1) | (a[0] >>> 31)) >>> 0;
  return [hi, lo];
}

function g(v, a, b, c, d, x, y) {
  v[a] = add64(add64(v[a], v[b]), x);
  v[d] = rotr32(xor64(v[d], v[a]));
  v[c] = add64(v[c], v[d]);
  v[b] = rotr24(xor64(v[b], v[c]));
  v[a] = add64(add64(v[a], v[b]), y);
  v[d] = rotr16(xor64(v[d], v[a]));
  v[c] = add64(v[c], v[d]);
  v[b] = rotr63(xor64(v[b], v[c]));
}

function compress(h, block, t, isFinal) {
  var m = new Array(16);
  var i;
  for (i = 0; i < 16; i++) {
    m[i] = readU64LE(block, i * 8);
  }
  var v = new Array(16);
  for (i = 0; i < 8; i++) {
    v[i] = h[i];
    v[i + 8] = IV[i];
  }
  v[12] = xor64(v[12], t);
  v[13] = xor64(v[13], [0, 0]);
  if (isFinal) {
    v[14] = not64(v[14]);
  }
  for (var round = 0; round < 12; round++) {
    var s = SIGMA[round % 10];
    g(v, 0, 4, 8, 12, m[s[0]], m[s[1]]);
    g(v, 1, 5, 9, 13, m[s[2]], m[s[3]]);
    g(v, 2, 6, 10, 14, m[s[4]], m[s[5]]);
    g(v, 3, 7, 11, 15, m[s[6]], m[s[7]]);
    g(v, 0, 5, 10, 15, m[s[8]], m[s[9]]);
    g(v, 1, 6, 11, 12, m[s[10]], m[s[11]]);
    g(v, 2, 7, 8, 13, m[s[12]], m[s[13]]);
    g(v, 3, 4, 9, 14, m[s[14]], m[s[15]]);
  }
  for (i = 0; i < 8; i++) {
    h[i] = xor64(xor64(h[i], v[i]), v[i + 8]);
  }
}

function readU64LE(bytes, offset) {
  var lo =
    ((bytes[offset] |
      (bytes[offset + 1] << 8) |
      (bytes[offset + 2] << 16) |
      (bytes[offset + 3] << 24)) >>>
    0);
  var hi =
    ((bytes[offset + 4] |
      (bytes[offset + 5] << 8) |
      (bytes[offset + 6] << 16) |
      (bytes[offset + 7] << 24)) >>>
    0);
  return [hi, lo];
}

function writeU64LE(out, offset, word) {
  var hi = word[0] >>> 0;
  var lo = word[1] >>> 0;
  out[offset] = lo & 0xff;
  out[offset + 1] = (lo >>> 8) & 0xff;
  out[offset + 2] = (lo >>> 16) & 0xff;
  out[offset + 3] = (lo >>> 24) & 0xff;
  out[offset + 4] = hi & 0xff;
  out[offset + 5] = (hi >>> 8) & 0xff;
  out[offset + 6] = (hi >>> 16) & 0xff;
  out[offset + 7] = (hi >>> 24) & 0xff;
}

// t (byte counter) is tracked as a [hi, lo] pair via add64, matching the
// other 64-bit words - our inputs are always far below 2^64 bytes so hi
// only ever matters for correctness-by-construction, never actual carries
// in practice, but tracking it properly costs nothing.
function addToCounter(t, n) {
  return add64(t, [0, n >>> 0]);
}

// bytes: Array/Uint8Array of input bytes. outLen: desired digest length, 1-64.
function blake2b(bytes, outLen) {
  if (outLen < 1 || outLen > 64) {
    throw new Error('blake2b: outLen must be between 1 and 64');
  }
  var h = new Array(8);
  var i;
  for (i = 0; i < 8; i++) {
    h[i] = IV[i];
  }
  // Parameter block (fanout=1, depth=1, keyLen=0, digestLen=outLen) fits
  // entirely in the low 32 bits.
  h[0] = xor64(h[0], [0, (0x01010000 | outLen) >>> 0]);

  var len = bytes.length;
  var block = new Array(128);
  var t = [0, 0];

  var offset = 0;
  if (len === 0) {
    for (i = 0; i < 128; i++) {
      block[i] = 0;
    }
    compress(h, block, t, true);
  } else {
    while (offset + 128 < len) {
      for (i = 0; i < 128; i++) {
        block[i] = bytes[offset + i];
      }
      t = addToCounter(t, 128);
      compress(h, block, t, false);
      offset += 128;
    }
    var remaining = len - offset;
    for (i = 0; i < 128; i++) {
      block[i] = i < remaining ? bytes[offset + i] : 0;
    }
    t = addToCounter(t, remaining);
    compress(h, block, t, true);
  }

  var out = new Array(64);
  for (i = 0; i < 8; i++) {
    writeU64LE(out, i * 8, h[i]);
  }
  return out.slice(0, outLen);
}

module.exports = {
  blake2b: blake2b,
  // 64-bit-word helpers, reused by argon2id.js's block-compression function
  // (which needs the same [hi,lo]-pair arithmetic plus one extra op,
  // fBlaMka's multiply, that argon2id.js defines itself).
  add64: add64,
  xor64: xor64,
  rotr32: rotr32,
  rotr24: rotr24,
  rotr16: rotr16,
  rotr63: rotr63,
};
