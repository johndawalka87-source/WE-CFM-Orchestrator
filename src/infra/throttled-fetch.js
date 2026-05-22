// throttled-fetch.js — Global API rate limiter for WE|||CRYPTO
// Prevents exchange APIs from throttling/banning and stops the proxy from
// being overwhelmed by 30+ simultaneous requests during prediction engine runs.
//
// Two modes exposed on window:
//   throttledFetch(url, options)  — concurrent cap, hard timeout per request
//   queuedFetch(url)              — strict serial queue with 65ms breathing room between calls
//
// Load order: AFTER proxy-fetch.js (so throttle wraps the already-proxied fetch).
//
// WHY Promise.race instead of AbortController:
//   proxy-fetch.js routes CF-protected domains through a local XHR proxy that
//   does not forward AbortController signals — so requests through the proxy
//   can hang forever.  Promise.race gives us a hard wall-clock deadline that
//   fires regardless, properly releasing the slot via finally.

(function () {
  'use strict';

  // ── 1. CONCURRENT THROTTLE ────────────────────────────────────────────────
  const MAX_CONCURRENT  = 20;     // allows 7-coin parallel fetch without queue build-up
  const FETCH_TIMEOUT_MS = 15000; // hard deadline per request (15 s) — proxy sources need room
  const SLOT_GAP_MS      = 30;    // breathing room between slot releases
  const API_TIMEOUT_MS = {
    coingecko: 15000,
    coinbase: 15000,
    okx: 15000,
    okc: 15000,
    bitstamp: 15000,
    binance: 15000,
    bybit: 15000,
    kraken: 15000,
    kucoin: 15000,
    mexc: 15000,
    bitfinex: 15000,
    cryptocom: 15000,
    kalshi: 15000,
    polymarket: 15000,
    blockchainraw: 15000,
    default: FETCH_TIMEOUT_MS,
  };

  let activeFetches = 0;
  const waitQueue = [];

  function inferApiName(url) {
    try {
      const host = new URL(String(url), window.location.href).hostname.toLowerCase();
      if (host.includes('coingecko')) return 'coingecko';
      if (host.includes('coinbase')) return 'coinbase';
      if (host.includes('okx.com') || host.includes('okcoin.com')) return 'okx';
      if (host.includes('bitstamp')) return 'bitstamp';
      if (host.includes('coinmarketcap')) return 'coinmarketcap';
      if (host.includes('binance')) return 'binance';
      if (host.includes('bybit')) return 'bybit';
      if (host.includes('kraken')) return 'kraken';
      if (host.includes('kucoin')) return 'kucoin';
      if (host.includes('mexc')) return 'mexc';
      if (host.includes('bitfinex')) return 'bitfinex';
      if (host.includes('crypto.com')) return 'cryptocom';
      if (host.includes('kalshi')) return 'kalshi';
      if (host.includes('polymarket')) return 'polymarket';
      if (host.includes('mempool.space') || host.includes('blockchair.com') || host.includes('etherscan.io') || host.includes('blockscout.com')) return 'blockchainraw';
      if (host.includes('blockcypher')) return 'blockcypher';
      if (host.includes('blockscout')) return 'blockscout';
      if (host.includes('chain.so')) return 'chainso';
      return null;
    } catch (_) {
      return null;
    }
  }

  async function throttledFetch(url, options = {}) {
    if (activeFetches >= MAX_CONCURRENT) {
      await new Promise(resolve => waitQueue.push(resolve));
    }
    activeFetches++;

    // Promise.race provides a hard deadline even when the proxy ignores
    // the AbortController signal.  The underlying fetch may keep running
    // in the background but it won't hold a throttle slot.
    const hardTimeout = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('[throttle] timeout')), (() => {
        const apiName = inferApiName(url) || 'default';
        const limiter = apiName && window.ApiRateLimiter ? window.ApiRateLimiter.getLimiter(apiName) : null;
        const queuePenaltyMs = limiter ? Math.min(4000, limiter.getQueueLength() * 120) : 0;
        const baseTimeout = API_TIMEOUT_MS[apiName] || API_TIMEOUT_MS.default;
        return baseTimeout + queuePenaltyMs;
      })())
    );

    try {
      const apiName = inferApiName(url);
      if (apiName && window.ApiRateLimiter) {
        await window.ApiRateLimiter.acquireToken(apiName);
      }
      const res = await Promise.race([fetch(url, options), hardTimeout]);
      return res;   // ← return raw Response; callers use .ok / .json() themselves
    } catch (err) {
      console.warn('[ThrottledFetch] timeout/error:', url.slice(0, 100));
      throw err;    // ← re-throw so caller's .catch(() => []) handles it gracefully
    } finally {
      activeFetches--;
      // Small gap before waking the next queued request — reduces proxy burst
      if (waitQueue.length > 0) {
        setTimeout(() => { if (waitQueue.length) waitQueue.shift()(); }, SLOT_GAP_MS);
      }
    }
  }

  // ── 2. SERIAL QUEUE (65 ms gap) ───────────────────────────────────────────
  // For Kalshi/market polling where strict ordering matters.
  const serialQueue = [];
  let queueBusy = false;

  async function queuedFetch(url) {
    return new Promise(resolve => {
      serialQueue.push({ url, resolve });
      runSerialQueue();
    });
  }

  async function runSerialQueue() {
    if (queueBusy || serialQueue.length === 0) return;
    queueBusy = true;
    const { url, resolve } = serialQueue.shift();
    try {
      const res = await fetch(url, { method: 'GET', headers: { 'Accept': 'application/json' } });
      resolve(await res.json());
    } catch (err) {
      console.error('[ThrottledFetch] serial queue error:', url, err);
      resolve(null);
    }
    queueBusy = false;
    setTimeout(runSerialQueue, 65);   // 65 ms breathing room between calls
  }

  // ── 3. RESET (call on each new runAll to drain stale queue) ─────────────
  // Resolves all pending waiters immediately so they abort (their callers have
  // .catch(() => []) guards).  Resets activeFetches so new requests get fresh slots.
  function throttledFetchReset() {
    const drained = waitQueue.length;
    // Resolve all waiters — they will attempt to proceed but the underlying
    // fetch calls they were waiting on belong to the abandoned prior run.
    // Their individual coin-level timeouts will catch anything that slips through.
    while (waitQueue.length) waitQueue.shift()();
    activeFetches = 0;
    if (drained) console.info(`[ThrottledFetch] reset — drained ${drained} stale queue entries`);
  }

  window.throttledFetch      = throttledFetch;
  window.queuedFetch         = queuedFetch;
  window.throttledFetchReset = throttledFetchReset;

  console.info(`[ThrottledFetch] v1.2 ready — concurrent: ${MAX_CONCURRENT} | timeout: ${FETCH_TIMEOUT_MS}ms | gap: ${SLOT_GAP_MS}ms`);
})();
