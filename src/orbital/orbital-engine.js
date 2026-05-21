// orbital-engine.js — WECRYPTO Cross-Chain Orbital Engine v1.0
// ═══════════════════════════════════════════════════════════════════════════
// Adds a non-veto orbital signal that contributes diagnostics to the 15m
// prediction pipeline. Designed to be additive and reversible:
//   * Never hard-blocks trading
//   * Feeds OEQ + s/p/d/f orbital diagnostics into prediction cards
//   * Provides a counter-trade intent surface for the Kalshi V2 mapper
//
// Public API (browser/Electron):
//   window.OrbitalEngine.isEnabled()
//   window.OrbitalEngine.processInterval(sym, candles15m)
//   window.OrbitalEngine.reinitLambdas(historyMap?)
//   window.OrbitalEngine.getState(sym)
//   window.OrbitalEngine.getLambda(sym)
//   window.OrbitalEngine.getDefaults()
//
// CommonJS export is also provided for Node smoke tests.
// ═══════════════════════════════════════════════════════════════════════════

(function (root) {
  'use strict';

  var ASSETS = ['BTC', 'ETH', 'SOL', 'XRP', 'DOGE', 'BNB', 'HYPE'];

  // Default lambda scales when no local sigma is available.
  var DEFAULT_LAMBDA = {
    BTC: 1.0,
    ETH: 1.15,
    SOL: 1.45,
    XRP: 1.25,
    DOGE: 1.55,
    BNB: 1.10,
    HYPE: 1.60,
  };

  var LAMBDA_FLOOR = 0.5;
  var LAMBDA_CEIL = 3.5;

  // Orbital weight mixture used to compute OEQ.
  var OEQ_WEIGHTS = { s: 0.45, p: 0.25, d: 0.20, f: 0.10 };

  // Entry / exit thresholds (OEQ units are post-lambda scaled).
  var ENTRY_OEQ = 1.0;
  var EXIT_D_TRAILING_MULT = 1.5;
  var EXIT_S_GROUND_STATE = 0.05;

  // OEQ_V2 formula config (volume-aware cross-chain model).
  var OEQ_V2_ENTRY_THRESHOLD = 1.0;
  var F_ANOMALY_WINDOW = 8;        // bars for avg-volume baseline
  var F_ANOMALY_FLOOR   = 0.5;     // prevent extreme dampening on thin candles
  var F_ANOMALY_CEIL    = 5.0;

  // Kalshi V2 payload defaults (overridable via env).
  var KALSHI_DEFAULT_COUNT     = 10;
  var KALSHI_DEFAULT_NO_PRICE  = 0.45;  // max fill for NO leg (buy NO bid)
  var KALSHI_BASE_URL          = 'https://trading-api.kalshi.com/trade-api/v2';

  // Rolling window for p (mean reversion) and d (realized vol) computations.
  var WINDOW_SIZE = 12;
  var QSP_WINDOW_SIZE = 16;
  var QSP_BIN_COUNT = 7;
  var QSP_UNCERTAINTY_DECAY = 0.25; // damp OEQ when quantizer confidence is low
  var QSP_ORBITAL_UNCERTAINTY_TRIGGER = 0.42;
  var QSP_ORBITAL_D_PCT_TRIGGER = 0.85;
  var QSP_ORBITAL_F_ANOMALY_TRIGGER = 1.6;

  // Lambda recalibration parameters.
  var LAMBDA_TARGET_SIGMA = 0.0085; // ~0.85% realized return std on 15m candles

  function readEnv(name) {
    try {
      if (typeof root !== 'undefined' && root.__env && root.__env[name] != null) return root.__env[name];
    } catch (_) {}
    try {
      if (typeof process !== 'undefined' && process && process.env && process.env[name] != null) {
        return process.env[name];
      }
    } catch (_) {}
    return null;
  }

  function readBoolEnv(name, fallback) {
    var raw = readEnv(name);
    if (raw == null) return !!fallback;
    var txt = String(raw).trim().toLowerCase();
    if (txt === '1' || txt === 'true' || txt === 'yes' || txt === 'on') return true;
    if (txt === '0' || txt === 'false' || txt === 'no' || txt === 'off') return false;
    return !!fallback;
  }

  function clamp(v, lo, hi) {
    if (!Number.isFinite(v)) return lo;
    return Math.max(lo, Math.min(hi, v));
  }

  function stdev(returns) {
    if (!returns || returns.length < 2) return 0;
    var mean = 0;
    for (var i = 0; i < returns.length; i++) mean += returns[i];
    mean /= returns.length;
    var sq = 0;
    for (var j = 0; j < returns.length; j++) {
      var d = returns[j] - mean;
      sq += d * d;
    }
    return Math.sqrt(sq / Math.max(1, returns.length - 1));
  }

  function returnsFromCloses(closes) {
    if (!Array.isArray(closes) || closes.length < 2) return [];
    var out = [];
    for (var i = 1; i < closes.length; i++) {
      var prev = closes[i - 1];
      if (prev > 0) out.push((closes[i] / prev) - 1);
    }
    return out;
  }

  function extractCloses(candles, maxLen) {
    if (!Array.isArray(candles)) return [];
    var limit = Math.min(candles.length, maxLen || candles.length);
    var slice = candles.slice(candles.length - limit);
    var closes = [];
    for (var i = 0; i < slice.length; i++) {
      var c = slice[i];
      var v = c && (c.close != null ? c.close : c.c);
      var n = Number(v);
      if (Number.isFinite(n) && n > 0) closes.push(n);
    }
    return closes;
  }

  function mean(arr) {
    if (!arr || !arr.length) return 0;
    var sum = 0;
    for (var i = 0; i < arr.length; i++) sum += arr[i];
    return sum / arr.length;
  }

  function stdevPopulation(arr) {
    if (!arr || arr.length < 2) return 0;
    var m = mean(arr);
    var sq = 0;
    for (var i = 0; i < arr.length; i++) {
      var d = arr[i] - m;
      sq += d * d;
    }
    return Math.sqrt(sq / arr.length);
  }

  function normalizeZ(value, baseline, sigma) {
    if (!Number.isFinite(value)) return 0;
    var s = Number.isFinite(sigma) && sigma > 1e-9 ? sigma : 1e-9;
    return clamp((value - (Number.isFinite(baseline) ? baseline : 0)) / s, -3, 3);
  }

  // Positive quadratic B-spline basis over equally-spaced centers.
  function bSplineBasis2(u) {
    var a = Math.abs(u);
    if (a >= 1.5) return 0;
    if (a >= 0.5) {
      var t = 1.5 - a;
      return 0.5 * t * t;
    }
    return 0.75 - (a * a);
  }

  function makeBinCenters(n) {
    var count = Math.max(3, n | 0);
    var out = [];
    if (count === 1) return [0];
    for (var i = 0; i < count; i++) {
      out.push(-1 + (2 * i / (count - 1)));
    }
    return out;
  }

  function probabilisticQuantize(features, binCount) {
    var vals = Array.isArray(features) ? features.filter(Number.isFinite) : [];
    if (!vals.length) {
      return { bins: [], expectation: 0, uncertainty: 1, confidence: 0, dominantBin: null };
    }

    var centers = makeBinCenters(binCount || QSP_BIN_COUNT);
    var spacing = centers.length > 1 ? (centers[1] - centers[0]) : 1;
    var weights = new Array(centers.length).fill(0);

    for (var i = 0; i < vals.length; i++) {
      var x = clamp(vals[i], -1, 1);
      var localSum = 0;
      var local = new Array(centers.length).fill(0);
      for (var j = 0; j < centers.length; j++) {
        var u = spacing > 0 ? (x - centers[j]) / spacing : (x - centers[j]);
        var w = bSplineBasis2(u);
        local[j] = w;
        localSum += w;
      }
      if (localSum <= 0) continue;
      for (var k = 0; k < centers.length; k++) {
        weights[k] += local[k] / localSum;
      }
    }

    var total = weights.reduce(function (a, b) { return a + b; }, 0);
    if (total <= 0) {
      return { bins: [], expectation: 0, uncertainty: 1, confidence: 0, dominantBin: null };
    }

    var bins = centers.map(function (c, idx) {
      return { center: c, weight: weights[idx] / total };
    });
    bins.sort(function (a, b) { return b.weight - a.weight; });

    var expectation = 0;
    var maxW = 0;
    for (var m = 0; m < bins.length; m++) {
      expectation += bins[m].center * bins[m].weight;
      if (bins[m].weight > maxW) maxW = bins[m].weight;
    }
    var uncertainty = clamp(1 - maxW, 0, 1);
    return {
      bins: bins,
      expectation: parseFloat(expectation.toFixed(6)),
      uncertainty: parseFloat(uncertainty.toFixed(6)),
      confidence: parseFloat((1 - uncertainty).toFixed(6)),
      dominantBin: bins[0] || null,
    };
  }

  function jacobiEigenvaluesSymmetric(matrix, maxIter) {
    var n = Array.isArray(matrix) ? matrix.length : 0;
    if (!n) return [];
    var a = matrix.map(function (row) { return row.slice(); });
    var iterations = Number.isFinite(maxIter) ? maxIter : 32;

    for (var iter = 0; iter < iterations; iter++) {
      var p = 0, q = 1;
      var maxVal = Math.abs(a[p][q] || 0);
      for (var i = 0; i < n; i++) {
        for (var j = i + 1; j < n; j++) {
          var v = Math.abs(a[i][j] || 0);
          if (v > maxVal) { maxVal = v; p = i; q = j; }
        }
      }
      if (maxVal < 1e-8) break;

      var app = a[p][p], aqq = a[q][q], apq = a[p][q];
      var phi = 0.5 * Math.atan2(2 * apq, (aqq - app));
      var c = Math.cos(phi), s = Math.sin(phi);

      for (var k = 0; k < n; k++) {
        if (k === p || k === q) continue;
        var akp = a[k][p], akq = a[k][q];
        a[k][p] = c * akp - s * akq;
        a[p][k] = a[k][p];
        a[k][q] = s * akp + c * akq;
        a[q][k] = a[k][q];
      }
      a[p][p] = c * c * app - 2 * s * c * apq + s * s * aqq;
      a[q][q] = s * s * app + 2 * s * c * apq + c * c * aqq;
      a[p][q] = 0;
      a[q][p] = 0;
    }

    var eig = [];
    for (var d = 0; d < n; d++) eig.push(Number(a[d][d]) || 0);
    eig.sort(function (x, y) { return x - y; });
    return eig;
  }

  function computeSchrodingerOrbitals(closes, levelCount) {
    var seq = Array.isArray(closes) ? closes.filter(Number.isFinite) : [];
    if (seq.length < 6) return [];
    var returns = [];
    for (var i = 1; i < seq.length; i++) {
      var prev = seq[i - 1];
      returns.push(prev > 0 ? (seq[i] / prev) - 1 : 0);
    }
    if (!returns.length) return [];

    var sigma = stdevPopulation(returns) || 1e-6;
    var n = returns.length;
    var h = [];
    for (var r = 0; r < n; r++) {
      h[r] = new Array(n).fill(0);
      var potential = Math.abs(returns[r]) / sigma;
      h[r][r] = 2 + potential;
      if (r > 0) h[r][r - 1] = -1;
      if (r < n - 1) h[r][r + 1] = -1;
    }

    var eig = jacobiEigenvaluesSymmetric(h, 28);
    if (!eig.length) return [];

    var count = Math.max(1, Math.min(levelCount || 3, eig.length));
    var window = seq.slice(-n);
    var avg = mean(window);
    var s = stdevPopulation(window) || 1;
    var levels = [];
    for (var k = 0; k < count; k++) {
      var e = Math.max(0, eig[k]);
      var width = clamp((Math.sqrt(e + 1e-9) * sigma * avg), avg * 0.001, avg * 0.05);
      levels.push({
        energy: parseFloat(e.toFixed(6)),
        center: parseFloat(avg.toFixed(6)),
        width: parseFloat(width.toFixed(6)),
        persistence: parseFloat(clamp(1 - (width / Math.max(avg * 0.05, 1e-6)), 0, 1).toFixed(6)),
        zScore: parseFloat(normalizeZ(window[window.length - 1], avg, s).toFixed(6)),
      });
    }
    return levels;
  }

  function buildQspState(closes, orbitals, v2) {
    var seq = Array.isArray(closes) ? closes.filter(Number.isFinite) : [];
    if (seq.length < 4) return null;
    var rets = returnsFromCloses(seq.slice(-QSP_WINDOW_SIZE));
    var sigma = stdevPopulation(rets);
    var drift = mean(rets);
    var lastRet = rets.length ? rets[rets.length - 1] : 0;
    var pPct = v2 && Number.isFinite(v2.pPct) ? v2.pPct : (Number.isFinite(orbitals.p) ? orbitals.p : 0);
    var dPct = v2 && Number.isFinite(v2.dPct) ? v2.dPct : (Number.isFinite(orbitals.d) ? Math.abs(orbitals.d) : 0);
    var fAnomaly = v2 && Number.isFinite(v2.fAnomaly) ? v2.fAnomaly : 1.0;

    var featureVec = [
      clamp(normalizeZ(lastRet, drift, sigma || 0.0005), -1, 1),
      clamp(normalizeZ(pPct / 100, 0, Math.max(sigma, 0.0005)), -1, 1),
      clamp(normalizeZ(dPct / 100, 0, Math.max(sigma, 0.0005)), -1, 1),
      clamp((fAnomaly - 1) / 2, -1, 1),
      clamp(Number.isFinite(orbitals.oeq) ? orbitals.oeq / 5 : 0, -1, 1),
    ];
    var quant = probabilisticQuantize(featureVec, QSP_BIN_COUNT);

    var runOrbitalLayer =
      quant.uncertainty >= QSP_ORBITAL_UNCERTAINTY_TRIGGER ||
      dPct >= QSP_ORBITAL_D_PCT_TRIGGER ||
      fAnomaly >= QSP_ORBITAL_F_ANOMALY_TRIGGER;

    var orbitalsQ = runOrbitalLayer ? computeSchrodingerOrbitals(seq.slice(-QSP_WINDOW_SIZE), 3) : [];
    return {
      mode: runOrbitalLayer ? 'hybrid' : 'quantizer-only',
      featureVec: featureVec.map(function (x) { return parseFloat(x.toFixed(6)); }),
      quantizer: quant,
      stress: {
        pPct: parseFloat(pPct.toFixed(6)),
        dPct: parseFloat(dPct.toFixed(6)),
        fAnomaly: parseFloat(fAnomaly.toFixed(6)),
      },
      schrodingerOrbitals: orbitalsQ,
    };
  }

  function applyQspToOrbitals(orbitals, qspState) {
    if (!orbitals || !qspState || !qspState.quantizer) return orbitals;
    var uncertainty = Number(qspState.quantizer.uncertainty) || 0;
    var bias = Number(qspState.quantizer.expectation) || 0;
    var damp = clamp(1 - (uncertainty * QSP_UNCERTAINTY_DECAY), 0.7, 1.0);
    var adjustedOEQ = orbitals.oeq * damp + (bias * 0.35);
    var adjustedP = orbitals.pDelta + (bias * 0.2);
    return {
      s: orbitals.s,
      p: orbitals.p,
      d: orbitals.d,
      f: orbitals.f,
      oeq: parseFloat(adjustedOEQ.toFixed(4)),
      pDelta: parseFloat(adjustedP.toFixed(4)),
      lastClose: orbitals.lastClose,
      _qsp: {
        uncertainty: parseFloat(uncertainty.toFixed(6)),
        expectation: parseFloat(bias.toFixed(6)),
        damp: parseFloat(damp.toFixed(6)),
      },
    };
  }

  // ── State per asset ────────────────────────────────────────────────────────
  var _lambdas = {};
  var _positions = {};
  var _lastResult = {};
  var _volBuffers = {};  // rolling volume buffers per asset for f_anomaly

  ASSETS.forEach(function (sym) {
    _lambdas[sym] = DEFAULT_LAMBDA[sym] || 1.0;
    _positions[sym] = {
      side: null,           // null | 'long' | 'short'
      entryPrice: null,
      entryOEQ: null,
      entryTs: null,
      peakAbsOEQ: 0,
      peakPrice: null,      // for d-orbital price-level trailing stop
    };
    _volBuffers[sym] = [];
    _lastResult[sym] = null;
  });

  function computeLambdaFromCloses(closes) {
    var rets = returnsFromCloses(closes);
    if (rets.length < 4) return null;
    var sigma = stdev(rets);
    if (!Number.isFinite(sigma) || sigma <= 0) return null;
    var lambda = LAMBDA_TARGET_SIGMA / sigma;
    return clamp(lambda, LAMBDA_FLOOR, LAMBDA_CEIL);
  }

  // ── Volume helpers (f_anomaly cross-chain model) ─────────────────────────
  function extractVolumes(candles, maxLen) {
    if (!Array.isArray(candles)) return [];
    var limit = Math.min(candles.length, maxLen || candles.length);
    var slice = candles.slice(candles.length - limit);
    var vols = [];
    for (var i = 0; i < slice.length; i++) {
      var c = slice[i];
      var v = c && (c.volume != null ? c.volume : (c.v != null ? c.v : null));
      var n = Number(v);
      if (Number.isFinite(n) && n >= 0) vols.push(n);
    }
    return vols;
  }

  // fAnomalyVol = latest candle vol / rolling avg vol (volume surge detector).
  // Returns 1.0 when no volume data is available (neutral, no dampening).
  function computeFAnomalyVol(sym, candles) {
    var vols = extractVolumes(candles, F_ANOMALY_WINDOW + 1);
    if (!vols || vols.length < 2) return 1.0;

    // Maintain per-asset rolling buffer.
    var buf = _volBuffers[sym] || (_volBuffers[sym] = []);
    vols.forEach(function (v) { buf.push(v); });
    if (buf.length > F_ANOMALY_WINDOW) buf.splice(0, buf.length - F_ANOMALY_WINDOW);

    var latestVol = vols[vols.length - 1];
    var avgVol = 0;
    for (var i = 0; i < buf.length; i++) avgVol += buf[i];
    avgVol /= Math.max(1, buf.length);
    if (avgVol <= 0) return 1.0;

    return clamp(latestVol / avgVol, F_ANOMALY_FLOOR, F_ANOMALY_CEIL);
  }

  // ── OEQ v2 formula (cross-chain nuclear model) ────────────────────────────
  // oeq_v2 = (p_pct / d_pct) × tanh(λ × dist_pct / f_anomaly)
  //
  // • p_pct         — kinetic thrust (latest close vs 8-bar mean), percent
  // • d_pct         — realized diffusion vol, percent  
  // • dist_pct      — distance from s-orbital ground state, percent
  // • f_anomaly     — volume surge ratio (dampens tanh on volume-backed moves)
  //
  // High f_anomaly (e.g. 3×) compresses the tanh argument → requires more
  // momentum per unit distance to breach OEQ_V2_ENTRY_THRESHOLD, protecting
  // the engine from fading true breakouts with genuine volume support.
  function computeOEQv2(closes, lambda, fAnomalyVol) {
    if (!closes || closes.length < 3) return null;
    var n = closes.length;
    var lastClose = closes[n - 1];
    var openClose = closes[n - 2]; // treat prev close as "open" for 15m delta

    // s-orbital: 8-bar rolling mean (ground state baseline)
    var win = closes.slice(-F_ANOMALY_WINDOW);
    var sBase = 0;
    for (var i = 0; i < win.length; i++) sBase += win[i];
    sBase /= Math.max(1, win.length);
    if (sBase <= 0) return null;

    // p_pct: kinetic thrust (close vs open, %)
    var pPct = openClose > 0 ? ((lastClose - openClose) / openClose) * 100 : 0;

    // d_pct: realized diffusion vol (stdev of recent returns, %)
    var rets = returnsFromCloses(closes.slice(-Math.min(16, n)));
    var dPct = rets.length ? stdev(rets) * 100 : 0.1;
    if (dPct < 0.001) dPct = 0.001;

    // distance from ground state, %
    var distPct = ((lastClose - sBase) / sBase) * 100;

    // OEQ v2 formula
    var fAnomaly = Number.isFinite(fAnomalyVol) && fAnomalyVol > 0 ? fAnomalyVol : 1.0;
    var tanhArg  = lambda * (distPct / fAnomaly);
    var oeqV2    = (pPct / dPct) * Math.tanh(tanhArg);

    return {
      oeqV2:     parseFloat(oeqV2.toFixed(4)),
      pPct:      parseFloat(pPct.toFixed(4)),
      dPct:      parseFloat(dPct.toFixed(4)),
      distPct:   parseFloat(distPct.toFixed(4)),
      sBase:     parseFloat(sBase.toFixed(4)),
      fAnomaly:  parseFloat(fAnomaly.toFixed(4)),
    };
  }

  // ── Kalshi V2 payload builder ─────────────────────────────────────────────
  // Maps orbital decision → strict fixed-point V2 order dict.
  // Caller must substitute ACTIVE_TICKER for the live KX ticker.
  function buildKalshiV2Payload(sym, decision, orbitals, v2) {
    var targetNoPrice = KALSHI_DEFAULT_NO_PRICE;
    var count         = KALSHI_DEFAULT_COUNT;
    var side, price;

    if (decision.action === 'EXECUTE_COUNTER_TRADE') {
      var pDelta = v2 ? v2.pPct : orbitals.pDelta;
      if (pDelta > 0) {
        // Upward surge → reversion down expected → BUY NO → sell YES side.
        side  = 'ask';
        price = parseFloat((1.0 - targetNoPrice).toFixed(4)); // e.g. 0.5500
      } else {
        // Downward flush → reversion up expected → BUY YES → bid side.
        side  = 'bid';
        price = parseFloat(targetNoPrice.toFixed(4));          // e.g. 0.4500
      }
    } else if (decision.action === 'EXECUTE_EXIT') {
      // Flatten at mid (market).
      side  = 'bid';
      price = 0.5000;
    } else {
      return null;
    }

    return {
      ticker:           'KX' + sym + '15M-ACTIVE',  // resolve to live ticker at fire time
      client_order_id:  null,                        // injected by executor (uuid)
      side:             side,
      count:            count.toFixed(2),
      price:            price.toFixed(4),
      time_in_force:    'immediate_or_cancel',
      _meta: {
        asset:    sym,
        action:   decision.action,
        oeqV2:    v2 ? v2.oeqV2 : null,
        pPct:     v2 ? v2.pPct  : null,
        fAnomaly: v2 ? v2.fAnomaly : null,
        ts:       Date.now(),
      },
    };
  }

  function reinitLambdas(historyMap) {
    // historyMap: optional { BTC: candles[], ETH: candles[], ... } where each
    // candle has either { close } or { c }. When omitted, the engine reads
    // closes from any locally available candle cache.
    ASSETS.forEach(function (sym) {
      var closes = null;
      if (historyMap && historyMap[sym]) {
        closes = extractCloses(historyMap[sym], 200);
      } else if (root && root._predictionsCache && root._predictionsCache[sym]) {
        closes = extractCloses(root._predictionsCache[sym].candles15m, 200);
      }
      var lambda = closes && closes.length >= 5 ? computeLambdaFromCloses(closes) : null;
      _lambdas[sym] = lambda != null ? lambda : (DEFAULT_LAMBDA[sym] || 1.0);
    });
    return Object.assign({}, _lambdas);
  }

  function _ensurePosition(sym) {
    if (!_positions[sym]) {
      _positions[sym] = { side: null, entryPrice: null, entryOEQ: null, entryTs: null, peakAbsOEQ: 0 };
    }
    return _positions[sym];
  }

  function _computeOrbitals(closes, lambda) {
    if (!closes.length) return null;

    var lastClose = closes[closes.length - 1];
    var prevClose = closes.length > 1 ? closes[closes.length - 2] : lastClose;
    var sRet = prevClose > 0 ? (lastClose / prevClose - 1) : 0;
    var s = sRet * 100 * lambda;

    var window = closes.slice(-WINDOW_SIZE);
    var sma = 0;
    for (var i = 0; i < window.length; i++) sma += window[i];
    sma /= Math.max(1, window.length);
    var pRaw = sma > 0 ? (lastClose - sma) / sma : 0;
    var p = pRaw * 100 * lambda;

    var rets = returnsFromCloses(window);
    var dRaw = rets.length ? stdev(rets) : 0;
    var d = dRaw * 100 * lambda * 0.75;

    var f = 0;
    if (closes.length >= 3) {
      var r1 = closes[closes.length - 1] / closes[closes.length - 2] - 1;
      var r0 = closes[closes.length - 2] / closes[closes.length - 3] - 1;
      f = (r1 - r0) * 100 * lambda * 0.6;
    }

    s = clamp(s, -10, 10);
    p = clamp(p, -10, 10);
    d = clamp(d, 0, 10);
    f = clamp(f, -10, 10);

    var oeq = (OEQ_WEIGHTS.s * s) + (OEQ_WEIGHTS.p * p) + (OEQ_WEIGHTS.d * d) + (OEQ_WEIGHTS.f * f);

    return {
      s: parseFloat(s.toFixed(4)),
      p: parseFloat(p.toFixed(4)),
      d: parseFloat(d.toFixed(4)),
      f: parseFloat(f.toFixed(4)),
      oeq: parseFloat(oeq.toFixed(4)),
      pDelta: parseFloat(p.toFixed(4)),
      lastClose: lastClose,
    };
  }

  function _decideAction(orbitals, position) {
    var absOEQ = Math.abs(orbitals.oeq);

    // Position open: evaluate hybrid exits
    if (position.side !== null) {
      var trailingDrop = position.peakAbsOEQ - (orbitals.d * EXIT_D_TRAILING_MULT);
      var trailingHit = absOEQ < Math.max(0, trailingDrop);
      var groundState = Math.abs(orbitals.s) < EXIT_S_GROUND_STATE;
      if (trailingHit || groundState) {
        return {
          action: 'EXECUTE_EXIT',
          state: trailingHit ? 'd-trailing-stop' : 's-ground-state',
          reason: trailingHit ? 'd-orbital trailing stop' : 's-orbital decay to ground state',
        };
      }
      return { action: 'WAIT', state: 'in-position', reason: 'no exit signal' };
    }

    // No position: entry only when |OEQ| exceeds threshold
    if (absOEQ >= ENTRY_OEQ) {
      var stateLabel = Math.abs(orbitals.f) > Math.abs(orbitals.s) ? 'f-anomaly' : 'p-excursion';
      return {
        action: 'EXECUTE_COUNTER_TRADE',
        state: stateLabel,
        reason: 'OEQ ' + orbitals.oeq.toFixed(2) + ' above entry threshold ' + ENTRY_OEQ.toFixed(2),
      };
    }

    return { action: 'HOLD', state: 'quiescent', reason: 'OEQ ' + orbitals.oeq.toFixed(2) + ' below entry threshold' };
  }

  function _fadeDirection(pDelta) {
    if (pDelta > 0) return 'fade-up';
    if (pDelta < 0) return 'fade-down';
    return 'neutral';
  }

  function _updatePosition(position, decision, orbitals) {
    if (decision.action === 'EXECUTE_COUNTER_TRADE' && position.side === null) {
      position.side = orbitals.pDelta > 0 ? 'short' : 'long';
      position.entryPrice = orbitals.lastClose;
      position.entryOEQ = orbitals.oeq;
      position.entryTs = Date.now();
      position.peakAbsOEQ = Math.abs(orbitals.oeq);
      position.peakPrice = orbitals.lastClose;
    } else if (decision.action === 'EXECUTE_EXIT') {
      position.side = null;
      position.entryPrice = null;
      position.entryOEQ = null;
      position.entryTs = null;
      position.peakAbsOEQ = 0;
      position.peakPrice = null;
    } else if (position.side !== null) {
      position.peakAbsOEQ = Math.max(position.peakAbsOEQ, Math.abs(orbitals.oeq));
      // Track peak price for price-level d-orbital trailing stop.
      if (position.side === 'long' && orbitals.lastClose > (position.peakPrice || 0)) {
        position.peakPrice = orbitals.lastClose;
      } else if (position.side === 'short' && (position.peakPrice === null || orbitals.lastClose < position.peakPrice)) {
        position.peakPrice = orbitals.lastClose;
      }
    }
  }

  function processInterval(sym, candles15m) {
    if (!sym || ASSETS.indexOf(sym) === -1) return null;
    var closes = extractCloses(candles15m, 60);
    if (closes.length < 3) return null;

    var lambda = _lambdas[sym] || DEFAULT_LAMBDA[sym] || 1.0;
    var orbitals = _computeOrbitals(closes, lambda);
    if (!orbitals) return null;

    // OEQ v2: volume-aware formula (cross-chain nuclear model).
    var fAnomalyVol = computeFAnomalyVol(sym, candles15m);
    var v2 = computeOEQv2(closes, lambda, fAnomalyVol);
    var qsp = buildQspState(closes, orbitals, v2);
    var effectiveOrbitals = applyQspToOrbitals(orbitals, qsp);

    var position = _ensurePosition(sym);
    var decision = _decideAction(effectiveOrbitals, position);
    _updatePosition(position, decision, effectiveOrbitals);

    // Kalshi V2 payload — only populated when action requires execution.
    var kalshiV2Payload = buildKalshiV2Payload(sym, decision, effectiveOrbitals, v2);

    var result = {
      asset: sym,
      lambda: parseFloat(lambda.toFixed(4)),
      s: effectiveOrbitals.s,
      p: effectiveOrbitals.p,
      d: effectiveOrbitals.d,
      f: effectiveOrbitals.f,
      oeq: effectiveOrbitals.oeq,
      pDelta: effectiveOrbitals.pDelta,
      // OEQ v2 (volume-normalized nuclear model)
      oeqV2: v2 ? v2.oeqV2 : null,
      fAnomalyVol: v2 ? v2.fAnomaly : fAnomalyVol,
      v2: v2,
      qsp: qsp,
      state: decision.state,
      action: decision.action,
      reason: decision.reason,
      fadeDirection: _fadeDirection(effectiveOrbitals.pDelta),
      // Kalshi V2 execution payload (null unless action = EXECUTE_*)
      kalshiV2Payload: kalshiV2Payload,
      position: {
        side: position.side,
        entryPrice: position.entryPrice,
        entryOEQ: position.entryOEQ,
        peakAbsOEQ: parseFloat(position.peakAbsOEQ.toFixed(4)),
        peakPrice: position.peakPrice,
      },
      ts: Date.now(),
    };
    _lastResult[sym] = result;
    return result;
  }

  function getState(sym) {
    return _lastResult[sym] || null;
  }

  function getLambda(sym) {
    return _lambdas[sym] != null ? _lambdas[sym] : null;
  }

  function isEnabled() {
    return readBoolEnv('WECRYP_ORBITAL_ENGINE_ENABLED', true);
  }

  function getDefaults() {
    return {
      assets: ASSETS.slice(),
      defaultLambda: Object.assign({}, DEFAULT_LAMBDA),
      oeqWeights: Object.assign({}, OEQ_WEIGHTS),
      entryOEQ: ENTRY_OEQ,
      exitDTrailingMult: EXIT_D_TRAILING_MULT,
      exitSGroundState: EXIT_S_GROUND_STATE,
      windowSize: WINDOW_SIZE,
      lambdaTargetSigma: LAMBDA_TARGET_SIGMA,
      lambdaBounds: [LAMBDA_FLOOR, LAMBDA_CEIL],
    };
  }

  var api = {
    ASSETS: ASSETS,
    isEnabled: isEnabled,
    processInterval: processInterval,
    reinitLambdas: reinitLambdas,
    getState: getState,
    getLambda: getLambda,
    getDefaults: getDefaults,
    buildKalshiV2Payload: buildKalshiV2Payload,
    computeOEQv2: computeOEQv2,
  };

  if (root && typeof root === 'object') {
    root.OrbitalEngine = api;
  }
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }

  if (root && typeof root === 'object' && !root.__WECRYP_ORBITAL_BOOTED__) {
    root.__WECRYP_ORBITAL_BOOTED__ = true;
    try { reinitLambdas(); } catch (_) {}
  }
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
