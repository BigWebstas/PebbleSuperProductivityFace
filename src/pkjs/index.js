// PebbleKit JS for the Super Productivity companion watchface.
//
// The watchface can't read the main watchapp's data (separate Pebble apps,
// separate storage), so this does its own trimmed SuperSync pull - snapshot
// bootstrap + op-log replay via the shared lib modules - then sends the face a
// few numbers for today. It syncs on launch, when the face asks (a wrist tap),
// and on a slow timer. Writes nothing back to the server; this is read-only.

var supersync = require('./lib/supersync-client.js');
var store = require('./lib/task-store.js');
var presence = require('./lib/presence-client.js');

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

function pushTracking() {
  var dict = { MSG_TYPE: 0 };
  if (presenceClient && trackedView && !trackedView.opaque && trackedView.title) {
    dict.FACE_TRACKING_TITLE = trackedView.title.slice(0, 38);
    dict.FACE_TRACKING_ELAPSED_S = Math.max(0, Math.round((Date.now() - trackedView.sinceTs) / 1000));
  } else if (presenceClient && trackedView && trackedView.opaque) {
    dict.FACE_TRACKING_TITLE = 'tracking on another device';
    dict.FACE_TRACKING_ELAPSED_S = 0;
  } else {
    dict.FACE_TRACKING_TITLE = '';
    dict.FACE_TRACKING_ELAPSED_S = 0;
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
      trackedView = { title: title, sinceTs: view.sinceTs || Date.now() };
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
    doSync();
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
