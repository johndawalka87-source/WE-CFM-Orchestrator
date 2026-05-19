// floating-orchestrator.js v2.0 — EV Engine
// Model-primary. Kalshi = house odds. Edge = modelProbUp vs kalshiYesPrice.
// Divergence = OPPORTUNITY. Entry price = context + risk flags, never a gate.
// Near-close trades: minimum gate is 5 seconds.
// 
// Active orchestrator symbols are resolved from window.PREDICTION_COINS at runtime.
// Any extra weights below remain dormant unless a symbol is part of the live prediction set.



(function () {
  'use strict';

  // Allocation weights (normalized; divide by sum for probability)
  // Physics-aligned to shell activation rates from ionization model
  const COIN_WEIGHTS = {
    BTC: 0.65,   // 55% → 35%  (reduce: 16% shell3 activation)
    ETH: 1.05,   // 27% → 30%  (steady: 45% shell3 activation)
    SOL: 0.45,   // 13% → 8%   (reduce: 0% shell3 activation)
    XRP: 0.70,   // 3% → 2%    (maintain: 0% shell3 activation)
    HYPE: 7.50,   // 1% → 8%    (increase: 41% shell3 activation)
    DOGE: 12.0,   // 1% → 10%   (increase: 52% shell3 activation)
    BNB: 9.99    // 0% → 10%   (new: 18% shell3 activation)
  };

  // Compute normalized weights for probability allocation
  const _weightSum = Object.values(COIN_WEIGHTS).reduce((a, b) => a + b, 0);
  const COIN_ALLOCATION = {};
  for (const [coin, weight] of Object.entries(COIN_WEIGHTS)) {
    COIN_ALLOCATION[coin] = weight / _weightSum;
  }

  const MODEL_THRESHOLD = 0.06;
  const FINAL_MODEL_CONF_MIN_TRADE = 10;
  const FINAL_MODEL_CONF_MIN_NONALIGNED_TRADE = 12;
  const MIN_SECONDS_LEFT = 5;
  const OPEN_WINDOW_GUARD_SECS = 15;
  const PREDICTION_STALE_WARN_MS = 45000;
  const MARKET_STALE_WARN_MS = 15000;
  const MAX_SECONDS_LEFT = 15 * 60 + 30;
  const EDGE_MIN_CENTS = 7;
  const EXCEPTIONAL_RECOVERY_TIMING_SCORE = 72;
  const EXCEPTIONAL_RECOVERY_EDGE_CENTS = 16;
  const EXCEPTIONAL_RECOVERY_MISPRICING = 0.14;
  const INVERSION_THRESH = 30;
  const THIN_BOOK_THRESH = 0.05;
  const TAIL_RISK_THRESH = 0.80;
  const LAST_CALL_MS = 60000;
  const MAX_KELLY = 0.25;
  const ENABLE_CROWD_FADE_OVERRIDE = true;
  const LOG_TUNED_HIGH_EDGE_RISK_CENTS = 20;
  const LOG_TUNED_DIVERGENT_YES_RISK_MIN = 0.55;
  const LOG_TUNED_DIVERGENT_YES_RISK_MAX = 0.70;
  function readRuntimeKnob(key, fallback) {
    var val = null;
    try {
      if (typeof window !== 'undefined' && window.__WECRYP_ORCH_CONFIG && window.__WECRYP_ORCH_CONFIG[key] != null) {
        val = window.__WECRYP_ORCH_CONFIG[key];
      }
    } catch (_) {}
    try {
      if (val == null && typeof process !== 'undefined' && process.env && process.env[key] != null) {
        val = process.env[key];
      }
    } catch (_) {}
    return val == null ? fallback : val;
  }
  function readNumberKnob(key, fallback, min, max) {
    var raw = readRuntimeKnob(key, fallback);
    var num = Number(raw);
    if (!Number.isFinite(num)) num = Number(fallback);
    if (Number.isFinite(min)) num = Math.max(min, num);
    if (Number.isFinite(max)) num = Math.min(max, num);
    return num;
  }
  function readBoolKnob(key, fallback) {
    var raw = readRuntimeKnob(key, fallback);
    if (typeof raw === 'boolean') return raw;
    var txt = String(raw).trim().toLowerCase();
    if (txt === '1' || txt === 'true' || txt === 'yes' || txt === 'on') return true;
    if (txt === '0' || txt === 'false' || txt === 'no' || txt === 'off') return false;
    return !!fallback;
  }
  const WAIT_GUARD_TIMING_SCORE_BASE = readNumberKnob('WECRYP_WAIT_GUARD_TIMING_SCORE_BASE', 68, 45, 95);
  const WAIT_GUARD_BTC_ETH_RELAX = readNumberKnob('WECRYP_WAIT_GUARD_BTC_ETH_RELAX', 4, 0, 12);
  const WAIT_GUARD_REGIME_TREND_RELAX = readNumberKnob('WECRYP_WAIT_GUARD_REGIME_TREND_RELAX', 3, 0, 10);
  const WAIT_GUARD_REGIME_VOLATILE_PENALTY = readNumberKnob('WECRYP_WAIT_GUARD_REGIME_VOLATILE_PENALTY', 4, 0, 12);
  const WAIT_GUARD_MCTS_RELAX_MAX = readNumberKnob('WECRYP_WAIT_GUARD_MCTS_RELAX_MAX', 4, 0, 12);
  const WAIT_GUARD_OPEN_BYPASS_ENABLED = readBoolKnob('WECRYP_WAIT_GUARD_OPEN_BYPASS_ENABLED', true);
  const WAIT_GUARD_OPEN_BYPASS_MIN_CONF = readNumberKnob('WECRYP_WAIT_GUARD_OPEN_BYPASS_MIN_CONF', 14, 0, 99);
  const WAIT_GUARD_OPEN_BYPASS_MIN_EDGE = readNumberKnob('WECRYP_WAIT_GUARD_OPEN_BYPASS_MIN_EDGE', 14, 0, 50);
  const WAIT_GUARD_OPEN_BYPASS_MIN_MISPRICING = readNumberKnob('WECRYP_WAIT_GUARD_OPEN_BYPASS_MIN_MISPRICING', 0.14, 0.02, 0.5);
  const MCTS_ENABLED = readBoolKnob('WECRYP_MCTS_ENABLED', true);
  const MCTS_SIMULATIONS = Math.round(readNumberKnob('WECRYP_MCTS_SIMULATIONS', 96, 16, 400));
  const MCTS_DEPTH = Math.round(readNumberKnob('WECRYP_MCTS_DEPTH', 6, 2, 16));
  const MCTS_EXPLORATION = readNumberKnob('WECRYP_MCTS_EXPLORATION', 1.15, 0.1, 4.0);
  const MCTS_CONFIDENCE_MOD_MAX = readNumberKnob('WECRYP_MCTS_CONFIDENCE_MOD_MAX', 10, 0, 20);
  const MCTS_DIRECTION_OVERRIDE_MIN_GAP = readNumberKnob('WECRYP_MCTS_DIRECTION_OVERRIDE_MIN_GAP', 0.14, 0.01, 0.5);
  const LIVE_CALIBRATION_EVENT_WINDOW = Math.round(readNumberKnob('WECRYP_LIVE_CALIBRATION_EVENT_WINDOW', 120, 20, 500));

  // Signal stability — prevents flipping in final minutes
  // Reduce lock hold time to avoid entering on stale signals; locks will also
  // be invalidated when a fresher model prediction appears for the same sym.
  const LOCK_MS = 20000;   // hold a trade signal for 20s on same contract
  const CROWD_FADE_NEUTRAL_BAND = 0.03; // treat 47/53 as neutral to avoid noisy fades
  const CROWD_FADE_BASE_MIN_SECS = 180;  // base sweet spot, then adapt live
  const CROWD_FADE_BASE_MAX_SECS = 420;
  const CROWD_FADE_HARD_MIN_SECS = 75;   // allow fast-track fades late only when tape is clean
  const CROWD_FADE_HARD_MAX_SECS = 540;  // allow early fades when edge is unusually strong
  const CROWD_FADE_CONFIRM_MIN_MS = 7000;
  const CROWD_FADE_CONFIRM_MAX_MS = 45000;
  const CROWD_FADE_MIN_EDGE_CENTS = 14; // stronger edge required than normal trade
  const CROWD_FADE_MIN_MISPRICE = 0.16; // dynamic floor starts at 16pp
  const CROWD_FADE_MAX_MISPRICE = 0.22; // and rises to 22pp when earlier
  const CROWD_FADE_MIN_MODEL_CONF = 0.12; // require model to be at least 62/38
  const CROWD_FADE_MIN_LIQUIDITY = 1500; // gate out very thin markets
  const STATE_PRUNE_MS = 120000;

  // Sweet spot entry window — best payout + not too close to close
  const SWEET_MIN_SECS = 180;     // 3 min left
  const SWEET_MAX_SECS = 360;     // 6 min left
  const SWEET_PAYOUT_MIN = 1.65;    // payout >= 1.65x (entry price <= ~0.61)
  const CLOSE_VALUE_MIN_SECS = 75;
  const CLOSE_VALUE_MAX_SECS = 210;
  const CLOSE_VALUE_CORE_MIN_SECS = 120;
  const CLOSE_VALUE_CORE_MAX_SECS = 180;
  const CLOSE_VALUE_EDGE_CENTS = 10;
  const CLOSE_VALUE_STRONG_EDGE_CENTS = 14;
  const CLOSE_VALUE_MIN_MISPRICE = 0.12;
  const CLOSE_VALUE_PAYOUT_MIN = 1.75;
  const SCALP_MIN_SECS = 420;
  const SCALP_MAX_SECS = 840;
  const SCALP_EDGE_CENTS = 6;
  const FINAL_SNIPE_MIN_SECS = 45;
  const FINAL_SNIPE_MAX_SECS = 90;

  // _locks[sym+closeTimeMs] = { direction, side, ts, closeTimeMs }
  var _locks = {};
  // _fadeCandidates[sym+closeTimeMs] = {
  //   direction, side, firstTs, lastTs, qualifiedSinceTs, lastQualifiedTs
  // }
  var _fadeCandidates = {};

  function crowdFadeDir(kalshiYesPrice, dirs, modelDir) {
    if (!Number.isFinite(kalshiYesPrice)) return null;
    if (!dirs || !modelDir) return null;

    // Crowd-fade is blockchain-led: follow model direction only when crowd pricing disagrees.
    var kalshiDir = null;
    if (kalshiYesPrice >= (0.5 + CROWD_FADE_NEUTRAL_BAND)) kalshiDir = dirs.yesDir;
    else if (kalshiYesPrice <= (0.5 - CROWD_FADE_NEUTRAL_BAND)) kalshiDir = dirs.noDir;
    if (!kalshiDir || kalshiDir === modelDir) return null;
    return modelDir;
  }

  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
  function hash32(text) {
    var h = 2166136261 >>> 0;
    var t = String(text || '');
    for (var i = 0; i < t.length; i += 1) {
      h ^= t.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }
  function seededRng(seed) {
    var s = (seed >>> 0) || 0x9e3779b9;
    return function () {
      s = (s + 0x6d2b79f5) >>> 0;
      var t = Math.imul(s ^ (s >>> 15), 1 | s);
      t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function confidence01(v) {
    if (!Number.isFinite(v)) return 0;
    if (v <= 1.01) return clamp(v, 0, 1);
    return clamp(v / 100, 0, 1);
  }
  function directionSign(dir) {
    if (dir === 'UP') return 1;
    if (dir === 'DOWN') return -1;
    return 0;
  }
  function extractRegimeTag(pred, cfm) {
    var diagRegime = pred && pred.diagnostics && pred.diagnostics.regime;
    var regimeState = diagRegime && (diagRegime.regime_state || diagRegime.state);
    if (regimeState) return String(regimeState);
    var liveRegime = pred && pred.liveRegime && (pred.liveRegime.regime || pred.liveRegime.state);
    if (liveRegime) return String(liveRegime);
    return crowdFadeRegime(pred, cfm);
  }
  function normalizeRegimeTag(regimeTag) {
    var r = String(regimeTag || '').toLowerCase();
    if (r.indexOf('trend') !== -1) return 'trending';
    if (r.indexOf('mean') !== -1 || r.indexOf('range') !== -1 || r.indexOf('reversion') !== -1) return 'range';
    if (r.indexOf('vol') !== -1) return 'volatile';
    if (r.indexOf('chop') !== -1 || r.indexOf('noise') !== -1) return 'chop';
    return r || 'mixed';
  }
  function buildMctsState(sym, pred, cfm, context) {
    if (!MCTS_ENABLED) return null;
    if (!pred || !Number.isFinite(context && context.modelProbUp)) return null;
    var momentum = cfm && Number.isFinite(cfm.momentum) ? cfm.momentum : 0;
    var trendDir = cfm && cfm.trend === 'rising' ? 1 : cfm && cfm.trend === 'falling' ? -1 : 0;
    var atrPct = pred && pred.volatility && Number.isFinite(pred.volatility.atrPct) ? pred.volatility.atrPct : null;
    var volatilityNorm = atrPct == null ? 0.25 : clamp(atrPct / 4.0, 0, 1.2);
    var liquidity = Number.isFinite(context && context.liquidity) ? context.liquidity : 1200;
    return {
      sym: sym,
      confidence: confidence01(context && context.calibratedConfidence),
      modelProbUp: clamp(context.modelProbUp, 0.02, 0.98),
      modelStrength: clamp(Math.abs(context.modelScore || 0), 0, 1),
      momentum: clamp(momentum, -1, 1),
      trendDir: trendDir,
      volatility: clamp(volatilityNorm, 0, 1.5),
      mispricing: Number.isFinite(context && context.mispricing) ? clamp(context.mispricing, 0, 0.5) : 0,
      secsLeft: Number.isFinite(context && context.secsLeft) ? context.secsLeft : null,
      liquidity: clamp(liquidity, 50, 200000),
      regime: normalizeRegimeTag(context && context.regimeTag),
      direction: context && context.currentDirection ? context.currentDirection : null,
      side: context && context.currentSide ? context.currentSide : null,
    };
  }
  function rolloutRewardForAction(state, action, rng, depth) {
    var bias = ((state.modelProbUp - 0.5) * 1.9) + (state.momentum * 0.5) + (state.trendDir * 0.3);
    var path = 0;
    var steps = Math.max(2, depth);
    for (var i = 0; i < steps; i += 1) {
      var shockScale = 0.12 + (state.volatility * 0.22) + (state.regime === 'chop' ? 0.08 : 0);
      if (state.regime === 'volatile') shockScale += 0.05;
      var shock = (rng() - 0.5) * 2 * shockScale;
      path += (bias * 0.38) + shock;
    }
    var dirEdge = path / Math.max(1, steps);
    var lateRisk = state.secsLeft != null ? clamp((90 - state.secsLeft) / 90, 0, 1) : 0.4;
    var slippage = clamp((state.volatility * 0.4) + (state.liquidity < 1400 ? 0.25 : 0), 0, 1.3);
    if (action === 'WAIT') {
      var waitSafety = (0.35 * lateRisk) + (0.22 * slippage) + (state.regime === 'volatile' ? 0.18 : 0);
      var waitOpportunityCost = Math.abs(dirEdge) * (0.45 + (state.confidence * 0.55));
      return clamp(waitSafety - waitOpportunityCost, -1.5, 1.5);
    }
    var sign = action === 'UP' ? 1 : -1;
    var directionalFit = sign * dirEdge;
    var confidenceBoost = state.confidence * (0.30 + state.modelStrength * 0.20);
    var mispricingBoost = state.mispricing * 1.3;
    var wrongWayPenalty = (sign === 1 ? (0.5 - state.modelProbUp) : (state.modelProbUp - 0.5));
    var regimePenalty = (state.regime === 'volatile' ? 0.14 : (state.regime === 'chop' ? 0.07 : 0));
    var riskPenalty = (lateRisk * 0.28) + (slippage * 0.20) + regimePenalty + Math.max(0, wrongWayPenalty);
    return clamp((directionalFit * 1.2) + confidenceBoost + mispricingBoost - riskPenalty, -1.5, 1.5);
  }
  function runVanillaMcts(state, cfg) {
    if (!state) {
      return { ran: false, reason: 'missing-state' };
    }
    var sims = Math.max(8, Number(cfg && cfg.simulations) || MCTS_SIMULATIONS);
    var depth = Math.max(2, Number(cfg && cfg.depth) || MCTS_DEPTH);
    var c = Number.isFinite(Number(cfg && cfg.exploration)) ? Number(cfg.exploration) : MCTS_EXPLORATION;
    var seed = hash32([
      state.sym,
      state.modelProbUp.toFixed(5),
      state.confidence.toFixed(4),
      state.momentum.toFixed(4),
      state.volatility.toFixed(4),
      state.mispricing.toFixed(4),
      state.secsLeft == null ? 'na' : String(Math.round(state.secsLeft)),
      state.regime
    ].join('|'));
    var rng = seededRng(seed);
    var children = {
      UP: { action: 'UP', visits: 0, total: 0 },
      DOWN: { action: 'DOWN', visits: 0, total: 0 },
      WAIT: { action: 'WAIT', visits: 0, total: 0 },
    };
    var totalVisits = 0;
    var actions = ['UP', 'DOWN', 'WAIT'];
    for (var i = 0; i < sims; i += 1) {
      var picked = null;
      var bestUcb = -Infinity;
      for (var j = 0; j < actions.length; j += 1) {
        var child = children[actions[j]];
        var ucb = child.visits === 0
          ? Infinity
          : (child.total / child.visits) + c * Math.sqrt(Math.log(totalVisits + 1) / child.visits);
        if (ucb > bestUcb) {
          bestUcb = ucb;
          picked = child;
        }
      }
      var reward = rolloutRewardForAction(state, picked.action, rng, depth);
      picked.visits += 1;
      picked.total += reward;
      totalVisits += 1;
    }
    function avg(action) {
      var node = children[action];
      return node.visits > 0 ? (node.total / node.visits) : 0;
    }
    var upScore = avg('UP');
    var downScore = avg('DOWN');
    var waitScore = avg('WAIT');
    var ordered = [
      { action: 'UP', score: upScore },
      { action: 'DOWN', score: downScore },
      { action: 'WAIT', score: waitScore },
    ].sort(function (a, b) { return b.score - a.score; });
    var best = ordered[0];
    var second = ordered[1];
    var directionalGap = upScore - downScore;
    var voteStrength = Math.abs(best.score - second.score);
    return {
      ran: true,
      seed: seed,
      simulations: sims,
      depth: depth,
      exploration: c,
      voteAction: best.action,\n      const pred = { market_id: (typeof marketId !== 'undefined' ? marketId : (typeof ticker !== 'undefined' ? ticker : null)), coin: (typeof coinSymbol !== 'undefined' ? coinSymbol : (typeof symbol !== 'undefined' ? symbol : 'UNKNOWN')), timestamp: (new Date()).toISOString(), voteAction: best.action, voteStrength: parseFloat((Math.abs(best.score - (second?.score || 0))).toFixed(4)), sessionId: (window.SESSION_ID || null) }; persistPrediction(pred),





