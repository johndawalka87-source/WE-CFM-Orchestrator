// ================================================================
// exchange-ws.js — Unified public exchange websocket mux
//
// Priority providers (WS-first):
//   Binance, Coinbase Pro, Kraken, Bybit, OKX, KuCoin, Gate.io
//   Blockchain.com mempool feed (BTC unconfirmed tx)
// Optional:
//   DexPaprika SSE (default endpoint enabled, override via runtime config)
//
// Exposes:
//   window.ExchangeWS.getTicker(provider, sym, maxAgeMs)
//   window.ExchangeWS.getAll(provider)
//   window.ExchangeWS.getMempool()
//   window.ExchangeWS.start()/stop()
// ================================================================
// Circuit breaker state for provider flapping/failure
const CIRCUIT_BREAKER = {};
const FAILURE_THRESHOLD = 4; // Number of consecutive failures before disabling
const COOLDOWN_MS = 2 * 60 * 1000; // 2 minutes cooldown

(function () {
  'use strict';

  const TRADE_WINDOW_MS = 120000;
  const RECONNECT_BASE_MS = 3000;
  const RECONNECT_MAX_MS = 45000;
  const RECONNECT_JITTER_RATIO = 0.35;

  const STORE = {}; // provider -> sym -> snapshot
  const MEMPOOL = { btcUnconfirmed: 0, btcValue: 0, lastTxTs: 0 };
  const CONNECTIONS = {}; // name -> { ws, reconnectMs, timer, active, extra }

  // Track failures and circuit breaker state per provider
  function getBreakerState(name) {
    if (!CIRCUIT_BREAKER[name]) {
      CIRCUIT_BREAKER[name] = {
        failures: 0,
        open: false,
        openUntil: 0,
      };
    }
    return CIRCUIT_BREAKER[name];
  }

  function recordFailure(name) {
    const br = getBreakerState(name);
    br.failures++;
    if (!br.open && br.failures >= FAILURE_THRESHOLD) {
      br.open = true;
      br.openUntil = Date.now() + COOLDOWN_MS;
      // User feedback: dispatch event
      if (typeof window !== 'undefined' && window.dispatchEvent && typeof CustomEvent === 'function') {
        window.dispatchEvent(new CustomEvent('provider-disabled', {
          detail: { provider: name, until: br.openUntil }
        }));
      }
      console.warn(`[CircuitBreaker] Provider ${name} disabled for ${COOLDOWN_MS / 1000}s due to repeated failures.`);
    }
  }

  function recordSuccess(name) {
    const br = getBreakerState(name);
    if (br.open && Date.now() > br.openUntil) {
      br.open = false;
      br.failures = 0;
      // User feedback: dispatch event
      if (typeof window !== 'undefined' && window.dispatchEvent && typeof CustomEvent === 'function') {
        window.dispatchEvent(new CustomEvent('provider-recovered', {
          detail: { provider: name }
        }));
      }
      console.info(`[CircuitBreaker] Provider ${name} re-enabled after cooldown.`);
    } else if (!br.open) {
      br.failures = 0;
    }
  }

  function isProviderDisabled(name) {
    const br = getBreakerState(name);
    if (br.open && Date.now() > br.openUntil) {
      // Auto-recover after cooldown
      br.open = false;
      br.failures = 0;
      if (typeof window !== 'undefined' && window.dispatchEvent && typeof CustomEvent === 'function') {
        window.dispatchEvent(new CustomEvent('provider-recovered', {
          detail: { provider: name }
        }));
      }
      console.info(`[CircuitBreaker] Provider ${name} auto-recovered after cooldown.`);
      return false;
    }
    return br.open;
  }
  const SSE = { stream: null, active: false, lastError: null };

  const COINS = ['BTC', 'ETH', 'SOL', 'XRP', 'BNB', 'DOGE', 'HYPE'];
  const DEXPAPRIKA_SSE_DEFAULT = 'https://mcp.dexpaprika.com/sse';
  const PROVIDERS = {
    BINANCE: 'BINANCE',
    COINBASE: 'COINBASE',
    KRAKEN: 'KRAKEN',
    BYBIT: 'BYBIT',
    OKX: 'OKX',
    KUCOIN: 'KUCOIN',
    GATE: 'GATE',
  };

  const MAP = {
    BINANCE: { BTC: 'btcusdt', ETH: 'ethusdt', SOL: 'solusdt', XRP: 'xrpusdt', BNB: 'bnbusdt', DOGE: 'dogeusdt', HYPE: 'hypeusdt' },
    COINBASE: { BTC: 'BTC-USD', ETH: 'ETH-USD', SOL: 'SOL-USD', XRP: 'XRP-USD', DOGE: 'DOGE-USD' },
    KRAKEN: { BTC: 'XBT/USDT', ETH: 'ETH/USDT', SOL: 'SOL/USDT', XRP: 'XRP/USDT', DOGE: 'DOGE/USDT' },
    BYBIT: { BTC: 'BTCUSDT', ETH: 'ETHUSDT', SOL: 'SOLUSDT', XRP: 'XRPUSDT', BNB: 'BNBUSDT', DOGE: 'DOGEUSDT' },
    OKX: { BTC: 'BTC-USDT', ETH: 'ETH-USDT', SOL: 'SOL-USDT', XRP: 'XRP-USDT', BNB: 'BNB-USDT', DOGE: 'DOGE-USDT' },
    KUCOIN: { BTC: 'BTC-USDT', ETH: 'ETH-USDT', SOL: 'SOL-USDT', XRP: 'XRP-USDT', BNB: 'BNB-USDT', DOGE: 'DOGE-USDT' },
    GATE: { BTC: 'BTC_USDT', ETH: 'ETH_USDT', SOL: 'SOL_USDT', XRP: 'XRP_USDT', BNB: 'BNB_USDT', DOGE: 'DOGE_USDT' },
  };

  function now() { return Date.now(); }

  function ensureSnapshot(provider, sym) {
    if (!STORE[provider]) STORE[provider] = {};
    if (!STORE[provider][sym]) {
      STORE[provider][sym] = {
        sym,
        provider,
        price: null,
        bid: null,
        ask: null,
        vol24h: null,
        buyPct: 50,
        sellPct: 50,
        ts: 0,
        tradeTs: 0,
        trades: [], // { ts, qty, buy }
      };
    }
    return STORE[provider][sym];
  }

  function parseNum(v) {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }

  function trimTrades(snap, refTs) {
    const cutoff = refTs - TRADE_WINDOW_MS;
    if (!snap.trades.length) return;
    let i = 0;
    while (i < snap.trades.length && snap.trades[i].ts < cutoff) i++;
    if (i > 0) snap.trades.splice(0, i);
  }

  function recalcTradeMix(snap) {
    if (!snap.trades.length) {
      snap.buyPct = 50;
      snap.sellPct = 50;
      return;
    }
    let buy = 0;
    let sell = 0;
    for (const t of snap.trades) {
      if (t.buy) buy += t.qty;
      else sell += t.qty;
    }
    const total = buy + sell;
    if (total <= 0) {
      snap.buyPct = 50;
      snap.sellPct = 50;
      return;
    }
    snap.buyPct = (buy / total) * 100;
    snap.sellPct = 100 - snap.buyPct;
  }

  function updateTicker(provider, sym, patch) {
    const snap = ensureSnapshot(provider, sym);
    if (patch.price != null) snap.price = patch.price;
    if (patch.bid != null) snap.bid = patch.bid;
    if (patch.ask != null) snap.ask = patch.ask;
    if (patch.vol24h != null) snap.vol24h = patch.vol24h;
    snap.ts = patch.ts || now();
    return snap;
  }

  function updateTrade(provider, sym, trade) {
    const snap = ensureSnapshot(provider, sym);
    const ts = trade.ts || now();
    const qty = trade.qty != null && trade.qty > 0 ? trade.qty : 0;
    snap.trades.push({ ts, qty, buy: !!trade.buy });
    trimTrades(snap, ts);
    recalcTradeMix(snap);
    snap.tradeTs = ts;
    if (trade.price != null && trade.price > 0) snap.price = trade.price;
    snap.ts = ts;
    return snap;
  }

  function conn(name) {
    if (!CONNECTIONS[name]) {
      CONNECTIONS[name] = { ws: null, reconnectMs: RECONNECT_BASE_MS, timer: null, active: false, extra: {} };
    }
    return CONNECTIONS[name];
  }

  function clearConnTimer(c) {
    if (c.timer) {
      clearTimeout(c.timer);
      c.timer = null;
    }
  }

  function jitterMs(baseMs) {
    const normalized = Math.max(250, Number(baseMs) || RECONNECT_BASE_MS);
    const extra = Math.floor(normalized * RECONNECT_JITTER_RATIO * Math.random());
    return normalized + extra;
  }

  function scheduleReconnect(name, reconnectFn) {
    const c = conn(name);
    if (!c.active) return;
    clearConnTimer(c);
    // If provider is disabled, skip reconnect until cooldown expires
    if (isProviderDisabled(name)) {
      const br = getBreakerState(name);
      const wait = Math.max(0, br.openUntil - Date.now());
      c.timer = setTimeout(() => reconnectFn(), wait + 1000);
      return;
    }
    const delay = jitterMs(c.reconnectMs);
    c.timer = setTimeout(() => reconnectFn(), delay);
    c.reconnectMs = Math.min(Math.floor(c.reconnectMs * 1.5), RECONNECT_MAX_MS);
  }

  function bindCloseReconnect(name, reconnectFn) {
    const c = conn(name);
    if (!c.ws) return;
    c.extra.lastFailureAt = 0;
    c.ws.onclose = (ev) => {
      c.ws = null;
      if (c.extra.pingTimer) {
        clearInterval(c.extra.pingTimer);
        c.extra.pingTimer = null;
      }
      const code = Number(ev?.code || 0);
      const cleanClose = ev?.wasClean === true || code === 1000;
      const duplicateFailure = c.extra.lastFailureAt && (Date.now() - c.extra.lastFailureAt) < 1200;
      if (!cleanClose && !duplicateFailure) {
        c.extra.lastFailureAt = Date.now();
        recordFailure(name);
      }
      scheduleReconnect(name, reconnectFn);
    };
    c.ws.onerror = () => {
      c.extra.lastFailureAt = Date.now();
      recordFailure(name);
      try { c.ws && c.ws.close(); } catch (_) { }
    };
  }

  // ───────────────────────── Binance ─────────────────────────
  function connectBinance() {
    if (isProviderDisabled('BINANCE')) return;
    const name = 'BINANCE';
    const c = conn(name);
    if (!c.active) return;
    if (c.ws && (c.ws.readyState === WebSocket.OPEN || c.ws.readyState === WebSocket.CONNECTING)) return;
    const symbols = Object.values(MAP.BINANCE);
    const streams = [];
    for (const s of symbols) {
      streams.push(`${s}@ticker`);
      streams.push(`${s}@trade`);
    }
    const url = `wss://stream.binance.com:9443/stream?streams=${streams.join('/')}`;
    c.ws = new WebSocket(url);
    c.ws.onopen = () => {
      c.reconnectMs = RECONNECT_BASE_MS;
      recordSuccess('BINANCE');
    };
    c.ws.onmessage = (ev) => {
      recordSuccess('BINANCE');
      let msg;
      try { msg = JSON.parse(ev.data); } catch (_) { return; }
      const stream = msg?.stream || '';
      const data = msg?.data || {};
      const pair = stream.split('@')[0];
      if (!pair) return;
      const sym = Object.keys(MAP.BINANCE).find(k => MAP.BINANCE[k] === pair);
      if (!sym) return;
      if (stream.endsWith('@ticker')) {
        updateTicker(PROVIDERS.BINANCE, sym, {
          price: parseNum(data.c),
          bid: parseNum(data.b),
          ask: parseNum(data.a),
          vol24h: parseNum(data.q),
          ts: parseNum(data.E) || now(),
        });
      } else if (stream.endsWith('@trade')) {
        const qty = parseNum(data.q) || 0;
        updateTrade(PROVIDERS.BINANCE, sym, {
          buy: !data.m, // buyer was taker
          qty,
          price: parseNum(data.p),
          ts: parseNum(data.T) || now(),
        });
      }
    };
    bindCloseReconnect(name, connectBinance);
  }

  // ─────────────────────── Coinbase Pro ───────────────────────
  function connectCoinbase() {
    if (isProviderDisabled('COINBASE')) return;
    const name = 'COINBASE';
    const c = conn(name);
    if (!c.active) return;
    if (c.ws && (c.ws.readyState === WebSocket.OPEN || c.ws.readyState === WebSocket.CONNECTING)) return;
    c.ws = new WebSocket('wss://ws-feed.exchange.coinbase.com');
    c.ws.onopen = () => {
      c.reconnectMs = RECONNECT_BASE_MS;
      recordSuccess('COINBASE');
      const products = Object.values(MAP.COINBASE);
      c.ws.send(JSON.stringify({
        type: 'subscribe',
        product_ids: products,
        channels: ['ticker', 'matches'],
      }));
    };
    c.ws.onmessage = (ev) => {
      recordSuccess('COINBASE');
      let msg;
      try { msg = JSON.parse(ev.data); } catch (_) { return; }
      const productId = msg.product_id;
      if (!productId) return;
      const sym = Object.keys(MAP.COINBASE).find(k => MAP.COINBASE[k] === productId);
      if (!sym) return;
      if (msg.type === 'ticker') {
        updateTicker(PROVIDERS.COINBASE, sym, {
          price: parseNum(msg.price),
          bid: parseNum(msg.best_bid),
          ask: parseNum(msg.best_ask),
          vol24h: parseNum(msg.volume_24h),
          ts: now(),
        });
      } else if (msg.type === 'match' || msg.type === 'last_match') {
        updateTrade(PROVIDERS.COINBASE, sym, {
          buy: msg.side === 'buy',
          qty: parseNum(msg.size) || 0,
          price: parseNum(msg.price),
          ts: msg.time ? Date.parse(msg.time) || now() : now(),
        });
      }
    };
    bindCloseReconnect(name, connectCoinbase);
  }

  // ───────────────────────── Kraken ───────────────────────────
  function connectKraken() {
    if (isProviderDisabled('KRAKEN')) return;
    const name = 'KRAKEN';
    const c = conn(name);
    if (!c.active) return;
    if (c.ws && (c.ws.readyState === WebSocket.OPEN || c.ws.readyState === WebSocket.CONNECTING)) return;
    c.ws = new WebSocket('wss://ws.kraken.com');
    c.ws.onopen = () => {
      c.reconnectMs = RECONNECT_BASE_MS;
      recordSuccess('KRAKEN');
      const pairs = Object.values(MAP.KRAKEN);
      c.ws.send(JSON.stringify({ event: 'subscribe', pair: pairs, subscription: { name: 'ticker' } }));
      c.ws.send(JSON.stringify({ event: 'subscribe', pair: pairs, subscription: { name: 'trade' } }));
    };
    c.ws.onmessage = (ev) => {
      recordSuccess('KRAKEN');
      let msg;
      try { msg = JSON.parse(ev.data); } catch (_) { return; }
      if (!Array.isArray(msg) || msg.length < 4) return;
      const channel = msg[2];
      const pair = msg[3];
      const sym = Object.keys(MAP.KRAKEN).find(k => MAP.KRAKEN[k] === pair);
      if (!sym) return;
      if (channel === 'ticker') {
        const payload = msg[1] || {};
        updateTicker(PROVIDERS.KRAKEN, sym, {
          price: parseNum(payload.c?.[0]),
          bid: parseNum(payload.b?.[0]),
          ask: parseNum(payload.a?.[0]),
          vol24h: parseNum(payload.v?.[1]),
          ts: now(),
        });
      } else if (channel === 'trade') {
        const trades = msg[1] || [];
        for (const t of trades) {
          const side = t?.[3];
          updateTrade(PROVIDERS.KRAKEN, sym, {
            buy: side === 'b',
            qty: parseNum(t?.[1]) || 0,
            price: parseNum(t?.[0]),
            ts: t?.[2] ? Math.floor(parseFloat(t[2]) * 1000) : now(),
          });
        }
      }
    };
    bindCloseReconnect(name, connectKraken);
  }

  // ───────────────────────── Bybit ────────────────────────────
  function connectBybit() {
    if (isProviderDisabled('BYBIT')) return;
    const name = 'BYBIT';
    const c = conn(name);
    if (!c.active) return;
    if (c.ws && (c.ws.readyState === WebSocket.OPEN || c.ws.readyState === WebSocket.CONNECTING)) return;
    c.ws = new WebSocket('wss://stream.bybit.com/v5/public/spot');
    c.ws.onopen = () => {
      c.reconnectMs = RECONNECT_BASE_MS;
      recordSuccess('BYBIT');
      const syms = Object.values(MAP.BYBIT);
      c.ws.send(JSON.stringify({ op: 'subscribe', args: syms.map(s => `tickers.${s}`) }));
      c.ws.send(JSON.stringify({ op: 'subscribe', args: syms.map(s => `publicTrade.${s}`) }));
    };
    c.ws.onmessage = (ev) => {
      recordSuccess('BYBIT');
      let msg;
      try { msg = JSON.parse(ev.data); } catch (_) { return; }
      const topic = msg?.topic || '';
      if (!topic.includes('.')) return;
      const pair = topic.split('.').slice(1).join('.');
      const sym = Object.keys(MAP.BYBIT).find(k => MAP.BYBIT[k] === pair);
      if (!sym) return;
      if (topic.startsWith('tickers.')) {
        const d = msg?.data || {};
        updateTicker(PROVIDERS.BYBIT, sym, {
          price: parseNum(d.lastPrice),
          bid: parseNum(d.bid1Price),
          ask: parseNum(d.ask1Price),
          vol24h: parseNum(d.turnover24h || d.volume24h),
          ts: now(),
        });
      } else if (topic.startsWith('publicTrade.')) {
        const rows = Array.isArray(msg?.data) ? msg.data : [];
        for (const r of rows) {
          updateTrade(PROVIDERS.BYBIT, sym, {
            buy: String(r.S || '').toLowerCase() === 'buy',
            qty: parseNum(r.v) || 0,
            price: parseNum(r.p),
            ts: parseNum(r.T) || now(),
          });
        }
      }
    };
    bindCloseReconnect(name, connectBybit);
  }

  // ───────────────────────── OKX ──────────────────────────────
  function connectOKX() {
    if (isProviderDisabled('OKX')) return;
    const name = 'OKX';
    const c = conn(name);
    if (!c.active) return;
    if (c.ws && (c.ws.readyState === WebSocket.OPEN || c.ws.readyState === WebSocket.CONNECTING)) return;
    c.ws = new WebSocket('wss://ws.okx.com:8443/ws/v5/public');
    c.ws.onopen = () => {
      c.reconnectMs = RECONNECT_BASE_MS;
      recordSuccess('OKX');
      const inst = Object.values(MAP.OKX);
      c.ws.send(JSON.stringify({ op: 'subscribe', args: inst.map(s => ({ channel: 'tickers', instId: s })) }));
      c.ws.send(JSON.stringify({ op: 'subscribe', args: inst.map(s => ({ channel: 'trades', instId: s })) }));
    };
    c.ws.onmessage = (ev) => {
      recordSuccess('OKX');
      let msg;
      try { msg = JSON.parse(ev.data); } catch (_) { return; }
      const arg = msg?.arg || {};
      const instId = arg.instId;
      const channel = arg.channel;
      if (!instId || !channel) return;
      const sym = Object.keys(MAP.OKX).find(k => MAP.OKX[k] === instId);
      if (!sym) return;
      const rows = Array.isArray(msg?.data) ? msg.data : [];
      if (channel === 'tickers') {
        const d = rows[0] || {};
        updateTicker(PROVIDERS.OKX, sym, {
          price: parseNum(d.last),
          bid: parseNum(d.bidPx),
          ask: parseNum(d.askPx),
          vol24h: parseNum(d.volCcy24h || d.vol24h),
          ts: parseNum(d.ts) || now(),
        });
      } else if (channel === 'trades') {
        for (const d of rows) {
          updateTrade(PROVIDERS.OKX, sym, {
            buy: String(d.side || '').toLowerCase() === 'buy',
            qty: parseNum(d.sz) || 0,
            price: parseNum(d.px),
            ts: parseNum(d.ts) || now(),
          });
        }
      }
    };
    bindCloseReconnect(name, connectOKX);
  }

  // ───────────────────────── KuCoin ───────────────────────────
  async function connectKuCoin() {
    if (isProviderDisabled('KUCOIN')) return;
    const name = 'KUCOIN';
    const c = conn(name);
    if (!c.active) return;
    if (c.ws && (c.ws.readyState === WebSocket.OPEN || c.ws.readyState === WebSocket.CONNECTING)) return;
    try {
      const res = await fetch('https://api.kucoin.com/api/v1/bullet-public', { method: 'POST' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.json();
      const endpoint = body?.data?.instanceServers?.[0]?.endpoint;
      const token = body?.data?.token;
      if (!endpoint || !token) throw new Error('No KuCoin token/endpoint');
      const connectId = `wecrypto-${Math.random().toString(36).slice(2)}`;
      c.ws = new WebSocket(`${endpoint}?token=${token}&connectId=${connectId}`);
      c.ws.onopen = () => {
        c.reconnectMs = RECONNECT_BASE_MS;
        recordSuccess('KUCOIN');
        const pairs = Object.values(MAP.KUCOIN).join(',');
        c.ws.send(JSON.stringify({ id: Date.now(), type: 'subscribe', topic: `/market/ticker:${pairs}`, privateChannel: false, response: true }));
        c.ws.send(JSON.stringify({ id: Date.now() + 1, type: 'subscribe', topic: `/market/match:${pairs}`, privateChannel: false, response: true }));
        if (c.extra.pingTimer) clearInterval(c.extra.pingTimer);
        c.extra.pingTimer = setInterval(() => {
          try { c.ws && c.ws.readyState === WebSocket.OPEN && c.ws.send(JSON.stringify({ id: Date.now(), type: 'ping' })); } catch (_) { }
        }, 18000);
      };
      c.ws.onmessage = (ev) => {
        recordSuccess('KUCOIN');
        let msg;
        try { msg = JSON.parse(ev.data); } catch (_) { return; }
        if (msg.type === 'welcome' || msg.type === 'ack' || msg.type === 'pong') return;
        const topic = msg.topic || '';
        const data = msg.data || {};
        const pair = topic.split(':')[1];
        if (!pair) return;
        const sym = Object.keys(MAP.KUCOIN).find(k => MAP.KUCOIN[k] === pair);
        if (!sym) return;
        if (topic.startsWith('/market/ticker:')) {
          updateTicker(PROVIDERS.KUCOIN, sym, {
            price: parseNum(data.price),
            bid: parseNum(data.bestBid),
            ask: parseNum(data.bestAsk),
            vol24h: parseNum(data.volValue || data.vol),
            ts: parseNum(data.time) || now(),
          });
        } else if (topic.startsWith('/market/match:')) {
          updateTrade(PROVIDERS.KUCOIN, sym, {
            buy: String(data.side || '').toLowerCase() === 'buy',
            qty: parseNum(data.size) || 0,
            price: parseNum(data.price),
            ts: parseNum(data.time) || now(),
          });
        }
      };
      bindCloseReconnect(name, connectKuCoin);
    } catch (_) {
      scheduleReconnect(name, connectKuCoin);
    }
  }

  // ───────────────────────── Gate.io ──────────────────────────
  function connectGate() {
    if (isProviderDisabled('GATE')) return;
    const name = 'GATE';
    const c = conn(name);
    if (!c.active) return;
    if (c.ws && (c.ws.readyState === WebSocket.OPEN || c.ws.readyState === WebSocket.CONNECTING)) return;
    c.ws = new WebSocket('wss://api.gateio.ws/ws/v4/');
    c.ws.onopen = () => {
      c.reconnectMs = RECONNECT_BASE_MS;
      recordSuccess('GATE');
      const pairs = Object.values(MAP.GATE);
      c.ws.send(JSON.stringify({ time: Math.floor(now() / 1000), channel: 'spot.tickers', event: 'subscribe', payload: pairs }));
      c.ws.send(JSON.stringify({ time: Math.floor(now() / 1000), channel: 'spot.trades', event: 'subscribe', payload: pairs }));
    };
    c.ws.onmessage = (ev) => {
      recordSuccess('GATE');
      let msg;
      try { msg = JSON.parse(ev.data); } catch (_) { return; }
      const channel = msg?.channel || '';
      if (msg?.event === 'subscribe' || msg?.event === 'pong') return;
      const result = msg?.result;
      if (!result) return;
      if (channel === 'spot.tickers') {
        const rows = Array.isArray(result) ? result : [result];
        for (const d of rows) {
          const pair = d.currency_pair;
          const sym = Object.keys(MAP.GATE).find(k => MAP.GATE[k] === pair);
          if (!sym) continue;
          updateTicker(PROVIDERS.GATE, sym, {
            price: parseNum(d.last),
            bid: parseNum(d.highest_bid),
            ask: parseNum(d.lowest_ask),
            vol24h: parseNum(d.quote_volume || d.base_volume),
            ts: now(),
          });
        }
      } else if (channel === 'spot.trades') {
        const rows = Array.isArray(result) ? result : [result];
        for (const d of rows) {
          const pair = d.currency_pair;
          const sym = Object.keys(MAP.GATE).find(k => MAP.GATE[k] === pair);
          if (!sym) continue;
          const side = String(d.side || d.type || '').toLowerCase();
          updateTrade(PROVIDERS.GATE, sym, {
            buy: side === 'buy',
            qty: parseNum(d.amount || d.size) || 0,
            price: parseNum(d.price),
            ts: parseNum(d.create_time_ms || d.time_ms) || now(),
          });
        }
      }
    };
    bindCloseReconnect(name, connectGate);
  }

  // ─────────────────── Blockchain.com mempool ───────────────────
  function connectBlockchainMempool() {
    const name = 'BLOCKCHAIN_MEMPOOL';
    const c = conn(name);
    if (!c.active) return;
    if (c.ws && (c.ws.readyState === WebSocket.OPEN || c.ws.readyState === WebSocket.CONNECTING)) return;
    c.ws = new WebSocket('wss://ws.blockchain.info/inv');
    c.ws.onopen = () => {
      c.reconnectMs = RECONNECT_BASE_MS;
      c.ws.send(JSON.stringify({ op: 'unconfirmed_sub' }));
    };
    c.ws.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch (_) { return; }
      if (msg?.op !== 'utx') return;
      const tx = msg?.x || {};
      const outs = Array.isArray(tx.out) ? tx.out : [];
      const sat = outs.reduce((sum, o) => sum + (parseNum(o.value) || 0), 0);
      MEMPOOL.btcUnconfirmed += 1;
      MEMPOOL.btcValue += sat / 1e8;
      MEMPOOL.lastTxTs = now();
      updateTrade('BLOCKCHAIN', 'BTC', { buy: false, qty: Math.max(sat / 1e8, 0.000001), price: null, ts: now() });
    };
    bindCloseReconnect(name, connectBlockchainMempool);
  }

  // Optional SSE (uses default DexPaprika endpoint; runtime config may override)
  function connectDexPaprikaSSE() {
    const url = window?.WECRYPTO_CONFIG?.dexPaprikaSseUrl || DEXPAPRIKA_SSE_DEFAULT;
    if (!url || typeof EventSource === 'undefined') return;
    try {
      SSE.stream = new EventSource(url);
      SSE.active = true;
      SSE.lastError = null;
      SSE.stream.onmessage = (ev) => {
        let msg;
        try { msg = JSON.parse(ev.data); } catch (_) { return; }
        const sym = String(msg?.sym || msg?.symbol || '').toUpperCase();
        if (!COINS.includes(sym)) return;
        updateTicker('DEXPAPRIKA', sym, {
          price: parseNum(msg.priceUsd || msg.price),
          vol24h: parseNum(msg.vol24h || msg.volume24h),
          ts: parseNum(msg.ts) || now(),
        });
      };
      SSE.stream.onerror = () => {
        SSE.lastError = 'sse_error';
      };
    } catch (e) {
      SSE.lastError = String(e?.message || e);
    }
  }

  function start() {
    for (const name of ['BINANCE', 'COINBASE', 'KRAKEN', 'BYBIT', 'OKX', 'KUCOIN', 'GATE', 'BLOCKCHAIN_MEMPOOL']) {
      conn(name).active = true;
    }
    connectBinance();
    connectCoinbase();
    connectKraken();
    connectBybit();
    connectOKX();
    connectKuCoin();
    connectGate();
    connectBlockchainMempool();
    connectDexPaprikaSSE();
  }

  function stop() {
    for (const c of Object.values(CONNECTIONS)) {
      c.active = false;
      clearConnTimer(c);
      if (c.extra.pingTimer) {
        clearInterval(c.extra.pingTimer);
        c.extra.pingTimer = null;
      }
      try { c.ws && c.ws.close(); } catch (_) { }
      c.ws = null;
    }
    if (SSE.stream) {
      try { SSE.stream.close(); } catch (_) { }
      SSE.stream = null;
      SSE.active = false;
    }
  }

  function getTicker(provider, sym, maxAgeMs = 20000) {
    const snap = STORE?.[provider]?.[sym];
    if (!snap) return null;
    if (!snap.ts) return null;
    if (now() - snap.ts > maxAgeMs) return null;
    return {
      provider: snap.provider,
      sym: snap.sym,
      price: snap.price,
      bid: snap.bid,
      ask: snap.ask,
      vol24h: snap.vol24h,
      buyPct: snap.buyPct,
      sellPct: snap.sellPct,
      ts: snap.ts,
      tradeTs: snap.tradeTs,
    };
  }

  function getAll(provider) {
    const out = {};
    const perProvider = STORE?.[provider] || {};
    for (const [sym, snap] of Object.entries(perProvider)) {
      out[sym] = {
        sym,
        price: snap.price,
        bid: snap.bid,
        ask: snap.ask,
        vol24h: snap.vol24h,
        buyPct: snap.buyPct,
        sellPct: snap.sellPct,
        ts: snap.ts,
      };
    }
    return out;
  }

  function getMempool() {
    const ageMs = MEMPOOL.lastTxTs ? now() - MEMPOOL.lastTxTs : null;
    return { ...MEMPOOL, ageMs };
  }

  function getStatus() {
    const status = {};
    for (const [name, c] of Object.entries(CONNECTIONS)) {
      status[name] = {
        connected: c.ws?.readyState === WebSocket.OPEN,
        reconnectMs: c.reconnectMs,
        active: c.active,
      };
    }
    return {
      connections: status,
      sse: { active: SSE.active, lastError: SSE.lastError },
      providers: Object.keys(STORE),
      mempool: getMempool(),
    };
  }

  window.ExchangeWS = {
    PROVIDERS,
    start,
    stop,
    getTicker,
    getAll,
    getMempool,
    getStatus,
  };

  document.addEventListener('DOMContentLoaded', () => {
    try { start(); } catch (_) { }
  });
})();

