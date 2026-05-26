// throttled-fetch.js — Global API rate limiter for WE|||CRYPTO
// Prevents exchange APIs from throttling/banning and stops the proxy from
// being overwhelmed by 30+ simultaneous requests during prediction engine runs.
//
// Two modes exposed on window:
//   throttledFetch(url, options)  — concurrent cap, hard timeout per request
//   queuedFetch(url)              — strict serial queue with 65ms breathing room between calls
(function() {
  // ── 1. CONCURRENT THROTTLE ────────────────────────────────────────────────
  const MAX_CONCURRENT   = 40;     // Balanced: high enough to avoid deadlock, low enough to protect proxy WSS
  const FETCH_TIMEOUT_MS = 10000;  // hard deadline per request (10 s)
  const SLOT_GAP_MS      = 25;     // breathing room between slots to protect proxy event loop
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
    upbit: 15000,
    bitget: 15000,
    bingx: 15000,
    bitvavo: 15000,
    gemini: 15000,
    coinw: 15000,
    lbank: 15000,
    bitso: 15000,
    bullish: 15000,
    whitebit: 15000,
    ourbit: 15000,
    weex: 15000,
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
      if (host.includes('chain.so')) return 'chainso';
      if (host.includes('upbit')) return 'upbit';
      if (host.includes('bitget')) return 'bitget';
      if (host.includes('bingx')) return 'bingx';
      if (host.includes('bitvavo')) return 'bitvavo';
      if (host.includes('gemini')) return 'gemini';
      if (host.includes('coinw')) return 'coinw';
      if (host.includes('lbkex') || host.includes('lbank')) return 'lbank';
      if (host.includes('bitso')) return 'bitso';
      if (host.includes('bullish')) return 'bullish';
      if (host.includes('whitebit')) return 'whitebit';
      if (host.includes('ourbit')) return 'ourbit';
      if (host.includes('weex')) return 'weex';
      return null;
    } catch (_) {
      return null;
    }
  }

  function resolveRuntimeKey(name) {
    try {
      if (typeof window.resolveRuntimeKey === 'function') return window.resolveRuntimeKey(name) || '';
    } catch (_) { }
    try {
      return window.__env?.[name] || window.desktopApp?.publicEnv?.[name] || '';
    } catch (_) {
      return '';
    }
  }

  function withCoinGeckoAuth(url, options = {}) {
    const key = String(resolveRuntimeKey('COINGECKO_API_KEY') || '').trim();
    if (!key) return options;
    const host = (() => {
      try { return new URL(String(url), window.location.href).hostname.toLowerCase(); } catch (_) { return ''; }
    })();
    const tier = String(resolveRuntimeKey('COINGECKO_API_TIER') || '').trim().toLowerCase();
    const usePro = /^(pro|paid|enterprise)$/.test(tier) || host.includes('pro-api.coingecko.com');
    const headerName = usePro ? 'x-cg-pro-api-key' : 'x-cg-demo-api-key';
    const headers = { ...(options.headers || {}) };
    if (!headers[headerName] && !headers[headerName.toUpperCase()]) {
      headers[headerName] = key;
    }
    return { ...options, headers };
  }

  function coinGeckoUrl(url) {
    const key = String(resolveRuntimeKey('COINGECKO_API_KEY') || '').trim();
    if (!key) return url;
    const tier = String(resolveRuntimeKey('COINGECKO_API_TIER') || '').trim().toLowerCase();
    const usePro = /^(pro|paid|enterprise)$/.test(tier);
    if (!usePro) return url;
    try {
      const u = new URL(String(url), window.location.href);
      if (u.hostname.includes('coingecko')) {
        u.hostname = 'pro-api.coingecko.com';
      }
      return u.toString();
    } catch (_) {
      return url;
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
      const finalUrl = apiName === 'coingecko' && typeof window.coinGeckoUrl === 'function'
        ? window.coinGeckoUrl(url)
        : url;
      const finalOptions = apiName === 'coingecko' ? withCoinGeckoAuth(finalUrl, options) : options;
      const fetchUrl = finalOptions._rewrittenUrl || finalUrl;
      const res = await Promise.race([fetch(fetchUrl, finalOptions), hardTimeout]);
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
  window.withCoinGeckoAuth   = withCoinGeckoAuth;
  window.coinGeckoUrl        = coinGeckoUrl;

  console.info(`[ThrottledFetch] v1.2 ready — concurrent: ${MAX_CONCURRENT} | timeout: ${FETCH_TIMEOUT_MS}ms | gap: ${SLOT_GAP_MS}ms`);
})();
