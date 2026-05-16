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
  const FINAL_MODEL_CONF_MIN_NONALIGNED_TRADE = 14;
  const MIN_SECONDS_LEFT = 5;
  const MAX_SECONDS_LEFT = 15 * 60 + 30;
  const EDGE_MIN_CENTS = 8;
  const INVERSION_THRESH = 30;
  const THIN_BOOK_THRESH = 0.05;
  const TAIL_RISK_THRESH = 0.80;
  const LAST_CALL_MS = 60000;
  const MAX_KELLY = 0.25;
  const ENABLE_CROWD_FADE_OVERRIDE = true;
  const LOG_TUNED_HIGH_EDGE_RISK_CENTS = 20;
  const LOG_TUNED_DIVERGENT_YES_RISK_MIN = 0.55;
  const LOG_TUNED_DIVERGENT_YES_RISK_MAX = 0.70;

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
  const FINAL_SNIPE_MAX_SECS = 75;

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

  function formatCrowdFadeWindowSecs(secs) {
    if (!Number.isFinite(secs)) return '?';
    if (secs >= 120) return (secs / 60).toFixed(secs % 60 === 0 ? 0 : 1) + 'm';
    return Math.round(secs) + 's';
  }

  function crowdFadeRegime(pred, cfm) {
    var ind = pred && pred.indicators ? pred.indicators : {};
    var adx = ind.adx && Number.isFinite(ind.adx.adx) ? ind.adx.adx : null;
    var atr = pred && pred.volatility && Number.isFinite(pred.volatility.atrPct)
      ? pred.volatility.atrPct : null;
    var momentum = cfm && Number.isFinite(cfm.momentum) ? Math.abs(cfm.momentum) : 0;
    if ((atr != null && atr >= 3.0) || (cfm && Number.isFinite(cfm.bidAsk) && cfm.bidAsk >= 0.35)) {
      return 'volatile';
    }
    if ((adx != null && adx >= 28) || momentum >= 0.18) return 'trending';
    if ((adx != null && adx <= 18) && (atr == null || atr <= 1.2)) return 'range';
    return 'mixed';
  }

  function crowdFadeFlowScore(modelDir, pred, cfm) {
    var ind = pred && pred.indicators ? pred.indicators : {};
    var isUp = modelDir === 'UP';
    var score = 0;
    var momentum = cfm && Number.isFinite(cfm.momentum) ? cfm.momentum : 0;
    var trend = cfm && cfm.trend ? cfm.trend : null;
    var bookImbalance = ind.book && Number.isFinite(ind.book.imbalance) ? ind.book.imbalance : null;
    var buyRatio = ind.flow && Number.isFinite(ind.flow.buyRatio) ? ind.flow.buyRatio : null;
    var volRatio = ind.volume && Number.isFinite(ind.volume.ratio) ? ind.volume.ratio : null;

    if ((isUp && momentum > 0.04) || (!isUp && momentum < -0.04)) score += 1;
    else if ((isUp && momentum < -0.04) || (!isUp && momentum > 0.04)) score -= 1;

    if ((isUp && trend === 'rising') || (!isUp && trend === 'falling')) score += 1;
    else if ((isUp && trend === 'falling') || (!isUp && trend === 'rising')) score -= 1;

    if (bookImbalance != null) {
      if ((isUp && bookImbalance >= 0.10) || (!isUp && bookImbalance <= -0.10)) score += 1;
      else if ((isUp && bookImbalance <= -0.12) || (!isUp && bookImbalance >= 0.12)) score -= 1;
    }

    if (buyRatio != null) {
      if ((isUp && buyRatio >= 55) || (!isUp && buyRatio <= 45)) score += 1;
      else if ((isUp && buyRatio <= 43) || (!isUp && buyRatio >= 57)) score -= 1;
    }

    if (volRatio != null) {
      if (volRatio >= 1.08) score += 1;
      else if (volRatio <= 0.88) score -= 1;
    }

    return clamp(score, -2, 5);
  }

  function crowdFadeToxicity(pred, cfm, liquidity, flowScore) {
    var toxicity = 0;
    var atr = pred && pred.volatility && Number.isFinite(pred.volatility.atrPct)
      ? pred.volatility.atrPct : null;
    if (Number.isFinite(liquidity) && liquidity > 0 && liquidity < CROWD_FADE_MIN_LIQUIDITY) toxicity += 1;
    if (cfm && Number.isFinite(cfm.bidAsk) && cfm.bidAsk >= 0.35) toxicity += 1;
    if (cfm && Number.isFinite(cfm.spread) && cfm.spread >= 0.75) toxicity += 1;
    if (atr != null && atr >= 3.5) toxicity += 1;
    if (flowScore < 1) toxicity += 1;
    return toxicity;
  }

  function buildCrowdFadeTimingProfile(params) {
    var secsLeft = params.secsLeft;
    var mispricing = params.mispricing;
    var edgeCents = params.edgeCents;
    var modelConfidence = params.modelConfidence;
    var liquidity = params.liquidity;
    var pred = params.pred;
    var cfm = params.cfm;
    var modelDir = params.modelDir;

    var regime = crowdFadeRegime(pred, cfm);
    var flowScore = crowdFadeFlowScore(modelDir, pred, cfm);
    var toxicity = crowdFadeToxicity(pred, cfm, liquidity, flowScore);
    var activeMinSecs = CROWD_FADE_BASE_MIN_SECS;
    var activeMaxSecs = CROWD_FADE_BASE_MAX_SECS;
    var timingLabel = 'adaptive';

    if (regime === 'trending' && flowScore >= 3 && mispricing >= 0.20 && edgeCents >= 18) {
      activeMinSecs = CROWD_FADE_HARD_MIN_SECS;
      activeMaxSecs = CROWD_FADE_HARD_MAX_SECS;
      timingLabel = 'fast-track';
    } else if (regime === 'trending' && flowScore >= 2) {
      activeMinSecs = 105;
      activeMaxSecs = 510;
      timingLabel = 'trend-led';
    } else if (regime === 'range') {
      activeMinSecs = 165;
      activeMaxSecs = 420;
      timingLabel = 'range-confirm';
    } else if (regime === 'volatile' || toxicity >= 3) {
      activeMinSecs = 150;
      activeMaxSecs = 330;
      timingLabel = 'volatility-caution';
    } else {
      activeMinSecs = 135;
      activeMaxSecs = 480;
    }

    if (flowScore >= 4 && mispricing >= 0.24 && edgeCents >= 20) timingLabel = 'fast-track';

    activeMinSecs = clamp(activeMinSecs, CROWD_FADE_HARD_MIN_SECS, CROWD_FADE_HARD_MAX_SECS);
    activeMaxSecs = clamp(activeMaxSecs, activeMinSecs + 30, CROWD_FADE_HARD_MAX_SECS);

    var span = Math.max(1, activeMaxSecs - activeMinSecs);
    var t = Number.isFinite(secsLeft) ? clamp((secsLeft - activeMinSecs) / span, 0, 1) : 1;

    var confirmMs = 12000 + t * 18000;
    confirmMs += toxicity * 5000;
    confirmMs -= Math.max(0, flowScore - 1) * 2500;
    if (mispricing >= 0.24) confirmMs -= 3000;
    else if (mispricing >= 0.20) confirmMs -= 1500;
    if (edgeCents >= 20) confirmMs -= 1000;
    if (modelConfidence >= 0.20) confirmMs -= 1000;
    confirmMs = Math.round(clamp(confirmMs, CROWD_FADE_CONFIRM_MIN_MS, CROWD_FADE_CONFIRM_MAX_MS));

    var minMispricing = CROWD_FADE_MIN_MISPRICE + t * (CROWD_FADE_MAX_MISPRICE - CROWD_FADE_MIN_MISPRICE);
    if (regime === 'trending') minMispricing -= 0.01;
    if (regime === 'range') minMispricing += 0.01;
    minMispricing += toxicity * 0.01;
    if (flowScore >= 3) minMispricing -= 0.02;
    minMispricing = clamp(minMispricing, 0.12, 0.28);

    var minEdgeCents = CROWD_FADE_MIN_EDGE_CENTS + Math.max(0, toxicity - 1) * 2;
    if (flowScore >= 3) minEdgeCents -= 2;
    if (regime === 'range') minEdgeCents += 1;
    minEdgeCents = Math.round(clamp(minEdgeCents, 10, 24));

    var minModelConfidence = CROWD_FADE_MIN_MODEL_CONF + Math.max(0, toxicity - 1) * 0.015;
    if (flowScore >= 3) minModelConfidence -= 0.02;
    if (regime === 'volatile') minModelConfidence += 0.02;
    minModelConfidence = clamp(minModelConfidence, 0.10, 0.22);

    var minLiquidity = CROWD_FADE_MIN_LIQUIDITY;
    if (regime === 'volatile') minLiquidity += 500;
    if (flowScore >= 3) minLiquidity = Math.max(1000, minLiquidity - 250);

    var lateSideGraceSecs = 20;
    var earlySideGraceSecs = 25;
    if (flowScore >= 2) {
      lateSideGraceSecs += 10;
      earlySideGraceSecs += 15;
    }
    if (flowScore >= 4) {
      lateSideGraceSecs += 10;
      earlySideGraceSecs += 15;
    }
    if (regime === 'trending') {
      lateSideGraceSecs += 15;
      earlySideGraceSecs += 20;
    } else if (regime === 'range') {
      lateSideGraceSecs += 5;
      earlySideGraceSecs += 10;
    } else if (regime === 'volatile') {
      lateSideGraceSecs -= 5;
      earlySideGraceSecs -= 5;
    }
    if (mispricing >= 0.22) {
      lateSideGraceSecs += 10;
      earlySideGraceSecs += 10;
    }
    if (edgeCents >= 20) {
      lateSideGraceSecs += 5;
      earlySideGraceSecs += 10;
    }
    lateSideGraceSecs = Math.round(clamp(lateSideGraceSecs - toxicity * 4, 8, 75));
    earlySideGraceSecs = Math.round(clamp(earlySideGraceSecs - Math.max(0, toxicity - 1) * 6, 12, 120));

    var softResetMs = 4500 + Math.max(0, flowScore) * 1500;
    if (regime === 'trending') softResetMs += 1500;
    if (regime === 'volatile') softResetMs -= 1000;
    if (mispricing >= 0.22) softResetMs += 1000;
    softResetMs -= Math.max(0, toxicity - 1) * 1000;
    softResetMs = Math.round(clamp(softResetMs, 3500, 12000));

    var graceMinSecs = clamp(activeMinSecs - lateSideGraceSecs, MIN_SECONDS_LEFT, activeMaxSecs);
    var graceMaxSecs = clamp(
      activeMaxSecs + earlySideGraceSecs,
      Math.max(activeMaxSecs, graceMinSecs + 30),
      MAX_SECONDS_LEFT
    );

    return {
      regime: regime,
      flowScore: flowScore,
      toxicity: toxicity,
      activeMinSecs: activeMinSecs,
      activeMaxSecs: activeMaxSecs,
      confirmMs: confirmMs,
      minMispricing: minMispricing,
      minEdgeCents: minEdgeCents,
      minModelConfidence: minModelConfidence,
      minLiquidity: minLiquidity,
      lateSideGraceSecs: lateSideGraceSecs,
      earlySideGraceSecs: earlySideGraceSecs,
      graceMinSecs: graceMinSecs,
      graceMaxSecs: graceMaxSecs,
      softResetMs: softResetMs,
      timingLabel: timingLabel,
      coreWindowLabel: formatCrowdFadeWindowSecs(activeMinSecs) + '→' + formatCrowdFadeWindowSecs(activeMaxSecs),
      windowLabel: formatCrowdFadeWindowSecs(graceMinSecs) + '→' + formatCrowdFadeWindowSecs(graceMaxSecs),
    };
  }

  function directionSign(direction) {
    return direction === 'UP' ? 1 : direction === 'DOWN' ? -1 : 0;
  }

  function scalpSetupScore(direction, pred) {
    var setups = Array.isArray(pred && pred.scalpSetups) ? pred.scalpSetups : [];
    if (!setups.length || !direction) return 0;
    var sign = directionSign(direction);
    return setups.reduce(function (score, setup) {
      if (!setup || setup.type === 'avoid') return score - 1;
      var dir = setup.direction === 'up' ? 1 : setup.direction === 'down' ? -1 : 0;
      var strength = setup.strength === 'high' ? 2 : setup.strength === 'medium' ? 1 : 0;
      if (setup.type === 'scalp_window' && strength) return score + 1;
      if (!dir || !sign) return score;
      return score + (dir === sign ? strength : -strength);
    }, 0);
  }

  function buildAdaptiveTimingRegime(params) {
    var sym = params.sym;
    var secsLeft = params.secsLeft;
    var entry = params.entry;
    var pred = params.pred || null;
    var cfm = params.cfm || null;
    var direction = params.direction;
    var modelActive = !!params.modelActive;
    var modelYesProb = params.modelYesProb;
    var kalshiYesPrice = params.kalshiYesPrice;
    var liquidity = params.liquidity;
    var finalConfidenceWeak = !!params.finalConfidenceWeak;
    var logTunedDowngradeReason = params.logTunedDowngradeReason || null;
    var reasons = [];
    var blocks = [];
    var phase = 'UNTIMED';

    if (Number.isFinite(secsLeft)) {
      if (secsLeft < FINAL_SNIPE_MIN_SECS) phase = 'SETTLING';
      else if (secsLeft < FINAL_SNIPE_MAX_SECS) phase = 'FINAL_SNIPE';
      else if (secsLeft <= CLOSE_VALUE_MAX_SECS) phase = 'CLOSE_VALUE';
      else if (secsLeft <= 420) phase = 'PRIME';
      else if (secsLeft <= SCALP_MAX_SECS) phase = 'SCALP_EARLY';
      else phase = 'SETUP';
    }

    var edgeCents = entry && Number.isFinite(entry.edgeCents) ? entry.edgeCents : 0;
    var payout = entry && Number.isFinite(entry.payoutMult) ? entry.payoutMult : 0;
    var entryPrice = entry && Number.isFinite(entry.entryPrice) ? entry.entryPrice : null;
    var modelConfidence = Number.isFinite(modelYesProb) ? Math.abs(modelYesProb - 0.5) : 0;
    var mispricing = Number.isFinite(modelYesProb) && Number.isFinite(kalshiYesPrice)
      ? Math.abs(modelYesProb - kalshiYesPrice)
      : 0;
    var adaptiveTiming = null;
    try {
      if (typeof window !== 'undefined' && window._adaptiveTuner?.getAdaptiveTimingThresholds) {
        adaptiveTiming = window._adaptiveTuner.getAdaptiveTimingThresholds(sym, {
          closeEdgeCents: CLOSE_VALUE_EDGE_CENTS,
          closeStrongEdgeCents: CLOSE_VALUE_STRONG_EDGE_CENTS,
          closeMinMisprice: CLOSE_VALUE_MIN_MISPRICE,
          closePayoutMin: CLOSE_VALUE_PAYOUT_MIN,
          scalpEdgeCents: SCALP_EDGE_CENTS,
        }, {
          pred: pred,
          cfm: cfm,
          secsLeft: secsLeft,
          direction: direction,
          edgeCents: edgeCents,
          modelYesProb: modelYesProb,
          kalshiYesPrice: kalshiYesPrice,
          bookImbalance: pred?.indicators?.book?.imbalance,
          buyRatio: pred?.indicators?.flow?.buyRatio,
        });
      }
    } catch (_) {}
    var closeEdgeCents = adaptiveTiming?.closeEdgeCents ?? CLOSE_VALUE_EDGE_CENTS;
    var closeStrongEdgeCents = adaptiveTiming?.closeStrongEdgeCents ?? CLOSE_VALUE_STRONG_EDGE_CENTS;
    var closeMinMisprice = adaptiveTiming?.closeMinMisprice ?? CLOSE_VALUE_MIN_MISPRICE;
    var closePayoutMin = adaptiveTiming?.closePayoutMin ?? CLOSE_VALUE_PAYOUT_MIN;
    var scalpEdgeCents = adaptiveTiming?.scalpEdgeCents ?? SCALP_EDGE_CENTS;
    var flowScore = crowdFadeFlowScore(direction, pred, cfm);
    var toxicity = crowdFadeToxicity(pred, cfm, liquidity, flowScore);
    var scalpScore = scalpSetupScore(direction, pred);
    var payoutHeavy = payout >= closePayoutMin || (entryPrice != null && entryPrice <= (1 / closePayoutMin));
    var coreCloseValueWindow = Number.isFinite(secsLeft)
      && secsLeft >= CLOSE_VALUE_CORE_MIN_SECS
      && secsLeft <= CLOSE_VALUE_CORE_MAX_SECS;
    var requiredCloseEdgeCents = coreCloseValueWindow ? closeEdgeCents : closeStrongEdgeCents;
    var closeValueFlowOk = flowScore >= 1
      || (coreCloseValueWindow && edgeCents >= closeEdgeCents + 6 && mispricing >= closeMinMisprice + 0.04)
      || (coreCloseValueWindow && edgeCents >= closeStrongEdgeCents + 4 && payoutHeavy);
    if (adaptiveTiming?.reasons?.length) {
      reasons.push('adaptive tuner: ' + adaptiveTiming.reasons.slice(0, 2).join(', '));
    }

    if (!modelActive) blocks.push('model inactive');
    if (!entry) blocks.push('no executable entry');
    if (finalConfidenceWeak) blocks.push('final model confidence weak');
    if (logTunedDowngradeReason) blocks.push(logTunedDowngradeReason);

    var closeValueQualified = phase === 'CLOSE_VALUE'
      && modelActive
      && !!entry
      && edgeCents >= requiredCloseEdgeCents
      && (mispricing >= closeMinMisprice || payoutHeavy)
      && closeValueFlowOk
      && toxicity <= 2
      && !logTunedDowngradeReason
      && (!finalConfidenceWeak || edgeCents >= closeStrongEdgeCents);

    var finalSnipeQualified = phase === 'FINAL_SNIPE'
      && modelActive
      && !!entry
      && edgeCents >= 16
      && mispricing >= 0.18
      && payout >= 2.0
      && flowScore >= 2
      && toxicity <= 1
      && !finalConfidenceWeak
      && !logTunedDowngradeReason;

    var scalpQualified = phase === 'SCALP_EARLY'
      && modelActive
      && !!entry
      && edgeCents >= scalpEdgeCents
      && modelConfidence >= 0.08
      && (flowScore >= 2 || scalpScore >= 2)
      && toxicity <= 2
      && !entry.tailRisk
      && !entry.thinBook
      && !finalConfidenceWeak
      && !logTunedDowngradeReason;

    if (phase === 'CLOSE_VALUE') {
      if (coreCloseValueWindow) reasons.push('core 2-3m value window');
      if (payoutHeavy) reasons.push('payout skew favorable');
      if (mispricing >= closeMinMisprice) reasons.push('market/model mispricing');
      if (flowScore >= 1) reasons.push('book/tape confirms');
      else if (closeValueFlowOk) reasons.push('large edge overrides neutral book');
      if (!closeValueQualified) {
        if (edgeCents < requiredCloseEdgeCents) blocks.push('close-window edge below +' + requiredCloseEdgeCents + 'c');
        if (!payoutHeavy && mispricing < closeMinMisprice) blocks.push('no payout/mispricing skew');
        if (!closeValueFlowOk) blocks.push('book/tape not confirming');
        if (toxicity > 2) blocks.push('microstructure toxicity elevated');
      }
    } else if (phase === 'SCALP_EARLY') {
      if (flowScore >= 2) reasons.push('book/tape impulse');
      if (scalpScore >= 2) reasons.push('scalp setup aligned');
      if (edgeCents >= scalpEdgeCents) reasons.push('positive scalp edge');
      if (!scalpQualified) {
        if (edgeCents < scalpEdgeCents) blocks.push('scalp edge below +' + scalpEdgeCents + 'c');
        if (flowScore < 2 && scalpScore < 2) blocks.push('no scalp impulse yet');
        if (entry && (entry.tailRisk || entry.thinBook)) blocks.push('bad scalp fill profile');
      }
    } else if (phase === 'FINAL_SNIPE') {
      if (!finalSnipeQualified) blocks.push('final snipe requires exceptional edge, payout, and clean tape');
    } else if (phase === 'SETTLING') {
      blocks.push('settlement too close for new entry');
    }

    var score = 0;
    score += clamp(edgeCents / 24, 0, 1) * 35;
    score += clamp(mispricing / 0.24, 0, 1) * 25;
    score += clamp((payout - 1) / 1.5, 0, 1) * 18;
    score += clamp((flowScore + 2) / 7, 0, 1) * 12;
    score += clamp((scalpScore + 2) / 6, 0, 1) * 10;
    score -= toxicity * 8;
    score = Math.round(clamp(score, 0, 100));

    var timingLabel = {
      SCALP_EARLY: 'SCALP FLIP',
      SETUP: 'SETUP',
      PRIME: 'PRIME',
      CLOSE_VALUE: coreCloseValueWindow ? '2-3M VALUE' : 'CLOSE VALUE',
      FINAL_SNIPE: 'FINAL SNIPE',
      SETTLING: 'SETTLING',
      UNTIMED: 'LIVE',
    }[phase] || phase;

    var exitPlan = null;
    if (phase === 'SCALP_EARLY') {
      exitPlan = 'Scalp exit: sell into the probability flip; take +8-12c or exit when book imbalance/tape mean-reverts.';
    } else if (phase === 'CLOSE_VALUE') {
      exitPlan = 'Close-value plan: hold only while edge stays mispriced; cancel/exit if live book flips or edge compresses under +6c.';
    } else if (phase === 'FINAL_SNIPE') {
      exitPlan = 'Final-snipe plan: only fill at price; no chase, no averaging, abandon on first book flip.';
    } else if (phase === 'PRIME') {
      exitPlan = 'Prime plan: enter if edge remains stable and manage before the last-minute spread widens.';
    }

    return {
      phase: phase,
      timingLabel: timingLabel,
      timingScore: score,
      promoteToTrade: closeValueQualified || finalSnipeQualified || scalpQualified,
      closeValueQualified: closeValueQualified,
      finalSnipeQualified: finalSnipeQualified,
      scalpQualified: scalpQualified,
      scalpCandidate: phase === 'SCALP_EARLY',
      closeValueCandidate: phase === 'CLOSE_VALUE',
      coreCloseValueWindow: coreCloseValueWindow,
      flowScore: flowScore,
      scalpScore: scalpScore,
      toxicity: toxicity,
      mispricing: mispricing,
      payoutHeavy: payoutHeavy,
      adaptiveTiming: adaptiveTiming,
      reasons: reasons,
      blocks: blocks.filter(Boolean),
      exitPlan: exitPlan,
    };
  }

  function pruneContractState(nowMs) {
    Object.keys(_locks).forEach(function (key) {
      var v = _locks[key];
      if (!v) { delete _locks[key]; return; }
      var expiredByClose = Number.isFinite(v.closeTimeMs) && nowMs > (v.closeTimeMs + 60000);
      var expiredByAge = Number.isFinite(v.ts) ? (nowMs - v.ts > LOCK_MS * 4) : true;
      if (expiredByClose || expiredByAge) delete _locks[key];
    });
    Object.keys(_fadeCandidates).forEach(function (key) {
      var v = _fadeCandidates[key];
      if (!v) { delete _fadeCandidates[key]; return; }
      if (!Number.isFinite(v.lastTs) || (nowMs - v.lastTs) > STATE_PRUNE_MS) delete _fadeCandidates[key];
    });
  }

  function scoreToProbUp(score) {
    return clamp(0.5 + score * 0.40, 0.02, 0.98);
  }

  function yesNoFromStrikeDir(strikeDir) {
    var yesDir = strikeDir === 'below' ? 'DOWN' : 'UP';
    return { yesDir: yesDir, noDir: yesDir === 'UP' ? 'DOWN' : 'UP' };
  }

  function computeEV(side, modelProbUp, kalshiYesPrice) {
    return side === 'YES' ? modelProbUp - kalshiYesPrice
      : kalshiYesPrice - modelProbUp;
  }

  function analyseEntry(side, modelProbUp, kalshiYesPrice) {
    var entryPrice = side === 'YES' ? kalshiYesPrice : (1 - kalshiYesPrice);
    var winProb = side === 'YES' ? modelProbUp : (1 - modelProbUp);
    var evRaw = computeEV(side, modelProbUp, kalshiYesPrice);
    var edgeCents = Math.round(evRaw * 100);
    var payoutMult = entryPrice > 0 ? parseFloat((1 / entryPrice).toFixed(2)) : null;
    var breakEven = parseFloat(entryPrice.toFixed(4));
    var netPayout = 1 - entryPrice;
    var kellyFrac = 0;
    if (evRaw > 0 && winProb > 0 && netPayout > 0)
      kellyFrac = clamp(evRaw / (winProb * netPayout), 0, MAX_KELLY);
    return {
      entryPrice: parseFloat(entryPrice.toFixed(4)),
      evRaw, edgeCents, payoutMult, breakEven,
      kellyFrac: parseFloat(kellyFrac.toFixed(4)),
      kellyPct: Math.round(kellyFrac * 100),
      isInversion: Math.abs(edgeCents) >= INVERSION_THRESH,
      thinBook: entryPrice <= THIN_BOOK_THRESH,
      tailRisk: entryPrice >= TAIL_RISK_THRESH,
      lossErasesWins: (entryPrice >= TAIL_RISK_THRESH && netPayout > 0)
        ? Math.round(entryPrice / netPayout) : null,
    };
  }

  function evaluateCrowdFade(params) {
    var sym = params.sym;
    var closeTimeMs = params.closeTimeMs;
    var kalshiYesPrice = params.kalshiYesPrice;
    var secsLeft = params.secsLeft;
    var dirs = params.dirs;
    var modelDir = params.modelDir;
    var modelYesProb = params.modelYesProb;
    var modelActive = params.modelActive;
    var entryYes = params.entryYes;
    var entryNo = params.entryNo;
    var liquidity = params.liquidity;
    var pred = params.pred || null;
    var cfm = params.cfm || null;

    var key = sym + '_' + (closeTimeMs || 'none');
    function clearCandidate() { delete _fadeCandidates[key]; }

    var fadeDir = crowdFadeDir(kalshiYesPrice, dirs, modelDir);
    if (!fadeDir || !modelActive || !Number.isFinite(modelYesProb)) {
      clearCandidate();
      return null;
    }

    var fadeSide = fadeDir === dirs.yesDir ? 'YES' : 'NO';
    var fadeEntry = fadeSide === 'YES' ? entryYes : entryNo;
    if (!fadeEntry) {
      clearCandidate();
      return null;
    }

    var now = Date.now();
    var prev = _fadeCandidates[key];
    var sameCandidate = !!(prev && prev.direction === fadeDir && prev.side === fadeSide);

    var mispricing = Math.abs(modelYesProb - kalshiYesPrice);
    var modelConfidence = Math.abs(modelYesProb - 0.5);
    var profile = buildCrowdFadeTimingProfile({
      secsLeft: secsLeft,
      mispricing: mispricing,
      edgeCents: fadeEntry.edgeCents,
      modelConfidence: modelConfidence,
      liquidity: liquidity,
      pred: pred,
      cfm: cfm,
      modelDir: fadeDir,
    });
    var withinAdaptiveWindow = Number.isFinite(secsLeft)
      && secsLeft >= profile.activeMinSecs
      && secsLeft <= profile.activeMaxSecs;
    var withinGraceWindow = Number.isFinite(secsLeft)
      && secsLeft >= profile.graceMinSecs
      && secsLeft <= profile.graceMaxSecs;
    if (!withinAdaptiveWindow && !sameCandidate) {
      clearCandidate();
      return null;
    }

    var edgeOk = Number.isFinite(fadeEntry.edgeCents) && fadeEntry.edgeCents >= profile.minEdgeCents;
    var modelConfOk = modelConfidence >= profile.minModelConfidence;
    var liquidityOk = !Number.isFinite(liquidity) || liquidity <= 0 || liquidity >= profile.minLiquidity;
    var qualified = modelConfOk && edgeOk && liquidityOk && mispricing >= profile.minMispricing;
    var lastQualifiedTs = sameCandidate
      ? (Number.isFinite(prev.lastQualifiedTs) ? prev.lastQualifiedTs : prev.lastTs)
      : null;
    var qualifiedSinceTs = sameCandidate
      ? (Number.isFinite(prev.qualifiedSinceTs) ? prev.qualifiedSinceTs : prev.firstTs)
      : null;
    var softHold = sameCandidate
      && withinGraceWindow
      && Number.isFinite(lastQualifiedTs)
      && (now - lastQualifiedTs) <= profile.softResetMs;
    if ((!qualified || !withinAdaptiveWindow) && !softHold) {
      clearCandidate();
      return null;
    }

    var timingLabel = profile.timingLabel;
    if (!withinAdaptiveWindow && softHold) timingLabel += ' hold';
    else if (!qualified && softHold) timingLabel += ' soft';

    if (sameCandidate) {
      prev.lastTs = now;
      if (qualified && withinAdaptiveWindow) {
        if (!Number.isFinite(prev.firstTs)) prev.firstTs = now;
        if (!Number.isFinite(prev.qualifiedSinceTs)) prev.qualifiedSinceTs = prev.firstTs;
        prev.lastQualifiedTs = now;
      }
      if (!Number.isFinite(prev.qualifiedSinceTs)) prev.qualifiedSinceTs = qualifiedSinceTs || prev.firstTs || now;
      var ageMs = Math.max(0, now - prev.qualifiedSinceTs);
      return {
        suggested: true,
        confirmed: ageMs >= profile.confirmMs,
        direction: fadeDir,
        side: fadeSide,
        entry: fadeEntry,
        ageMs: ageMs,
        confirmMs: profile.confirmMs,
        mispricing: mispricing,
        minMispricing: profile.minMispricing,
        timingLabel: timingLabel,
        windowLabel: profile.windowLabel,
        regime: profile.regime,
        flowScore: profile.flowScore,
      };
    }

    _fadeCandidates[key] = {
      direction: fadeDir,
      side: fadeSide,
      firstTs: now,
      lastTs: now,
      qualifiedSinceTs: now,
      lastQualifiedTs: now,
    };
    return {
      suggested: true,
      confirmed: false,
      direction: fadeDir,
      side: fadeSide,
      entry: fadeEntry,
      ageMs: 0,
      confirmMs: profile.confirmMs,
      mispricing: mispricing,
      minMispricing: profile.minMispricing,
      timingLabel: timingLabel,
      windowLabel: profile.windowLabel,
      regime: profile.regime,
      flowScore: profile.flowScore,
    };
  }

  function translate(sym, pred, cfm) {
    var pm = window.PredictionMarkets && window.PredictionMarkets.getCoin && window.PredictionMarkets.getCoin(sym);
    var k15 = (pm && pm.kalshi15m) || null;
    var kAlign = pred && pred.projections && pred.projections.p15 && pred.projections.p15.kalshiAlign ? pred.projections.p15.kalshiAlign : null;
    var strikeDirRaw = (kAlign && kAlign.strikeDir) || (k15 && k15.strikeDir) || 'above';
    var strikeDir = strikeDirRaw === 'below' ? 'below' : 'above';
    var dirs = yesNoFromStrikeDir(strikeDir);
    var modelScore = (pred && pred.score) || 0;
    var calibratedConfidence = pred && Number.isFinite(pred.confidence) ? pred.confidence : null;
    var modelVetoed = !!(pred && pred.diagnostics && pred.diagnostics.vetoed);
    var modelVetoReason = pred && pred.diagnostics && pred.diagnostics.vetoReason ? String(pred.diagnostics.vetoReason) : '';
    var modelVetoSeverity = pred && pred.diagnostics && pred.diagnostics.vetoSeverity
      ? String(pred.diagnostics.vetoSeverity).toLowerCase()
      : '';
    var modelHardVeto = modelVetoSeverity === 'hard' || !!(pred && pred.diagnostics && pred.diagnostics.hardVeto);
    var modelSoftVeto = !modelHardVeto && (modelVetoed || !!(pred && pred.diagnostics && pred.diagnostics.softVeto));
    var modelProbUpRaw = scoreToProbUp(modelScore);
    var modelYesProb = null;
    if (kAlign && Number.isFinite(kAlign.modelYesPct)) {
      modelYesProb = clamp(kAlign.modelYesPct / 100, 0.02, 0.98);
    } else {
      modelYesProb = strikeDir === 'below' ? (1 - modelProbUpRaw) : modelProbUpRaw;
    }
    var modelProbUp = strikeDir === 'below' ? (1 - modelYesProb) : modelYesProb;
    var scoreActive = Math.abs(modelScore) >= MODEL_THRESHOLD;
    var cdfActive = Number.isFinite(kAlign && kAlign.modelYesPct)
      ? Math.abs((kAlign.modelYesPct / 100) - 0.5) >= 0.08
      : false;
    var confidenceActive = (calibratedConfidence != null ? calibratedConfidence : 0) >= 12;
    var modelActive = !modelHardVeto && (scoreActive || (cdfActive && confidenceActive));
    var modelDir = modelYesProb >= 0.5 ? dirs.yesDir : dirs.noDir;
    var modelBullish = modelDir === 'UP';
    var kalshiYesPrice = k15 ? k15.probability : null;
    var kalshiActive = kalshiYesPrice !== null && kalshiYesPrice !== undefined;
    var kalshiDirHint = !kalshiActive ? null
      : kalshiYesPrice >= 0.55 ? dirs.yesDir
        : kalshiYesPrice <= 0.45 ? dirs.noDir
          : null;
    var kalshiBullish = kalshiDirHint === 'UP';
    var kalshiBearish = kalshiDirHint === 'DOWN';
    var kalshiNeutral = kalshiDirHint === null;
    var closeTimeMs = k15 && k15.closeTime ? new Date(k15.closeTime).getTime() : null;
    var msLeft = closeTimeMs != null ? Math.max(0, closeTimeMs - Date.now()) : null;
    var secsLeft = msLeft != null ? msLeft / 1000 : null;
    var minsLeft = msLeft != null ? msLeft / 60000 : null;
    var is15mTicker = !k15 || !k15.ticker || /15M/i.test(String(k15.ticker));
    var hasValid15mWindow = Number.isFinite(secsLeft) && secsLeft > 0 && secsLeft <= MAX_SECONDS_LEFT;
    pruneContractState(Date.now());
    var tooLate = msLeft != null && msLeft < MIN_SECONDS_LEFT * 1000;
    var tooEarly = minsLeft != null && minsLeft > 14.5;
    var lastCall = msLeft != null && msLeft <= LAST_CALL_MS;
    var vetoSt = window.ShellRouter && window.ShellRouter.getVetoState && window.ShellRouter.getVetoState(sym);
    if (vetoSt && vetoSt.phase === 'evaluating') {
      return {
        sym: sym, action: 'hold', side: null, direction: null, alignment: 'SHELL_EVAL',
        confidence: 0, msLeft: msLeft ? Math.round(msLeft) : null, secsLeft: secsLeft ? parseFloat(secsLeft.toFixed(1)) : null,
        minsLeft: minsLeft, lastCall: lastCall, closeTimeMs: closeTimeMs, closeTime: k15 ? k15.closeTime : null,
        contractTicker: k15 ? k15.ticker : null,
        reason: 'Shell wall evaluating (' + (vetoSt.evalTick || '?') + '/3) — data collection'
      };
    }
    if (vetoSt && vetoSt.phase === 'confirmed')
      return _earlyExit(sym, k15, msLeft, secsLeft, minsLeft, lastCall, 'Shell wall confirmed — stand aside');
    var earlyExit = pred && pred.diagnostics && pred.diagnostics.earlyExit;
    if (modelHardVeto && (!kalshiActive || kalshiDirHint === null)) {
      return _skip(sym, 'Model vetoed' + (modelVetoReason ? ' — ' + modelVetoReason : '') + '; no independent market edge');
    }
    if (!kalshiActive && !modelActive)
      return _skip(sym, 'No signal — score ' + modelScore.toFixed(3) + ', no Kalshi data');
    if (kalshiActive && (!is15mTicker || !hasValid15mWindow))
      return _skip(sym, 'Invalid contract window for 15m execution');
    if (tooLate)
      return _skip(sym, 'Settlement < ' + MIN_SECONDS_LEFT + 's — too late to fill');
    if (earlyExit)
      return _earlyExit(sym, k15, msLeft, secsLeft, minsLeft, lastCall);
    var direction, alignment;
    if (kalshiActive && modelActive) {
      var sameDir = (modelBullish && kalshiBullish) || (!modelBullish && kalshiBearish);
      if (sameDir) { direction = modelDir; alignment = 'ALIGNED'; }
      else if (kalshiNeutral) { direction = modelDir; alignment = 'MODEL_LEADS'; }
      else { direction = modelDir; alignment = 'DIVERGENT'; }
    } else if (modelActive) {
      direction = modelDir; alignment = 'MODEL_ONLY';
    } else {
      if (kalshiNeutral)
        return _skip(sym, (modelVetoed
          ? 'Model vetoed' + (modelVetoReason ? ' — ' + modelVetoReason : '')
          : 'Kalshi ~50/50, model below threshold (' + modelScore.toFixed(3) + ')'));
      direction = kalshiYesPrice >= 0.5 ? dirs.yesDir : dirs.noDir;
      alignment = 'KALSHI_ONLY';
    }
    var entryYes = kalshiYesPrice !== null ? analyseEntry('YES', modelYesProb, kalshiYesPrice) : null;
    var entryNo = kalshiYesPrice !== null ? analyseEntry('NO', modelYesProb, kalshiYesPrice) : null;
    var side = direction === dirs.yesDir ? 'YES' : 'NO';
    var entry = side === 'YES' ? entryYes : side === 'NO' ? entryNo : null;
    var mStr = clamp(Math.abs(modelScore), 0, 1);
    var eBoost = entry ? clamp(Math.abs(entry.edgeCents) / 60, 0, 0.25) : 0;
    var confidence = Math.round(clamp((mStr + eBoost) * 75, 0, 99));
    var action;
    if (alignment === 'KALSHI_ONLY') action = 'watch';
    else if (!entry || entry.edgeCents < EDGE_MIN_CENTS) action = (entry && entry.edgeCents < 0) ? 'skip' : 'watch';
    else action = modelActive ? 'trade' : 'watch';
    var finalConfidenceFloor = alignment === 'ALIGNED'
      ? FINAL_MODEL_CONF_MIN_TRADE
      : FINAL_MODEL_CONF_MIN_NONALIGNED_TRADE;
    var finalConfidenceWeak = calibratedConfidence != null && calibratedConfidence < finalConfidenceFloor;
    if (action === 'trade' && finalConfidenceWeak) action = 'watch';
    if (tooEarly && action === 'trade') action = 'watch';
    var symNorm = String(sym || '').toUpperCase();
    var logTunedDowngradeReason = null;
    if (
      action === 'trade'
      && symNorm !== 'BTC'
      && alignment !== 'ALIGNED'
      && entry
      && Number.isFinite(entry.edgeCents)
      && entry.edgeCents >= LOG_TUNED_HIGH_EDGE_RISK_CENTS
    ) {
      logTunedDowngradeReason = 'non-BTC non-aligned high-edge segment';
    } else if (
      action === 'trade'
      && symNorm !== 'BTC'
      && alignment === 'DIVERGENT'
      && Number.isFinite(kalshiYesPrice)
      && kalshiYesPrice >= LOG_TUNED_DIVERGENT_YES_RISK_MIN
      && kalshiYesPrice < LOG_TUNED_DIVERGENT_YES_RISK_MAX
    ) {
      logTunedDowngradeReason = 'non-BTC divergent 55-69% YES segment';
    }
    if (logTunedDowngradeReason) action = 'watch';
    var softVetoDowngradeReason = null;
    if (
      action === 'trade'
      && modelSoftVeto
      && entry
      && Number.isFinite(entry.edgeCents)
      && entry.edgeCents < (EDGE_MIN_CENTS + 2)
    ) {
      softVetoDowngradeReason = 'soft veto + marginal edge';
      action = 'watch';
    }
    var timingDowngradeReason = logTunedDowngradeReason || softVetoDowngradeReason;
    var timingProfile = buildAdaptiveTimingRegime({
      sym: sym,
      secsLeft: secsLeft,
      entry: entry,
      pred: pred,
      cfm: cfm,
      direction: direction,
      modelActive: modelActive,
      modelYesProb: modelYesProb,
      kalshiYesPrice: kalshiYesPrice,
      liquidity: k15 ? k15.liquidity : null,
      finalConfidenceWeak: finalConfidenceWeak,
      logTunedDowngradeReason: timingDowngradeReason,
    });
    if (action !== 'skip' && timingProfile.promoteToTrade) {
      action = 'trade';
    } else if (action === 'trade' && timingProfile.phase === 'SETTLING') {
      action = 'watch';
    }
    if (action === 'skip')
      return _skip(sym, 'Negative EV — edge ' + (entry ? entry.edgeCents : 0) + 'c (need >=' + EDGE_MIN_CENTS + 'c)');

    // Tier 1: Sweet spot window (3–6 min left, payout >= 1.65x)
    var payout = entry ? entry.payoutMult : null;
    var sweetSpot = secsLeft != null && secsLeft >= SWEET_MIN_SECS && secsLeft <= SWEET_MAX_SECS
      && payout != null && payout >= SWEET_PAYOUT_MIN
      && action === 'trade';
    var kPct = kalshiYesPrice != null ? 'Kalshi ' + Math.round(kalshiYesPrice * 100) + '% YES' : '';
    var mPct = 'model ' + Math.round(modelYesProb * 100) + '% YES';
    var edgeStr = entry ? ((entry.edgeCents >= 0 ? '+' : '') + entry.edgeCents + 'c/contract') : '';
    var confidenceTail = finalConfidenceWeak
      ? ' · downgraded to watch: final model confidence ' + calibratedConfidence + '% < ' + finalConfidenceFloor + '%'
      : '';
    var logTunedTail = logTunedDowngradeReason
      ? ' · downgraded to watch: ' + logTunedDowngradeReason
      : '';
    var softVetoTail = softVetoDowngradeReason
      ? ' · downgraded to watch: ' + softVetoDowngradeReason
      : (modelSoftVeto ? ' · model caution: ' + (modelVetoReason || 'soft veto') : '');
    var timingTail = timingProfile && timingProfile.promoteToTrade
      ? ' · timing regime: ' + timingProfile.timingLabel + ' (' + timingProfile.reasons.join(', ') + ')'
      : (timingProfile && timingProfile.blocks.length && action !== 'trade'
        ? ' · timing watch: ' + timingProfile.blocks.slice(0, 2).join(', ')
        : '');
    var reasonMap = {
      ALIGNED: sym + ' ' + direction + ': ' + kPct + ' + ' + mPct + ' -> ' + edgeStr,
      DIVERGENT: sym + ': ' + mPct + ' vs ' + kPct + ' -> INVERSION — buy ' + side + ' cheap, house is wrong — ' + edgeStr,
      MODEL_LEADS: sym + ' ' + direction + ': ' + mPct + ' (Kalshi ~50/50, model ahead) -> ' + edgeStr,
      MODEL_ONLY: sym + ' ' + direction + ': ' + mPct + ' (no Kalshi data)',
      KALSHI_ONLY: sym + ' ' + direction + ': ' + kPct + ' (' + (modelVetoed
        ? 'model vetoed' + (modelVetoReason ? ' — ' + modelVetoReason : '')
        : 'model score ' + modelScore.toFixed(3) + ' below threshold') + ')',
    };
    Object.keys(reasonMap).forEach(function (key) {
      if (key !== 'KALSHI_ONLY' && confidenceTail) reasonMap[key] += confidenceTail;
      if (key !== 'KALSHI_ONLY' && logTunedTail) reasonMap[key] += logTunedTail;
      if (key !== 'KALSHI_ONLY' && softVetoTail) reasonMap[key] += softVetoTail;
      if (key !== 'KALSHI_ONLY' && timingTail) reasonMap[key] += timingTail;
    });
    var blockedBy = [];
    if (modelHardVeto) blockedBy.push('hard veto' + (modelVetoReason ? ': ' + modelVetoReason : ''));
    else if (modelSoftVeto) blockedBy.push('soft veto' + (modelVetoReason ? ': ' + modelVetoReason : ''));
    if (finalConfidenceWeak) blockedBy.push('final confidence floor');
    if (logTunedDowngradeReason) blockedBy.push(logTunedDowngradeReason);
    if (softVetoDowngradeReason) blockedBy.push(softVetoDowngradeReason);
    if (tooEarly) blockedBy.push('open-window guard');
    if (timingProfile && timingProfile.blocks && timingProfile.blocks.length) {
      blockedBy = blockedBy.concat(timingProfile.blocks.slice(0, 3));
    }
    var strikeStr = null;
    if (k15 && k15.ticker) {
      var tm = k15.ticker.match(/T(\d+(?:\.\d+)?)$/);
      if (tm) strikeStr = 'T' + Number(tm[1]).toLocaleString();
    }
    var result = {
      sym: sym, contractTicker: k15 ? k15.ticker : null, strikeStr: strikeStr,
      side: side, direction: direction, alignment: alignment, action: action, confidence: confidence,
      finalModelConfidence: calibratedConfidence,
      modelVetoed: modelVetoed,
      modelVetoSeverity: modelVetoSeverity || (modelHardVeto ? 'hard' : (modelSoftVeto ? 'soft' : 'none')),
      modelHardVeto: modelHardVeto,
      modelSoftVeto: modelSoftVeto,
      modelVetoReason: modelVetoReason || null,
      modelScore: modelScore, modelProbUp: parseFloat(modelProbUp.toFixed(4)),
      modelProbYes: parseFloat(modelYesProb.toFixed(4)),
      kalshiYesPrice: kalshiYesPrice, kalshiActive: kalshiActive,
      closeTimeMs: closeTimeMs,
      msLeft: msLeft != null ? Math.round(msLeft) : null,
      secsLeft: secsLeft != null ? parseFloat(secsLeft.toFixed(1)) : null,
      minsLeft: minsLeft != null ? parseFloat(minsLeft.toFixed(3)) : null,
      minutesLeft: minsLeft,
      lastCall: lastCall, tooEarly: tooEarly,
      targetPrice: k15 ? k15.targetPrice : null, targetPriceNum: k15 ? k15.targetPriceNum : null,
      liquidity: k15 ? k15.liquidity : 0, closeTime: k15 ? k15.closeTime : null,
      humanReason: reasonMap[alignment] || (sym + ' ' + direction),
      sweetSpot: sweetSpot,
      timingRegime: timingProfile.phase,
      timingLabel: timingProfile.timingLabel,
      timingScore: timingProfile.timingScore,
      timingReasons: timingProfile.reasons,
      timingBlocks: timingProfile.blocks,
      closeValue: !!timingProfile.closeValueQualified,
      closeValueCandidate: !!timingProfile.closeValueCandidate,
      scalpFlip: !!timingProfile.scalpQualified,
      scalpCandidate: !!timingProfile.scalpCandidate,
      coreCloseValueWindow: !!timingProfile.coreCloseValueWindow,
      exitPlan: timingProfile.exitPlan,
      microFlowScore: timingProfile.flowScore,
      scalpSetupScore: timingProfile.scalpScore,
      microToxicity: timingProfile.toxicity,
      timingAdaptive: timingProfile.adaptiveTiming,
      missedOpportunityScore: action === 'watch' ? timingProfile.timingScore : 0,
      logTunedDowngrade: !!logTunedDowngradeReason,
      logTunedDowngradeReason: logTunedDowngradeReason,
      softVetoDowngradeReason: softVetoDowngradeReason,
      blockedBy: blockedBy.filter(Boolean),
    };
    if (entry) Object.assign(result, entry);

    // --- Signal lock + crowd fade ---
    var lockKey = sym + '_' + (closeTimeMs || 'none');
    var lock = _locks[lockKey];
    var nowTs = Date.now();
    var fadeEval = evaluateCrowdFade({
      sym: sym,
      closeTimeMs: closeTimeMs,
      kalshiYesPrice: kalshiYesPrice,
      secsLeft: secsLeft,
      dirs: dirs,
      modelDir: modelDir,
      modelYesProb: modelYesProb,
      modelActive: modelActive,
      entryYes: entryYes,
      entryNo: entryNo,
      liquidity: k15 ? k15.liquidity : null,
      pred: pred,
      cfm: cfm,
    });

    if (fadeEval && fadeEval.confirmed && ENABLE_CROWD_FADE_OVERRIDE) {
      // Persistent, model-confirmed mispricing fade.
      result.direction = fadeEval.direction;
      result.side = fadeEval.side;
      result.action = 'trade';
      result.alignment = 'CROWD_FADE';
      result.crowdFade = true;
      result.crowdFadeAgeMs = fadeEval.ageMs;
      result.crowdFadeConfirmLeftSec = 0;
      result.crowdFadeMispricingPp = Math.round((fadeEval.mispricing || 0) * 100);
      result.crowdFadeTimingLabel = fadeEval.timingLabel || 'adaptive';
      result.crowdFadeWindowLabel = fadeEval.windowLabel || null;
      result.timingRegime = result.timingRegime || 'CROWD_FADE';
      result.timingLabel = 'CROWD FADE';
      result.exitPlan = 'Crowd-fade plan: sell when market reprices toward model or when book/tape stops confirming the fade.';
      if (fadeEval.entry) Object.assign(result, fadeEval.entry);
      result.humanReason = sym + ' CROWD FADE (' + (fadeEval.timingLabel || 'adaptive') +
        (fadeEval.windowLabel ? ', ' + fadeEval.windowLabel : '') + ') → ' + fadeEval.direction +
        ': model-vs-market gap ' + result.crowdFadeMispricingPp + 'pp, edge ' + (result.edgeCents || 0) + 'c';
      // include predTs to allow invalidation when a newer model prediction arrives
      _locks[lockKey] = { direction: fadeEval.direction, side: result.side, ts: nowTs, closeTimeMs: closeTimeMs, predTs: (pred && (pred.ts || pred.timestamp)) || nowTs };
    } else if (fadeEval && fadeEval.suggested) {
      // Candidate mispricing is building but not persistent enough yet.
      result.crowdFadeSuggested = true;
      result.crowdFade = false;
      result.crowdFadeAgeMs = fadeEval.ageMs;
      result.crowdFadeTimingLabel = fadeEval.timingLabel || 'adaptive';
      result.crowdFadeWindowLabel = fadeEval.windowLabel || null;
      var confirmLeft = Math.max(0, Math.ceil(((fadeEval.confirmMs || CROWD_FADE_CONFIRM_MAX_MS) - fadeEval.ageMs) / 1000));
      result.crowdFadeConfirmLeftSec = confirmLeft;
      result.crowdFadeMispricingPp = Math.round((fadeEval.mispricing || 0) * 100);
      result.humanReason += ' · crowd-fade setup ' + Math.round((fadeEval.mispricing || 0) * 100) +
        'pp/' + Math.round((fadeEval.minMispricing || CROWD_FADE_MIN_MISPRICE) * 100) + 'pp (' +
        (fadeEval.timingLabel || 'adaptive') + ', confirm ' + confirmLeft + 's)';
    } else if (result.action === 'trade') {
      // New trade signal — lock it
      _locks[lockKey] = { direction: result.direction, side: result.side, ts: nowTs, closeTimeMs: closeTimeMs, predTs: (pred && (pred.ts || pred.timestamp)) || nowTs };
    } else if (lock && lock.closeTimeMs === closeTimeMs && (nowTs - lock.ts) < LOCK_MS) {
      // Signal drifted off trade but lock is still fresh — hold it
      // However, invalidate the lock when a newer model prediction is present
      var latestPredTs = pred && (pred.ts || pred.timestamp) ? Number(pred.ts || pred.timestamp) : null;
      if (latestPredTs && lock.predTs && latestPredTs > lock.predTs) {
        // Newer prediction arrived — drop stale lock
        delete _locks[lockKey];
      } else {
        var lockConflict = modelActive && modelDir && lock.direction && modelDir !== lock.direction;
        if (lockConflict) {
          delete _locks[lockKey];
        } else {
          result.direction = lock.direction;
          result.side = lock.side;
          result.action = 'trade';
          result.signalLocked = true;
          result.humanReason = sym + ' [LOCKED ' + Math.round((nowTs - lock.ts) / 1000) + 's ago] ' + lock.direction;
        }
      }
    }

    return result;
  }

  function _skip(sym, reason) {
    return { sym: sym, action: 'skip', side: null, direction: null, reason: reason, alignment: null, confidence: 0 };
  }
  function _earlyExit(sym, k15, msLeft, secsLeft, minsLeft, lastCall, reason) {
    return {
      sym: sym, action: 'earlyExit', side: null, direction: null,
      alignment: 'EARLY_EXIT', confidence: 0,
      reason: reason || 'CFM Router early-exit signal',
      contractTicker: k15 ? k15.ticker : null,
      closeTimeMs: k15 && k15.closeTime ? new Date(k15.closeTime).getTime() : null,
      closeTime: k15 ? k15.closeTime : null,
      msLeft: msLeft != null ? Math.round(msLeft) : null,
      secsLeft: secsLeft != null ? parseFloat(secsLeft.toFixed(1)) : null,
      minsLeft: minsLeft, lastCall: lastCall
    };
  }

  function getActiveCoins() {
    var coins = (window.PREDICTION_COINS || []).map(function (coin) {
      return coin && coin.sym ? coin.sym : null;
    }).filter(Boolean);
    return coins.length ? coins : ['BTC', 'ETH', 'SOL', 'XRP'];
  }

  function resolveAll(predAll, cfmAll) {
    var COINS = getActiveCoins();
    var intents = {};
    COINS.forEach(function (sym) {
      try { intents[sym] = translate(sym, predAll && predAll[sym], cfmAll && cfmAll[sym]); }
      catch (e) { intents[sym] = _skip(sym, 'Error: ' + e.message); }
    });
    return intents;
  }

  var _cache = {};
  window.KalshiOrchestrator = {
    translate: translate,
    resolveAll: resolveAll,
    scoreToProbUp: scoreToProbUp,
    analyseEntry: analyseEntry,
    getIntent: function (sym) { return _cache[sym] || null; },
    getAllIntents: function () { return _cache; },
    update: function (predAll, cfmAll) {
      _cache = resolveAll(predAll, cfmAll);
      return _cache;
    },
  };
  console.log('[KalshiOrchestrator] v2.0 loaded — EV engine | gate=5s | ms-precision clock');
})();
