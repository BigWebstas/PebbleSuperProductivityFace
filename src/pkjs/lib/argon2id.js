// Dependency-free Argon2id (RFC 9106), specialized for parallelism=1 - which
// is a hardcoded constant in Super Productivity's client
// (packages/sync-core/src/encryption/argon2.ts DEFAULT_ARGON2_PARAMS), not a
// per-account setting, so a single-lane implementation covers every account.
// This drops all cross-lane referencing/synchronization from the general
// spec, which is otherwise unused here.
//
// 64-bit words are [hi, lo] pairs of unsigned 32-bit numbers, not BigInt -
// see the top-of-file comment in blake2b.js for why (the Pebble build
// toolchain's bundler can't even parse BigInt literal syntax).
//
// Verified against hash-wasm's argon2id() output, including production
// parameters (parallelism=1, iterations=3, memorySize=65536 KiB) - see
// scripts/test-argon2.js.
'use strict';

var blake2bLib = require('./blake2b.js');
var blake2b = blake2bLib.blake2b;
var add64 = blake2bLib.add64;
var xor64 = blake2bLib.xor64;
var rotr32 = blake2bLib.rotr32;
var rotr24 = blake2bLib.rotr24;
var rotr16 = blake2bLib.rotr16;
var rotr63 = blake2bLib.rotr63;

var BLOCK_WORDS = 128; // 1024 bytes / 8
var ARGON2_TYPE_ID = 2;
var ARGON2_VERSION = 0x13;

// Unsigned 32x32 -> 64-bit multiply, done via 16-bit splits and plain
// (non-bitwise) arithmetic throughout: intermediate values here exceed 2^32
// and the `>>>`/`<<` operators silently reduce mod 2^32 *before* shifting,
// which would be wrong here. Math.floor/% keep everything exact (all
// intermediates stay well under 2^53, safe for doubles).
function mul32(aLo, bLo) {
  var aH = (aLo >>> 16) & 0xffff;
  var aL = aLo & 0xffff;
  var bH = (bLo >>> 16) & 0xffff;
  var bL = bLo & 0xffff;

  var p0 = aL * bL;
  var p1 = aH * bL + aL * bH;
  var p2 = aH * bH;

  var lowFull = p0 + (p1 % 65536) * 65536;
  var lo = lowFull % 4294967296;
  var carry = Math.floor(lowFull / 4294967296);
  var hiFull = p2 + Math.floor(p1 / 65536) + carry;
  var hi = hiFull % 4294967296;

  return [hi >>> 0, lo >>> 0];
}

// Argon2's own mixing primitive (RFC 9106 SS3.5): like BLAKE2b's G, but with
// an extra "multiply the low 32 bits of both operands, double it, add it in"
// step folded into each addition - this is the one place Argon2 diverges
// from plain BLAKE2b arithmetic.
function fBlaMka(x, y) {
  var product = mul32(x[1], y[1]);
  var doubled = add64(product, product);
  return add64(add64(x, y), doubled);
}

function gMix(v, a, b, c, d) {
  v[a] = fBlaMka(v[a], v[b]);
  v[d] = rotr32(xor64(v[d], v[a]));
  v[c] = fBlaMka(v[c], v[d]);
  v[b] = rotr24(xor64(v[b], v[c]));
  v[a] = fBlaMka(v[a], v[b]);
  v[d] = rotr16(xor64(v[d], v[a]));
  v[c] = fBlaMka(v[c], v[d]);
  v[b] = rotr63(xor64(v[b], v[c]));
}

// Applies the 8-call G pattern to one group of 16 words (in place).
function permuteGroup(v, i0, i1, i2, i3, i4, i5, i6, i7, i8, i9, i10, i11, i12, i13, i14, i15) {
  var idx = [i0, i1, i2, i3, i4, i5, i6, i7, i8, i9, i10, i11, i12, i13, i14, i15];
  var w = idx.map(function (i) { return v[i]; });
  gMix(w, 0, 4, 8, 12);
  gMix(w, 1, 5, 9, 13);
  gMix(w, 2, 6, 10, 14);
  gMix(w, 3, 7, 11, 15);
  gMix(w, 0, 5, 10, 15);
  gMix(w, 1, 6, 11, 12);
  gMix(w, 2, 7, 8, 13);
  gMix(w, 3, 4, 9, 14);
  for (var k = 0; k < 16; k++) {
    v[idx[k]] = w[k];
  }
}

// The Argon2 block permutation P: row-wise groups, then the strided
// "diagonal" groups - matches the reference implementation's fill_block().
function permuteBlock(r) {
  var i;
  for (i = 0; i < 8; i++) {
    var b = 16 * i;
    permuteGroup(r, b, b + 1, b + 2, b + 3, b + 4, b + 5, b + 6, b + 7, b + 8, b + 9, b + 10, b + 11, b + 12, b + 13, b + 14, b + 15);
  }
  for (i = 0; i < 8; i++) {
    var c = 2 * i;
    permuteGroup(
      r,
      c, c + 1,
      c + 16, c + 17,
      c + 32, c + 33,
      c + 48, c + 49,
      c + 64, c + 65,
      c + 80, c + 81,
      c + 96, c + 97,
      c + 112, c + 113
    );
  }
}

// Argon2's compression function G(X, Y) -> new 1024-byte block (as 128
// [hi,lo]-word pairs). If xorInto is given, the result is XORed into it in
// place (used for pass > 0, where new values accumulate onto old ones)
// instead of producing a fresh block.
function compressBlocks(x, y, xorInto) {
  var r = new Array(BLOCK_WORDS);
  var i;
  for (i = 0; i < BLOCK_WORDS; i++) {
    r[i] = xor64(x[i], y[i]);
  }
  var z = r.slice();
  permuteBlock(z);
  if (xorInto) {
    for (i = 0; i < BLOCK_WORDS; i++) {
      xorInto[i] = xor64(xor64(xorInto[i], r[i]), z[i]);
    }
    return xorInto;
  }
  var out = new Array(BLOCK_WORDS);
  for (i = 0; i < BLOCK_WORDS; i++) {
    out[i] = xor64(r[i], z[i]);
  }
  return out;
}

function zeroBlock() {
  var b = new Array(BLOCK_WORDS);
  for (var i = 0; i < BLOCK_WORDS; i++) {
    b[i] = [0, 0];
  }
  return b;
}

function blockToBytes(block) {
  var out = new Array(1024);
  for (var i = 0; i < BLOCK_WORDS; i++) {
    var hi = block[i][0] >>> 0;
    var lo = block[i][1] >>> 0;
    var o = i * 8;
    out[o] = lo & 0xff;
    out[o + 1] = (lo >>> 8) & 0xff;
    out[o + 2] = (lo >>> 16) & 0xff;
    out[o + 3] = (lo >>> 24) & 0xff;
    out[o + 4] = hi & 0xff;
    out[o + 5] = (hi >>> 8) & 0xff;
    out[o + 6] = (hi >>> 16) & 0xff;
    out[o + 7] = (hi >>> 24) & 0xff;
  }
  return out;
}

function bytesToBlock(bytes) {
  var out = new Array(BLOCK_WORDS);
  for (var i = 0; i < BLOCK_WORDS; i++) {
    var o = i * 8;
    var lo = (bytes[o] | (bytes[o + 1] << 8) | (bytes[o + 2] << 16) | (bytes[o + 3] << 24)) >>> 0;
    var hi = (bytes[o + 4] | (bytes[o + 5] << 8) | (bytes[o + 6] << 16) | (bytes[o + 7] << 24)) >>> 0;
    out[i] = [hi, lo];
  }
  return out;
}

function u32le(n) {
  n = n >>> 0;
  return [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff];
}

function concatBytes(arrays) {
  var total = 0;
  var i;
  for (i = 0; i < arrays.length; i++) {
    total += arrays[i].length;
  }
  var out = new Array(total);
  var offset = 0;
  for (i = 0; i < arrays.length; i++) {
    var a = arrays[i];
    for (var k = 0; k < a.length; k++) {
      out[offset++] = a[k];
    }
  }
  return out;
}

// Argon2's variable-length hash H', built from BLAKE2b (RFC 9106 SS3.3).
function hPrime(input, outLen) {
  if (outLen <= 64) {
    return blake2b(concatBytes([u32le(outLen), input]), outLen);
  }
  var out = [];
  var vPrev = blake2b(concatBytes([u32le(outLen), input]), 64);
  out = out.concat(vPrev.slice(0, 32));
  var remaining = outLen - 32;
  while (remaining > 64) {
    vPrev = blake2b(vPrev, 64);
    out = out.concat(vPrev.slice(0, 32));
    remaining -= 32;
  }
  var last = blake2b(vPrev, remaining);
  out = out.concat(last);
  return out;
}

// Squaring-bias reference-position selection (RFC 9106 SS3.4.1.3), specialized
// for a single lane (referenceAreaSize always refers to positions within the
// only lane there is). j1 is an unsigned 32-bit value; j1^2 can be up to
// ~2^64, well past Number's exact-integer range (2^53), so the square is
// computed via the same 16-bit-split technique as mul32 (in argon2id.js's
// fBlaMka), keeping only the high 32 bits, which is all this needs.
function indexAlpha(pass, slice, segmentLength, laneLength, j1, referenceAreaSize) {
  var j1Unsigned = j1 >>> 0;
  var aH = (j1Unsigned >>> 16) & 0xffff;
  var aL = j1Unsigned & 0xffff;
  var p0 = aL * aL;
  var p1 = 2 * aH * aL;
  var p2 = aH * aH;
  var lowFull = p0 + (p1 % 65536) * 65536;
  var carry = Math.floor(lowFull / 4294967296);
  var relHigh = p2 + Math.floor(p1 / 65536) + carry;

  var relativePosition = referenceAreaSize - 1 - Math.floor((referenceAreaSize * relHigh) / 4294967296);

  var startPosition = pass === 0 ? 0 : ((slice + 1) % 4) * segmentLength;
  return (startPosition + relativePosition) % laneLength;
}

function referenceAreaSize(pass, slice, segmentLength, index) {
  if (pass === 0) {
    if (slice === 0) {
      return index - 1;
    }
    return slice * segmentLength + index - 1;
  }
  return segmentLength * 3 + index - 1; // laneLength - segmentLength + index - 1, single lane
}

// Generates one address block's worth (128 entries) of data-independent
// (J1, J2) pairs for Argon2i-style indexing (RFC 9106 SS3.3.1), single lane.
function generateAddressBlock(pass, slice, laneLength, iterations, counter) {
  var inputBlock = zeroBlock();
  inputBlock[0] = [0, pass >>> 0];
  inputBlock[1] = [0, 0]; // lane
  inputBlock[2] = [0, slice >>> 0];
  inputBlock[3] = [0, laneLength >>> 0];
  inputBlock[4] = [0, iterations >>> 0];
  inputBlock[5] = [0, ARGON2_TYPE_ID];
  inputBlock[6] = [0, counter >>> 0];
  inputBlock[7] = [0, 0];
  var zero = zeroBlock();
  var tmp = compressBlocks(zero, inputBlock, null);
  return compressBlocks(zero, tmp, null);
}

// password, salt: byte arrays. Returns a byte array of length hashLength.
function argon2id(password, salt, opts) {
  var parallelism = 1;
  var iterations = opts.iterations;
  var memoryKiB = opts.memorySize;
  var hashLength = opts.hashLength;

  var memoryBlocks = Math.floor(memoryKiB / (4 * parallelism)) * 4 * parallelism;
  if (memoryBlocks < 8) {
    memoryBlocks = 8;
  }
  var laneLength = memoryBlocks; // parallelism === 1
  var segmentLength = Math.floor(laneLength / 4);

  var h0 = blake2b(
    concatBytes([
      u32le(parallelism),
      u32le(hashLength),
      u32le(memoryKiB),
      u32le(iterations),
      u32le(ARGON2_VERSION),
      u32le(ARGON2_TYPE_ID),
      u32le(password.length),
      password,
      u32le(salt.length),
      salt,
      u32le(0), // secret key length
      u32le(0), // associated data length
    ]),
    64
  );

  var memory = new Array(memoryBlocks);
  memory[0] = bytesToBlock(hPrime(concatBytes([h0, u32le(0), u32le(0)]), 1024));
  memory[1] = bytesToBlock(hPrime(concatBytes([h0, u32le(1), u32le(0)]), 1024));

  for (var pass = 0; pass < iterations; pass++) {
    for (var slice = 0; slice < 4; slice++) {
      var dataIndependent = pass === 0 && slice < 2;
      // Address blocks are keyed to (pass, lane, slice, counter) in the
      // spec's own input_block, so this state is per-slice, not shared
      // across the slice0/1 boundary.
      var addressBlock = null;
      var addressCounter = 0;

      var startIndex = pass === 0 && slice === 0 ? 2 : 0;
      for (var idxInSlice = startIndex; idxInSlice < segmentLength; idxInSlice++) {
        var j = slice * segmentLength + idxInSlice;
        var prevIndex = j === 0 ? laneLength - 1 : j - 1;

        var j1;
        if (dataIndependent) {
          var posInBlock = idxInSlice % 128;
          if (addressBlock === null || posInBlock === 0) {
            addressCounter++;
            addressBlock = generateAddressBlock(pass, slice, laneLength, iterations, addressCounter);
          }
          j1 = addressBlock[posInBlock][1]; // low 32 bits of the word
        } else {
          j1 = memory[prevIndex][0][1];
        }

        var areaSize = referenceAreaSize(pass, slice, segmentLength, idxInSlice);
        var refIndex = indexAlpha(pass, slice, segmentLength, laneLength, j1, areaSize);

        var withXor = pass > 0;
        var target = withXor ? memory[j] : null;
        var result = compressBlocks(memory[prevIndex], memory[refIndex], target);
        if (!withXor) {
          memory[j] = result;
        }
      }
    }
  }

  var finalBlock = memory[laneLength - 1]; // single lane: no cross-lane XOR needed
  return hPrime(blockToBytes(finalBlock), hashLength);
}

module.exports = {
  argon2id: argon2id,
};
