// Thin client for the SuperSync REST API (packages/super-sync-server in the
// super-productivity repo), plus the E2EE payload encrypt/decrypt helpers.
//
// Routes, auth scheme, GET /api/sync/ops's response shape, and the E2EE wire
// format/KDF below are all confirmed against
// packages/sync-core/src/encryption.ts and encryption/argon2.ts in the
// super-productivity/super-productivity GitHub repo (see README.md's "What
// is verified vs. assumed" section) - see task-store.js for the confirmed
// Operation field names (opType/entityType/isPayloadEncrypted, not
// type/entityType/encrypted, and entries are wrapped as
// { serverSeq, op, receivedAt }).
//
// Wire format (base64-encoded on the wire):
//   Argon2id ciphertext : [16-byte salt][12-byte IV][AES-GCM ciphertext+tag]
//   Legacy PBKDF2        : [12-byte IV][AES-GCM ciphertext+tag]
// Format is picked by length: < 28 bytes invalid, < 44 bytes legacy,
// otherwise Argon2id (matches encryption/web-crypto.ts's detectFormat()).
// All new encryptions use Argon2id; legacy only matters for old data.
//
// KDF parameters (packages/sync-core/src/encryption/argon2.ts
// DEFAULT_ARGON2_PARAMS / legacy.ts's PBKDF2 call):
//   Argon2id: parallelism=1 (a hardcoded app constant - argon2id.js is
//             specialized for this), iterations=3, memorySize=65536 KiB,
//             32-byte key.
//   Legacy:   PBKDF2-HMAC-SHA256, salt = utf8(password) itself (not the
//             email - insecure, kept only for backward compatibility),
//             1000 iterations, 32-byte key.
// GET /api/sync/restore/:serverSeq is confirmed to reject E2EE accounts
// outright (400 ENCRYPTED_OPS_NOT_SUPPORTED) - index.js no longer treats
// that as a sync failure, it falls through to a full ops replay instead.
'use strict';

var aesGcm = require('./aes-gcm.js');
var sha256lib = require('./sha256.js');
var base64 = require('./base64.js');
var argon2Lib = require('./argon2id.js');

var DEFAULT_BASE_URL = 'https://sync.super-productivity.com';

var SALT_LENGTH = 16;
var IV_LENGTH = 12;
var TAG_LENGTH = 16;
var MIN_ARGON2_SIZE = SALT_LENGTH + IV_LENGTH + TAG_LENGTH;
var MIN_LEGACY_SIZE = IV_LENGTH + TAG_LENGTH;
var ARGON2_PARAMS = { parallelism: 1, iterations: 3, memorySize: 65536, hashLength: 32 };
var LEGACY_PBKDF2_ITERATIONS = 1000;
var LEGACY_KEY_LEN = 32;

function randomBytes(n) {
  var out = new Array(n);
  for (var i = 0; i < n; i++) {
    out[i] = Math.floor(Math.random() * 256);
  }
  return out;
}

function deriveArgon2Key(password, salt) {
  return argon2Lib.argon2id(sha256lib.utf8ToBytes(password), salt, ARGON2_PARAMS);
}

function deriveLegacyKey(password) {
  var salt = sha256lib.utf8ToBytes(password);
  return sha256lib.pbkdf2(sha256lib.utf8ToBytes(password), salt, LEGACY_PBKDF2_ITERATIONS, LEGACY_KEY_LEN);
}

// Argon2id is expensive (multi-second on real hardware at these params), so
// derived keys are cached per (password, salt) for the lifetime of this
// object - mirrors encryption/session-cache.ts's rationale. One crypto
// instance is created per pairing/password in index.js and reused across an
// entire sync session.
//
// `persistence` (all fields optional) lets index.js push that per-salt cache
// out to localStorage so it also survives across pkjs sessions - the JS VM
// is torn down every time the watchapp closes, so without this every app
// open that syncs re-runs Argon2id for salts an earlier session already
// paid for (each SuperSync client session encrypts all its ops under one
// salt, so even "3 new ops from the desktop" costs a full derivation):
//   loadKeys()            -> { base64(salt): base64(key), ... } seeded in
//   saveKey(b64salt, b64key)  called once per newly-derived salt
//   loadEncryptSalt()     -> base64(salt) this client last encrypted under,
//                            reused so the first watch toggle after an app
//                            launch doesn't derive a fresh random salt
//   saveEncryptSalt(b64salt)
function createCrypto(password, persistence) {
  persistence = persistence || {};
  var decryptKeyCache = {}; // base64(salt) -> derived key bytes
  var legacyKey = null;
  var encryptSalt = null;
  var encryptKey = null;

  if (persistence.loadKeys) {
    var persisted = persistence.loadKeys() || {};
    Object.keys(persisted).forEach(function (b64salt) {
      try {
        decryptKeyCache[b64salt] = base64.base64ToBytes(persisted[b64salt]);
      } catch (e) {
        // a corrupt entry just means that salt gets re-derived - ignore
      }
    });
  }

  function rememberKey(b64salt, keyBytes) {
    if (persistence.saveKey) {
      try {
        persistence.saveKey(b64salt, base64.bytesToBase64(keyBytes));
      } catch (e) {
        // persistence is best-effort; the in-memory cache still works
      }
    }
  }

  function getArgon2KeyForSalt(salt) {
    var cacheKey = base64.bytesToBase64(salt);
    if (!decryptKeyCache[cacheKey]) {
      decryptKeyCache[cacheKey] = deriveArgon2Key(password, salt);
      rememberKey(cacheKey, decryptKeyCache[cacheKey]);
    }
    return decryptKeyCache[cacheKey];
  }

  function getLegacyKey() {
    if (!legacyKey) {
      legacyKey = deriveLegacyKey(password);
    }
    return legacyKey;
  }

  function decrypt(payloadBase64) {
    var bytes = base64.base64ToBytes(payloadBase64);
    var iv, ciphertext, tag, key;
    if (bytes.length >= MIN_ARGON2_SIZE) {
      var salt = bytes.slice(0, SALT_LENGTH);
      iv = bytes.slice(SALT_LENGTH, SALT_LENGTH + IV_LENGTH);
      var rest = bytes.slice(SALT_LENGTH + IV_LENGTH);
      ciphertext = rest.slice(0, rest.length - TAG_LENGTH);
      tag = rest.slice(rest.length - TAG_LENGTH);
      key = getArgon2KeyForSalt(salt);
    } else if (bytes.length >= MIN_LEGACY_SIZE) {
      iv = bytes.slice(0, IV_LENGTH);
      var rest2 = bytes.slice(IV_LENGTH);
      ciphertext = rest2.slice(0, rest2.length - TAG_LENGTH);
      tag = rest2.slice(rest2.length - TAG_LENGTH);
      key = getLegacyKey();
    } else {
      throw new Error('encrypted payload too short (' + bytes.length + ' bytes)');
    }
    var plaintextBytes = aesGcm.aesGcmDecrypt(key, iv, ciphertext, tag, []);
    return JSON.parse(bytesToUtf8(plaintextBytes));
  }

  function encrypt(obj) {
    if (!encryptKey) {
      // Reuse the salt this client last encrypted under (persisted across
      // pkjs sessions) rather than a fresh random one - its derived key is
      // then almost always already in decryptKeyCache (seeded from
      // persistence above, or from decrypting our own prior ops back down),
      // so the common "toggle a task on the watch -> upload" path pays no
      // Argon2id at all after the first ever sync.
      var reusedSalt = persistence.loadEncryptSalt && persistence.loadEncryptSalt();
      if (reusedSalt) {
        try {
          encryptSalt = base64.base64ToBytes(reusedSalt);
          if (encryptSalt.length !== SALT_LENGTH) {
            encryptSalt = null;
          }
        } catch (e) {
          encryptSalt = null;
        }
      }
      if (!encryptSalt) {
        encryptSalt = randomBytes(SALT_LENGTH);
        if (persistence.saveEncryptSalt) {
          try {
            persistence.saveEncryptSalt(base64.bytesToBase64(encryptSalt));
          } catch (e) {
            // best-effort - a fresh salt next session just costs one derive
          }
        }
      }
      var b64EncryptSalt = base64.bytesToBase64(encryptSalt);
      if (decryptKeyCache[b64EncryptSalt]) {
        encryptKey = decryptKeyCache[b64EncryptSalt];
      } else {
        encryptKey = deriveArgon2Key(password, encryptSalt);
        // Seed the decrypt cache too, so decrypting this same op back down
        // (e.g. on the next sync, after uploading a task toggle) doesn't
        // blindly re-run Argon2id for a salt we already paid to derive.
        decryptKeyCache[b64EncryptSalt] = encryptKey;
        rememberKey(b64EncryptSalt, encryptKey);
      }
    }
    var plaintext = sha256lib.utf8ToBytes(JSON.stringify(obj));
    var iv = randomBytes(IV_LENGTH);
    var result = aesGcm.aesGcmEncrypt(encryptKey, iv, plaintext, []);
    return base64.bytesToBase64(encryptSalt.concat(iv).concat(result.ciphertext).concat(result.tag));
  }

  // True when decrypt(payloadBase64) would hit the per-salt key cache rather
  // than run a fresh Argon2id derivation. The live-tracking presence path
  // (presence-client.js) uses this to avoid a multi-second (phone: tens of
  // seconds) synchronous KDF stall inside a WebSocket onmessage handler -
  // presence messages from another device are encrypted under THAT device's
  // session salt, which is only in cache if a normal op sync already pulled
  // (and decrypted) that device's ops. A miss means "show it opaquely", not
  // "block the socket to derive". Legacy-format blobs use PBKDF2-1000, cheap
  // enough to treat as always-decryptable.
  function canDecryptWithoutDerive(payloadBase64) {
    var bytes;
    try {
      bytes = base64.base64ToBytes(payloadBase64);
    } catch (e) {
      return false;
    }
    if (bytes.length < MIN_ARGON2_SIZE) {
      return bytes.length >= MIN_LEGACY_SIZE;
    }
    var b64salt = base64.bytesToBase64(bytes.slice(0, SALT_LENGTH));
    return !!decryptKeyCache[b64salt];
  }

  return { decrypt: decrypt, encrypt: encrypt, canDecryptWithoutDerive: canDecryptWithoutDerive };
}

function bytesToUtf8(bytes) {
  // Minimal UTF-8 decoder (inverse of sha256lib.utf8ToBytes).
  var out = '';
  var i = 0;
  while (i < bytes.length) {
    var b0 = bytes[i];
    if (b0 < 0x80) {
      out += String.fromCharCode(b0);
      i += 1;
    } else if ((b0 & 0xe0) === 0xc0) {
      out += String.fromCharCode(((b0 & 0x1f) << 6) | (bytes[i + 1] & 0x3f));
      i += 2;
    } else if ((b0 & 0xf0) === 0xe0) {
      out += String.fromCharCode(
        ((b0 & 0x0f) << 12) | ((bytes[i + 1] & 0x3f) << 6) | (bytes[i + 2] & 0x3f)
      );
      i += 3;
    } else {
      var cp =
        ((b0 & 0x07) << 18) |
        ((bytes[i + 1] & 0x3f) << 12) |
        ((bytes[i + 2] & 0x3f) << 6) |
        (bytes[i + 3] & 0x3f);
      out += String.fromCodePoint(cp);
      i += 4;
    }
  }
  return out;
}

// ---------------- HTTP ----------------

function request(method, baseUrl, path, token, body) {
  return new Promise(function (resolve, reject) {
    var xhr = new XMLHttpRequest();
    xhr.open(method, baseUrl + path, true);
    xhr.setRequestHeader('Content-Type', 'application/json');
    if (token) {
      xhr.setRequestHeader('Authorization', 'Bearer ' + token);
    }
    xhr.onload = function () {
      var responseBody;
      try {
        responseBody = xhr.responseText ? JSON.parse(xhr.responseText) : null;
      } catch (e) {
        responseBody = xhr.responseText;
      }
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(responseBody);
      } else {
        // Prefer the server's own explanation (e.g. which field failed
        // validation) over a bare status code - this is the only signal
        // available for debugging the "assumed" wire-format details
        // documented at the top of this file, short of a live account.
        var detail = (responseBody && typeof responseBody === 'object' && responseBody.error) ?
          responseBody.error : (method + ' ' + path);
        var err = new Error(xhr.status + ' ' + detail);
        err.status = xhr.status;
        err.body = responseBody;
        reject(err);
      }
    };
    xhr.onerror = function () {
      reject(new Error('Network error calling ' + path));
    };
    xhr.ontimeout = function () {
      reject(new Error('Timed out calling ' + path));
    };
    xhr.timeout = 15000;
    xhr.send(body ? JSON.stringify(body) : undefined);
  });
}

function SuperSyncClient(opts) {
  this.baseUrl = (opts && opts.baseUrl) || DEFAULT_BASE_URL;
  this.token = opts && opts.token;
}

// excludeClient is deliberately unused by index.js's doSync() - unlike every
// other route/field in this file, that query param's filtering semantics
// were never checked against live traffic, and a mismatch there was the
// likely cause of a real bug (other devices' completed-task changes not
// coming back down). Left supported here, rather than removed outright, in
// case it's ever re-verified against a real account and worth re-enabling.
SuperSyncClient.prototype.downloadOps = function (sinceSeq, excludeClient, limit) {
  var qs = '?sinceSeq=' + encodeURIComponent(sinceSeq);
  if (limit) {
    qs += '&limit=' + limit;
  }
  if (excludeClient) {
    qs += '&excludeClient=' + encodeURIComponent(excludeClient);
  }
  return request('GET', this.baseUrl, '/api/sync/ops' + qs, this.token);
};

SuperSyncClient.prototype.uploadOps = function (ops, clientId, lastKnownServerSeq) {
  return request('POST', this.baseUrl, '/api/sync/ops', this.token, {
    ops: ops,
    clientId: clientId,
    lastKnownServerSeq: lastKnownServerSeq,
  });
};

SuperSyncClient.prototype.getRestorePoints = function (limit) {
  var qs = limit ? '?limit=' + limit : '';
  return request('GET', this.baseUrl, '/api/sync/restore-points' + qs, this.token);
};

SuperSyncClient.prototype.restoreSnapshot = function (serverSeq) {
  return request('GET', this.baseUrl, '/api/sync/restore/' + encodeURIComponent(serverSeq), this.token);
};

SuperSyncClient.prototype.getStatus = function () {
  return request('GET', this.baseUrl, '/api/sync/status', this.token);
};

module.exports = {
  SuperSyncClient: SuperSyncClient,
  createCrypto: createCrypto,
  DEFAULT_BASE_URL: DEFAULT_BASE_URL,
};
