// orbital-firebase-broadcaster.js — WECRYPTO Firestore lane broadcaster
'use strict';

const path = require('path');

let _firestore = null;
let _rtdb = null;
let _initDone = false;
let _initError = null;
let _adminModule = null;
let _bootstrapInFlight = null;

const ROOT_COLLECTION = 'wecrypto_engine';
const ROOT_DOC_ID = 'root';
const FIRESTORE_RATE_MS = 30_000;     // orbital state writes
const TICK_RATE_MS = 1_000;           // per-market tick writes
const VERTEX_RATE_MS = 2_000;         // per-kind execution logs
const _lastWrite = {};                // { sym: ts }
const _lastTickWrite = {};            // { market: ts }
const _lastVertexWrite = {};          // { kind: ts }

function _initFirebase() {
  if (_firestore && (_rtdb || _initDone)) return;
  try {
    _adminModule = _adminModule || require(path.join(__dirname, '../cloud/firebase-admin-firestore'));
    _firestore = _adminModule && typeof _adminModule.getFirestore === 'function'
      ? _adminModule.getFirestore()
      : (_adminModule && _adminModule.firestore ? _adminModule.firestore : null);
    if (!_firestore && _adminModule && typeof _adminModule.startupCheck === 'function' && !_bootstrapInFlight) {
      _bootstrapInFlight = _adminModule.startupCheck({ required: false, probe: false })
        .then(() => {
          _firestore = _adminModule && typeof _adminModule.getFirestore === 'function'
            ? _adminModule.getFirestore()
            : _firestore;
        })
        .catch((e) => {
          _initError = e && e.message ? e.message : String(e);
        })
        .finally(() => {
          _bootstrapInFlight = null;
        });
    }
  } catch (e) {
    _initError = e.message;
  }
  try {
    const admin = require('firebase-admin');
    const rtdbUrl = process.env.WECRYPTO_FIREBASE_DATABASE_URL;
    if (rtdbUrl && admin.apps && admin.apps.length) {
      _rtdb = admin.app().database(rtdbUrl);
    }
  } catch (_) { }
  _initDone = true;
}

function _toUpper(value, fallback) {
  const v = String(value || '').trim().toUpperCase();
  return v || String(fallback || 'UNKNOWN').trim().toUpperCase();
}

function _toNum(value, fallback = null) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function _isRateLimited(map, key, windowMs) {
  const now = Date.now();
  const last = map[key] || 0;
  if (now - last < windowMs) return true;
  map[key] = now;
  return false;
}

function _deriveAssetFromTicker(marketTicker) {
  const txt = String(marketTicker || '').toUpperCase();
  const known = ['BTC', 'ETH', 'SOL', 'XRP', 'DOGE', 'BNB', 'HYPE', 'RNDR', 'DOT'];
  for (const sym of known) {
    if (txt.includes(sym)) return sym;
  }
  return 'UNKNOWN';
}

function _deriveMarketId(marketTicker) {
  const raw = String(marketTicker || '').trim();
  if (!raw) return 'UNKNOWN_MARKET';
  return raw.replace(/[^a-zA-Z0-9_\-]/g, '_');
}

function _buildOrbitalPayload(orbital) {
  return {
    asset: _toUpper(orbital.asset, 'UNKNOWN'),
    timestamp: new Date().toISOString(),
    ts: _toNum(orbital.ts, Date.now()),
    lambda: _toNum(orbital.lambda, null),
    orbital_metrics: {
      s_ground_state: _toNum(orbital.s, null),
      p_momentum: _toNum(orbital.p, null),
      d_diffusion: _toNum(orbital.d, null),
      f_price_accel: _toNum(orbital.f, null),
      f_vol_anomaly: _toNum(orbital.fAnomalyVol, null),
    },
    exhaustion_profile: {
      oeq_v1: _toNum(orbital.oeq, null),
      oeq_v2: _toNum(orbital.oeqV2, null),
      p_pct: _toNum(orbital?.v2?.pPct, null),
      d_pct: _toNum(orbital?.v2?.dPct, null),
      dist_pct: _toNum(orbital?.v2?.distPct, null),
      structural_state: orbital.state || null,
    },
    qsp: orbital.qsp || null,
    execution_signal: {
      action: orbital.action || null,
      reason: orbital.reason || null,
      fade_direction: orbital.fadeDirection || null,
    },
    kalshi_v2_payload: orbital.kalshiV2Payload || null,
    position: {
      side: orbital.position ? orbital.position.side : null,
      entry_price: orbital.position ? _toNum(orbital.position.entryPrice, null) : null,
      peak_price: orbital.position ? _toNum(orbital.position.peakPrice, null) : null,
      peak_oeq: orbital.position ? _toNum(orbital.position.peakAbsOEQ, null) : null,
    },
  };
}

function _buildTickPayload(tick) {
  const market = _deriveMarketId(tick.market_id || tick.market_ticker || tick.ticker);
  const ts = _toNum(tick.ts, Date.now());
  return {
    market_id: market,
    price: _toNum(tick.price, _toNum(tick.yes_bid, _toNum(tick.last_traded, null))),
    vol: _toNum(tick.vol, _toNum(tick.volume, null)),
    ts,
    stream_status: tick.stream_status || 'active',
    yes_bid: _toNum(tick.yes_bid, null),
    yes_ask: _toNum(tick.yes_ask, null),
    no_bid: _toNum(tick.no_bid, null),
    no_ask: _toNum(tick.no_ask, null),
    source: tick.source || 'kalshi-ws',
  };
}

function _buildTensorBatchPayload(orbital) {
  const ts = _toNum(orbital.ts, Date.now());
  const qsp = orbital.qsp || {};
  const eigenvalues = Array.isArray(qsp.schrodingerOrbitals)
    ? qsp.schrodingerOrbitals.map((lvl) => _toNum(lvl.energy, null)).filter(Number.isFinite)
    : [];

  const confidence = _toNum(qsp?.quantizer?.confidence, null);
  let state = 'coiled';
  const action = orbital.action || orbital?.execution_signal?.action || null;
  if (action === 'EXECUTE_COUNTER_TRADE') state = 'excited';
  else if (action === 'EXECUTE_EXIT') state = 'decaying';
  else if (confidence != null && confidence < 0.45) state = 'diffuse';

  return {
    state,
    ts,
    eigenvalues,
    qsp_mode: qsp.mode || null,
    confidence,
    oeq: _toNum(orbital.oeq, _toNum(orbital?.exhaustion_profile?.oeq_v1, null)),
    oeq_v2: _toNum(orbital.oeqV2, _toNum(orbital?.exhaustion_profile?.oeq_v2, null)),
    p_delta: _toNum(orbital.pDelta, null),
    payload: orbital.kalshiV2Payload || orbital.kalshi_v2_payload || null,
  };
}

function _buildVertexExecutionPayload(kind, data = {}) {
  return {
    kind: String(kind || 'orbital_rebalances'),
    ts: _toNum(data.ts, Date.now()),
    source: data.source || 'wecrypto',
    asset: data.asset ? _toUpper(data.asset, 'UNKNOWN') : null,
    market_id: data.market_id ? _deriveMarketId(data.market_id) : null,
    action: data.action || null,
    score: _toNum(data.score, null),
    payload: data.payload && typeof data.payload === 'object' ? data.payload : null,
    diagnostics: data.diagnostics && typeof data.diagnostics === 'object' ? data.diagnostics : null,
  };
}

async function _pushOrbitalState(sym, payload) {
  if (!_firestore) return;
  const asset = _toUpper(sym, 'UNKNOWN');
  const rootRef = _firestore.collection(ROOT_COLLECTION).doc(ROOT_DOC_ID);
  try {
    const latestRef = rootRef.collection('orbital_states').doc(asset);
    await latestRef.set({
      latest_state: payload.exhaustion_profile?.structural_state || null,
      latest_ts: payload.ts,
      latest_oeq: payload.exhaustion_profile?.oeq_v1 || null,
      latest_confidence: payload?.qsp?.quantizer?.confidence || null,
      updated_at: payload.timestamp,
    }, { merge: true });
  } catch (e) {
    console.warn('[orbital-broadcaster] orbital state latest write error:', e.message);
  }

  try {
    const tensorRef = rootRef
      .collection('orbital_states').doc(asset)
      .collection('tensor_batches');
    await tensorRef.add(_buildTensorBatchPayload(payload));
  } catch (e) {
    console.warn('[orbital-broadcaster] tensor batch write error:', e.message);
  }
}

async function _pushTick(tickPayload) {
  if (!_firestore) return;
  const marketId = _deriveMarketId(tickPayload.market_id);
  const rootRef = _firestore.collection(ROOT_COLLECTION).doc(ROOT_DOC_ID);
  try {
    const streamRef = rootRef.collection('event_streams').doc(marketId);
    await streamRef.set({
      stream_status: tickPayload.stream_status || 'active',
      market_id: marketId,
      updated_at_ts: tickPayload.ts,
    }, { merge: true });

    await streamRef.collection('ticks').add({
      price: tickPayload.price,
      vol: tickPayload.vol,
      ts: tickPayload.ts,
      yes_bid: tickPayload.yes_bid,
      yes_ask: tickPayload.yes_ask,
      no_bid: tickPayload.no_bid,
      no_ask: tickPayload.no_ask,
      source: tickPayload.source || 'kalshi-ws',
    });
  } catch (e) {
    console.warn('[orbital-broadcaster] tick write error:', e.message);
  }
}

async function _pushVertexExecution(kind, data = {}) {
  if (!_firestore) return;
  const bucket = String(kind || 'orbital_rebalances');
  const rootRef = _firestore.collection(ROOT_COLLECTION).doc(ROOT_DOC_ID);
  try {
    const bucketRef = rootRef.collection('vertex_executions').doc(bucket);
    await bucketRef.set({
      last_ts: _toNum(data.ts, Date.now()),
      updated_at: new Date().toISOString(),
      kind: bucket,
    }, { merge: true });
    await bucketRef.collection('entries').add(_buildVertexExecutionPayload(bucket, data));
  } catch (e) {
    console.warn('[orbital-broadcaster] vertex execution write error:', e.message);
  }
}

async function _pushToRTDB(sym, payload) {
  if (!_rtdb) return;
  try {
    await _rtdb.ref('orbital/' + _toUpper(sym, 'UNKNOWN')).set(payload);
  } catch (_) { }
}

function push(orbital) {
  if (!orbital || !orbital.asset) return;
  _initFirebase();
  const sym = _toUpper(orbital.asset, 'UNKNOWN');
  if (_isRateLimited(_lastWrite, sym, FIRESTORE_RATE_MS)) return;

  const payload = _buildOrbitalPayload(orbital);
  _pushOrbitalState(sym, payload).catch(() => { });
  _pushToRTDB(sym, payload).catch(() => { });

  if (orbital.action === 'EXECUTE_COUNTER_TRADE' || orbital.action === 'EXECUTE_EXIT') {
    const kind = orbital.action === 'EXECUTE_COUNTER_TRADE' ? 'short_term_contracts' : 'orbital_rebalances';
    _pushVertexExecution(kind, {
      ts: payload.ts,
      source: 'orbital-engine',
      asset: sym,
      action: orbital.action,
      score: payload.exhaustion_profile?.oeq_v2 ?? payload.exhaustion_profile?.oeq_v1 ?? null,
      payload: orbital.kalshiV2Payload || null,
      diagnostics: { state: orbital.state, reason: orbital.reason, qsp: orbital.qsp || null },
    }).catch(() => { });
  }
}

async function pushBatch(results) {
  if (!Array.isArray(results) || !results.length) return;
  _initFirebase();
  for (const orbital of results) push(orbital);
}

function pushMarketTick(tick) {
  if (!tick) return;
  _initFirebase();
  const marketId = _deriveMarketId(tick.market_id || tick.market_ticker || tick.ticker);
  if (_isRateLimited(_lastTickWrite, marketId, TICK_RATE_MS)) return;
  const payload = _buildTickPayload(tick);
  _pushTick(payload).catch(() => { });
}

function pushVertexExecution(kind, data) {
  _initFirebase();
  const bucket = String(kind || 'orbital_rebalances');
  if (_isRateLimited(_lastVertexWrite, bucket, VERTEX_RATE_MS)) return;
  _pushVertexExecution(bucket, data || {}).catch(() => { });
}

function getDiagnostics() {
  return {
    firestoreReady: !!_firestore,
    rtdbReady: !!_rtdb,
    initError: _initError,
    lastWrite: Object.assign({}, _lastWrite),
    lastTickWrite: Object.assign({}, _lastTickWrite),
    lastVertexWrite: Object.assign({}, _lastVertexWrite),
    rootCollection: ROOT_COLLECTION,
    rootDocId: ROOT_DOC_ID,
    rateLimitMs: FIRESTORE_RATE_MS,
    tickRateMs: TICK_RATE_MS,
    vertexRateMs: VERTEX_RATE_MS,
  };
}

module.exports = {
  push,
  pushBatch,
  pushMarketTick,
  pushVertexExecution,
  getDiagnostics,
};
