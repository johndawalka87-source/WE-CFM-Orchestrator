#!/usr/bin/env node
'use strict';

// Cross-chain orbital engine smoke test (no network, no DOM).
// Loads orbital-engine.js + kalshi-v2-mapper.js with a minimal window shim,
// feeds synthetic 15m candles per asset, prints orbital + payload diagnostics.

const path = require('path');

if (typeof globalThis.window === 'undefined') {
  globalThis.window = globalThis;
}

const ENGINE_PATH = path.resolve(__dirname, '..', 'src', 'orbital', 'orbital-engine.js');
const MAPPER_PATH = path.resolve(__dirname, '..', 'src', 'orbital', 'kalshi-v2-mapper.js');

const Engine = require(ENGINE_PATH);
const Mapper = require(MAPPER_PATH);

function makeCandles(seedClose, n) {
  let close = seedClose;
  const out = [];
  for (let i = 0; i < n; i++) {
    const shock = (Math.sin(i * 0.7) * 0.004) + (Math.cos(i * 1.1) * 0.003);
    close = close * (1 + shock);
    out.push({ close: close });
  }
  // inject a stretch overshoot to trigger entry signal on the last candle
  out[out.length - 1].close = close * 1.018;
  return out;
}

const fixtures = {
  BTC: makeCandles(68000, 24),
  ETH: makeCandles(3300, 24),
  SOL: makeCandles(155, 24),
  XRP: makeCandles(0.62, 24),
};

console.log('[orbital-smoke] WECRYP_ORBITAL_ENGINE_ENABLED =', Engine.isEnabled());
console.log('[orbital-smoke] WECRYP_KALSHI_V2_SUBMIT_ENABLED =', Mapper.isSubmitEnabled());

const initial = Engine.reinitLambdas(fixtures);
console.log('[orbital-smoke] lambdas (recalibrated):', initial);

Object.keys(fixtures).forEach((sym) => {
  const orbital = Engine.processInterval(sym, fixtures[sym]);
  if (!orbital) {
    console.log(`[orbital-smoke] ${sym} → no result (insufficient data)`);
    return;
  }
  console.log(`[orbital-smoke] ${sym}`,
    `λ=${orbital.lambda}`,
    `s=${orbital.s} p=${orbital.p} d=${orbital.d} f=${orbital.f}`,
    `OEQ=${orbital.oeq}`,
    `state=${orbital.state}`,
    `action=${orbital.action}`,
    `fade=${orbital.fadeDirection}`);

  if (orbital.action === 'EXECUTE_COUNTER_TRADE') {
    const payload = Mapper.buildOrderPayload({
      ticker: `KX${sym}15M-TEST`,
      pDelta: orbital.pDelta,
      count: 1,
      price: 0.45,
    });
    console.log(`[orbital-smoke] ${sym} payload:`, JSON.stringify(payload));
    const result = Mapper.submitIfEnabled(payload, null);
    console.log(`[orbital-smoke] ${sym} submit:`, result.submitted, result.reason || '');
  }
});

console.log('[orbital-smoke] OK');
