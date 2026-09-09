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
