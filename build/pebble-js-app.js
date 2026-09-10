/******/ (function(modules) { // webpackBootstrap
/******/ 	// The module cache
/******/ 	var installedModules = {};
/******/
/******/ 	// The require function
/******/ 	function __webpack_require__(moduleId) {
/******/
/******/ 		// Check if module is in cache
/******/ 		if(installedModules[moduleId])
/******/ 			return installedModules[moduleId].exports;
/******/
/******/ 		// Create a new module (and put it into the cache)
/******/ 		var module = installedModules[moduleId] = {
/******/ 			exports: {},
/******/ 			id: moduleId,
/******/ 			loaded: false
/******/ 		};
/******/
/******/ 		// Execute the module function
/******/ 		modules[moduleId].call(module.exports, module, module.exports, __webpack_require__);
/******/
/******/ 		// Flag the module as loaded
/******/ 		module.loaded = true;
/******/
/******/ 		// Return the exports of the module
/******/ 		return module.exports;
/******/ 	}
/******/
/******/
/******/ 	// expose the modules object (__webpack_modules__)
/******/ 	__webpack_require__.m = modules;
/******/
/******/ 	// expose the module cache
/******/ 	__webpack_require__.c = installedModules;
/******/
/******/ 	// __webpack_public_path__
/******/ 	__webpack_require__.p = "";
/******/
/******/ 	// Load entry module and return exports
/******/ 	return __webpack_require__(0);
/******/ })
/************************************************************************/
/******/ ([
/* 0 */
/***/ (function(module, exports, __webpack_require__) {

	__webpack_require__(1);
	module.exports = __webpack_require__(2);


/***/ }),
/* 1 */
/***/ (function(module, exports) {

	/**
	 * Copyright 2024 Google LLC
	 *
	 * Licensed under the Apache License, Version 2.0 (the "License");
	 * you may not use this file except in compliance with the License.
	 * You may obtain a copy of the License at
	 *
	 *     http://www.apache.org/licenses/LICENSE-2.0
	 *
	 * Unless required by applicable law or agreed to in writing, software
	 * distributed under the License is distributed on an "AS IS" BASIS,
	 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
	 * See the License for the specific language governing permissions and
	 * limitations under the License.
	 */
	
	(function(p) {
	  if (!p === undefined) {
	    console.error('Pebble object not found!?');
	    return;
	  }
	
	  // Aliases:
	  p.on = p.addEventListener;
	  p.off = p.removeEventListener;
	
	  // For Android (WebView-based) pkjs, print stacktrace for uncaught errors:
	  if (typeof window !== 'undefined' && window.addEventListener) {
	    window.addEventListener('error', function(event) {
	      if (event.error && event.error.stack) {
	        console.error('' + event.error + '\n' + event.error.stack);
	      }
	    });
	  }
	
	})(Pebble);


/***/ }),
/* 2 */
/***/ (function(module, exports, __webpack_require__) {

	// PebbleKit JS for the Super Productivity companion watchface.
	//
	// The watchface can't read the main watchapp's data (separate Pebble apps,
	// separate storage), so this does its own trimmed SuperSync pull - snapshot
	// bootstrap + op-log replay via the shared lib modules - then sends the face a
	// few numbers for today. It syncs on launch, when the face asks (a wrist tap),
	// and on a slow timer. Writes nothing back to the server; this is read-only.
	
	var supersync = __webpack_require__(3);
	var store = __webpack_require__(9);
	var presence = __webpack_require__(10);
	
	var MSG_REFRESH_REQUEST = 1;
	
	var STATUS_OK = 0;
	var STATUS_SYNCING = 1;
	var STATUS_NOT_PAIRED = 2;
	var STATUS_ERROR = 3;
	
	// Re-pull at most this often on the background timer; a tap forces one anyway.
	var POLL_MS = 20 * 60 * 1000;
	var lastPollAt = 0;
	var syncInFlight = false;
	var cachedCrypto = null;
	var cachedPassword = null;
	
	// ---------- storage ----------
	function loadConfig() {
	  try { return JSON.parse(localStorage.getItem('spf_config') || 'null'); } catch (e) { return null; }
	}
	function saveConfig(c) { localStorage.setItem('spf_config', JSON.stringify(c)); }
	function loadState() {
	  try { return JSON.parse(localStorage.getItem('spf_entities') || 'null') || store.emptyState(); }
	  catch (e) { return store.emptyState(); }
	}
	function saveState(s) { localStorage.setItem('spf_entities', JSON.stringify(s)); }
	function loadLastSeq() { return parseInt(localStorage.getItem('spf_last_seq') || '0', 10); }
	function saveLastSeq(n) { localStorage.setItem('spf_last_seq', String(n)); }
	
	function getCrypto() {
	  var pw = localStorage.getItem('spf_password');
	  if (!pw) { return null; }
	  if (!cachedCrypto || cachedPassword !== pw) {
	    cachedCrypto = supersync.createCrypto(pw, {
	      loadKeys: function () { try { return JSON.parse(localStorage.getItem('spf_kdf_keys') || '{}'); } catch (e) { return {}; } },
	      saveKey: function (salt, keyB64) {
	        var m; try { m = JSON.parse(localStorage.getItem('spf_kdf_keys') || '{}'); } catch (e) { m = {}; }
	        m[salt] = keyB64; localStorage.setItem('spf_kdf_keys', JSON.stringify(m));
	      },
	      loadEncryptSalt: function () { return localStorage.getItem('spf_kdf_salt'); },
	      saveEncryptSalt: function (s) { localStorage.setItem('spf_kdf_salt', s); },
	    });
	    cachedPassword = pw;
	  }
	  return cachedCrypto;
	}
	
	// ---------- send to watch ----------
	function sendToFace(dict) {
	  Pebble.sendAppMessage(dict, function () {}, function (e) {
	    console.log('[spf] send failed: ' + JSON.stringify(e));
	  });
	}
	function sendStatus(code) { sendToFace({ MSG_TYPE: 0, FACE_STATUS: code }); }
	
	// ---------- compute the face payload ----------
	// Currently-tracked task from the presence WebSocket (opt-in), or null.
	var trackedView = null; // { title, sinceTs } or { opaque:true }
	
	// Seconds of *this session* at which the tracked task tips past its estimate,
	// or -1 when it has no estimate / isn't a known task. The watch compares this
	// against its live timer so the line can go red the moment it crosses.
	function trackedOverS() {
	  try {
	    if (!trackedView || !trackedView.taskId) { return -1; }
	    var t = loadState().task[trackedView.taskId];
	    if (!t || !t.timeEstimate || t.timeEstimate <= 0) { return -1; }
	    return Math.max(0, Math.round((t.timeEstimate - (t.timeSpent || 0)) / 1000));
	  } catch (e) { return -1; }
	}
	
	function pushTracking() {
	  var dict = { MSG_TYPE: 0 };
	  if (presenceClient && trackedView && !trackedView.opaque && trackedView.title) {
	    dict.FACE_TRACKING_TITLE = trackedView.title.slice(0, 38);
	    dict.FACE_TRACKING_ELAPSED_S = Math.max(0, Math.round((Date.now() - trackedView.sinceTs) / 1000));
	    dict.FACE_TRACKING_OVER_S = trackedOverS();
	  } else if (presenceClient && trackedView && trackedView.opaque) {
	    dict.FACE_TRACKING_TITLE = 'tracking on another device';
	    dict.FACE_TRACKING_ELAPSED_S = 0;
	    dict.FACE_TRACKING_OVER_S = -1;
	  } else {
	    dict.FACE_TRACKING_TITLE = '';
	    dict.FACE_TRACKING_ELAPSED_S = 0;
	    dict.FACE_TRACKING_OVER_S = -1;
	  }
	  sendToFace(dict);
	}
	
	function pushFaceData(state) {
	  store.setStartOfNextDayFromState(state);
	  var stats = store.computeStats(state);
	
	  // "N done / M planned today" from the same today list the watchapp shows.
	  // getActiveTasks(state, limit, groupByProject, todayOnly, hideDone) - positional.
	  var today;
	  try {
	    today = store.getActiveTasks(state, 200, false, true, false) || [];
	  } catch (e) {
	    today = [];
	  }
	  var total = today.length;
	  var done = today.filter(function (t) { return t.isDone; }).length;
	
	  // Soonest still-upcoming timed task today, from the same list.
	  var nowMin = (function () { var d = new Date(); return d.getHours() * 60 + d.getMinutes(); })();
	  var nextMin = -1, nextTitle = '';
	  today.forEach(function (t) {
	    if (t.isDone || typeof t.dueWithTime !== 'number') { return; }
	    var d = new Date(t.dueWithTime);
	    var m = d.getHours() * 60 + d.getMinutes();
	    if (m >= nowMin && (nextMin < 0 || m < nextMin)) { nextMin = m; nextTitle = String(t.title || ''); }
	  });
	
	  // Habits: N done / M tracked-today, plus the longest live streak.
	  var habDone = 0, habTotal = 0, topStreak = 0, topTitle = '';
	  try {
	    var habits = store.getActiveHabits(state, 40) || [];
	    habTotal = habits.length;
	    habits.forEach(function (h) {
	      if (h.done) { habDone++; }
	      if ((h.streak || 0) > topStreak) { topStreak = h.streak; topTitle = String(h.title || ''); }
	    });
	  } catch (e) {}
	
	  // Week: minutes worked per day, [6] = today, as a CSV string.
	  var weekCsv = '0,0,0,0,0,0,0';
	  try {
	    weekCsv = (stats.week || []).map(function (d) {
	      return Math.round((d.ms || 0) / 60000);
	    }).join(',');
	  } catch (e) {}
	
	  sendToFace({
	    MSG_TYPE: 0,
	    FACE_STATUS: STATUS_OK,
	    FACE_DONE_TODAY: done,
	    FACE_TOTAL_TODAY: total,
	    FACE_WORKED_MIN: Math.round((stats.workedTodayMs || 0) / 60000),
	    FACE_EST_REMAIN_MIN: Math.round((stats.estimateRemainingMs || 0) / 60000),
	    FACE_NEXT_MIN: nextMin,
	    FACE_NEXT_TITLE: nextTitle.slice(0, 38),
	    FACE_HABITS_DONE: habDone,
	    FACE_HABITS_TOTAL: habTotal,
	    FACE_HABIT_STREAK: topStreak,
	    FACE_HABIT_TITLE: topTitle.slice(0, 20),
	    FACE_WEEK_CSV: weekCsv,
	  });
	}
	
	// ---------- trimmed sync ----------
	function doSync() {
	  var config = loadConfig();
	  if (!config || !config.jwt) {
	    // Full clear so nothing stale (incl. a tracking line) lingers before pairing.
	    sendToFace({
	      MSG_TYPE: 0, FACE_STATUS: STATUS_NOT_PAIRED,
	      FACE_DONE_TODAY: 0, FACE_TOTAL_TODAY: 0, FACE_WORKED_MIN: 0, FACE_EST_REMAIN_MIN: 0,
	      FACE_NEXT_MIN: -1, FACE_NEXT_TITLE: '', FACE_HABITS_DONE: 0, FACE_HABITS_TOTAL: 0,
	      FACE_HABIT_STREAK: 0, FACE_HABIT_TITLE: '', FACE_WEEK_CSV: '0,0,0,0,0,0,0',
	      FACE_TRACKING_TITLE: '', FACE_TRACKING_ELAPSED_S: 0,
	    });
	    return Promise.resolve();
	  }
	  if (syncInFlight) { return Promise.resolve(); }
	  syncInFlight = true;
	  sendStatus(STATUS_SYNCING);
	
	  var client = new supersync.SuperSyncClient({ baseUrl: config.baseUrl || supersync.DEFAULT_BASE_URL, token: config.jwt });
	  var crypto = getCrypto();
	  var state = loadState();
	  var lastSeq = loadLastSeq();
	  var isFirst = lastSeq === 0 && Object.keys(state.task || {}).length === 0;
	
	  var pullPage = function () {
	    return client.downloadOps(lastSeq, null, 500).then(function (res) {
	      store.applyOperations(res.ops || [], state, crypto);
	      (res.ops || []).forEach(function (entry) {
	        if (entry.serverSeq > lastSeq) { lastSeq = entry.serverSeq; }
	      });
	      if (res.hasMore) { return pullPage(); }
	    });
	  };
	
	  var bootstrap = function () {
	    if (!isFirst) { return Promise.resolve(); }
	    return client.getRestorePoints(1).then(function (res) {
	      var pts = res && res.restorePoints;
	      if (!pts || !pts.length) { return; }
	      return client.restoreSnapshot(pts[0].serverSeq).then(function (snap) {
	        var payload = snap && snap.encrypted && crypto ? crypto.decrypt(snap.payload) : snap;
	        if (payload && payload.task) { state.task = payload.task.entities || payload.task; }
	        lastSeq = pts[0].serverSeq;
	      });
	    }).catch(function (err) {
	      if (err && err.status) { return; } // E2EE: fall through to a full op replay
	      throw err;
	    });
	  };
	
	  return bootstrap().then(pullPage).then(function () {
	    saveState(state);
	    saveLastSeq(lastSeq);
	    lastPollAt = Date.now();
	    pushFaceData(state);
	    if (presenceClient && trackedView) { pushTracking(); } // refresh the over-estimate base
	  }).catch(function (err) {
	    console.log('[spf] sync failed: ' + (err && err.message ? err.message : JSON.stringify(err)));
	    sendStatus(STATUS_ERROR);
	    // still show whatever the cache has
	    try { pushFaceData(loadState()); } catch (e) {}
	  }).then(function () { syncInFlight = false; });
	}
	
	// ---------- live tracking (opt-in, its own WebSocket) ----------
	var presenceClient = null;
	var presenceToken = null;
	
	function getClientId() {
	  var id = localStorage.getItem('spf_client_id');
	  if (!id) {
	    id = 'spf-' + Date.now().toString(36) + '-' + Math.floor(Math.random() * 1e9).toString(36);
	    localStorage.setItem('spf_client_id', id);
	  }
	  return id;
	}
	
	function applyPresence(config) {
	  var wants = !!(config && config.showTracking && config.jwt);
	  if (presenceClient && (!wants || presenceToken !== config.jwt)) {
	    presenceClient.disconnect();
	    presenceClient = null;
	  }
	  if (!wants) {
	    trackedView = null;
	    pushTracking();
	    return;
	  }
	  if (!presenceClient) {
	    presenceToken = config.jwt;
	    presenceClient = new presence.PresenceClient({
	      baseUrl: config.baseUrl || supersync.DEFAULT_BASE_URL,
	      token: config.jwt,
	      clientId: getClientId(),
	      getCrypto: getCrypto,
	      log: function (m) { console.log('[spf presence] ' + m); },
	    });
	    presenceClient.onState(function (view) {
	      if (view.state !== 'tracking') { trackedView = null; pushTracking(); return; }
	      if (view.opaque) { trackedView = { opaque: true }; pushTracking(); return; }
	      var title = '';
	      if (view.taskId) {
	        var t = loadState().task[view.taskId];
	        title = (t && t.title) || 'a task';
	      }
	      trackedView = { title: title, sinceTs: view.sinceTs || Date.now(), taskId: view.taskId };
	      pushTracking();
	    });
	    presenceClient.onCleared(function () { trackedView = null; pushTracking(); });
	    presenceClient.onOffline(function () { /* keep showing the last view */ });
	  }
	  presenceClient.connect();
	}
	
	// ---------- events ----------
	Pebble.addEventListener('ready', function () {
	  console.log('[spf] ready');
	  var config = loadConfig();
	  if (config && config.pollMin) { POLL_MS = config.pollMin * 60 * 1000; }
	  doSync();
	  applyPresence(config);
	  setInterval(function () {
	    if (Date.now() - lastPollAt >= POLL_MS) { doSync(); }
	  }, 60 * 1000);
	});
	
	Pebble.addEventListener('appmessage', function (e) {
	  if (e.payload && e.payload.MSG_TYPE === MSG_REFRESH_REQUEST) {
	    // A tap always re-pushes the cached view (instant, no radio). A full
	    // server sync only if the last one is over a minute old - repeated taps
	    // shouldn't each wake the radio.
	    if (Date.now() - lastPollAt >= 60 * 1000) {
	      doSync();
	    } else {
	      try { pushFaceData(loadState()); } catch (err) {}
	    }
	    if (presenceClient) { pushTracking(); }
	  }
	});
	
	// ---------- config page ----------
	function configHtml(config) {
	  var esc = function (s) {
	    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
	  };
	  var hasPw = !!localStorage.getItem('spf_password');
	  var hasTok = !!(config && config.jwt);
	  var showTracking = !!(config && config.showTracking);
	  var pollMin = (config && config.pollMin) || 20;
	  var pollOpts = [10, 15, 20, 30, 60].map(function (v) {
	    return '<option value="' + v + '"' + (v === pollMin ? ' selected' : '') + '>every ' + v + ' min</option>';
	  }).join('');
	  var html = '<!doctype html><html><head><meta charset="utf-8">' +
	    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
	    '<style>' +
	    ':root{color-scheme:light dark}' +
	    'body{font-family:-apple-system,Roboto,sans-serif;margin:0;padding:16px;background:#fff;color:#111}' +
	    '@media(prefers-color-scheme:dark){body{background:#1c1c1e;color:#e6e6e9}input,select{background:#2c2c2e;color:#e6e6e9;border-color:#48484a}}' +
	    'h1{font-size:18px}label{display:block;margin-top:14px;font-size:13px;font-weight:600}' +
	    'input,select{width:100%;box-sizing:border-box;padding:10px;font-size:15px;margin-top:4px;border:1px solid #ccc;border-radius:6px}' +
	    '.row{display:flex;align-items:center;gap:8px;margin-top:14px}.row input{width:auto;margin:0}.row label{display:inline;margin:0;font-weight:normal}' +
	    'p.hint{font-size:12px;color:#777}' +
	    'button{width:100%;padding:12px;font-size:15px;margin-top:16px;border:none;border-radius:6px;background:#1a73e8;color:#fff}' +
	    'button.secondary{background:#eee;color:#111;margin-top:8px}' +
	    '</style></head><body>' +
	    '<h1>Super Productivity watchface</h1>' +
	    '<p class="hint">This face syncs separately from the watchapp. Paste the same SuperSync details.</p>' +
	    '<label for="baseUrl">SuperSync server URL</label>' +
	    '<input id="baseUrl" type="url" value="' + esc((config && config.baseUrl) || supersync.DEFAULT_BASE_URL) + '">' +
	    '<label for="email">Account email</label>' +
	    '<input id="email" type="email" value="' + esc(config && config.email) + '">' +
	    '<label for="password">Sync encryption password</label>' +
	    '<input id="password" type="password" placeholder="' + (hasPw ? 'Saved - leave blank to keep' : 'From Super Productivity sync settings') + '">' +
	    '<label for="jwt">SuperSync access token</label>' +
	    '<input id="jwt" type="text" placeholder="' + (hasTok ? 'Saved - leave blank to keep' : 'Paste the token from the SuperSync login page') + '">' +
	    '<label for="pollMin">Refresh</label>' +
	    '<select id="pollMin">' + pollOpts + '</select>' +
	    '<div class="row"><input id="showTracking" type="checkbox"' + (showTracking ? ' checked' : '') + '>' +
	    '<label for="showTracking">Show the live-tracked task</label></div>' +
	    '<p class="hint">Holds a connection open to show what you\'re tracking right now, with a running timer. Uses noticeably more battery.</p>' +
	    '<button id="save">Save</button>' +
	    '<button id="cancel" class="secondary">Cancel</button>' +
	    '<script>' +
	    'function close(d){location.href="pebblejs://close#"+encodeURIComponent(JSON.stringify(d))}' +
	    'document.getElementById("save").onclick=function(){close({' +
	    'baseUrl:document.getElementById("baseUrl").value.replace(/\\/+$/,""),' +
	    'email:document.getElementById("email").value.trim(),' +
	    'password:document.getElementById("password").value,' +
	    'jwt:document.getElementById("jwt").value.trim(),' +
	    'pollMin:parseInt(document.getElementById("pollMin").value,10)||20,' +
	    'showTracking:document.getElementById("showTracking").checked})};' +
	    'document.getElementById("cancel").onclick=function(){close({cancelled:true})};' +
	    '</script></body></html>';
	  return 'data:text/html;charset=utf-8,' + encodeURIComponent(html);
	}
	
	Pebble.addEventListener('showConfiguration', function () {
	  Pebble.openURL(configHtml(loadConfig() || {}));
	});
	
	Pebble.addEventListener('webviewclosed', function (e) {
	  if (!e.response) { return; }
	  var r;
	  try { r = JSON.parse(decodeURIComponent(e.response)); } catch (err) { return; }
	  if (r.cancelled) { return; }
	  var config = loadConfig() || {};
	  var credsChanged = false;
	  if (r.baseUrl && r.baseUrl !== config.baseUrl) { config.baseUrl = r.baseUrl; credsChanged = true; }
	  if (r.email != null) { config.email = r.email; }
	  if (r.jwt && r.jwt !== config.jwt) { config.jwt = r.jwt; credsChanged = true; }
	  if (r.password) { localStorage.setItem('spf_password', r.password); credsChanged = true; }
	  config.pollMin = r.pollMin || 20;
	  config.showTracking = !!r.showTracking;
	  saveConfig(config);
	  POLL_MS = config.pollMin * 60 * 1000;
	  if (credsChanged) {
	    cachedCrypto = null;
	    localStorage.removeItem('spf_entities');
	    localStorage.removeItem('spf_last_seq');
	    localStorage.removeItem('spf_kdf_keys');
	  }
	  doSync();
	  applyPresence(config);
	});


/***/ }),
/* 3 */
/***/ (function(module, exports, __webpack_require__) {

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
	
	var aesGcm = __webpack_require__(4);
	var sha256lib = __webpack_require__(5);
	var base64 = __webpack_require__(6);
	var argon2Lib = __webpack_require__(7);
	
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


/***/ }),
/* 4 */
/***/ (function(module, exports) {

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


/***/ }),
/* 5 */
/***/ (function(module, exports) {

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


/***/ }),
/* 6 */
/***/ (function(module, exports) {

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


/***/ }),
/* 7 */
/***/ (function(module, exports, __webpack_require__) {

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
	
	var blake2bLib = __webpack_require__(8);
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


/***/ }),
/* 8 */
/***/ (function(module, exports) {

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


/***/ }),
/* 9 */
/***/ (function(module, exports) {

	// Maintains a local cache of SuperSync entities (rebuilt by replaying
	// operations) and derives the watch's task list from it.
	//
	// See the top-of-file comment in supersync-client.js for the operation
	// field-name assumptions this replay logic depends on.
	//
	// TASK entity semantics, confirmed by decrypting a real account's full op
	// history: this is a Redux action-replay log, not a flat CRUD op log.
	// `op.opType` (CRT/UPD/...) doesn't tell you how to interpret the payload
	// for TASK entities - `op.actionType` does, and each action type has its
	// own bespoke `payload.actionPayload` shape, mirroring the app's actual
	// NgRx actions (root-store/meta/task-shared.actions.ts,
	// features/project/store/project.actions.ts) and their meta-reducers
	// (root-store/meta/task-shared-meta-reducers/*) in the super-productivity
	// GitHub repo.
	//
	// A task's dueDay/dueWithTime doesn't only change via TASK-entity ops.
	// Scheduling a task through the desktop's Schedule dialog with no specific
	// time (including its "Today" quick-access button - dialog-schedule-task.
	// component.ts) dispatches PlannerActions.planTaskForDay/transferTask,
	// synced under entityType 'PLANNER' (planner.actions.ts), even though the
	// real task.reducer.ts's own `on(PlannerActions.planTaskForDay, ...)`
	// handler sets task.dueDay directly - see applyPlannerAction below.
	//
	// getActiveTasks() returns every main task that is NOT sitting in a
	// project's backlog - no date filtering. Confirmed against
	// project.model.ts: backlog membership lives on the PROJECT entity
	// (project.taskIds vs project.backlogTaskIds), not on the task itself, so
	// it's tracked here as a synthetic task.__inBacklog flag, seeded from the
	// SYNC_IMPORT project snapshot and kept up to date by the handful of
	// "[Project] ... Backlog ..." move actions and the isAddToBacklog/
	// isMoveToBacklog flags addTask/scheduleTaskWithTime/applyShortSyntax
	// carry. (project.actions.ts also has several backlog *reorder* actions -
	// moveProjectTask{Up,Down,ToTop,ToBottom,In}BacklogList - which only
	// change position within the backlog, never membership, so they're
	// deliberately not handled here.)
	//
	// Subtasks (task.parentId set) are never selected independently - a
	// subtask is shown by riding along with its (visible) parent via the
	// parent's subTaskIds, indented, regardless of the subtask's own
	// isDone/backlog status.
	//
	// SYNC_IMPORT/BACKUP_IMPORT/REPAIR carry a full NgRx EntityState snapshot
	// per feature slice (payload.task = { ids: [...], entities: {...} },
	// payload.project likewise), also confirmed against the same real
	// account, whose op history starts with exactly this op - without it, a
	// task/project created before the visible history begins would only ever
	// show whatever fields a later action happened to touch.
	'use strict';
	
	function dateToDateStr(d) {
	  var mm = ('0' + (d.getMonth() + 1)).slice(-2);
	  var dd = ('0' + d.getDate()).slice(-2);
	  return d.getFullYear() + '-' + mm + '-' + dd;
	}
	
	// The "logical day" rollover: SP's globalConfig.misc.startOfNextDay(Time) - the
	// clock time your day flips over (e.g. 4am). Minutes since midnight, 0 =
	// midnight. Set from the replayed globalConfig (setStartOfNextDayFromState);
	// every date-sensitive computation below derives its "now" from logicalNow().
	var startOfNextDayMin = 0;
	function setStartOfNextDayMin(min) {
	  startOfNextDayMin = (typeof min === 'number' && isFinite(min) && min >= 0 && min < 1440)
	    ? Math.floor(min) : 0;
	}
	function setStartOfNextDayFromState(state) {
	  var misc = state && state.globalConfig && state.globalConfig.misc;
	  if (misc) {
	    var t = misc.startOfNextDayTime;
	    var m = typeof t === 'string' && /^(\d{1,2}):(\d{2})$/.exec(t);
	    if (m) {
	      setStartOfNextDayMin((+m[1]) * 60 + (+m[2]));
	      return;
	    }
	    var h = misc.startOfNextDay;
	    if (typeof h === 'number' && h >= 0 && h <= 23) {
	      setStartOfNextDayMin(h * 60);
	      return;
	    }
	  }
	  setStartOfNextDayMin(0);
	}
	
	// "now", shifted back by the rollover offset - its local calendar date is the
	// logical day.
	function logicalNow() {
	  return new Date(Date.now() - startOfNextDayMin * 60000);
	}
	
	function todayStr() {
	  return dateToDateStr(logicalNow());
	}
	
	function yesterdayStr() {
	  var d = logicalNow();
	  d.setDate(d.getDate() - 1);
	  return dateToDateStr(d);
	}
	
	// dueWithTime is a ms timestamp (a task scheduled for a specific time of
	// day). The real app enforces dueDay/dueWithTime as MUTUALLY EXCLUSIVE -
	// setting one clears the other (task-shared-scheduling.reducer.ts) - so a
	// todayOnly filter keyed on dueDay alone would miss a dueWithTime-only
	// task entirely. The scheduled time is shifted by the same rollover offset
	// (SP's isTodayWithOffset) so a 1am task with a 4am rollover still counts as
	// "today".
	function msIsToday(ms) {
	  return dateToDateStr(new Date(ms - startOfNextDayMin * 60000)) === todayStr();
	}
	
	// Whole days from today to a task's deadline (negative = overdue, 0 = today),
	// or undefined when it has none. deadlineDay ('YYYY-MM-DD') and deadlineWithTime
	// (epoch ms) are mutually exclusive in the real model - handle either.
	function taskDeadlineDays(t) {
	  var day = t.deadlineDay ||
	    (t.deadlineWithTime ? dateToDateStr(new Date(t.deadlineWithTime)) : null);
	  return day ? diffInDays(todayStr(), day) : undefined;
	}
	
	// Short issue-tracker key for a task linked to an issue (Jira/GitHub/...). Jira
	// etc. store the key itself in issueId ("PROJ-123"); GitHub/GitLab/Gitea store
	// a plain number, shown as "#123". Story points, when set, follow as " 3p". A
	// trailing "!" means the linked issue changed upstream (issueWasUpdated) - it's
	// attached to the badge so it reads apart from the standalone "! 2d" deadline
	// marker. Long/opaque ids (CalDAV uids) are dropped - no useful badge.
	// undefined when the task has no issue.
	function taskIssueKey(t) {
	  if (!t || !t.issueId) {
	    return undefined;
	  }
	  var id = String(t.issueId);
	  var label = /^\d+$/.test(id) ? '#' + id : id;
	  if (label.length > 13) {
	    return undefined;
	  }
	  var pts = t.issuePoints;
	  if (typeof pts === 'number' && isFinite(pts) && pts > 0) {
	    label += ' ' + (Math.round(pts * 10) / 10) + 'p';
	  }
	  if (t.issueWasUpdated) {
	    label += '!';
	  }
	  return label;
	}
	
	// state: { task: { [id]: {id, title, isDone, parentId?, projectId?,
	//                          tagIds?, __inBacklog?, ...} },
	//          project: { [id]: {id, title, ...} },
	//          simpleCounter: { [id]: {id, title, isEnabled, type, countOnDay,
	//                                   streakMinValue?, isTrackStreaks?, ...} },
	//          note: { [id]: {id, projectId, isPinnedToToday, content, created,
	//                          modified, ...} },
	//          tag: { [id]: {id, title, ...} } }
	function emptyState() {
	  return {
	    task: {}, project: {}, simpleCounter: {}, note: {}, tag: {}, taskRepeatCfg: {},
	    metric: {}, timeTracking: { project: {}, tag: {} },
	  };
	}
	
	function ensureCollection(state, entityType) {
	  if (!state[entityType]) {
	    state[entityType] = {};
	  }
	  return state[entityType];
	}
	
	function setInBacklog(tasks, id, val) {
	  if (id && tasks[id]) {
	    tasks[id].__inBacklog = val;
	  }
	}
	
	// Like a plain replace, but carries the synthetic __inBacklog flag
	// forward - real Task payloads never include it (we invented it), so a
	// naive `tasks[id] = task` would silently drop whatever backlog state
	// we'd tracked so far every time one of these full-snapshot actions fires.
	function replaceTaskPreservingBacklog(tasks, task) {
	  if (!task || !task.id) {
	    return;
	  }
	  var prevInBacklog = tasks[task.id] ? tasks[task.id].__inBacklog : false;
	  tasks[task.id] = task;
	  tasks[task.id].__inBacklog = !!prevInBacklog;
	}
	
	function mergeTaskChanges(tasks, id, changes) {
	  if (id) {
	    tasks[id] = Object.assign({}, tasks[id], changes);
	  }
	}
	
	function deleteTasks(tasks, ids) {
	  (ids || []).forEach(function (id) { delete tasks[id]; });
	}
	
	// Mirrors removeTaskFromParentSideEffects in
	// task-shared-crud.reducer.ts (just the subTaskIds splice - the real
	// helper's time recalc doesn't affect anything the watch shows): drops
	// `childId` from whichever task currently lists it in subTaskIds. Used by
	// both convert actions so a re-parented task can't stay referenced by its
	// old parent (which would otherwise keep rendering it as a nested row -
	// twice, once a convertToMainTask also lists it at top level).
	function detachFromParent(tasks, childId) {
	  Object.keys(tasks).forEach(function (pid) {
	    var sub = tasks[pid].subTaskIds;
	    if (sub && sub.indexOf(childId) !== -1) {
	      mergeTaskChanges(tasks, pid, { subTaskIds: sub.filter(function (s) { return s !== childId; }) });
	    }
	  });
	}
	
	// Inserts `childId` into `parentId`'s subTaskIds if absent, honoring the
	// afterTaskId anchor the convert actions carry (moveItemAfterAnchor in the
	// real reducer): null => prepend, a known id => right after it, anything
	// else => append.
	function attachToParent(tasks, parentId, childId, afterTaskId) {
	  var parent = tasks[parentId];
	  if (!parent) {
	    return;
	  }
	  var sub = parent.subTaskIds || [];
	  if (sub.indexOf(childId) !== -1) {
	    return;
	  }
	  var next;
	  if (!afterTaskId) {
	    next = [childId].concat(sub);
	  } else {
	    var at = sub.indexOf(afterTaskId);
	    next = at === -1 ? sub.concat([childId]) : sub.slice(0, at + 1).concat([childId], sub.slice(at + 1));
	  }
	  mergeTaskChanges(tasks, parentId, { subTaskIds: next });
	}
	
	function applyTaskAction(op, actionPayload, state) {
	  var tasks = state.task;
	  if (!actionPayload) {
	    return;
	  }
	  switch (op.actionType) {
	    case '[Task Shared] addTask':
	      replaceTaskPreservingBacklog(tasks, actionPayload.task);
	      if (actionPayload.task) {
	        setInBacklog(tasks, actionPayload.task.id, !!actionPayload.isAddToBacklog);
	      }
	      break;
	
	    // Mirrors on(addSubTask, ...) in tasks/store/task.reducer.ts. A subtask
	    // is NOT created via addTask - it's its own '[Task] Add SubTask' action
	    // ({ task, parentId }), dispatched both when a subtask is added by hand
	    // and, crucially, once per subTaskTemplate when
	    // task-repeat-cfg.service.ts materializes a recurring task's daily
	    // instance. Without this case that action fell through to `default` and
	    // was dropped entirely: the subtask entity never entered state.task and
	    // its id never reached the parent's subTaskIds, so a recurring task with
	    // subtasks (or any subtask added since the last full snapshot) showed on
	    // the watch as just its bare parent row. The real reducer also forces
	    // projectId to the parent's and tagIds to [], and (only for the very
	    // first subtask, and only if the parent has none of its own) copies the
	    // parent's timeEstimate/timeSpent down - that last part is skipped here
	    // since it only nudges the "spent / estimate" subtitle, never whether a
	    // row appears.
	    case '[Task] Add SubTask': {
	      var subTask = actionPayload.task;
	      var subParentId = actionPayload.parentId;
	      var subParent = subParentId && tasks[subParentId];
	      if (subTask && subTask.id && subParent) {
	        tasks[subTask.id] = Object.assign({}, subTask, {
	          parentId: subParentId,
	          projectId: subParent.projectId,
	          tagIds: [],
	        });
	        setInBacklog(tasks, subTask.id, false);
	        // Append (real reducer uses [...subTaskIds, task.id]), with the same
	        // already-present guard it keeps for replayed/imported ids.
	        var subParentIds = subParent.subTaskIds || [];
	        if (subParentIds.indexOf(subTask.id) === -1) {
	          mergeTaskChanges(tasks, subParentId, { subTaskIds: subParentIds.concat([subTask.id]) });
	        }
	      }
	      break;
	    }
	
	    // NOT a full task snapshot - confirmed wrong by reading the actual
	    // reducer (handleScheduleTaskWithTime in
	    // task-shared-scheduling.reducer.ts): dueWithTime/remindAt are their
	    // OWN top-level actionPayload fields, siblings of `task`, and the real
	    // reducer only ever reads `task.id` from the task field itself
	    // (taskAdapter.updateOne({ id: task.id, changes: { dueWithTime,
	    // dueDay: undefined, remindAt } })) - a narrow merge onto the task
	    // already in the store, not a replace. Whether actionPayload.task
	    // happens to also carry a matching dueWithTime depends entirely on the
	    // calling code and isn't guaranteed: task-repeat-cfg.service.ts's
	    // recurring-task creation passes `task: taskWithTargetDates`, a
	    // snapshot built BEFORE the schedule was computed, so it never has
	    // dueWithTime - a previous version of this code did a full replace
	    // with that task object and silently dropped the schedule entirely,
	    // which is why a recurring task with a time never showed "@ ..." like
	    // a normal scheduled task did. isMoveToBacklog mirrors
	    // handleScheduleTaskWithTime's own backlog-move side effect.
	    case '[Task Shared] scheduleTaskWithTime':
	    case '[Task Shared] reScheduleTaskWithTime': {
	      var schedId = actionPayload.task && actionPayload.task.id;
	      if (schedId) {
	        mergeTaskChanges(tasks, schedId, {
	          dueWithTime: actionPayload.dueWithTime,
	          dueDay: undefined,
	          remindAt: actionPayload.remindAt,
	        });
	        if (actionPayload.isMoveToBacklog) {
	          setInBacklog(tasks, schedId, true);
	        }
	      }
	      break;
	    }
	
	    case '[Task Shared] restoreTask':
	    case '[Task Shared] restoreDeletedTask':
	      replaceTaskPreservingBacklog(tasks, actionPayload.task);
	      break;
	
	    case '[Task Shared] updateTask':
	      if (actionPayload.task) {
	        mergeTaskChanges(tasks, actionPayload.task.id, actionPayload.task.changes);
	      }
	      break;
	
	    case '[Task Shared] updateTasks':
	      (actionPayload.tasks || []).forEach(function (u) {
	        mergeTaskChanges(tasks, u.id, u.changes);
	      });
	      break;
	
	    // Mirrors handleMoveToOtherProject in project-shared.reducer.ts:
	    // reassigns projectId on the task and every one of its subtasks (only
	    // the parent moves between the two projects' own taskIds lists, but
	    // ALL of them get the new projectId - subtasks are never independently
	    // listed in a project's taskIds). Previously unhandled entirely, which
	    // left a moved task's projectId stale here - showing under its old
	    // project, or "No Project" if it never had one - even though the real
	    // account has it correctly reassigned. Also clears __inBacklog: the
	    // real reducer removes the moved tasks from the old project's
	    // backlogTaskIds and never adds them to the new project's, so a move
	    // always drops backlog membership regardless of where it started.
	    case '[Task Shared] moveToOtherProject': {
	      var movedTask = actionPayload.task;
	      if (movedTask && movedTask.id && actionPayload.targetProjectId) {
	        var movedIds = [movedTask.id].concat(movedTask.subTaskIds || []);
	        movedIds.forEach(function (id) {
	          mergeTaskChanges(tasks, id, { projectId: actionPayload.targetProjectId });
	          setInBacklog(tasks, id, false);
	        });
	      }
	      break;
	    }
	
	    // Mirrors handlePlanTasksForToday in task-shared-scheduling.reducer.ts:
	    // sets dueDay to the target day and clears remindAt. Kept for its own
	    // sake (dueDay is still real task state worth having correct) even
	    // though it no longer drives the active-task filter.
	    case '[Task Shared] planTasksForToday': {
	      // Confirmed against the real handlePlanTasksForToday
	      // (task-shared-scheduling.reducer.ts): besides setting dueDay, it
	      // ALSO conditionally clears dueWithTime via shouldClearDueTimeForToday
	      // (is-today.util.ts) - cleared unless the existing dueWithTime
	      // already happens to land on today. Previously this case only ever
	      // set dueDay, never touching a leftover dueWithTime - harmless if the
	      // task had none, but taskIsPlannedForToday() checks dueWithTime
	      // FIRST, so a task "Add to Today"'d while still carrying a stale
	      // dueWithTime (any value not already today) stayed hidden from the
	      // watch's Today Only filter forever, even though the desktop
	      // correctly cleared it and showed the task normally.
	      var today = actionPayload.today || todayStr();
	      (actionPayload.taskIds || []).forEach(function (id) {
	        if (tasks[id]) {
	          var changes = { dueDay: today, remindAt: undefined };
	          var existingDueWithTime = tasks[id].dueWithTime;
	          if (existingDueWithTime && !msIsToday(existingDueWithTime)) {
	            changes.dueWithTime = undefined;
	          }
	          mergeTaskChanges(tasks, id, changes);
	        }
	      });
	      break;
	    }
	
	    // Mirrors handleUnScheduleTask: clears scheduling, or pins to today if
	    // isLeaveInToday.
	    case '[Task Shared] unscheduleTask': {
	      var day = actionPayload.isLeaveInToday ? (actionPayload.today || todayStr()) : undefined;
	      mergeTaskChanges(tasks, actionPayload.id, {
	        dueDay: day,
	        dueWithTime: undefined,
	        remindAt: undefined,
	      });
	      break;
	    }
	
	    case '[Task Shared] deleteTask':
	      if (actionPayload.task) {
	        deleteTasks(tasks, [actionPayload.task.id]);
	      }
	      break;
	
	    case '[Task Shared] deleteTasks':
	      deleteTasks(tasks, actionPayload.taskIds);
	      break;
	
	    // Archived tasks leave the active view entirely, regardless of
	    // backlog/due-date status.
	    case '[Task Shared] moveToArchive':
	      deleteTasks(tasks, (actionPayload.tasks || []).map(function (t) { return t.id; }));
	      break;
	
	    // Mirrors handleApplyShortSyntax in short-syntax-shared.reducer.ts: a
	    // task's title can itself carry scheduling ("do the thing today" or
	    // "at 3pm") and/or a backlog move, applied atomically alongside plain
	    // field changes.
	    case '[Task Shared] applyShortSyntax': {
	      var scId = actionPayload.task && actionPayload.task.id;
	      if (scId) {
	        var scChanges = Object.assign({}, actionPayload.taskChanges);
	        var info = actionPayload.schedulingInfo;
	        if (info && info.dueWithTime) {
	          scChanges.dueWithTime = info.dueWithTime;
	          scChanges.dueDay = undefined;
	        } else if (info && info.day) {
	          scChanges.dueDay = info.day;
	          scChanges.dueWithTime = undefined;
	        }
	        mergeTaskChanges(tasks, scId, scChanges);
	        if (info && info.isMoveToBacklog) {
	          setInBacklog(tasks, scId, true);
	        }
	      }
	      break;
	    }
	
	    // Mirrors handleConvertToMainTask in task-shared-crud.reducer.ts:
	    // promotes a subtask to a main task (clearing parentId, without which
	    // it stays invisible to isMainTask() forever), optionally planning it
	    // for today. The detachFromParent() call mirrors the reducer's own
	    // removeTaskFromParentSideEffects: without it the former parent's
	    // subTaskIds still lists this id, so pushTaskAndSubtasks() renders the
	    // promoted task a SECOND time as a nested row under its old parent.
	    case '[Task Shared] convertToMainTask': {
	      var mainTask = actionPayload.task;
	      if (mainTask && mainTask.id) {
	        detachFromParent(tasks, mainTask.id);
	        var mainChanges = { parentId: undefined };
	        if (actionPayload.isPlanForToday && !mainTask.dueWithTime) {
	          mainChanges.dueDay = actionPayload.today || todayStr();
	        }
	        mergeTaskChanges(tasks, mainTask.id, mainChanges);
	      }
	      break;
	    }
	
	    // Mirrors handleConvertToSubTask in task-shared-crud.reducer.ts
	    // ({ taskId, targetParentId, afterTaskId }): demotes a task to a subtask
	    // of targetParentId. Setting only parentId (as this used to) made the
	    // task vanish from the watch entirely - isMainTask() now rejects it, but
	    // nothing had added it to the target parent's subTaskIds, which is the
	    // only place pushTaskAndSubtasks() looks for children. Now also inherits
	    // the parent's projectId, clears dueDay, drops backlog membership, and
	    // detaches from any previous parent - all per the real reducer.
	    case '[Task Shared] convertToSubTask': {
	      var cstId = actionPayload.taskId;
	      var cstParentId = actionPayload.targetParentId;
	      if (cstId && tasks[cstId] && cstParentId && tasks[cstParentId]) {
	        detachFromParent(tasks, cstId);
	        mergeTaskChanges(tasks, cstId, {
	          parentId: cstParentId,
	          projectId: tasks[cstParentId].projectId,
	          dueDay: undefined,
	        });
	        setInBacklog(tasks, cstId, false);
	        attachToParent(tasks, cstParentId, cstId, actionPayload.afterTaskId);
	      }
	      break;
	    }
	
	    // The following four, from project.actions.ts's "MOVE TASK ACTIONS"
	    // section, change backlog *membership* (as opposed to the several
	    // *reorder-within-backlog* actions there, which don't and are
	    // deliberately not handled).
	    case '[Project] Auto Move Task from regular to backlog':
	    case '[Project] Move Task from regular to backlog':
	      setInBacklog(tasks, actionPayload.taskId, true);
	      break;
	
	    case '[Project] Auto Move Task from backlog to regular':
	    case '[Project] Move Task from backlog to regular':
	      setInBacklog(tasks, actionPayload.taskId, false);
	      break;
	
	    // Confirmed against time-tracking.actions.ts/task.reducer.ts: the
	    // payload is only { taskId, date, duration } - a DELTA in ms for that
	    // calendar day, never the full timeSpentOnDay map - and the real
	    // reducer applies it ADDITIVELY (tasks[id].timeSpentOnDay[date] =
	    // (existing || 0) + duration) so concurrent contributions from other
	    // clients aren't clobbered. timeSpent is just the sum across every day
	    // in that map - recomputed here rather than tracked separately so it
	    // can never drift from timeSpentOnDay. No-ops on a task we don't know
	    // about yet, matching the real reducer's own no-op when the entity
	    // isn't loaded (task.reducer.ts).
	    case '[TimeTracking] Sync time spent': {
	      var ttId = actionPayload.taskId;
	      var ttDate = actionPayload.date;
	      var ttDuration = actionPayload.duration;
	      if (ttId && ttDate && typeof ttDuration === 'number' && tasks[ttId]) {
	        var timeSpentOnDay = Object.assign({}, tasks[ttId].timeSpentOnDay);
	        timeSpentOnDay[ttDate] = (timeSpentOnDay[ttDate] || 0) + ttDuration;
	        var timeSpent = 0;
	        Object.keys(timeSpentOnDay).forEach(function (d) { timeSpent += timeSpentOnDay[d]; });
	        mergeTaskChanges(tasks, ttId, { timeSpentOnDay: timeSpentOnDay, timeSpent: timeSpent });
	      }
	      break;
	    }
	
	    default:
	      // Reminders, Today-tag ordering, tags, deadlines, and other
	      // TASK-entity actions don't affect
	      // title/isDone/backlog-membership/timeSpent - nothing to do.
	      break;
	  }
	}
	
	// PLANNER-entity ops (planner.actions.ts) - separate from TASK-entity ops
	// even though the desktop's own task.reducer.ts reacts to these by setting
	// dueDay directly on the task. Confirmed live: a task scheduled via the
	// Schedule dialog's plain date picker (or its "Today" quick-access button -
	// dialog-schedule-task.component.ts's onQuickAccessClick/_planForDay, taken
	// whenever no specific time is set) never appeared on the watch under
	// Today Only despite showing "Planned for: Today" on desktop - the op is
	// captured with entityType 'PLANNER'/actionType '[Planner] Plan Task for
	// Day', which used to fall into applyOperation's generic flat-merge
	// fallback (writing into state.planner, never touched by
	// taskIsPlannedForToday) instead of updating task.dueDay the way the real
	// task.reducer.ts's own `on(PlannerActions.planTaskForDay, ...)` does.
	function applyPlannerAction(op, actionPayload, state) {
	  var tasks = state.task;
	  if (!actionPayload) {
	    return;
	  }
	  switch (op.actionType) {
	    // Mirrors task.reducer.ts's on(PlannerActions.planTaskForDay, ...).
	    case '[Planner] Plan Task for Day': {
	      var pId = actionPayload.task && actionPayload.task.id;
	      if (pId) {
	        mergeTaskChanges(tasks, pId, {
	          dueDay: actionPayload.day,
	          dueWithTime: undefined,
	          remindAt: undefined,
	        });
	      }
	      break;
	    }
	
	    // Mirrors handleTransferTask in planner-shared.reducer.ts (the drag-
	    // and-drop reschedule in the Schedule/Planner week view) - same
	    // dueDay-setting effect as Plan Task for Day, different trigger.
	    case '[Planner] Transfer Task': {
	      var trId = actionPayload.task && actionPayload.task.id;
	      if (trId) {
	        mergeTaskChanges(tasks, trId, {
	          dueDay: actionPayload.newDay,
	          dueWithTime: undefined,
	        });
	      }
	      break;
	    }
	
	    default:
	      // Upsert Planner Day/Move In List/Move Before Task only reorder -
	      // no dueDay/membership effect to mirror.
	      break;
	  }
	}
	
	function applyProjectAction(op, actionPayload, state) {
	  var projects = ensureCollection(state, 'project');
	  if (!actionPayload) {
	    return;
	  }
	  switch (op.actionType) {
	    case '[Project] Add Project':
	      if (actionPayload.project && actionPayload.project.id) {
	        projects[actionPayload.project.id] = actionPayload.project;
	      }
	      break;
	
	    case '[Project] Update Project':
	      if (actionPayload.project && actionPayload.project.id) {
	        projects[actionPayload.project.id] =
	          Object.assign({}, projects[actionPayload.project.id], actionPayload.project.changes);
	      }
	      break;
	
	    // No per-task payload here (just a projectId) - clear the flag for
	    // every task currently attributed to that project instead.
	    case '[Project] Move all backlog tasks to regular': {
	      var tasks = state.task;
	      Object.keys(tasks).forEach(function (id) {
	        if (tasks[id] && tasks[id].projectId === actionPayload.projectId) {
	          tasks[id].__inBacklog = false;
	        }
	      });
	      break;
	    }
	
	    default:
	      break;
	  }
	}
	
	// The real app has no "project notes" field - a project has a *list* of
	// separate Note entities (project.noteIds), entityType 'NOTE'
	// (note.actions.ts/note.reducer.ts), riding the same generic op-log capture
	// path TASK/PROJECT/SIMPLE_COUNTER do. The watch has no UI for a list of
	// notes per project though - it treats a project's oldest Note (by
	// `created`, see firstNoteForProject in index.js) as the one synthetic
	// "project note" it shows/appends to, same "one note, view + append" shape
	// task.notes already has. This just needs to replay the real Note entity
	// faithfully; which note the watch picks is index.js's concern, not this
	// replay's.
	function applyNoteAction(op, actionPayload, state) {
	  var notes = ensureCollection(state, 'note');
	  if (!actionPayload) {
	    return;
	  }
	  switch (op.actionType) {
	    case '[Note] Add Note':
	      if (actionPayload.note && actionPayload.note.id) {
	        notes[actionPayload.note.id] = actionPayload.note;
	      }
	      break;
	
	    case '[Note] Update Note':
	      if (actionPayload.note && actionPayload.note.id) {
	        notes[actionPayload.note.id] =
	          Object.assign({}, notes[actionPayload.note.id], actionPayload.note.changes);
	      }
	      break;
	
	    case '[Note] Delete Note':
	      if (actionPayload.id) {
	        delete notes[actionPayload.id];
	      }
	      break;
	
	    case '[Note] Move to other project':
	      if (actionPayload.note && actionPayload.note.id && actionPayload.targetProjectId) {
	        notes[actionPayload.note.id] =
	          Object.assign({}, notes[actionPayload.note.id], { projectId: actionPayload.targetProjectId });
	      }
	      break;
	
	    default:
	      // Update Note Order only reorders (todayOrder, or a project's own
	      // note order) - nothing about title/content to mirror.
	      break;
	  }
	}
	
	// Resolves task.tagIds against the TAG entity collection replayed here
	// (tag.actions.ts, entityType 'TAG' - same generic op-log capture path
	// PROJECT/NOTE already use, no entity-specific meta-reducer). Only `title`
	// is needed for the watch's read-only tags overlay - see main.c's
	// show_tags_overlay/MSG_TASK_TAGS.
	function applyTagAction(op, actionPayload, state) {
	  var tags = ensureCollection(state, 'tag');
	  if (!actionPayload) {
	    return;
	  }
	  switch (op.actionType) {
	    case '[Tag] Add Tag':
	      if (actionPayload.tag && actionPayload.tag.id) {
	        tags[actionPayload.tag.id] = actionPayload.tag;
	      }
	      break;
	
	    case '[Tag] Update Tag':
	      if (actionPayload.tag && actionPayload.tag.id) {
	        tags[actionPayload.tag.id] = Object.assign({}, tags[actionPayload.tag.id], actionPayload.tag.changes);
	      }
	      break;
	
	    case '[Tag] Delete Tag':
	      if (actionPayload.id) {
	        delete tags[actionPayload.id];
	      }
	      break;
	
	    // NOT "...Delete Tags" - mirrors deleteSimpleCounters' own real action
	    // string literal, confirmed against the actual createAction() call
	    // rather than assumed from the plural naming pattern.
	    case '[Tag] Delete multiple Tags':
	      (actionPayload.ids || []).forEach(function (id) { delete tags[id]; });
	      break;
	
	    default:
	      // Reorder and advanced-config actions don't touch title - nothing to
	      // mirror.
	      break;
	  }
	}
	
	// "Habits" in the real app's UI are actually the SimpleCounter feature
	// (src/app/features/simple-counter/), entityType 'SIMPLE_COUNTER' - there is
	// no separate "HABIT" entity type. Confirmed against
	// simple-counter.actions.ts/reducer.ts: unlike TASK's bespoke
	// actionPayload shapes, every persistent SimpleCounter action rides the
	// same generic op-log capture path (no entity-specific meta-reducer), but
	// the actionPayload shapes themselves still vary per action type just like
	// TASK's do.
	function applySimpleCounterAction(op, actionPayload, state) {
	  var counters = ensureCollection(state, 'simpleCounter');
	  if (!actionPayload) {
	    return;
	  }
	  switch (op.actionType) {
	    case '[SimpleCounter] Add SimpleCounter':
	      if (actionPayload.simpleCounter && actionPayload.simpleCounter.id) {
	        counters[actionPayload.simpleCounter.id] = actionPayload.simpleCounter;
	      }
	      break;
	
	    case '[SimpleCounter] Update SimpleCounter':
	      if (actionPayload.simpleCounter && actionPayload.simpleCounter.id) {
	        var scId = actionPayload.simpleCounter.id;
	        counters[scId] = Object.assign({}, counters[scId], actionPayload.simpleCounter.changes);
	      }
	      break;
	
	    // Confirmed against the real reducer (setSimpleCounterCounterToday/
	    // ForDate cases): a plain REPLACE of that single day's count
	    // (Math.max(0, newVal)), not additive - unlike task time-tracking's
	    // delta semantics. This is the "mark a habit done for today" action.
	    case '[SimpleCounter] Set SimpleCounter Counter Today':
	    case '[SimpleCounter] Set SimpleCounter Counter For Date': {
	      var cId = actionPayload.id;
	      var day = actionPayload.today || actionPayload.date;
	      if (cId && day && typeof actionPayload.newVal === 'number' && counters[cId]) {
	        var countOnDay = Object.assign({}, counters[cId].countOnDay);
	        countOnDay[day] = Math.max(0, actionPayload.newVal);
	        counters[cId] = Object.assign({}, counters[cId], { countOnDay: countOnDay });
	      }
	      break;
	    }
	
	    // StopWatch-type counters' batched time sync - confirmed additive
	    // (currentVal + duration), mirroring task time-tracking exactly.
	    case '[SimpleCounter] Sync counter time': {
	      var stId = actionPayload.id;
	      var stDate = actionPayload.date;
	      var stDuration = actionPayload.duration;
	      if (stId && stDate && typeof stDuration === 'number' && counters[stId]) {
	        var stCountOnDay = Object.assign({}, counters[stId].countOnDay);
	        stCountOnDay[stDate] = (stCountOnDay[stDate] || 0) + stDuration;
	        counters[stId] = Object.assign({}, counters[stId], { countOnDay: stCountOnDay });
	      }
	      break;
	    }
	
	    case '[SimpleCounter] Delete SimpleCounter':
	      if (actionPayload.id) {
	        delete counters[actionPayload.id];
	      }
	      break;
	
	    // NOT "...Delete SimpleCounters" - the real action's string literal is
	    // "Delete multiple SimpleCounters" (deleteSimpleCounters action
	    // creator), confirmed by reading the actual createAction() call rather
	    // than assuming the plural naming pattern TASK's deleteTasks uses.
	    case '[SimpleCounter] Delete multiple SimpleCounters':
	      (actionPayload.ids || []).forEach(function (id) { delete counters[id]; });
	      break;
	
	    default:
	      // Reorder, upsert (sync/import only), and other SimpleCounter-entity
	      // actions don't affect title/isEnabled/type/countOnDay - nothing to do.
	      break;
	  }
	}
	
	// TASK_REPEAT_CFG (recurring-task templates). Only used by the Upcoming page
	// (computeUpcoming projects their future occurrences); the payload shapes below
	// are read straight from super-productivity's task-repeat-cfg.actions.ts.
	function applyTaskRepeatCfgAction(op, actionPayload, state) {
	  var cfgs = ensureCollection(state, 'taskRepeatCfg');
	  if (!actionPayload) {
	    return;
	  }
	  switch (op.actionType) {
	    case '[TaskRepeatCfg][Task] Add TaskRepeatCfg to Task':
	    case '[TaskRepeatCfg] Upsert TaskRepeatCfg':
	      if (actionPayload.taskRepeatCfg && actionPayload.taskRepeatCfg.id) {
	        var full = actionPayload.taskRepeatCfg;
	        cfgs[full.id] = actionPayload.startTime
	          ? Object.assign({}, full, { startTime: actionPayload.startTime })
	          : full;
	      }
	      break;
	
	    case '[TaskRepeatCfg] Update TaskRepeatCfg':
	      if (actionPayload.taskRepeatCfg && actionPayload.taskRepeatCfg.id) {
	        cfgs[actionPayload.taskRepeatCfg.id] = Object.assign(
	          {}, cfgs[actionPayload.taskRepeatCfg.id], actionPayload.taskRepeatCfg.changes);
	      }
	      break;
	
	    case '[TaskRepeatCfg] Update TaskRepeatCfgs':
	      (actionPayload.taskRepeatCfgs || []).forEach(function (u) {
	        if (u && u.id) {
	          cfgs[u.id] = Object.assign({}, cfgs[u.id], u.changes);
	        }
	      });
	      break;
	
	    case '[TaskRepeatCfg] Delete TaskRepeatCfg':
	      if (actionPayload.id) {
	        delete cfgs[actionPayload.id];
	      }
	      break;
	
	    case '[TaskRepeatCfg] Delete TaskRepeatCfgs':
	      (actionPayload.ids || []).forEach(function (id) { delete cfgs[id]; });
	      break;
	
	    // A single materialised instance was deleted - remember the date so its
	    // occurrence stops showing in the Upcoming projection.
	    case '[TaskRepeatCfg] Delete Single Instance':
	      if (actionPayload.repeatCfgId && actionPayload.dateStr && cfgs[actionPayload.repeatCfgId]) {
	        var c = cfgs[actionPayload.repeatCfgId];
	        var deleted = (c.deletedInstanceDates || []).slice();
	        if (deleted.indexOf(actionPayload.dateStr) === -1) {
	          deleted.push(actionPayload.dateStr);
	        }
	        cfgs[actionPayload.repeatCfgId] = Object.assign({}, c, { deletedInstanceDates: deleted });
	      }
	      break;
	
	    default:
	      break;
	  }
	}
	
	// Daily metric / reflection entity (metric.actions.ts), keyed by day string.
	// The watch never displays these; this keeps state.metric consistent so the
	// watch's own energy-check-in upsert (index.js's handleMetricEnergy) merges
	// onto the latest value rather than clobbering a desktop reflection.
	function applyMetricAction(op, actionPayload, state) {
	  var metrics = ensureCollection(state, 'metric');
	  if (!actionPayload) {
	    return;
	  }
	  switch (op.actionType) {
	    case '[Metric] Add Metric':
	    case '[Metric] Upsert Metric':
	      if (actionPayload.metric && actionPayload.metric.id) {
	        metrics[actionPayload.metric.id] = actionPayload.metric;
	      }
	      break;
	    case '[Metric] Update Metric':
	      // ngrx Update<Metric>: { id, changes }
	      if (actionPayload.metric && actionPayload.metric.id) {
	        metrics[actionPayload.metric.id] = Object.assign(
	          {}, metrics[actionPayload.metric.id], actionPayload.metric.changes);
	      }
	      break;
	    case '[Metric] Delete Metric':
	      if (actionPayload.id) {
	        delete metrics[actionPayload.id];
	      }
	      break;
	    default:
	      break;
	  }
	}
	
	// Per-day work-session data (time-tracking.model.ts's TTWorkContextData:
	// s/e = minute-rounded epoch ms of work start/end, b = break count, bt = break
	// ms), keyed state.timeTracking[project|tag][ctxId][dateStr]. The watch never
	// tracks this itself; this replay just keeps it consistent so computeStats can
	// show each day's session span + break count on the Stats page.
	function applyTimeTrackingAction(op, actionPayload, state) {
	  var tt = state.timeTracking || (state.timeTracking = { project: {}, tag: {} });
	  if (!actionPayload) {
	    return;
	  }
	  var type, ctxId, date, data;
	  if (op.actionType === '[TimeTracking] Sync sessions') {
	    type = actionPayload.contextType;
	    ctxId = actionPayload.contextId;
	    date = actionPayload.date;
	    data = actionPayload.data;
	  } else if (op.actionType === '[TimeTracking] Update Work Context Data') {
	    type = actionPayload.ctx && actionPayload.ctx.type;
	    ctxId = actionPayload.ctx && actionPayload.ctx.id;
	    date = actionPayload.date;
	    data = actionPayload.updates;
	  } else {
	    return;
	  }
	  var bucket = type === 'TAG' ? 'tag' : type === 'PROJECT' ? 'project' : null;
	  if (!bucket || !ctxId || !date || !data) {
	    return;
	  }
	  var byCtx = tt[bucket][ctxId] || (tt[bucket][ctxId] = {});
	  byCtx[date] = Object.assign({}, byCtx[date], data);
	}
	
	// globalConfig sync (global-config.actions.ts): "[Global Config] Update Global
	// Config Section", entityId = the section key, actionPayload = { sectionKey,
	// sectionCfg (a Partial<section>) }. Merged into state.globalConfig[section].
	// The watch only reads the `pomodoro` section (focus-mode timing).
	function applyGlobalConfigAction(op, actionPayload, state) {
	  if (!actionPayload || !actionPayload.sectionKey) {
	    return;
	  }
	  var gc = state.globalConfig || (state.globalConfig = {});
	  gc[actionPayload.sectionKey] = Object.assign(
	    {}, gc[actionPayload.sectionKey], actionPayload.sectionCfg || {});
	  if (actionPayload.sectionKey === 'misc') {
	    setStartOfNextDayFromState(state);
	  }
	}
	
	// Applies one SuperSync operation to `state` in place. `crypto` is the
	// object returned by supersync-client.js's createCrypto(password) if E2EE is
	// on, or null/undefined otherwise. Never throws - a single malformed/
	// unrecognized op should not take down the whole sync (it just means that
	// entity may be stale until next snapshot restore).
	//
	// `entry` is one element of GET /api/sync/ops's `ops` array, confirmed
	// against a live account to be shaped { serverSeq, op: {...}, receivedAt } -
	// NOT a flat Operation object. entityType is uppercase ("TASK",
	// "GLOBAL_CONFIG", ...), the op-type field is `opType` not `type`, and the
	// encrypted flag is `isPayloadEncrypted` not `encrypted`.
	function applyOperation(entry, state, crypto) {
	  var op = entry && entry.op;
	  if (!op) {
	    return;
	  }
	  try {
	    var payload = op.payload;
	    if (op.isPayloadEncrypted && payload && crypto) {
	      payload = crypto.decrypt(payload);
	    }
	    var entityType = op.entityType && String(op.entityType).toLowerCase();
	
	    // SP resolves a field-level sync conflict (projectId is the common one -
	    // see the real repo's lww-projectid-convergence spec + repairTaskProjectForLww)
	    // by emitting a "[<ENTITY>] LWW Update" op whose actionPayload is the
	    // WINNING entity spread at the top level (id + every field + a `meta`
	    // blob). It REPLACES the stored entity, it does not merge. None of the
	    // per-action handlers below know this actionType, so before this a task
	    // moved between projects on the desktop kept its stale projectId on the
	    // watch - it stayed listed under the old project in the Projects browser
	    // and drew the wrong project name everywhere (grouped today view, Schedule
	    // page). Handled here generically for the entity types the watch renders;
	    // the payload is a full entity so a plain replace is right (a task keeps
	    // only __inBacklog, which is the watch's own synthetic flag).
	    if (op.actionType && /\]\s*LWW Update\s*$/.test(op.actionType)) {
	      var lwwData = (payload && payload.actionPayload) || payload;
	      if (lwwData && lwwData.id) {
	        if (lwwData.meta) {
	          lwwData = Object.assign({}, lwwData);
	          delete lwwData.meta;
	        }
	        if (entityType === 'task') {
	          replaceTaskPreservingBacklog(ensureCollection(state, 'task'), lwwData);
	        } else if (entityType === 'project') {
	          ensureCollection(state, 'project')[lwwData.id] = lwwData;
	        } else if (entityType === 'note') {
	          ensureCollection(state, 'note')[lwwData.id] = lwwData;
	        } else if (entityType === 'tag') {
	          ensureCollection(state, 'tag')[lwwData.id] = lwwData;
	        } else if (entityType === 'simple_counter') {
	          ensureCollection(state, 'simpleCounter')[lwwData.id] = lwwData;
	        } else if (entityType === 'task_repeat_cfg') {
	          ensureCollection(state, 'taskRepeatCfg')[lwwData.id] = lwwData;
	        }
	      }
	      return;
	    }
	
	    if (entityType === 'task') {
	      applyTaskAction(op, payload && payload.actionPayload, state);
	      return;
	    }
	    if (entityType === 'project') {
	      applyProjectAction(op, payload && payload.actionPayload, state);
	      return;
	    }
	    if (entityType === 'simple_counter') {
	      applySimpleCounterAction(op, payload && payload.actionPayload, state);
	      return;
	    }
	    if (entityType === 'planner') {
	      applyPlannerAction(op, payload && payload.actionPayload, state);
	      return;
	    }
	    if (entityType === 'note') {
	      applyNoteAction(op, payload && payload.actionPayload, state);
	      return;
	    }
	    if (entityType === 'tag') {
	      applyTagAction(op, payload && payload.actionPayload, state);
	      return;
	    }
	    if (entityType === 'task_repeat_cfg') {
	      applyTaskRepeatCfgAction(op, payload && payload.actionPayload, state);
	      return;
	    }
	    if (entityType === 'metric') {
	      applyMetricAction(op, payload && payload.actionPayload, state);
	      return;
	    }
	    if (entityType === 'time_tracking') {
	      applyTimeTrackingAction(op, payload && payload.actionPayload, state);
	      return;
	    }
	    if (entityType === 'global_config') {
	      applyGlobalConfigAction(op, payload && payload.actionPayload, state);
	      return;
	    }
	
	    // Everything else (GLOBAL_CONFIG, PLUGIN_USER_DATA, ...) is unused by
	    // the watch's task list - kept as a best-effort flat CRUD merge (this
	    // project's original, unverified assumption) purely so unrelated
	    // entity types don't spam the "unhandled" log.
	    switch (op.opType) {
	      case 'CRT': {
	        var created = ensureCollection(state, entityType);
	        created[op.entityId] = payload;
	        break;
	      }
	      case 'UPD': {
	        var coll = ensureCollection(state, entityType);
	        coll[op.entityId] = Object.assign({}, coll[op.entityId], payload);
	        break;
	      }
	      case 'DEL': {
	        var delColl = ensureCollection(state, entityType);
	        if (payload && Array.isArray(payload.ids)) {
	          payload.ids.forEach(function (id) { delete delColl[id]; });
	        } else {
	          delete delColl[op.entityId];
	        }
	        break;
	      }
	      case 'MOV':
	        break;
	      case 'SYNC_IMPORT':
	      case 'BACKUP_IMPORT':
	      case 'REPAIR':
	        // Confirmed against a live account: this carries a full NgRx
	        // EntityState snapshot per feature slice, e.g.
	        // payload.task = { ids: [...], entities: { [id]: Task } },
	        // payload.project likewise. This is a full replacement, not a
	        // merge - it fires once, at whatever point the local history
	        // begins.
	        if (payload && payload.task && payload.task.entities) {
	          state.task = payload.task.entities;
	        }
	        if (payload && payload.project && payload.project.entities) {
	          state.project = payload.project.entities;
	          // Seed __inBacklog from each project's backlogTaskIds - this is
	          // the only place backlog membership is available as a
	          // ready-made list rather than an incremental move action.
	          Object.keys(state.project).forEach(function (projectId) {
	            var backlogIds = state.project[projectId].backlogTaskIds || [];
	            backlogIds.forEach(function (taskId) {
	              if (state.task[taskId]) {
	                state.task[taskId].__inBacklog = true;
	              }
	            });
	          });
	        }
	        if (payload && payload.simpleCounter && payload.simpleCounter.entities) {
	          state.simpleCounter = payload.simpleCounter.entities;
	        }
	        if (payload && payload.note && payload.note.entities) {
	          state.note = payload.note.entities;
	        }
	        if (payload && payload.tag && payload.tag.entities) {
	          state.tag = payload.tag.entities;
	        }
	        if (payload && payload.taskRepeatCfg && payload.taskRepeatCfg.entities) {
	          state.taskRepeatCfg = payload.taskRepeatCfg.entities;
	        }
	        if (payload && payload.metric && payload.metric.entities) {
	          state.metric = payload.metric.entities;
	        }
	        // globalConfig / timeTracking are plain objects, not NgRx EntityState.
	        if (payload && payload.globalConfig) {
	          state.globalConfig = payload.globalConfig;
	          setStartOfNextDayFromState(state);
	        }
	        if (payload && payload.timeTracking) {
	          state.timeTracking = payload.timeTracking;
	        }
	        break;
	      default:
	        console.log('[task-store] unhandled op type: ' + op.opType);
	    }
	  } catch (err) {
	    console.log('[task-store] failed to apply op ' + (op && op.id) + ': ' + err.message);
	  }
	}
	
	// onProgress, if given, is called after every entry as (doneCount, total) -
	// used by doSync()'s pullPage() to surface decrypt progress on a slow page
	// instead of leaving the watch's status frozen (see its own call site).
	function applyOperations(entries, state, crypto, onProgress) {
	  entries.forEach(function (entry, index) {
	    applyOperation(entry, state, crypto);
	    if (onProgress) {
	      onProgress(index + 1, entries.length);
	    }
	  });
	}
	
	function isMainTask(t) {
	  return !t.parentId;
	}
	
	function projectTitleFor(state, task) {
	  var project = task.projectId && state.project && state.project[task.projectId];
	  return (project && project.title) || 'No Project';
	}
	
	// Resolves task.tagIds against state.tag, joined for the watch's read-only
	// tags overlay (long-select Back on a task row - see main.c's
	// show_tags_overlay/MSG_TASK_TAGS). A tag id with no matching entity (not
	// yet synced, or deleted) is silently skipped rather than surfacing a
	// blank/placeholder name.
	function tagTitlesFor(state, task) {
	  var ids = task.tagIds || [];
	  var tags = state.tag || {};
	  var names = [];
	  ids.forEach(function (id) {
	    if (tags[id] && tags[id].title) {
	      names.push(tags[id].title);
	    }
	  });
	  return names.join(', ');
	}
	
	function titleCompare(a, b) {
	  // Plain ordinal comparison, not localeCompare(): confirmed against the
	  // basalt emulator that its embedded JS engine throws "Internal error.
	  // Icu error." on locale-aware string ops with no ICU data loaded, and
	  // locale-aware sorting isn't needed for this anyway.
	  var at = String(a);
	  var bt = String(b);
	  return at < bt ? -1 : at > bt ? 1 : 0;
	}
	
	// Sort order within one visual group: not-done before done, then by title.
	// Module-level (not nested in getActiveTasks) so getProjectTasks can reuse
	// the exact same ordering for a project browser's regular / backlog lists.
	function withinGroupSort(a, b) {
	  if (!!a.isDone !== !!b.isDone) {
	    return a.isDone ? 1 : -1;
	  }
	  return titleCompare(a.title, b.title);
	}
	
	// Sentinel project id for the synthetic "No Project" entry getProjectList
	// emits when project-less active tasks exist - getProjectTasks maps it back
	// to "tasks with no projectId". A real project id is a plain nanoid(), so
	// this can't collide.
	var NO_PROJECT_ID = '__NO_PROJECT__';
	
	// Every non-archived project, plus a synthetic "No Project" entry when
	// there are project-less active main tasks to reach through it. Sorted by
	// title. Shape: [{ id, title, color }] where color is 0xRRGGBB parsed from the
	// project's theme colour (0 if none). Feeds the watch's Projects browser (a
	// pinned row -> project list -> that project's tasks), which - unlike the
	// today list - is not date-filtered.
	function projectColorRgb(p) {
	  // super-productivity Project.theme.primary is a "#rrggbb" string
	  // (WorkContextThemeCfg); older data used a flat themeColor. We quantise it
	  // to Pebble's packed GColor8 byte here (2 bits per channel + opaque alpha)
	  // so the watch just assigns it - no colour maths in the draw path, which
	  // matters for emery's tight code budget. 0 = no colour -> no swatch.
	  var hex = (p.theme && p.theme.primary) || p.themeColor || '';
	  var m = /^#?([0-9a-fA-F]{6})$/.exec(String(hex).trim());
	  if (!m) {
	    return 0;
	  }
	  var n = parseInt(m[1], 16);
	  var r = (n >> 16) & 0xff, g = (n >> 8) & 0xff, b = n & 0xff;
	  return 0xc0 | ((r >> 6) << 4) | ((g >> 6) << 2) | (b >> 6); // GColor8.argb, always non-zero (alpha bits set)
	}
	
	// Count of a project's active main tasks in its REGULAR list - the backlog,
	// done tasks and subtasks are all excluded. projectId falsy / NO_PROJECT_ID
	// counts the no-project tasks. Shown right-aligned on each browser project row.
	function projectRegularTaskCount(state, projectId) {
	  var allTasks = state.task || {};
	  var wantNoProject = !projectId || projectId === NO_PROJECT_ID;
	  var n = 0;
	  Object.keys(allTasks).forEach(function (id) {
	    var t = allTasks[id];
	    if (!t || !t.title || !isMainTask(t) || t.isDone || t.__inBacklog) {
	      return;
	    }
	    if (wantNoProject ? !t.projectId : t.projectId === projectId) {
	      n++;
	    }
	  });
	  return n;
	}
	
	function getProjectList(state) {
	  var projects = state.project || {};
	  var allTasks = state.task || {};
	  var out = Object.keys(projects)
	    .map(function (id) { return projects[id]; })
	    .filter(function (p) { return p && p.id && p.title && !p.isArchived; })
	    .map(function (p) {
	      return {
	        id: p.id,
	        title: p.title,
	        color: projectColorRgb(p),
	        taskCount: projectRegularTaskCount(state, p.id),
	      };
	    });
	  out.sort(function (a, b) { return titleCompare(a.title, b.title); });
	  var hasNoProject = Object.keys(allTasks).some(function (id) {
	    var t = allTasks[id];
	    return t && t.title && isMainTask(t) && !t.projectId && !t.isDone;
	  });
	  if (hasNoProject) {
	    out.push({
	      id: NO_PROJECT_ID,
	      title: 'No Project',
	      color: 0,
	      taskCount: projectRegularTaskCount(state, NO_PROJECT_ID),
	    });
	  }
	  return out;
	}
	
	// One project's whole active task list, split into its regular list and its
	// backlog - { regular: [rows], backlog: [rows] }, each row the same shape
	// getActiveTasks produces (id, title, isDone, project, projectId, tags,
	// dueWithTime, timeSpent, timeEstimate) with subtasks nested under their
	// parent the same way. projectId === NO_PROJECT_ID (or falsy) selects tasks
	// with no project. No date filter - a project browser shows everything, not
	// just today. Done tasks still obey hideDone's grace period. Each list is
	// capped at `limit` rows.
	function getProjectTasks(state, projectId, limit, hideDone) {
	  var allTasks = state.task || {};
	  var wantNoProject = !projectId || projectId === NO_PROJECT_ID;
	  var projName = wantNoProject
	    ? 'No Project'
	    : ((state.project && state.project[projectId] && state.project[projectId].title) || 'No Project');
	  var pid = wantNoProject ? '' : projectId;
	  var mains = Object.keys(allTasks)
	    .map(function (id) { return allTasks[id]; })
	    .filter(function (t) { return t && t.title && isMainTask(t); })
	    .filter(function (t) { return !isHiddenDone(t, hideDone); })
	    .filter(function (t) {
	      return wantNoProject ? !t.projectId : t.projectId === projectId;
	    });
	  var regularMains = mains
	    .filter(function (t) { return !t.__inBacklog; })
	    .sort(withinGroupSort);
	  var backlogMains = mains
	    .filter(function (t) { return t.__inBacklog; })
	    .sort(withinGroupSort);
	  var regular = [];
	  var backlog = [];
	  regularMains.forEach(function (t) {
	    pushTaskAndSubtasks(regular, state, allTasks, t, projName, pid, 0, hideDone);
	  });
	  backlogMains.forEach(function (t) {
	    pushTaskAndSubtasks(backlog, state, allTasks, t, projName, pid, 0, hideDone);
	  });
	  return { regular: regular.slice(0, limit), backlog: backlog.slice(0, limit) };
	}
	
	// Count of a tag's OPEN (undone) main tasks - across every project, backlog
	// included, since a tag isn't project-scoped. Shown right-aligned on each row
	// of the optional Tags page.
	function tagOpenTaskCount(state, tagId) {
	  var allTasks = state.task || {};
	  var n = 0;
	  Object.keys(allTasks).forEach(function (id) {
	    var t = allTasks[id];
	    if (t && t.title && isMainTask(t) && !t.isDone &&
	        (t.tagIds || []).indexOf(tagId) !== -1) {
	      n++;
	    }
	  });
	  return n;
	}
	
	// The Tags page's level-0 list: every real tag with its open-task count,
	// title-sorted. The virtual TODAY tag (id 'TODAY', membership derived from
	// dueDay not a stored list - see taskIsPlannedForToday) is skipped.
	function getTagList(state) {
	  var tags = state.tag || {};
	  return Object.keys(tags)
	    .map(function (id) { return tags[id]; })
	    .filter(function (tg) { return tg && tg.id && tg.title && tg.id !== 'TODAY'; })
	    .map(function (tg) {
	      return {
	        id: tg.id,
	        title: tg.title,
	        color: projectColorRgb(tg),
	        taskCount: tagOpenTaskCount(state, tg.id),
	      };
	    })
	    .sort(function (a, b) { return titleCompare(a.title, b.title); });
	}
	
	// One tag's open main tasks (subtasks nested under their parent, as elsewhere),
	// from any project. Each row's `project` is its own task's project title so the
	// watch can show it. No backlog split - a tag spans projects. Done tasks still
	// obey hideDone's grace period. Capped at `limit` rows.
	function getTagTasks(state, tagId, limit, hideDone) {
	  var allTasks = state.task || {};
	  var mains = Object.keys(allTasks)
	    .map(function (id) { return allTasks[id]; })
	    .filter(function (t) { return t && t.title && isMainTask(t); })
	    .filter(function (t) { return !isHiddenDone(t, hideDone); })
	    .filter(function (t) { return (t.tagIds || []).indexOf(tagId) !== -1; })
	    .sort(withinGroupSort);
	  var rows = [];
	  mains.forEach(function (t) {
	    var proj = t.projectId && state.project && state.project[t.projectId];
	    pushTaskAndSubtasks(rows, state, allTasks, t, projectTitleFor(state, t),
	                        t.projectId || undefined, proj ? projectColorRgb(proj) : undefined, hideDone);
	  });
	  return rows.slice(0, limit);
	}
	
	// Returns up to `limit` rows: main tasks that are not sitting in a
	// project's backlog (see the top-of-file comment - no date filtering),
	// each immediately followed by its own subtasks (indented), regardless of
	// the subtask's own isDone/backlog status.
	//
	// When groupByProject is true, rows are grouped by project title (not-
	// done-first, then title, within each group; groups themselves ordered by
	// title, "No Project" included as its own group); every row carries a
	// `project` field equal to its group's title, so a caller can detect
	// group boundaries as runs of equal `project` values. When false, every
	// row's `project` is '' - a single implicit group, matching the flat list
	// this had before grouping existed.
	//
	// Mirrors computeOrderedTaskIdsForToday in the real app's
	// work-context.selectors.ts: dueWithTime takes priority when set (checked
	// against today's calendar day) - dueDay is only consulted as a fallback
	// when dueWithTime is NOT set. This isn't just an arbitrary tie-break: it's
	// how the real selector resolves legacy data that (pre dueDay/dueWithTime
	// mutual exclusivity - see task-shared-scheduling.reducer.ts) can carry
	// both fields, where a stale leftover dueDay must not override a dueWithTime
	// that says otherwise.
	function taskIsPlannedForToday(t, today) {
	  if (t.dueWithTime) {
	    return msIsToday(t.dueWithTime);
	  }
	  return t.dueDay === today;
	}
	
	// A task marked done stays visible for this long after completion even
	// with hideDone on, so completing it on the watch doesn't make it vanish
	// before the user can see it happen - the very next auto-sync
	// (runAutoSyncAfterOp, on by default) used to land within a second or two
	// of the toggle and immediately exclude it. Only meaningful for a task
	// completed VIA THE WATCH: doneOn is stamped by handleTaskToggle's own
	// optimistic update in index.js, which is the only place this replay path
	// sets it reliably - a real op from another client (task.service.ts's own
	// `update(id, { isDone: true })` call, confirmed via the real source,
	// never includes doneOn in the dispatched changes; the real reducer
	// computes ITS OWN Date.now() fallback at replay time, which this app's
	// generic mergeTaskChanges() doesn't replicate) generally won't carry a
	// fresh-enough doneOn through this app's own replay to matter here - which
	// is also the right scope: nobody's watching the watch in real time for a
	// completion that happened on a different device.
	var HIDE_DONE_GRACE_MS = 10000;
	
	// Shared by getActiveTasks' own main-task filter and pushTaskAndSubtasks'
	// per-subtask filter below - a done task/subtask with no doneOn at all
	// (never set - e.g. done before this grace period existed, or done by
	// another client per the comment above) hides immediately, same as this
	// app's original behavior, rather than being treated as "just completed".
	function isHiddenDone(t, hideDone) {
	  if (!hideDone || !t.isDone) {
	    return false;
	  }
	  return !t.doneOn || Date.now() - t.doneOn >= HIDE_DONE_GRACE_MS;
	}
	
	// When todayOnly is true, tasks are further restricted to ones actually
	// planned for today (see taskIsPlannedForToday) - not undated, overdue, or
	// future-dated ones. This mirrors the real app's virtual TODAY_TAG, whose
	// membership is likewise derived from dueDay/dueWithTime rather than a
	// synced list (boards.util.ts: "TODAY_TAG is virtual: membership derives
	// from dueDay/dueWithTime"). A main task with no due date of its own but a
	// SUBTASK due today still qualifies - the real selector evaluates every
	// task/subtask independently and would otherwise list that subtask as its
	// own top-level Today entry; this app always nests subtasks under their
	// parent (see pushTaskAndSubtasks), so the parent has to be included for
	// the subtask to have somewhere to nest. Doesn't consider
	// deadlineDay/deadlineWithTime or explicit tag assignment - not a full
	// port, just enough to match what the desktop's Today page actually shows
	// for the common case.
	// alwaysIncludeId, when given, names one task that must appear in the result
	// even if todayOnly / the backlog filter would drop it - the watch's
	// currently-tracked task, which may have been started from the Projects
	// browser and so be neither planned for today nor in the regular list. The
	// watch needs it here to render its pinned "TRACKING" row (main.c's
	// pinned_task_index scans exactly this list). A tracked SUBTASK pulls in its
	// parent instead, so it still nests (same reason todayOnly pulls in a parent
	// for a today-due subtask).
	function getActiveTasks(state, limit, groupByProject, todayOnly, hideDone, alwaysIncludeId) {
	  var allTasks = state.task || {};
	  var today = todayStr();
	  var mainTasks = Object.keys(allTasks)
	    .map(function (id) { return allTasks[id]; })
	    // t.title is the tell for a "ghost" record: mergeTaskChanges()
	    // deliberately creates a bare { ...changes } entry (no throw) when an
	    // update-style op references a task id this replay has never seen a
	    // create/snapshot for - e.g. a stray/out-of-order op, or a real task
	    // that was deleted/archived before this account's visible history
	    // began. A real task always has a title; nothing about that intentional
	    // no-throw behavior was ever meant to make ghosts user-visible, so they
	    // never got a title fallback - filtered here instead of leaving them to
	    // surface as a literal "(untitled)" row in "No Project" (see
	    // pushTaskAndSubtasks, which no longer substitutes placeholder text).
	    .filter(function (t) { return t && t.title && isMainTask(t); })
	    // Hiding a done MAIN task hides its whole subtask block along with it
	    // (pushTaskAndSubtasks is never called for a task that's filtered out
	    // here) - same "the subtask has nowhere to nest" reasoning already
	    // used for todayOnly above. A done SUBTASK under a still-open parent is
	    // handled separately, per-subtask, in pushTaskAndSubtasks - the parent
	    // staying visible is exactly the case that reasoning doesn't apply to.
	    .filter(function (t) { return !isHiddenDone(t, hideDone); })
	    .filter(function (t) {
	      if (!todayOnly) {
	        // Mirrors project.taskIds vs project.backlogTaskIds
	        // (project.model.ts): with no date filter, this is "this project's
	        // regular list", which excludes backlog by definition.
	        return !t.__inBacklog;
	      }
	      // The real Today selector (computeOrderedTaskIdsForToday in
	      // work-context.selectors.ts) has NO concept of backlog membership at
	      // all - it's driven purely by dueDay/dueWithTime. A task can be BOTH
	      // still-listed in its project's backlogTaskIds AND explicitly pulled
	      // into today: planTasksForToday never touches backlogTaskIds
	      // (confirmed against handlePlanTasksForToday in
	      // task-shared-scheduling.reducer.ts - it only updates dueDay/
	      // remindAt/dueWithTime and the TODAY tag's own taskIds). Excluding it
	      // here just because __inBacklog is still (correctly, per the real
	      // data model) true would hide a task the real Today page shows -
	      // confirmed live: a GitHub-issue task created straight into the
	      // backlog, later planned for today, stayed excluded from this list
	      // forever even though the desktop's own Today view showed it
	      // normally. todayOnly intentionally ignores __inBacklog entirely,
	      // matching the real selector's own total independence from it.
	      if (taskIsPlannedForToday(t, today)) {
	        return true;
	      }
	      return (t.subTaskIds || []).some(function (subId) {
	        var sub = allTasks[subId];
	        return sub && taskIsPlannedForToday(sub, today);
	      });
	    });
	
	  if (alwaysIncludeId && !mainTasks.some(function (t) { return t.id === alwaysIncludeId; })) {
	    var forced = allTasks[alwaysIncludeId];
	    if (forced && forced.parentId) {
	      forced = allTasks[forced.parentId];
	    }
	    if (forced && forced.title && isMainTask(forced) && !isHiddenDone(forced, hideDone) &&
	        !mainTasks.some(function (t) { return t.id === forced.id; })) {
	      mainTasks.push(forced);
	    }
	  }
	
	  var rows = [];
	  if (groupByProject) {
	    var byProject = {};
	    // Grouped by project TITLE (not id) - see projectTitleFor's own "No
	    // Project" fallback - so groupProjectIds takes the first task's own
	    // projectId seen for that title as the whole visual group's id (used by
	    // the watch's project-notes row - see TASK_PROJECT_ID in index.js's
	    // sendTaskAt). Two distinct projects sharing a display name would
	    // already visually merge into one group before this existed; this just
	    // means the merged group's notes button points at whichever of them was
	    // seen first, same negligible edge case.
	    var groupProjectIds = {};
	    var groupColors = {};
	    mainTasks.forEach(function (t) {
	      var name = projectTitleFor(state, t);
	      if (!byProject[name]) {
	        byProject[name] = [];
	        groupProjectIds[name] = t.projectId || '';
	        groupColors[name] = t.projectId ? projectColorRgb((state.project && state.project[t.projectId]) || {}) : 0;
	      }
	      byProject[name].push(t);
	    });
	    Object.keys(byProject).sort(titleCompare).forEach(function (name) {
	      byProject[name].sort(withinGroupSort);
	      byProject[name].forEach(function (t) {
	        pushTaskAndSubtasks(rows, state, allTasks, t, name, groupProjectIds[name], groupColors[name], hideDone);
	      });
	    });
	  } else {
	    mainTasks.sort(withinGroupSort);
	    mainTasks.forEach(function (t) {
	      pushTaskAndSubtasks(rows, state, allTasks, t, '', '', 0, hideDone);
	    });
	  }
	
	  return rows.slice(0, limit);
	}
	
	// Pebble's MenuLayer has no per-row indent control, so nesting is baked
	// into the title string itself. Plain leading spaces alone read as barely
	// different from a regular row at this font size - a leading marker plus
	// wider indentation reads unambiguously as "sub-item of the row above".
	// U+00BB (RIGHT-POINTING DOUBLE ANGLE QUOTATION MARK, "»") - confirmed
	// rendering correctly on this app's system font in the emulator, unlike an
	// earlier attempt at U+2514 (BOX DRAWINGS LIGHT UP AND RIGHT, "└"), which
	// showed as an empty missing-glyph box on every platform (confirmed twice).
	// Not every non-ASCII codepoint fails the way U+2514 did - » (plus ›, ·,
	// also tried) rendered fine, it was specifically that one glyph missing
	// from the font, not a blanket Unicode limitation. Previously plain ASCII
	// (~) for exactly that reason, before this was re-tested more thoroughly.
	var SUBTASK_PREFIX = '    » ';
	
	function pushTaskAndSubtasks(rows, state, allTasks, t, groupName, groupProjectId, groupColor, hideDone) {
	  // t is already guaranteed a real title here - getActiveTasks filters
	  // ghost (title-less) records out of mainTasks before this is ever
	  // called (hideDone's own done-main-task filtering happens there too, for
	  // the same reason - see its comment). Subtasks aren't filtered upstream
	  // (pulled straight from allTasks by id), so a ghost subtask - same
	  // "update referenced an id this replay never saw a create for" cause as
	  // a ghost main task - is skipped here instead of surfacing as a
	  // placeholder-titled row; a done one is skipped here too when hideDone
	  // is on, independently of whatever state its (necessarily not-done, or
	  // this whole block would never run) parent is in.
	  // No `notes` field here - the watch fetches a task's full notes on demand
	  // (MSG_NOTE_REQUEST, see index.js's sendFullNotesForTask) only for
	  // whichever one task's overlay is currently open, rather than every row
	  // carrying a preview whether or not it's ever viewed. projectId likewise
	  // rides along on every row (not just once per group) so main.c's
	  // recompute_groups() - which derives its per-group TaskGroup from
	  // whichever task happens to be group.start - can read it off any task
	  // rather than needing a separate carrier. tags, unlike notes, IS sent
	  // directly (not fetched on demand) - resolved tag names are short and
	  // already fully available locally once TAG entities have replayed, so
	  // there's no fetch round-trip worth avoiding the way there is for a
	  // task's full notes text.
	  rows.push({ id: t.id, title: t.title, isDone: !!t.isDone, project: groupName, projectId: groupProjectId || undefined, projectColor: groupColor || undefined, tags: tagTitlesFor(state, t) || undefined, dueWithTime: t.dueWithTime || undefined, remindAt: t.remindAt || undefined, timeSpent: t.timeSpent || undefined, timeEstimate: t.timeEstimate || undefined, deadlineDays: taskDeadlineDays(t), recurs: t.repeatCfgId ? 1 : undefined, issueKey: taskIssueKey(t) });
	  (t.subTaskIds || []).forEach(function (subId) {
	    var sub = allTasks[subId];
	    if (sub && sub.title && !isHiddenDone(sub, hideDone)) {
	      rows.push({ id: sub.id, title: SUBTASK_PREFIX + sub.title, isDone: !!sub.isDone, project: groupName, projectId: groupProjectId || undefined, projectColor: groupColor || undefined, tags: tagTitlesFor(state, sub) || undefined, dueWithTime: sub.dueWithTime || undefined, remindAt: sub.remindAt || undefined, timeSpent: sub.timeSpent || undefined, timeEstimate: sub.timeEstimate || undefined, deadlineDays: taskDeadlineDays(sub), recurs: sub.repeatCfgId ? 1 : undefined, issueKey: taskIssueKey(sub) });
	    }
	  });
	}
	
	// Returns up to `limit` enabled, manipulable SimpleCounters ("habits" in the
	// real app's own UI labeling), each with today's progress. "Done today"
	// mirrors the majority of the real UI's own comparisons
	// (habit-tracker.component.ts's getProgress/isSimpleCompletion,
	// EMPTY_SIMPLE_COUNTER's own default): goal defaults to 1 when
	// streakMinValue is unset, done means countOnDay[today] >= goal - this
	// holds for StopWatch-type counters too (value/goal are both milliseconds
	// there, not a plain count), which the watch shows with a live-ticking
	// timer (long-select to start/stop) instead of the Select/long-select
	// increment/decrement a plain ClickCounter row uses - see isStopwatch below
	// and main.c's habits_menu_select_long_click. A RepeatedCountdownReminder
	// counter (isCountdown) gets its own long-select-to-start/stop countdown
	// timer too, but its value/goal stay a plain completed-rounds count, same
	// units as ClickCounter - confirmed against the real
	// simple-counter-button.component.ts: toggleStopwatch() (its click handler,
	// shared with StopWatch) only starts/stops the countdown; the count itself
	// only advances via countUpAndNextRepeatCountdownSession(), fired when the
	// countdown reaches zero, not by any per-tick accumulation the way a
	// StopWatch's ms-valued countOnDay works. countdownMs carries
	// countdownDuration (the configured length of one round) for exactly that
	// timer - 0/absent for every other type. Only isEnabled counters are
	// included, matching selectEnabledSimpleCounters. Sorted plain
	// alphabetically by title - done/not-done doesn't split the list into two
	// blocks, since a habit's position jumping around as soon as it crosses its
	// goal for the day makes a specific habit harder to find at a glance than a
	// fixed alphabetical spot does.
	// Streak handling mirrors the real app's get-simple-counter-streak-duration.ts.
	// A counter with no streakMinValue has no streak (returns 0). "specific-days"
	// mode counts only the weekdays flagged in streakWeekDays (SP's default counter
	// has Mon-Fri) and an unset streakWeekDays is treated as "not configured" -> 0,
	// exactly as SP does. "weekly-frequency" mode counts weeks (Mon-start) that hit
	// streakWeeklyFrequency goal-met days, returning the summed day count. Callers
	// gate all of this on isTrackStreaks (default true) - see getActiveHabits.
	
	function streakDayConsidered(streakWeekDays, d) {
	  return !!(streakWeekDays && streakWeekDays[d.getDay()]);
	}
	
	// Walk `d` backwards to the nearest weekday streakWeekDays counts (SP's
	// setDayToLastConsideredWeekday - 7-step failsafe against an all-false mask).
	function streakStepToConsidered(d, streakWeekDays) {
	  for (var i = 0; i <= 7 && !streakDayConsidered(streakWeekDays, d); i++) {
	    d.setDate(d.getDate() - 1);
	  }
	}
	
	// Monday-anchored start of the week containing `date`, at local midnight.
	function streakWeekStart(date) {
	  var r = new Date(date);
	  var day = r.getDay();
	  r.setDate(r.getDate() - (day === 0 ? 6 : day - 1));
	  r.setHours(0, 0, 0, 0);
	  return r;
	}
	
	// Goal-met days in the 7 days from weekStart.
	function streakWeekMetCount(weekStart, on, min) {
	  var count = 0;
	  for (var i = 0; i < 7; i++) {
	    var d = new Date(weekStart);
	    d.setDate(d.getDate() + i);
	    if ((on[dateToDateStr(d)] || 0) >= min) {
	      count++;
	    }
	  }
	  return count;
	}
	
	function habitWeeklyFrequencyStreak(c) {
	  var min = c.streakMinValue;
	  var freq = c.streakWeeklyFrequency;
	  if (!freq || freq < 1) {
	    return 0;
	  }
	  var on = c.countOnDay || {};
	  var currentWeekStart = streakWeekStart(logicalNow());
	  var currentWeekCount = streakWeekMetCount(currentWeekStart, on, min);
	  var isCurrentWeekMet = currentWeekCount >= freq;
	  var weekStart = new Date(currentWeekStart);
	  if (!isCurrentWeekMet) {
	    weekStart.setDate(weekStart.getDate() - 7);
	  }
	  var total = 0;
	  for (var guard = 0; guard < 520; guard++) {
	    var wc = streakWeekMetCount(weekStart, on, min);
	    if (wc < freq) {
	      break;
	    }
	    total += wc;
	    weekStart.setDate(weekStart.getDate() - 7);
	  }
	  if (total > 0 && !isCurrentWeekMet) {
	    return total + currentWeekCount;
	  }
	  // SP intentionally shows the current week's progress when no full week has
	  // met the goal yet, as encouragement.
	  return total || currentWeekCount;
	}
	
	// Current streak. specific-days: consecutive considered weekdays meeting the
	// goal, counting behind today when today isn't met yet. weekly-frequency: see
	// habitWeeklyFrequencyStreak.
	function habitStreak(c) {
	  var min = c && c.streakMinValue;
	  if (!min) {
	    return 0;
	  }
	  if (c.streakMode === 'weekly-frequency') {
	    return habitWeeklyFrequencyStreak(c);
	  }
	  if (!c.streakWeekDays) {
	    return 0;
	  }
	  var on = c.countOnDay || {};
	  var today = todayStr();
	  var d = logicalNow();
	  streakStepToConsidered(d, c.streakWeekDays);
	  if (dateToDateStr(d) === today && (on[today] || 0) < min) {
	    d.setDate(d.getDate() - 1);
	    streakStepToConsidered(d, c.streakWeekDays);
	  }
	  var n = 0;
	  for (var guard = 0; guard < 2000 && (on[dateToDateStr(d)] || 0) >= min; guard++) {
	    n++;
	    d.setDate(d.getDate() - 1);
	    streakStepToConsidered(d, c.streakWeekDays);
	  }
	  return n;
	}
	
	// Earliest local Date among "YYYY-MM-DD" countOnDay keys, or null.
	function streakEarliestDate(on) {
	  var best = null;
	  for (var k in on) {
	    if (!on.hasOwnProperty(k)) {
	      continue;
	    }
	    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(k);
	    if (m) {
	      var t = new Date(+m[1], +m[2] - 1, +m[3]).getTime();
	      if (best === null || t < best) {
	        best = t;
	      }
	    }
	  }
	  return best === null ? null : new Date(best);
	}
	
	// The record the current streak is measured against - the longest such run
	// anywhere in this counter's history. Same mode split as habitStreak; the
	// weekly-frequency variant sums met days over the longest run of consecutive
	// completed weeks (partial current week excluded).
	function habitBestStreak(c) {
	  var min = c && c.streakMinValue;
	  if (!min) {
	    return 0;
	  }
	  var on = c.countOnDay || {};
	  var earliest = streakEarliestDate(on);
	  if (!earliest) {
	    return 0;
	  }
	  if (c.streakMode === 'weekly-frequency') {
	    var freq = c.streakWeeklyFrequency;
	    if (!freq || freq < 1) {
	      return 0;
	    }
	    var w = streakWeekStart(earliest);
	    var currentWeekStart = streakWeekStart(logicalNow()).getTime();
	    var runSum = 0;
	    var wbest = 0;
	    for (var wg = 0; wg < 1200 && w.getTime() < currentWeekStart; wg++) {
	      var wc = streakWeekMetCount(w, on, min);
	      runSum = wc >= freq ? runSum + wc : 0;
	      if (runSum > wbest) {
	        wbest = runSum;
	      }
	      w.setDate(w.getDate() + 7);
	    }
	    return wbest;
	  }
	  if (!c.streakWeekDays) {
	    return 0;
	  }
	  var today = todayStr();
	  var d = new Date(earliest);
	  var run = 0;
	  var best = 0;
	  for (var g = 0; g < 4000; g++) {
	    var ds = dateToDateStr(d);
	    if (streakDayConsidered(c.streakWeekDays, d)) {
	      if ((on[ds] || 0) >= min) {
	        run++;
	        if (run > best) {
	          best = run;
	        }
	      } else if (ds !== today) {
	        run = 0; // an unmet considered day in the past breaks the run
	      }
	    }
	    if (ds === today) {
	      break;
	    }
	    d.setDate(d.getDate() + 1);
	  }
	  return best;
	}
	
	function getActiveHabits(state, limit) {
	  var counters = state.simpleCounter || {};
	  var today = todayStr();
	  var rows = Object.keys(counters)
	    .map(function (id) { return counters[id]; })
	    .filter(function (c) { return c && c.id && c.title && c.isEnabled; })
	    .map(function (c) {
	      var goal = c.streakMinValue || 1;
	      var value = (c.countOnDay && c.countOnDay[today]) || 0;
	      var isCountdown = c.type === 'RepeatedCountdownReminder';
	      // isTrackStreaks defaults true (EMPTY_SIMPLE_COUNTER); when off, SP shows
	      // no streak, so neither do we.
	      var tracksStreak = c.isTrackStreaks !== false;
	      return {
	        id: c.id,
	        title: c.title,
	        value: value,
	        goal: goal,
	        done: value >= goal,
	        isStopwatch: c.type === 'StopWatch',
	        isCountdown: isCountdown,
	        countdownMs: isCountdown ? (c.countdownDuration || 0) : 0,
	        streak: tracksStreak ? habitStreak(c) : 0,
	        bestStreak: tracksStreak ? habitBestStreak(c) : 0,
	      };
	    });
	  rows.sort(function (a, b) { return titleCompare(a.title, b.title); });
	  return rows.slice(0, limit);
	}
	
	// The watch's Stats page (a pinned row, non-aplite) - the headline numbers
	// the desktop's Today panel shows, plus every project's task count.
	//
	//   estimateRemainingMs - over today's undone tasks, the sum of
	//     max(0, timeEstimate - timeSpent). A parent that has subtasks is
	//     summed from its own undone subtasks (SP treats the parent estimate
	//     as a roll-up of them); a task with no subtasks uses its own figures.
	//   workedTodayMs - the sum of timeSpentOnDay[today] across every leaf
	//     task and subtask. Roll-up parents (those with subtasks) are skipped
	//     so their children's time isn't counted twice.
	//   projects - getProjectList order, each with taskCount = its undone,
	//     non-backlog main tasks (matching the desktop sidebar's badge).
	//
	// The desktop's third headline, "time without a break", is local runtime
	// state from its TakeABreakService (it resets on idle detection) and never
	// enters the SuperSync op log - the watch fills that slot with its own
	// current tracking-session length instead, computed on the watch.
	function computeStats(state) {
	  var tasks = state.task || {};
	  var today = todayStr();
	  var yesterday = yesterdayStr();
	  var estimateRemainingMs = 0;
	  var workedTodayMs = 0;
	  var workedYesterdayMs = 0;
	  var completedTodayCount = 0;
	  var completedYesterdayCount = 0;
	
	  // Last 7 days incl. today (oldest first) - a small worklog on the Stats page.
	  var DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
	  var weekBuckets = [0, 0, 0, 0, 0, 0, 0];
	  var weekLabels = [];
	  var weekIndex = {};
	  for (var wi = 0; wi < 7; wi++) {
	    var wd = logicalNow();
	    wd.setDate(wd.getDate() - (6 - wi));
	    weekIndex[dateToDateStr(wd)] = wi;
	    weekLabels.push(wi === 6 ? 'Today' : DOW[wd.getDay()]);
	  }
	  var workedWeekMs = 0;
	
	  Object.keys(tasks).forEach(function (id) {
	    var t = tasks[id];
	    if (!t || !t.title) {
	      return;
	    }
	    var subIds = (t.subTaskIds || []).filter(function (s) { return tasks[s]; });
	    var hasSubs = subIds.length > 0;
	
	    if (!hasSubs) {
	      workedTodayMs += (t.timeSpentOnDay && t.timeSpentOnDay[today]) || 0;
	      workedYesterdayMs += (t.timeSpentOnDay && t.timeSpentOnDay[yesterday]) || 0;
	      if (t.timeSpentOnDay) {
	        Object.keys(t.timeSpentOnDay).forEach(function (ds) {
	          if (ds in weekIndex) {
	            var v = t.timeSpentOnDay[ds] || 0;
	            weekBuckets[weekIndex[ds]] += v;
	            workedWeekMs += v;
	          }
	        });
	      }
	    }
	    // "Completed yesterday" leans on doneOn, which only survives replay for
	    // watch-completed / recently-completed tasks - so it can undercount.
	    if (t.isDone && t.doneOn && dateToDateStr(new Date(t.doneOn)) === yesterday) {
	      completedYesterdayCount++;
	    }
	
	    if (!isMainTask(t)) {
	      return;
	    }
	    var plannedToday = taskIsPlannedForToday(t, today) || subIds.some(function (sid) {
	      return taskIsPlannedForToday(tasks[sid], today);
	    });
	    if (!plannedToday) {
	      return;
	    }
	    // For a task with subtasks, count/estimate each subtask (SP treats the
	    // parent as a roll-up); otherwise the task itself. "completed today" is
	    // the done items among today's list - the desktop's "N of M done" - not
	    // doneOn-dated, since doneOn only survives this replay for tasks
	    // completed via the watch (see isHiddenDone's own comment).
	    if (hasSubs) {
	      subIds.forEach(function (sid) {
	        var s = tasks[sid];
	        if (!s) {
	          return;
	        }
	        if (s.isDone) {
	          completedTodayCount++;
	        } else {
	          estimateRemainingMs += Math.max(0, (s.timeEstimate || 0) - (s.timeSpent || 0));
	        }
	      });
	    } else if (t.isDone) {
	      completedTodayCount++;
	    } else {
	      estimateRemainingMs += Math.max(0, (t.timeEstimate || 0) - (t.timeSpent || 0));
	    }
	  });
	
	  var projects = getProjectList(state).map(function (p) {
	    var wantNoProject = p.id === NO_PROJECT_ID;
	    var count = 0;
	    Object.keys(tasks).forEach(function (id) {
	      var t = tasks[id];
	      if (!t || !t.title || !isMainTask(t) || t.isDone || t.__inBacklog) {
	        return;
	      }
	      if (wantNoProject ? !t.projectId : t.projectId === p.id) {
	        count++;
	      }
	    });
	    return { id: p.id, title: p.title, taskCount: count };
	  });
	
	  // Per-day work-session span + break count from the timeTracking entity,
	  // across every project/tag context for that date. s/e are minute-rounded
	  // epoch ms; convert to minutes-since-local-midnight for the watch.
	  var weekStart = [-1, -1, -1, -1, -1, -1, -1];
	  var weekEnd = [-1, -1, -1, -1, -1, -1, -1];
	  var weekBreaks = [0, 0, 0, 0, 0, 0, 0];
	  var tt = state.timeTracking || {};
	  ['project', 'tag'].forEach(function (bucket) {
	    var b = tt[bucket] || {};
	    Object.keys(b).forEach(function (ctxId) {
	      var byDate = b[ctxId] || {};
	      Object.keys(byDate).forEach(function (ds) {
	        if (!(ds in weekIndex)) {
	          return;
	        }
	        var wi = weekIndex[ds];
	        var d = byDate[ds] || {};
	        if (typeof d.s === 'number' && d.s > 0) {
	          var sd = new Date(d.s);
	          var sm = sd.getHours() * 60 + sd.getMinutes();
	          if (weekStart[wi] < 0 || sm < weekStart[wi]) {
	            weekStart[wi] = sm;
	          }
	        }
	        if (typeof d.e === 'number' && d.e > 0) {
	          var ed = new Date(d.e);
	          var em = ed.getHours() * 60 + ed.getMinutes();
	          if (em > weekEnd[wi]) {
	            weekEnd[wi] = em;
	          }
	        }
	        if (typeof d.b === 'number' && d.b > 0) {
	          weekBreaks[wi] += d.b;
	        }
	      });
	    });
	  });
	
	  var week = weekLabels.map(function (label, i) {
	    return {
	      label: label, ms: weekBuckets[i],
	      startMin: weekStart[i], endMin: weekEnd[i], breaks: weekBreaks[i],
	    };
	  });
	
	  return {
	    estimateRemainingMs: estimateRemainingMs,
	    workedTodayMs: workedTodayMs,
	    workedYesterdayMs: workedYesterdayMs,
	    completedTodayCount: completedTodayCount,
	    completedYesterdayCount: completedYesterdayCount,
	    projects: projects,
	    week: week,
	    workedWeekMs: workedWeekMs,
	  };
	}
	
	// A shareable Markdown report of computeStats() + getActiveHabits(): a
	// today/yesterday table, a 7-day worked-minutes bar (mermaid xychart-beta),
	// an open-tasks-by-project pie, and a habit-streak bar + table. Rendered
	// read-only on the settings page for the user to copy out - the watch/phone
	// has nowhere to write a file. Pure formatting, no state access.
	function statsToMarkdown(stats, habits) {
	  stats = stats || {};
	  habits = habits || [];
	  var week = stats.week || [];
	
	  function fmtDur(ms) {
	    if (!ms || ms <= 0) { return '\u2014'; }
	    var m = Math.round(ms / 60000);
	    if (m < 1) { return '<1m'; }
	    var h = Math.floor(m / 60);
	    return h > 0 ? (h + 'h ' + (m % 60) + 'm') : (m + 'm');
	  }
	  function fmtClock(min) {
	    if (min == null || min < 0) { return null; }
	    return Math.floor(min / 60) + ':' + (min % 60 < 10 ? '0' : '') + (min % 60);
	  }
	  function fmtSpan(cell) {
	    var a = fmtClock(cell && cell.startMin);
	    var b = fmtClock(cell && cell.endMin);
	    return (a && b) ? (a + '\u2013' + b) : '\u2014';
	  }
	  // mermaid category label - quote it, drop the chars that break the parser.
	  function lbl(s) {
	    return '"' + String(s).replace(/["\r\n[\]]/g, ' ').trim() + '"';
	  }
	  function cell(s) { return String(s).replace(/\|/g, '\\|').replace(/[\r\n]+/g, ' '); }
	
	  var d = new Date();
	  var p2 = function (n) { return (n < 10 ? '0' : '') + n; };
	  var stamp = d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate()) +
	              ' ' + p2(d.getHours()) + ':' + p2(d.getMinutes());
	
	  var today = week.length ? week[week.length - 1] : {};
	  var yest = week.length >= 2 ? week[week.length - 2] : {};
	
	  var L = [];
	  L.push('# Super Productivity \u2014 stats');
	  L.push('');
	  L.push('_Exported ' + stamp + '_');
	  L.push('');
	  L.push('## Today & yesterday');
	  L.push('');
	  L.push('| | Today | Yesterday |');
	  L.push('| --- | --- | --- |');
	  L.push('| Worked | ' + fmtDur(stats.workedTodayMs) + ' | ' + fmtDur(stats.workedYesterdayMs) + ' |');
	  L.push('| Tasks done | ' + (stats.completedTodayCount || 0) + ' | ' + (stats.completedYesterdayCount || 0) + ' |');
	  L.push('| Est. remaining | ' + fmtDur(stats.estimateRemainingMs) + ' | \u2014 |');
	  L.push('| Session | ' + fmtSpan(today) + ' | ' + fmtSpan(yest) + ' |');
	  L.push('| Breaks | ' + ((today && today.breaks) || 0) + ' | ' + ((yest && yest.breaks) || 0) + ' |');
	  L.push('');
	
	  if (week.length) {
	    L.push('## Minutes worked, last 7 days');
	    L.push('');
	    L.push('```mermaid');
	    L.push('xychart-beta');
	    L.push('    title "Minutes worked per day"');
	    L.push('    x-axis [' + week.map(function (w) { return lbl(w.label); }).join(', ') + ']');
	    L.push('    y-axis "Minutes"');
	    L.push('    bar [' + week.map(function (w) { return Math.round((w.ms || 0) / 60000); }).join(', ') + ']');
	    L.push('```');
	    L.push('');
	    L.push('Week total: **' + fmtDur(stats.workedWeekMs) + '**');
	    L.push('');
	  }
	
	  var projs = (stats.projects || []).filter(function (x) { return x.taskCount > 0; });
	  L.push('## Open tasks by project');
	  L.push('');
	  if (projs.length) {
	    L.push('```mermaid');
	    L.push('pie showData');
	    L.push('    title Open tasks by project');
	    projs.forEach(function (x) { L.push('    ' + lbl(x.title) + ' : ' + x.taskCount); });
	    L.push('```');
	  } else {
	    L.push('_No open tasks._');
	  }
	  L.push('');
	
	  var streaked = habits.filter(function (h) { return (h.streak || 0) > 0 || (h.bestStreak || 0) > 0; });
	  if (streaked.length) {
	    L.push('## Habit streaks');
	    L.push('');
	    L.push('```mermaid');
	    L.push('xychart-beta');
	    L.push('    title "Current streak (days)"');
	    L.push('    x-axis [' + streaked.map(function (h) { return lbl(h.title); }).join(', ') + ']');
	    L.push('    y-axis "Days"');
	    L.push('    bar [' + streaked.map(function (h) { return h.streak || 0; }).join(', ') + ']');
	    L.push('```');
	    L.push('');
	    L.push('| Habit | Current | Best |');
	    L.push('| --- | --- | --- |');
	    streaked.forEach(function (h) {
	      L.push('| ' + cell(h.title) + ' | ' + (h.streak || 0) + ' | ' + (h.bestStreak || 0) + ' |');
	    });
	    L.push('');
	  }
	
	  return L.join('\n');
	}
	
	// Voice-search the whole task set (every project, backlog, future, done - the
	// replayed state.task has them all) for tasks whose title contains every
	// whitespace-separated token of `query`, case-insensitive. Undone first, then
	// title order. Read-only result rows: title + the project it lives in (or
	// "Backlog" / "No project" / a parent-task title for a subtask), plus done /
	// due markers for the watch's line formatter.
	function computeSearch(state, query, limit) {
	  var tasks = state.task || {};
	  // Split on anything that isn't a letter or digit (Latin + Latin-1/Extended)
	  // so a dictated trailing "." or a hyphen doesn't wreck the match.
	  var tokens = String(query || '').toLowerCase()
	    .split(/[^a-z0-9À-ɏ]+/)
	    .filter(Boolean);
	  if (!tokens.length) {
	    return [];
	  }
	  var projTitle = {};
	  Object.keys(state.project || {}).forEach(function (id) {
	    if (state.project[id]) { projTitle[id] = state.project[id].title; }
	  });
	  var hits = [];
	  Object.keys(tasks).forEach(function (id) {
	    var t = tasks[id];
	    if (!t || !t.title) {
	      return;
	    }
	    var hay = t.title.toLowerCase();
	    if (!tokens.every(function (tok) { return hay.indexOf(tok) !== -1; })) {
	      return;
	    }
	    var parent = t.parentId && tasks[t.parentId];
	    var project = (t.projectId && projTitle[t.projectId]) ? projTitle[t.projectId]
	      : (parent && parent.title) ? parent.title
	      : 'No project';
	    hits.push({
	      title: (parent ? '» ' : '') + t.title,
	      project: project,
	      backlog: !!t.__inBacklog,
	      done: !!t.isDone,
	      dueDay: t.dueDay || null,
	    });
	  });
	  hits.sort(function (a, b) {
	    if (a.done !== b.done) { return a.done ? 1 : -1; }
	    return titleCompare(a.title, b.title);
	  });
	  return hits.slice(0, limit || 40);
	}
	
	// ---- recurring-task occurrence projection (Upcoming page, phase B) ----
	// A day-by-day scan mirroring super-productivity's getNextRepeatOccurrence
	// predicates (DAILY/WEEKLY/MONTHLY/YEARLY, monthly Nth-weekday + last-day
	// anchors, deletedInstanceDates). Not a perfect port - repeatFromCompletionDate
	// is approximated from lastTaskCreationDay, and the whole thing is a preview,
	// not the desktop's authoritative materialisation.
	
	var REPEAT_WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
	
	// "YYYY-MM-DD" -> local Date at midnight.
	function parseDayStr(s) {
	  var p = String(s).split('-');
	  return new Date(parseInt(p[0], 10), parseInt(p[1], 10) - 1, parseInt(p[2], 10));
	}
	
	function diffInDays(fromDay, toDay) {
	  return Math.round((parseDayStr(toDay).getTime() - parseDayStr(fromDay).getTime()) / 86400000);
	}
	function diffInMonths(fromDay, toDay) {
	  var a = parseDayStr(fromDay), b = parseDayStr(toDay);
	  return (b.getFullYear() - a.getFullYear()) * 12 + (b.getMonth() - a.getMonth());
	}
	function addDaysStr(dayStr, n) {
	  var d = parseDayStr(dayStr);
	  d.setDate(d.getDate() + n);
	  return dateToDateStr(d);
	}
	function lastDayOfMonth(year, month0) {
	  return new Date(year, month0 + 1, 0).getDate();
	}
	// nth (1-4) weekday of a month, or 5 = last. weekday: 0=Sun..6=Sat.
	function nthWeekdayDate(year, month0, weekday, nth) {
	  if (nth >= 5) {
	    var last = lastDayOfMonth(year, month0);
	    for (var d = last; d >= 1; d--) {
	      if (new Date(year, month0, d).getDay() === weekday) {
	        return d;
	      }
	    }
	    return null;
	  }
	  var first = new Date(year, month0, 1).getDay();
	  var offset = (weekday - first + 7) % 7;
	  var day = 1 + offset + (nth - 1) * 7;
	  return day <= lastDayOfMonth(year, month0) ? day : null;
	}
	
	function repeatMatchesDay(cfg, dayStr, startDay) {
	  var every = cfg.repeatEvery > 0 ? cfg.repeatEvery : 1;
	  var d = parseDayStr(dayStr);
	  switch (cfg.repeatCycle) {
	    case 'DAILY': {
	      var dd = diffInDays(startDay, dayStr);
	      return dd >= 0 && dd % every === 0;
	    }
	    case 'WEEKLY': {
	      var dw = Math.floor(diffInDays(startDay, dayStr) / 7);
	      return dw >= 0 && dw % every === 0 && cfg[REPEAT_WEEKDAYS[d.getDay()]] === true;
	    }
	    case 'MONTHLY': {
	      var dm = diffInMonths(startDay, dayStr);
	      if (dm < 0 || dm % every !== 0) {
	        return false;
	      }
	      var hasNth = cfg.monthlyWeekOfMonth != null && cfg.monthlyWeekday != null;
	      if (hasNth) {
	        return d.getDate() === nthWeekdayDate(d.getFullYear(), d.getMonth(), cfg.monthlyWeekday, cfg.monthlyWeekOfMonth);
	      }
	      if (cfg.monthlyLastDay) {
	        return d.getDate() === lastDayOfMonth(d.getFullYear(), d.getMonth());
	      }
	      var anchorDom = parseDayStr(startDay).getDate();
	      return d.getDate() === Math.min(anchorDom, lastDayOfMonth(d.getFullYear(), d.getMonth()));
	    }
	    case 'YEARLY': {
	      var s = parseDayStr(startDay);
	      var yd = d.getFullYear() - s.getFullYear();
	      if (yd < 0 || yd % every !== 0 || d.getMonth() !== s.getMonth()) {
	        return false;
	      }
	      var anchorDay = Math.min(s.getDate(), lastDayOfMonth(d.getFullYear(), d.getMonth()));
	      return d.getDate() === anchorDay;
	    }
	    default:
	      return false;
	  }
	}
	
	// Occurrence dates (YYYY-MM-DD) of `cfg` strictly within (fromDay, toDay],
	// skipping days already materialised (<= lastTaskCreationDay) and deleted ones.
	function repeatOccurrences(cfg, fromDay, toDay) {
	  if (!cfg || cfg.isPaused || !cfg.title || !cfg.repeatCycle) {
	    return [];
	  }
	  var startDay = (cfg.repeatFromCompletionDate && cfg.lastTaskCreationDay)
	    ? cfg.lastTaskCreationDay
	    : (cfg.startDate || '1970-01-01');
	  var lastCreated = cfg.lastTaskCreationDay || null;
	  var deleted = cfg.deletedInstanceDates || [];
	  var out = [];
	  var day = addDaysStr(fromDay, 1);
	  var guard = 0;
	  while (day <= toDay && guard++ < 400) {
	    if ((!lastCreated || day > lastCreated) &&
	        deleted.indexOf(day) === -1 &&
	        repeatMatchesDay(cfg, day, startDay)) {
	      out.push(day);
	    }
	    day = addDaysStr(day, 1);
	  }
	  return out;
	}
	
	var UPCOMING_HORIZON_DAYS = 21;
	
	// The watch's optional "Upcoming" page: every not-done main task scheduled for
	// a local day AFTER today - by dueDay, or by the local day of a dueWithTime.
	// Today and the past are already covered by the today list / Schedule page.
	// Sorted by day then time-of-day (dateless entries last within a day), capped.
	// Two sources: tasks that already carry a future date (any date, capped by
	// `limit`), and projected occurrences of recurring configs (repeatOccurrences,
	// within UPCOMING_HORIZON_DAYS) that the desktop hasn't materialised yet -
	// those are marked `recurring: true`. A projected occurrence whose day+title
	// already appears as a real task is dropped. Phone-side: the watch has no
	// future-date data of its own.
	function computeUpcoming(state, limit) {
	  var tasks = (state && state.task) || {};
	  var projects = (state && state.project) || {};
	  var repeatCfgs = (state && state.taskRepeatCfg) || {};
	  var today = todayStr();
	  var out = [];
	  var seen = {}; // "day\x01title" of real tasks, to dedupe projected occurrences
	
	  Object.keys(tasks).forEach(function (id) {
	    var t = tasks[id];
	    if (!t || !t.title || t.isDone || !isMainTask(t)) {
	      return;
	    }
	    var day = null;
	    var timeMin = -1;
	    if (typeof t.dueWithTime === 'number' && isFinite(t.dueWithTime)) {
	      var d = new Date(t.dueWithTime);
	      day = dateToDateStr(d);
	      timeMin = d.getHours() * 60 + d.getMinutes();
	    } else if (t.dueDay) {
	      day = String(t.dueDay);
	    } else {
	      return;
	    }
	    if (day <= today) {
	      return;
	    }
	    var projTitle = t.projectId && projects[t.projectId] && projects[t.projectId].title;
	    out.push({
	      day: day,
	      timeMin: timeMin,
	      title: String(t.title),
	      project: projTitle ? String(projTitle) : '',
	    });
	    seen[day + '\x01' + String(t.title)] = true;
	  });
	
	  var horizonDay = addDaysStr(today, UPCOMING_HORIZON_DAYS);
	  Object.keys(repeatCfgs).forEach(function (id) {
	    var cfg = repeatCfgs[id];
	    var occ = repeatOccurrences(cfg, today, horizonDay);
	    if (!occ.length) {
	      return;
	    }
	    var startMin = -1;
	    if (cfg.startTime && /^\d{1,2}:\d{2}/.test(cfg.startTime)) {
	      var hm = cfg.startTime.split(':');
	      startMin = parseInt(hm[0], 10) * 60 + parseInt(hm[1], 10);
	    }
	    var cfgProj = cfg.projectId && projects[cfg.projectId] && projects[cfg.projectId].title;
	    occ.forEach(function (day) {
	      if (seen[day + '\x01' + String(cfg.title)]) {
	        return;
	      }
	      out.push({
	        day: day,
	        timeMin: startMin,
	        title: String(cfg.title),
	        project: cfgProj ? String(cfgProj) : '',
	        recurring: true,
	      });
	    });
	  });
	
	  out.sort(function (a, b) {
	    if (a.day !== b.day) {
	      return a.day < b.day ? -1 : 1;
	    }
	    var am = a.timeMin < 0 ? 24 * 60 : a.timeMin;
	    var bm = b.timeMin < 0 ? 24 * 60 : b.timeMin;
	    return am - bm;
	  });
	
	  return out.slice(0, limit || 40);
	}
	
	// Today-pinned standalone notes (the `note` entity, isPinnedToToday), oldest
	// first by `created`. { title, body } - title is the first line, body the
	// rest. The watch shows these on its optional Notes page.
	function computeNotes(state, limit) {
	  var notes = (state && state.note) || {};
	  var out = Object.keys(notes)
	    .map(function (id) { return notes[id]; })
	    .filter(function (n) { return n && n.isPinnedToToday && typeof n.content === 'string' && n.content.trim(); })
	    .sort(function (a, b) { return (a.created || 0) - (b.created || 0); })
	    .slice(0, limit || 20)
	    .map(function (n) {
	      var lines = n.content.replace(/\r/g, '').split('\n');
	      var title = (lines.shift() || '').trim();
	      var body = lines.join('\n').trim();
	      return { title: title, body: body };
	    });
	  return out;
	}
	
	var REPEAT_DOW = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
	var REPEAT_DOW_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
	var REPEAT_ORDINAL = ['', '1st', '2nd', '3rd', '4th', '5th'];
	
	// Short human string for a taskRepeatCfg's cadence: "Daily", "Every 3 days",
	// "Mon Wed Fri", "Weekly", "Monthly", "Monthly (2nd Tue)", "Yearly". Does not
	// mention pause state - callers show that separately (cfg.isPaused).
	function formatRepeatCfg(cfg) {
	  if (!cfg) {
	    return '';
	  }
	  var every = cfg.repeatEvery > 1 ? cfg.repeatEvery : 0;
	  var s;
	  switch (cfg.repeatCycle) {
	    case 'DAILY':
	      s = every ? 'Every ' + every + ' days' : 'Daily';
	      break;
	    case 'WEEKLY': {
	      var days = [];
	      for (var i = 0; i < 7; i++) {
	        if (cfg[REPEAT_DOW[i]]) {
	          days.push(REPEAT_DOW_SHORT[i]);
	        }
	      }
	      s = days.length ? days.join(' ') : (every ? 'Every ' + every + ' weeks' : 'Weekly');
	      break;
	    }
	    case 'MONTHLY':
	      if (cfg.monthlyWeekOfMonth && cfg.monthlyWeekday != null) {
	        var wk = cfg.monthlyWeekOfMonth === -1 ? 'last' : (REPEAT_ORDINAL[cfg.monthlyWeekOfMonth] || cfg.monthlyWeekOfMonth);
	        s = 'Monthly (' + wk + ' ' + REPEAT_DOW_SHORT[cfg.monthlyWeekday] + ')';
	      } else {
	        s = every ? 'Every ' + every + ' months' : 'Monthly';
	      }
	      break;
	    case 'YEARLY':
	      s = every ? 'Every ' + every + ' years' : 'Yearly';
	      break;
	    default:
	      s = 'Repeats';
	  }
	  return s;
	}
	
	module.exports = {
	  emptyState: emptyState,
	  applyOperation: applyOperation,
	  applyOperations: applyOperations,
	  getActiveTasks: getActiveTasks,
	  getActiveHabits: getActiveHabits,
	  habitStreak: habitStreak,
	  habitBestStreak: habitBestStreak,
	  getProjectList: getProjectList,
	  getProjectTasks: getProjectTasks,
	  getTagList: getTagList,
	  getTagTasks: getTagTasks,
	  computeStats: computeStats,
	  statsToMarkdown: statsToMarkdown,
	  computeSearch: computeSearch,
	  computeUpcoming: computeUpcoming,
	  computeNotes: computeNotes,
	  formatRepeatCfg: formatRepeatCfg,
	  setStartOfNextDayFromState: setStartOfNextDayFromState,
	  repeatOccurrences: repeatOccurrences,
	  NO_PROJECT_ID: NO_PROJECT_ID,
	  todayStr: todayStr,
	  yesterdayStr: yesterdayStr,
	  dateToDateStr: dateToDateStr,
	  HIDE_DONE_GRACE_MS: HIDE_DONE_GRACE_MS,
	};


/***/ }),
/* 10 */
/***/ (function(module, exports) {

	// Live tracking presence over the SuperSync WebSocket (super-productivity
	// desktop v18.21.1, PR #9771).
	//   Phase 1 (viewer): renders what another device is tracking, can ask it to
	//     stop (requestStop / onState / onCleared).
	//   Phase 2 (producer): broadcasts THIS watch's own tracking as "Pebble" so
	//     the desktop shows it, honours a remote stop command
	//     (broadcastTracking / broadcastStopped / onStopCommand). A 60s heartbeat
	//     keeps it fresh; on socket drop the server flips producerConnected and
	//     other devices decay it to "was tracking" then hide it.
	//
	// Wire contract mirrored from the super-productivity repo (UNVERIFIED against
	// a live account, same caveat as supersync-client.js's REST routes):
	//   src/app/op-log/sync/super-sync-websocket.service.ts   - socket + framing
	//   packages/super-sync-server/.../websocket-connection.service.ts - relay
	//   src/app/features/tracking-presence/tracking-presence.service.ts - codec
	//   src/app/features/tracking-presence/tracking-presence.model.ts   - shapes
	//
	// Transport summary:
	//   URL   wss://<host>/api/sync/ws?token=<jwt>&clientId=<id>   (http->ws swap)
	//   in    {type:"connected"} once; {type:"ping"} ~30s -> reply {type:"pong"};
	//         {type:"presence_state", payload, ordinal, producerConnected};
	//         {type:"presence_cmd", payload}   (ignored here - we only send these)
	//   out   {type:"pong"}; {type:"presence_cmd", payload}
	//   close 4003 auth / 4008 conn-limit / 4009 replaced -> do NOT reconnect
	//
	// `payload` is JSON.stringify({ enc, data }). When enc, `data` is an
	// AES-GCM/Argon2id blob in supersync-client.js's exact op-payload format, so
	// the crypto object from createCrypto() decodes it directly. Fail closed:
	// a plaintext envelope while a key is configured is dropped, not trusted.
	'use strict';
	
	// presence_state payload, after decode (tracking-presence.model.ts):
	//   { v:1, sessionId, seq, state:"tracking"|"stopped", reason?:"idle",
	//     taskId:string|null, sinceTs:number, deviceLabel:string, focusCycle?:number }
	
	// Viewer staleness / linger windows (tracking-presence.model.ts constants).
	var STALE_AFTER_MS = 90 * 1000;
	var STOPPED_LINGER_MS = 10 * 1000;
	
	// Socket liveness: server pings ~30s, so silence past this means a dead pipe.
	var LIVENESS_TIMEOUT_MS = 45 * 1000;
	
	// Producer heartbeat - re-announce our tracking state before other devices'
	// 90s staleness window would decay it (tracking-presence.service.ts).
	var HEARTBEAT_MS = 60 * 1000;
	
	var DEVICE_LABEL = 'Pebble';
	
	var MIN_RECONNECT_MS = 1000;
	var MAX_RECONNECT_MS = 60 * 1000;
	// No attempt cap - a phone can be offline for hours and the socket must come
	// back on its own when the network does. The backoff exponent is clamped so
	// the delay tops out at MAX_RECONNECT_MS and stays there.
	var MAX_BACKOFF_EXPONENT = 16;
	
	// Close codes the server uses to say "don't come back on your own".
	var NO_RECONNECT_CLOSE_CODES = { 4003: 1, 4008: 1, 4009: 1 };
	
	function noop() {}
	
	// Strip markup-capable chars and cap length - deviceLabel is relayed from
	// another device and, with E2EE off, a hostile server could inject it
	// (mirrors sanitizeDeviceLabel in tracking-presence.service.ts).
	function sanitizeDeviceLabel(v) {
	  if (typeof v !== 'string') {
	    return '';
	  }
	  return v.replace(/[<>&"'`]/g, '').slice(0, 32);
	}
	
	// opts: { baseUrl, token, clientId, getCrypto, log? }
	//   getCrypto: () => crypto|null   (called lazily so it always reflects the
	//                                   current pairing, like index.js's getCrypto)
	//   log:       optional (msg) => void, defaults to console.log with a prefix
	function PresenceClient(opts) {
	  this._baseUrl = opts.baseUrl;
	  this._token = opts.token;
	  this._clientId = opts.clientId;
	  this._getCrypto = opts.getCrypto || function () { return null; };
	  this._log = opts.log || function (m) { console.log('[presence] ' + m); };
	
	  // Timers, overridable so tests don't wait real seconds.
	  var t = opts.tuning || {};
	  this._lingerMs = t.lingerMs || STOPPED_LINGER_MS;
	  this._livenessMs = t.livenessMs || LIVENESS_TIMEOUT_MS;
	  this._minReconnectMs = t.minReconnectMs || MIN_RECONNECT_MS;
	  this._maxReconnectMs = t.maxReconnectMs || MAX_RECONNECT_MS;
	  this._heartbeatMs = t.heartbeatMs || HEARTBEAT_MS;
	
	  this._ws = null;
	  this._intentionalClose = false;
	  this._reconnectAttempts = 0;
	  this._reconnectTimer = null;
	  this._livenessTimer = null;
	  this._lingerTimer = null;
	  this._heartbeatTimer = null;
	
	  // Viewer: dedupe / current-view state.
	  this._lastOrdinal = -1;
	  this._current = null; // last emitted session view, or null
	  this._triedDeriveSalts = {}; // b64-salt-prefix -> true, deferred-derive dedupe
	
	  // Producer: this watch's own broadcast session, or null when not tracking.
	  this._producer = null; // { sessionId, taskId, sinceTs, seq }
	
	  this._onStateCb = noop;
	  this._onClearedCb = noop;
	  this._onStopCommandCb = noop;
	  this._onOfflineCb = noop;
	}
	
	// cb({ state, reason, taskId, sinceTs, deviceLabel, sessionId, seq,
	//      producerConnected, ordinal, receivedAt, opaque? })
	// `opaque:true` (+ a `reason` of 'no-key' | 'needs-derive' | 'plaintext')
	// means the payload could not be decoded here - render a device-less
	// "tracking on another device" with no task title and no Stop.
	PresenceClient.prototype.onState = function (cb) {
	  this._onStateCb = cb || noop;
	};
	
	// cb() - the shown session should be hidden (linger elapsed, or disconnect).
	PresenceClient.prototype.onCleared = function (cb) {
	  this._onClearedCb = cb || noop;
	};
	
	// cb() - the socket dropped while a session was on screen and a reconnect is
	// pending. The consumer should show it as "offline / reconnecting" rather than
	// a frozen live view. A successful reconnect re-emits the last view through
	// onState, which clears the offline surface.
	PresenceClient.prototype.onOffline = function (cb) {
	  this._onOfflineCb = cb || noop;
	};
	
	PresenceClient.prototype.isConnected = function () {
	  return !!this._ws && this._ws.readyState === 1;
	};
	
	PresenceClient.prototype.connect = function () {
	  this._intentionalClose = false;
	  if (this._ws && (this._ws.readyState === 0 || this._ws.readyState === 1)) {
	    return;
	  }
	  this._open();
	};
	
	PresenceClient.prototype.disconnect = function () {
	  this._intentionalClose = true;
	  this._clearTimer('_reconnectTimer');
	  this._clearTimer('_livenessTimer');
	  this._clearTimer('_lingerTimer');
	  this._stopHeartbeat();
	  this._producer = null;
	  if (this._ws) {
	    try {
	      this._ws.close(1000, 'client disconnect');
	    } catch (e) {
	      // already closing/closed
	    }
	    this._ws = null;
	  }
	  if (this._current) {
	    this._current = null;
	    this._lastOrdinal = -1;
	    this._onClearedCb();
	  }
	};
	
	// Ask the device that owns `sessionId` to stop. Fire-and-forget: the viewer
	// UI clears on that device's own "stopped" broadcast, never optimistically
	// (the producer ignores a stale sessionId - CAS guard).
	PresenceClient.prototype.requestStop = function (sessionId) {
	  if (!sessionId || !this.isConnected()) {
	    return;
	  }
	  var cmd = { v: 1, cmd: 'stop', sessionId: sessionId, deviceLabel: 'Pebble' };
	  var envelope = this._encodeEnvelope(cmd);
	  if (!envelope) {
	    this._log('requestStop: could not encode cmd envelope');
	    return;
	  }
	  this._send({ type: 'presence_cmd', payload: JSON.stringify(envelope) });
	};
	
	// ---------------- producer (Phase 2) ----------------
	
	// cb() - a remote device asked us to stop the session we're broadcasting.
	// The caller should stop the watch's timer; the resulting broadcastStopped()
	// is the ack that clears the commanding device.
	PresenceClient.prototype.onStopCommand = function (cb) {
	  this._onStopCommandCb = cb || noop;
	};
	
	function genSessionId() {
	  return 'pres-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
	}
	
	// Announce (or re-announce) that this watch is tracking `taskId`, started at
	// wall-clock ms `sinceTs`. A new task starts a new session. Safe to call
	// before the socket is open - the state is stored and sent on connect.
	PresenceClient.prototype.broadcastTracking = function (taskId, sinceTs) {
	  if (!this._producer || this._producer.taskId !== taskId) {
	    this._producer = { sessionId: genSessionId(), taskId: taskId, sinceTs: sinceTs, seq: 0 };
	  } else {
	    this._producer.sinceTs = sinceTs;
	  }
	  this._sendProducerState('tracking');
	  this._startHeartbeat();
	};
	
	// Announce that this watch stopped tracking. No-op if we weren't broadcasting.
	PresenceClient.prototype.broadcastStopped = function () {
	  if (!this._producer) {
	    return;
	  }
	  this._sendProducerState('stopped');
	  this._stopHeartbeat();
	  this._producer = null;
	};
	
	PresenceClient.prototype.isBroadcasting = function () {
	  return !!this._producer;
	};
	
	PresenceClient.prototype._sendProducerState = function (state) {
	  if (!this._producer) {
	    return;
	  }
	  this._producer.seq++;
	  var payload = {
	    v: 1,
	    sessionId: this._producer.sessionId,
	    seq: this._producer.seq,
	    state: state,
	    taskId: this._producer.taskId,
	    sinceTs: this._producer.sinceTs,
	    deviceLabel: DEVICE_LABEL,
	  };
	  var envelope = this._encodeEnvelope(payload);
	  if (!envelope) {
	    this._log('broadcast: could not encode state envelope');
	    return;
	  }
	  this._send({ type: 'presence_state', payload: JSON.stringify(envelope) });
	};
	
	PresenceClient.prototype._startHeartbeat = function () {
	  if (this._heartbeatTimer) {
	    return;
	  }
	  var self = this;
	  this._heartbeatTimer = setInterval(function () {
	    if (self._producer) {
	      self._sendProducerState('tracking');
	    }
	  }, this._heartbeatMs);
	};
	
	PresenceClient.prototype._stopHeartbeat = function () {
	  if (this._heartbeatTimer) {
	    clearInterval(this._heartbeatTimer);
	    this._heartbeatTimer = null;
	  }
	};
	
	// ---------------- socket ----------------
	
	PresenceClient.prototype._open = function () {
	  var wsUrl = this._baseUrl.replace(/^https:/i, 'wss:').replace(/^http:/i, 'ws:');
	  var url = wsUrl + '/api/sync/ws?token=' + encodeURIComponent(this._token) +
	    '&clientId=' + encodeURIComponent(this._clientId);
	
	  var ws;
	  try {
	    ws = new WebSocket(url);
	  } catch (e) {
	    this._log('WebSocket construct failed: ' + (e && e.message));
	    this._scheduleReconnect();
	    return;
	  }
	  this._ws = ws;
	  var self = this;
	
	  ws.onopen = function () {
	    if (self._ws !== ws) {
	      return;
	    }
	    self._log('connected');
	    self._reconnectAttempts = 0;
	    self._armLiveness();
	    // Re-announce our tracking state after a (re)connect - a fresh socket
	    // means the server's single-slot cache lost it.
	    if (self._producer) {
	      self._sendProducerState('tracking');
	      self._startHeartbeat();
	    } else if (self._current && !self._current.opaque && self._current.state === 'tracking') {
	      // Viewer: we were showing a remote session and just reconnected. The
	      // server may not re-push its slot, so re-emit the last view now to clear
	      // the offline surface; the producer's heartbeat refreshes it within 60s.
	      self._onStateCb(self._current);
	    }
	  };
	
	  ws.onmessage = function (event) {
	    if (self._ws !== ws) {
	      return;
	    }
	    self._armLiveness();
	    var msg;
	    try {
	      msg = JSON.parse(event.data);
	    } catch (e) {
	      return; // non-JSON frame, ignore
	    }
	    self._handleFrame(msg);
	  };
	
	  ws.onclose = function (event) {
	    if (self._ws !== ws) {
	      return;
	    }
	    self._ws = null;
	    self._clearTimer('_livenessTimer');
	    var code = event && event.code;
	    if (self._intentionalClose || NO_RECONNECT_CLOSE_CODES[code]) {
	      self._log('closed (' + code + '), not reconnecting');
	      return;
	    }
	    self._log('closed (' + code + '), will reconnect');
	    // A session was on screen - tell the consumer to show it as offline while
	    // we retry, instead of leaving a frozen live view.
	    if (self._current && self._current.state !== 'stopped') {
	      self._onOfflineCb();
	    }
	    self._scheduleReconnect();
	  };
	
	  ws.onerror = function () {
	    if (self._ws !== ws) {
	      return;
	    }
	    // A close event follows; reconnect is handled there.
	    self._log('socket error');
	  };
	};
	
	PresenceClient.prototype._send = function (obj) {
	  if (!this.isConnected()) {
	    return;
	  }
	  try {
	    this._ws.send(JSON.stringify(obj));
	  } catch (e) {
	    this._log('send failed: ' + (e && e.message));
	  }
	};
	
	PresenceClient.prototype._handleFrame = function (msg) {
	  switch (msg && msg.type) {
	    case 'ping':
	      this._send({ type: 'pong' });
	      break;
	    case 'connected':
	    case 'new_ops':
	      break; // op sync stays on the REST path
	    case 'presence_state':
	      if (typeof msg.payload === 'string' && typeof msg.ordinal === 'number') {
	        this._onPresenceState(msg.payload, msg.ordinal, msg.producerConnected !== false);
	      }
	      break;
	    case 'presence_cmd':
	      if (typeof msg.payload === 'string') {
	        this._onPresenceCmd(msg.payload);
	      }
	      break;
	    default:
	      break;
	  }
	};
	
	// A relayed command from another device. Phase 2 acts only on a "stop" that
	// names the session we're currently broadcasting (CAS guard).
	PresenceClient.prototype._onPresenceCmd = function (payloadStr) {
	  if (!this._producer) {
	    return;
	  }
	  var decoded = this._decodeEnvelope(payloadStr);
	  if (!decoded || decoded.opaque) {
	    return;
	  }
	  var cmd = decoded.payload;
	  if (cmd && cmd.v === 1 && cmd.cmd === 'stop' && cmd.sessionId === this._producer.sessionId) {
	    this._log('remote stop for our session');
	    this._onStopCommandCb();
	  }
	};
	
	// ---------------- reconnect / liveness ----------------
	
	PresenceClient.prototype._scheduleReconnect = function () {
	  if (this._intentionalClose || this._reconnectTimer) {
	    return;
	  }
	  this._reconnectAttempts++;
	  var exp = Math.min(this._reconnectAttempts - 1, MAX_BACKOFF_EXPONENT);
	  var delay = Math.min(this._minReconnectMs * Math.pow(2, exp), this._maxReconnectMs);
	  delay = Math.round(delay * (0.9 + Math.random() * 0.2)); // +/-10% jitter
	  var self = this;
	  this._reconnectTimer = setTimeout(function () {
	    self._reconnectTimer = null;
	    if (!self._intentionalClose) {
	      self._open();
	    }
	  }, delay);
	};
	
	PresenceClient.prototype._armLiveness = function () {
	  this._clearTimer('_livenessTimer');
	  var self = this;
	  this._livenessTimer = setTimeout(function () {
	    self._livenessTimer = null;
	    self._log('liveness timeout, forcing reconnect');
	    if (self._ws) {
	      try {
	        self._ws.close(4000, 'liveness timeout');
	      } catch (e) {
	        self._ws = null;
	        self._scheduleReconnect();
	      }
	    }
	  }, this._livenessMs);
	};
	
	PresenceClient.prototype._clearTimer = function (name) {
	  if (this[name]) {
	    clearTimeout(this[name]);
	    this[name] = null;
	  }
	};
	
	// ---------------- presence codec ----------------
	
	// Returns { enc, data } or null.
	PresenceClient.prototype._encodeEnvelope = function (obj) {
	  var crypto = this._getCrypto();
	  if (crypto) {
	    try {
	      return { enc: true, data: crypto.encrypt(obj) };
	    } catch (e) {
	      this._log('encrypt failed: ' + (e && e.message));
	      return null;
	    }
	  }
	  return { enc: false, data: JSON.stringify(obj) };
	};
	
	// Returns one of:
	//   { payload: <decoded object> }
	//   { opaque: 'no-key' | 'needs-derive' | 'plaintext' }
	//   null   (malformed - drop silently)
	PresenceClient.prototype._decodeEnvelope = function (payloadStr) {
	  var envelope;
	  try {
	    envelope = JSON.parse(payloadStr);
	  } catch (e) {
	    return null;
	  }
	  if (!envelope || typeof envelope.data !== 'string') {
	    return null;
	  }
	  var crypto = this._getCrypto();
	  if (envelope.enc) {
	    if (!crypto) {
	      this._log('presence payload encrypted but no sync key configured');
	      return { opaque: 'no-key' };
	    }
	    if (!crypto.canDecryptWithoutDerive(envelope.data)) {
	      // Deriving Argon2id here would stall the socket for tens of seconds.
	      // The producing device encrypts under its own op-session salt; the
	      // watch only has it cached once a sync has decrypted one of that
	      // device's ops. Shown opaquely until then.
	      this._log('presence payload under an uncached key salt - shown opaquely');
	      return { opaque: 'needs-derive' };
	    }
	    try {
	      return { payload: crypto.decrypt(envelope.data) };
	    } catch (e) {
	      this._log('presence decrypt failed: ' + (e && e.message));
	      return null;
	    }
	  }
	  if (crypto) {
	    // Encryption configured but the envelope is plaintext - hostile-server
	    // guard, fail closed (tracking-presence.service.ts does the same).
	    this._log('presence payload is plaintext while a key is configured - refusing');
	    return { opaque: 'plaintext' };
	  }
	  try {
	    return { payload: JSON.parse(envelope.data) };
	  } catch (e) {
	    return null;
	  }
	};
	
	PresenceClient.prototype._onPresenceState = function (payloadStr, ordinal, producerConnected) {
	  // Server-assigned ordinal orders states across devices without trusting
	  // their clocks. Equal ordinals are re-announcements (producerConnected
	  // flipped) and must pass.
	  if (ordinal < this._lastOrdinal) {
	    return;
	  }
	
	  var decoded = this._decodeEnvelope(payloadStr);
	  if (!decoded) {
	    return;
	  }
	  this._lastOrdinal = ordinal;
	
	  if (decoded.opaque) {
	    this._clearTimer('_lingerTimer');
	    this._current = {
	      opaque: decoded.opaque,
	      producerConnected: producerConnected,
	      ordinal: ordinal,
	      receivedAt: Date.now(),
	    };
	    this._onStateCb({
	      opaque: true,
	      reason: decoded.opaque,
	      state: 'tracking',
	      taskId: null,
	      sessionId: null,
	      deviceLabel: '',
	      sinceTs: 0,
	      seq: 0,
	      producerConnected: producerConnected,
	      ordinal: ordinal,
	      receivedAt: this._current.receivedAt,
	    });
	    // The producing device (often another phone) encrypts under a session
	    // salt this watch hasn't derived yet - a normal sync only caches it once
	    // it decrypts one of that device's ops, which may not happen while the
	    // device is merely tracking time. Derive it once, off the socket's
	    // message path (a brief JS pause), so the task name shows on the next
	    // heartbeat if not sooner.
	    if (decoded.opaque === 'needs-derive') {
	      this._deferredDerive(payloadStr, ordinal, producerConnected);
	    }
	    return;
	  }
	
	  this._applyDecodedPayload(decoded.payload, ordinal, producerConnected);
	};
	
	// One-shot background Argon2id derive for a producer whose salt we lack.
	// Deduped per salt per session so a repeating heartbeat can't loop it.
	PresenceClient.prototype._deferredDerive = function (payloadStr, ordinal, producerConnected) {
	  var crypto = this._getCrypto();
	  if (!crypto) {
	    return;
	  }
	  var data;
	  try {
	    data = JSON.parse(payloadStr).data;
	  } catch (e) {
	    return;
	  }
	  if (typeof data !== 'string' || data.length < 24) {
	    return;
	  }
	  var saltKey = data.slice(0, 24); // base64 of the 16-byte salt prefix
	  if (this._triedDeriveSalts[saltKey]) {
	    return;
	  }
	  this._triedDeriveSalts[saltKey] = true;
	  this._log('deriving this producer key once - the app may pause briefly');
	  var self = this;
	  setTimeout(function () {
	    var p;
	    try {
	      p = crypto.decrypt(data);
	    } catch (e) {
	      self._log('deferred presence decrypt failed: ' + (e && e.message));
	      return;
	    }
	    // Apply only if nothing newer has superseded this frame meanwhile.
	    if (ordinal >= self._lastOrdinal) {
	      self._applyDecodedPayload(p, ordinal, producerConnected);
	    }
	  }, 0);
	};
	
	PresenceClient.prototype._applyDecodedPayload = function (p, ordinal, producerConnected) {
	  if (!p || p.v !== 1 ||
	      typeof p.sessionId !== 'string' ||
	      (p.state !== 'tracking' && p.state !== 'stopped') ||
	      typeof p.seq !== 'number' || !isFinite(p.seq) ||
	      typeof p.sinceTs !== 'number' || !isFinite(p.sinceTs) ||
	      (p.taskId !== null && typeof p.taskId !== 'string')) {
	    return;
	  }
	
	  // Same session, older producer seq - a straggler, drop it.
	  if (this._current && !this._current.opaque &&
	      this._current.sessionId === p.sessionId && p.seq < this._current.seq) {
	    return;
	  }
	
	  this._clearTimer('_lingerTimer');
	
	  var view = {
	    opaque: false,
	    state: p.state,
	    reason: p.reason === 'idle' ? 'idle' : undefined,
	    taskId: p.taskId,
	    sinceTs: p.sinceTs,
	    deviceLabel: sanitizeDeviceLabel(p.deviceLabel),
	    sessionId: p.sessionId,
	    seq: p.seq,
	    producerConnected: producerConnected,
	    ordinal: ordinal,
	    receivedAt: Date.now(),
	  };
	  this._current = view;
	  this._onStateCb(view);
	
	  // A plain "stopped" (task switched, or user stopped) lingers briefly so a
	  // stop+start within seconds mutates the surface in place. An idle pause
	  // (reason:"idle") stays visible as "Paused" until superseded.
	  if (p.state === 'stopped' && p.reason !== 'idle') {
	    var self = this;
	    this._lingerTimer = setTimeout(function () {
	      self._lingerTimer = null;
	      self._current = null;
	      self._lastOrdinal = -1;
	      self._onClearedCb();
	    }, this._lingerMs);
	  }
	};
	
	module.exports = {
	  PresenceClient: PresenceClient,
	  STALE_AFTER_MS: STALE_AFTER_MS,
	  STOPPED_LINGER_MS: STOPPED_LINGER_MS,
	  HEARTBEAT_MS: HEARTBEAT_MS,
	  DEVICE_LABEL: DEVICE_LABEL,
	  sanitizeDeviceLabel: sanitizeDeviceLabel,
	};


/***/ })
/******/ ]);
//# sourceMappingURL=pebble-js-app.js.map