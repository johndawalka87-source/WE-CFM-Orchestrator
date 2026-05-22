// ================================================================
// WE|||CRYPTO — Hourly Ranges Panel v5 (Auto-load + Rich Data)
//
// Fetches actual hourly range contracts from Kalshi API (~70 ranges per coin)
// Enriches with live prices from Coinbase, Kraken, CoinGecko
// Auto-loads on page init, updates every 30 seconds
//
// Kalshi hourly range series (e.g., KXBTC_H, KXETH_H, etc.)
// Each range: e.g., "KXBTC_H_75000_75100" = BTC between $75000-$75100
// ================================================================

(function () {
  'use strict';

  const MAIN_COINS = ['BTC', 'ETH', 'SOL', 'XRP', 'DOGE', 'BNB', 'HYPE'];
  const COIN_COLORS = {
    BTC: '#f7931a', ETH: '#627eea', SOL: '#00d4aa', XRP: '#23292f',
    DOGE: '#c2a633', BNB: '#f3ba2f', HYPE: '#00dcff',
  };
  // Fetch directly from Kalshi public REST API via proxy orchestrator instead of local websocket worker
  const KALSHI_PUBLIC_BASE = 'https://api.elections.kalshi.com/trade-api/v2';
  const COINBASE_BASE = 'https://api.coinbase.com/api/v3/brokerage';
  const KRAKEN_BASE = 'https://api.kraken.com/0/public';
  const COINGECKO_BASE = 'https://api.coingecko.com/api/v3';
  
  // Crypto price ladder series on Kalshi (includes initialized ladders before trading opens).
  const HOURLY_RANGE_SERIES = {
    BTC:  'KXBTC',
    ETH:  'KXETH',
    SOL:  'KXSOLE',
    XRP:  'KXXRP',
    DOGE: 'KXDOGE',
    BNB:  'KXBNB',
    HYPE: 'KXHYPE',
  };

  // Coinbase product IDs for live pricing
  const COINBASE_PRODUCTS = {
    BTC: 'BTC-USD', ETH: 'ETH-USD', SOL: 'SOL-USD', XRP: 'XRP-USD',
    DOGE: 'DOGE-USD', BNB: 'BNB-USD', HYPE: 'HYPE-USD',
  };

  // Kraken tickers
  const KRAKEN_TICKERS = {
    BTC: 'XXBTZUSD', ETH: 'XETHZUSD', SOL: 'SOLZUSD', XRP: 'XXRPZUSD',
    DOGE: 'XDOGEZUSD', BNB: 'BNBUSD', HYPE: null,
  };

  // CoinGecko IDs
  const COINGECKO_IDS = {
    BTC: 'bitcoin', ETH: 'ethereum', SOL: 'solana', XRP: 'ripple',
    DOGE: 'dogecoin', BNB: 'binancecoin', HYPE: 'hyperliquid',
  };

  let _cachedRanges = {}; // { 'BTC': [{ ...market }, ...], ... }
  let _cachedPrices = {}; // { 'BTC': 45000, ... }
  let _priceHistory = {}; // { 'BTC': [{ ts, price }], ... }
  let _pollTimer = null;
  const REQUEST_TIMEOUT_MS = 30000;
  const ACTIVE_VIEW_KEY = '__weCurrentView';
  const TARGET_BUCKET_MIN = 15;
  const TARGET_BUCKET_MAX = 15;
  const TARGET_BUCKET_DEFAULT = 15;
  const PRICE_HISTORY_WINDOW_MS = 2 * 60 * 60 * 1000;
  const MIN_TARGET_CLOSE_LEAD_MS = 6 * 60 * 1000;
  const MAX_MARKET_PAGES = 6;
  const OPEN_SOON_WINDOW_MS = 90 * 60 * 1000;

  function isHourlyRangesActive() {
    if (window[ACTIVE_VIEW_KEY]) return window[ACTIVE_VIEW_KEY] === 'hourly-ranges';
    const activeBtn = document.querySelector('.nav-btn.active');
    return activeBtn?.dataset?.view === 'hourly-ranges';
  }

  function withTimeout(promise, timeoutMs = REQUEST_TIMEOUT_MS) {
    return Promise.race([
      promise,
      new Promise((_, reject) => setTimeout(() => reject(new Error(`timeout ${timeoutMs}ms`)), timeoutMs)),
    ]);
  }

  // ── Route through Tauri suppFetch for CORS bypass ───────────────
  async function proxyFetch(url) {
    try {
      const host = new URL(String(url), window.location.href).hostname.toLowerCase();
      const apiName = host.includes('coingecko') ? 'coingecko'
        : host.includes('kraken') ? 'kraken'
          : null;
      if (apiName && window.ApiRateLimiter) await window.ApiRateLimiter.acquireToken(apiName);
    } catch (_) { }
    if (typeof window.suppFetch === 'function') {
      try {
        const res = await withTimeout(window.suppFetch(url));
        if (res && typeof res.json === 'function') {
          return await withTimeout(res.json());
        }
        return typeof res === 'string' ? JSON.parse(res) : res;
      } catch (e) {
        console.warn('[HR] suppFetch error:', url, e.message);
      }
    }
    try {
      const fetchImpl = window.throttledFetch || fetch;
      const res = await withTimeout(fetchImpl(url));
      if (!res.ok) throw new Error(res.status);
      return withTimeout(res.json());
    } catch (e) {
      console.warn('[HR] fetch error:', url, e.message);
      return null;
    }
  }

  // ── Fetch live price from multiple sources ──────────────────────
  async function getLivePrice(sym) {
    // Try Coinbase first (fastest, most reliable)
    const cbProduct = COINBASE_PRODUCTS[sym];
    if (cbProduct) {
      try {
        const data = await proxyFetch(`${COINBASE_BASE}/market/products/${cbProduct}/ticker`);
        if (data?.price) {
          console.log(`[HR] ${sym} price from Coinbase: ${data.price}`);
          return parseFloat(data.price);
        }
      } catch (e) {
        console.warn(`[HR] Coinbase ${sym}:`, e.message);
      }
    }

    // Fallback to Kraken
    const krakenTicker = KRAKEN_TICKERS[sym];
    if (krakenTicker) {
      try {
        const data = await proxyFetch(`${KRAKEN_BASE}/Ticker?pair=${krakenTicker}`);
        if (data?.result?.[krakenTicker]) {
          const price = parseFloat(data.result[krakenTicker].c[0]);
          console.log(`[HR] ${sym} price from Kraken: ${price}`);
          return price;
        }
      } catch (e) {
        console.warn(`[HR] Kraken ${sym}:`, e.message);
      }
    }

    // Fallback to CoinGecko
    const geckoId = COINGECKO_IDS[sym];
    if (geckoId) {
      try {
        const data = await proxyFetch(`${COINGECKO_BASE}/simple/price?ids=${geckoId}&vs_currencies=usd`);
        if (data?.[geckoId]?.usd) {
          const price = data[geckoId].usd;
          console.log(`[HR] ${sym} price from CoinGecko: ${price}`);
          return price;
        }
      } catch (e) {
        console.warn(`[HR] CoinGecko ${sym}:`, e.message);
      }
    }

    // Fallback to cached prediction market data
    const pred = window._predictions?.[sym];
    if (pred?.price) {
      console.log(`[HR] ${sym} price from window._predictions: ${pred.price}`);
      return pred.price;
    }
    
    console.warn(`[HR] No price found for ${sym}`);
    return null;
  }

  // ── Fetch all hourly range contracts for a coin ─────────────────
  function toFiniteNumber(v) {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }

  function clamp01(n) {
    if (!Number.isFinite(n)) return null;
    return Math.max(0, Math.min(1, n));
  }

  function clamp(n, lo, hi) {
    return Math.max(lo, Math.min(hi, n));
  }

  function formatRangeUsd(low, high) {
    if (!Number.isFinite(low) || !Number.isFinite(high)) return '—';
    return low >= 1
      ? `$${low.toFixed(0)}-$${high.toFixed(0)}`
      : `$${low.toFixed(4)}-$${high.toFixed(4)}`;
  }

  function toPercentStr(v, digits = 1) {
    if (!Number.isFinite(v)) return '—';
    return `${(v * 100).toFixed(digits)}%`;
  }

  function parseContractPrice(...candidates) {
    for (const c of candidates) {
      const n = Number(c);
      if (Number.isFinite(n)) return n;
    }
    return null;
  }

  function recordPriceHistory(sym, price) {
    if (!Number.isFinite(price) || price <= 0) return;
    const now = Date.now();
    if (!_priceHistory[sym]) _priceHistory[sym] = [];
    _priceHistory[sym].push({ ts: now, price });
    _priceHistory[sym] = _priceHistory[sym].filter(p => (now - p.ts) <= PRICE_HISTORY_WINDOW_MS);
  }

  function sampleAtAge(samples, ageMs) {
    if (!Array.isArray(samples) || samples.length < 2) return null;
    const targetTs = Date.now() - ageMs;
    for (let i = samples.length - 1; i >= 0; i--) {
      if (samples[i].ts <= targetTs) return samples[i];
    }
    return samples[0];
  }

  function getTrendMetrics(sym, currentPrice) {
    const samples = _priceHistory[sym] || [];
    const base = Number.isFinite(currentPrice) && currentPrice > 0 ? currentPrice : samples[samples.length - 1]?.price;
    if (!Number.isFinite(base) || base <= 0 || samples.length < 2) {
      return { momentum10m: 0, momentum30m: 0, volatilityPct: 0.0035 };
    }
    const p10 = sampleAtAge(samples, 10 * 60 * 1000);
    const p30 = sampleAtAge(samples, 30 * 60 * 1000);
    const momentum10m = p10 && p10.price > 0 ? (base - p10.price) / p10.price : 0;
    const momentum30m = p30 && p30.price > 0 ? (base - p30.price) / p30.price : 0;
    const returns = [];
    for (let i = 1; i < samples.length; i++) {
      const prev = samples[i - 1].price;
      const cur = samples[i].price;
      if (!Number.isFinite(prev) || !Number.isFinite(cur) || prev <= 0 || cur <= 0) continue;
      returns.push(Math.log(cur / prev));
    }
    const mean = returns.length ? returns.reduce((s, r) => s + r, 0) / returns.length : 0;
    const variance = returns.length
      ? returns.reduce((s, r) => s + Math.pow(r - mean, 2), 0) / returns.length
      : 0;
    const volatilityPct = Math.max(0.0008, Math.sqrt(Math.max(0, variance)));
    return { momentum10m, momentum30m, volatilityPct };
  }

  function parseStrikeFromTicker(ticker) {
    if (!ticker) return null;
    const m = String(ticker).match(/-T([0-9.]+)$/);
    if (!m) return null;
    return toFiniteNumber(m[1]);
  }

  function pickTargetCloseTime(markets, minLeadMs = 0) {
    const now = Date.now();
    const byClose = new Map();
    for (const m of (Array.isArray(markets) ? markets : [])) {
      const closeMs = Date.parse(m.close_time);
      if (!Number.isFinite(closeMs)) continue;
      const openMs = Date.parse(m.open_time);
      const existing = byClose.get(closeMs) || {
        closeMs,
        count: 0,
        hasActive: false,
        opensSoon: false,
      };
      existing.count += 1;
      if (Number.isFinite(openMs) && openMs <= now && closeMs >= now) existing.hasActive = true;
      if (Number.isFinite(openMs) && openMs > now && (openMs - now) <= OPEN_SOON_WINDOW_MS) existing.opensSoon = true;
      byClose.set(closeMs, existing);
    }
    const entries = [...byClose.values()];
    if (!entries.length) return null;

    const activeOrSoon = entries.filter(e =>
      (e.hasActive || e.opensSoon) &&
      e.closeMs >= now &&
      (e.closeMs - now) >= minLeadMs
    );
    const upcomingWithLead = entries.filter(e => e.closeMs >= now && (e.closeMs - now) >= minLeadMs);
    const upcoming = entries.filter(e => e.closeMs >= now);
    const pool = activeOrSoon.length
      ? activeOrSoon
      : (upcomingWithLead.length ? upcomingWithLead : (upcoming.length ? upcoming : entries));
    pool.sort((a, b) => {
      // Prefer soonest actionable close bucket, then deepest ladder.
      if (a.closeMs !== b.closeMs) return a.closeMs - b.closeMs;
      return b.count - a.count;
    });
    return new Date(pool[0].closeMs).toISOString();
  }

  function estimateStepFromStrikes(strikes) {
    if (!Array.isArray(strikes) || strikes.length < 2) return 1;
    let best = Infinity;
    for (let i = 1; i < strikes.length; i++) {
      const d = strikes[i] - strikes[i - 1];
      if (Number.isFinite(d) && d > 0 && d < best) best = d;
    }
    return Number.isFinite(best) && best > 0 ? best : 1;
  }

  function isYesAboveContract(market = {}) {
    const strikeType = String(market.strike_type || '').toLowerCase();
    const yesText = String(market.yes_sub_title || market.subtitle || market.title || '').toLowerCase();
    if (strikeType.includes('below') || strikeType.includes('under')) return false;
    if (strikeType.includes('above') || strikeType.includes('over') || strikeType.includes('greater')) return true;
    if (yesText.includes('below') || yesText.includes('under')) return false;
    return true;
  }

  function buildRangesFromContracts(markets) {
    const contracts = (Array.isArray(markets) ? markets : []).map(m => {
      const floor = toFiniteNumber(m.floor_strike) ?? toFiniteNumber(m.floor_price);
      const cap = toFiniteNumber(m.cap_strike) ?? toFiniteNumber(m.cap_price);
      const strike = floor ?? cap ?? parseStrikeFromTicker(m.ticker);
      const yesPriceRaw = parseContractPrice(
        m.yes_price_dollars,
        m.yes_price,
        m.yes_ask_dollars,
        m.last_price_dollars,
        m.last_price
      );
      const noPriceRaw = parseContractPrice(
        m.no_price_dollars,
        m.no_price,
        m.no_ask_dollars
      );
      const yesPrice = Number.isFinite(yesPriceRaw) ? yesPriceRaw : 0;
      const noPrice = Number.isFinite(noPriceRaw) ? noPriceRaw : (yesPrice <= 1 ? (1 - yesPrice) : (100 - yesPrice));
      const rawProb = yesPrice > 1 ? yesPrice / 100 : yesPrice;
      const prob = clamp01(rawProb);
      return {
        ticker: m.ticker,
        status: m.status || 'unknown',
        closeTime: m.close_time,
        floor,
        cap,
        strike,
        yesPrice,
        noPrice,
        prob,
        yesIsAbove: isYesAboveContract(m),
      };
    });

    // 1) Native bounded contracts (floor + cap) if present.
    const bounded = contracts
      .filter(c => Number.isFinite(c.floor) && Number.isFinite(c.cap) && c.cap > c.floor)
      .map(c => ({
        ticker: c.ticker,
        low: c.floor,
        high: c.cap,
        yesPrice: c.yesPrice,
        noPrice: c.noPrice,
        prob: c.prob,
        closeTime: c.closeTime,
        status: c.status,
      }));
    if (bounded.length) return bounded;

    // 2) Threshold ladders (-Tstrike): synthesize bounded bands from adjacent strikes.
    const thresholds = contracts
      .filter(c => Number.isFinite(c.strike))
      .sort((a, b) => a.strike - b.strike);
    if (thresholds.length < 2) return [];

    const strikes = thresholds.map(t => t.strike);
    const step = estimateStepFromStrikes(strikes);
    const exceedance = thresholds.map(t => {
      const pYes = clamp01(t.prob);
      if (pYes == null) return null;
      return t.yesIsAbove ? pYes : (1 - pYes);
    });

    const synthetic = [];
    // Lower tail: P(price < first strike)
    const firstEx = exceedance[0];
    if (firstEx != null) {
      synthetic.push({
        ticker: `${thresholds[0].ticker}|tail-lower`,
        low: thresholds[0].strike - step,
        high: thresholds[0].strike,
        yesPrice: thresholds[0].yesPrice,
        noPrice: thresholds[0].noPrice,
        prob: clamp01(1 - firstEx),
        closeTime: thresholds[0].closeTime,
        status: thresholds[0].status,
      });
    }

    for (let i = 0; i < thresholds.length - 1; i++) {
      const lowC = thresholds[i];
      const highC = thresholds[i + 1];
      const pLow = exceedance[i];
      const pHigh = exceedance[i + 1];
      synthetic.push({
        ticker: `${lowC.ticker}|band`,
        low: lowC.strike,
        high: highC.strike,
        yesPrice: lowC.yesPrice,
        noPrice: lowC.noPrice,
        prob: (pLow != null && pHigh != null) ? clamp01(pLow - pHigh) : clamp01(lowC.prob),
        closeTime: lowC.closeTime || highC.closeTime,
        status: lowC.status,
      });
    }

    // Upper tail: P(price >= last strike)
    const last = thresholds[thresholds.length - 1];
    const lastEx = exceedance[exceedance.length - 1];
    if (lastEx != null) {
      synthetic.push({
        ticker: `${last.ticker}|tail-upper`,
        low: last.strike,
        high: last.strike + step,
        yesPrice: last.yesPrice,
        noPrice: last.noPrice,
        prob: clamp01(lastEx),
        closeTime: last.closeTime,
        status: last.status,
      });
    }
    return synthetic;
  }

  function normalizeRangeLikelihoods(ranges, currentPrice) {
    const src = Array.isArray(ranges) ? ranges : [];
    if (!src.length) return [];

    const existingMass = src.reduce((sum, r) => sum + (Number.isFinite(r.prob) ? Math.max(0, r.prob) : 0), 0);
    if (existingMass > 0.05) {
      return src.map(r => ({ ...r, prob: clamp01(r.prob) ?? 0 }));
    }

    // Kalshi often posts initialized ladders with 0/1 placeholders.
    // When that happens, derive a distance-weighted likelihood across posted buckets.
    const mids = src.map(r => ({ r, mid: (r.low + r.high) / 2 }));
    const sortedMids = mids.map(x => x.mid).sort((a, b) => a - b);
    const step = estimateStepFromStrikes(sortedMids);
    const anchor = (Number.isFinite(currentPrice) && currentPrice > 0)
      ? currentPrice
      : (sortedMids[Math.floor(sortedMids.length / 2)] || 0);
    const scale = Math.max(step * 1.75, Math.abs(anchor) * 0.0025, 0.0001);

    const weighted = mids.map(x => {
      const dist = Math.abs(x.mid - anchor);
      const w = Math.exp(-(dist / scale));
      return { ...x.r, prob: w };
    });
    const total = weighted.reduce((s, r) => s + r.prob, 0) || 1;
    return weighted.map(r => ({ ...r, prob: clamp01(r.prob / total) || 0 }));
  }

  async function fetchHourlyRangesForCoin(sym) {
    const series = HOURLY_RANGE_SERIES[sym];
    if (!series) return [];

    try {
      // Make a single call using the REST API to bypass the overloaded local websocket worker
      const fetchSeriesMarkets = async (seriesTicker) => {
        const now = Date.now();
        if (window._hourlyContractCache?.[seriesTicker] && (now - window._hourlyContractCache[seriesTicker].ts < 10 * 60 * 1000)) {
          return window._hourlyContractCache[seriesTicker].markets;
        }
        
        try {
          let markets = [];
          const url = `${KALSHI_PUBLIC_BASE}/markets?series_ticker=${seriesTicker}&status=open&limit=1000`;
          const data = await proxyFetch(url);
          let payload = (data && data.success && data.data) ? data.data : data;
          markets = Array.isArray(payload?.markets) ? payload.markets : [];
          
          if (markets.length > 0) {
            window._hourlyContractCache = window._hourlyContractCache || {};
            window._hourlyContractCache[seriesTicker] = { ts: now, markets };
            return markets;
          }
          return [];
        } catch (e) {
          console.warn(`[HR] fetchSeriesMarkets error for ${seriesTicker}:`, e.message);
          return [];
        }
      };

      console.log(`[HR] Fetching ${sym} ranges (paged): ${series}`);
      let markets = await fetchSeriesMarkets(series);

      if (!markets.length) {
        console.warn(`[HR] No markets returned for ${sym}`);
        return [];
      }

      // Dedupe then focus only on the active/next close bucket (e.g., the 5AM ladder).
      const uniqueMarkets = Array.from(new Map(markets.map(m => [m.ticker, m])).values());
      const targetClose = pickTargetCloseTime(uniqueMarkets, MIN_TARGET_CLOSE_LEAD_MS);
      const allRanges = buildRangesFromContracts(uniqueMarkets);
      if (targetClose) {
        markets = uniqueMarkets.filter(m => {
          const ms = Date.parse(m.close_time);
          return Number.isFinite(ms) && new Date(ms).toISOString() === targetClose;
        });
      } else {
        markets = uniqueMarkets;
      }

      let ranges = buildRangesFromContracts(markets);
      const anchorPrice = Number.isFinite(_cachedPrices[sym]) && _cachedPrices[sym] > 0
        ? _cachedPrices[sym]
        : Number(window._predictions?.[sym]?.price);
      const hasCurrentCoverage = Number.isFinite(anchorPrice) && anchorPrice > 0
        ? ranges.some(r => anchorPrice >= r.low && anchorPrice <= r.high)
        : true;
      if (ranges.length < TARGET_BUCKET_MIN || !hasCurrentCoverage) {
        ranges = allRanges;
      }
      console.log(`[HR] Got ${ranges.length} ranges for ${sym} (targetClose=${targetClose || 'n/a'})`);

      // Sort by low price descending (highest at top, lowest at bottom)
      ranges.sort((a, b) => b.low - a.low);
      return ranges;
    } catch (e) {
      console.error(`[HR] Error fetching ranges for ${sym}:`, e);
      return [];
    }
  }

  // ── Fetch all hourly ranges for all coins + live prices ────────
  async function loadAllRanges() {
    console.log('[HR] ⏳ Starting loadAllRanges...');
    const results = [];
    for (const sym of MAIN_COINS) {
      console.log(`[HR] Fetching ${sym}...`);
      try {
        // Stagger per-symbol calls to avoid Kalshi burst 429s.
        await new Promise(r => setTimeout(r, 220));
        // Fetch ranges and live price in parallel
        // Fetch ranges and live price sequentially to avoid bursts
        const ranges = await fetchHourlyRangesForCoin(sym);
        const price = await getLivePrice(sym);
        
        if (Array.isArray(ranges) && ranges.length > 0) {
          _cachedRanges[sym] = ranges;
        } else if (!_cachedRanges[sym]) {
          _cachedRanges[sym] = [];
        }
        if (Number.isFinite(price) && price > 0) {
          _cachedPrices[sym] = price;
          recordPriceHistory(sym, price);
        } else if (!_cachedPrices[sym]) {
          _cachedPrices[sym] = null;
        }
        const status = (_cachedRanges[sym] || []).length > 0 ? `✓ ${_cachedRanges[sym].length} ranges` : '✗ No ranges';
        console.log(`[HR] ${sym}: ${status}, price=$${price}`);
        results.push({ sym, ranges: (_cachedRanges[sym] || []).length, price: _cachedPrices[sym] });
      } catch (e) {
        console.error(`[HR] ERROR loading ${sym}:`, e);
        if (!_cachedRanges[sym]) _cachedRanges[sym] = [];
        if (!_cachedPrices[sym]) _cachedPrices[sym] = null;
        results.push({ sym, error: e.message });
      }
    }
    console.log('[HR] ✓ loadAllRanges complete', results);
    return results;
  }

  // ── Determine range classification relative to current price ────
  function classifyRange(low, high, currentPrice) {
    if (!currentPrice) return 'neutral'; // grey if no price
    if (currentPrice >= low && currentPrice <= high) return 'current'; // GREEN
    if (currentPrice < low) return 'lower'; // RED
    return 'higher'; // ORANGE (projected higher)
  }

  // ── Select exact -5 to +5 buckets around current price ─────────
  function selectTargetBuckets(ranges, currentPrice) {
    if (!ranges || ranges.length === 0) return [];
    
    // Sort ascending by price
    const asc = [...ranges].sort((a, b) => a.low - b.low);
    
    // Find the bucket containing current price, or the nearest bucket
    let currentIndex = -1;
    if (Number.isFinite(currentPrice) && currentPrice > 0) {
      currentIndex = asc.findIndex(r => currentPrice >= r.low && currentPrice <= r.high);
      
      if (currentIndex === -1) {
        let nearestDist = Infinity;
        for (let i = 0; i < asc.length; i++) {
          const mid = (asc[i].low + asc[i].high) / 2;
          const dist = Math.abs(mid - currentPrice);
          if (dist < nearestDist) {
            nearestDist = dist;
            currentIndex = i;
          }
        }
      }
    }
    
    if (currentIndex === -1) {
      // Default to highest probability bucket if no price
      const best = [...asc].sort((a, b) => (b.prob || 0) - (a.prob || 0))[0];
      currentIndex = asc.indexOf(best);
    }
    
    // Grab exactly 7 below and 7 above (15 total)
    const startIdx = Math.max(0, currentIndex - 7);
    const endIdx = Math.min(asc.length - 1, currentIndex + 7);
    
    const selected = asc.slice(startIdx, endIdx + 1);
    
    // Sort descending for the UI ladder (highest price at top)
    return selected.sort((a, b) => b.low - a.low);
  }

  function deriveHourlyContractForecast(sym, normalizedRanges, currentPrice) {
    const ranges = Array.isArray(normalizedRanges) ? normalizedRanges.filter(r => Number.isFinite(r.low) && Number.isFinite(r.high)) : [];
    if (!ranges.length || !Number.isFinite(currentPrice) || currentPrice <= 0) return null;

    const mass = ranges.reduce((s, r) => s + Math.max(0, Number(r.prob) || 0), 0) || 1;
    const expectedPx = ranges.reduce((s, r) => {
      const mid = (r.low + r.high) / 2;
      const p = Math.max(0, Number(r.prob) || 0);
      return s + (mid * p);
    }, 0) / mass;
    const expectedMovePct = (expectedPx - currentPrice) / currentPrice;

    const trend = getTrendMetrics(sym, currentPrice);
    const modelScore = clamp(Number(window._predictions?.[sym]?.score) || 0, -1, 1);
    const trackerStats = window.HourlyKalshiTracker?.getStats?.(sym) || null;
    const trackerBias = (trackerStats && Number(trackerStats.totalBets) >= 6)
      ? clamp(((Number(trackerStats.winRate) || 50) - 50) / 100, -0.2, 0.2)
      : 0;

    const rangeBias = Math.tanh(expectedMovePct / Math.max(0.0025, trend.volatilityPct * 0.8));
    const composite = (
      (0.56 * rangeBias) +
      (0.16 * clamp(trend.momentum10m * 8, -1, 1)) +
      (0.10 * clamp(trend.momentum30m * 6, -1, 1)) +
      (0.14 * modelScore) +
      (0.04 * trackerBias)
    );
    const probUp = clamp01(0.5 + (composite / 2)) ?? 0.5;

    const sideCandidates = ranges.filter(r => {
      const mid = (r.low + r.high) / 2;
      return probUp >= 0.5 ? (mid >= currentPrice) : (mid <= currentPrice);
    });
    const chosenPool = sideCandidates.length ? sideCandidates : ranges;
    const target = [...chosenPool].sort((a, b) => (Number(b.prob) || 0) - (Number(a.prob) || 0))[0] || null;
    if (!target) return null;

    const confidence = clamp(
      (Math.abs(probUp - 0.5) * 1.35) + ((Number(target.prob) || 0) * 0.5),
      0.05,
      0.97
    );
    const action = probUp >= 0.56 ? 'YES' : probUp <= 0.44 ? 'NO' : 'WAIT';
    const closeMs = Date.parse(target.closeTime || '');
    const minsToClose = Number.isFinite(closeMs) ? Math.max(0, Math.round((closeMs - Date.now()) / 60000)) : null;

    return {
      action,
      confidence,
      probUp,
      expectedPx,
      expectedMovePct,
      target,
      minsToClose,
      trend,
      trackerStats,
    };
  }

  // ── Build range ladder with color coding ──────────────────────
  function buildRangeLadder(sym, ranges, currentPrice, maxRanges = TARGET_BUCKET_DEFAULT) {
    if (!ranges || ranges.length === 0) {
      return `<div class="hr-ladder-empty">No ranges available…</div>`;
    }

    const normalizedRanges = normalizeRangeLikelihoods(ranges, currentPrice);

    // Show focused actionable targets (3–6 buckets) instead of overloaded ladders.
    const filteredRanges = selectTargetBuckets(normalizedRanges, currentPrice, maxRanges);
    if (filteredRanges.length === 0) {
      return `<div class="hr-ladder-empty">No ranges available…</div>`;
    }

    const currentBucket = Number.isFinite(currentPrice)
      ? filteredRanges.find(r => currentPrice >= r.low && currentPrice <= r.high) || normalizedRanges.find(r => currentPrice >= r.low && currentPrice <= r.high)
      : null;
    const hourTarget = currentBucket || [...normalizedRanges].sort((a, b) => (b.prob || 0) - (a.prob || 0))[0] || null;
    const hourTargetStr = hourTarget ? formatRangeUsd(hourTarget.low, hourTarget.high) : '—';
    const hourlyForecast = deriveHourlyContractForecast(sym, normalizedRanges, currentPrice);
    const forecastSummary = hourlyForecast ? `
      <div class="hr-target-summary">
        Hourly contract call:
        <strong>${hourlyForecast.action}</strong>
        ${hourlyForecast.target?.ticker ? `<span style="opacity:.75">(${hourlyForecast.target.ticker})</span>` : ''}
        · Target <strong>${formatRangeUsd(hourlyForecast.target?.low, hourlyForecast.target?.high)}</strong>
        · Conf <strong>${Math.round(hourlyForecast.confidence * 100)}%</strong>
        · Prob(UP) <strong>${Math.round((hourlyForecast.probUp || 0.5) * 100)}%</strong>
        ${Number.isFinite(hourlyForecast.minsToClose) ? `· closes in <strong>${hourlyForecast.minsToClose}m</strong>` : ''}
      </div>
    ` : '';
    const currentSummary = currentBucket
      ? `<div class="hr-current-summary">In range now: <strong>${formatRangeUsd(currentBucket.low, currentBucket.high)}</strong> · Likelihood <strong>${Math.round((currentBucket.prob || 0) * 100)}%</strong></div>`
      : '';
    const targetSummary = hourTarget
      ? `<div class="hr-target-summary">Hour target: <strong>${hourTargetStr}</strong> · Hit likelihood <strong>${Math.round((hourTarget.prob || 0) * 100)}%</strong></div>`
      : '';
    const calibrationSummary = hourlyForecast
      ? `<div class="hr-current-summary">Expected settle: <strong>$${hourlyForecast.expectedPx.toFixed(2)}</strong> (${toPercentStr(hourlyForecast.expectedMovePct, 2)}) · 10m drift <strong>${toPercentStr(hourlyForecast.trend.momentum10m, 2)}</strong> · 30m drift <strong>${toPercentStr(hourlyForecast.trend.momentum30m, 2)}</strong></div>`
      : '';

    const levels = filteredRanges.map(r => {
      const probPct = Math.round(r.prob * 100);
      const classification = classifyRange(r.low, r.high, currentPrice);
      
      const priceStr = formatRangeUsd(r.low, r.high);
      
      let badge = '';
      if (classification === 'current' && currentPrice) {
        badge = ` <span class="hr-range-badge">● ${currentPrice.toFixed(2)}</span>`;
      }
      
      const targetTag = (hourTarget && r.low === hourTarget.low && r.high === hourTarget.high)
        ? `<span class="hr-target-tag">TARGET</span>`
        : '';
      return `
        <div class="hr-level hr-level-${classification}" title="${r.ticker}">
          <span class="hr-level-price">${priceStr}</span>
          <span class="hr-level-prob">${probPct}% hit</span>
          ${targetTag}
          ${badge}
        </div>
      `;
    });

    return `${forecastSummary}${targetSummary}${calibrationSummary}${currentSummary}<div class="hr-ladder">${levels.join('')}</div>`;
  }

  // ── Build full panel ─────────────────────────────────────────────
  function buildPanelHTML() {
    let html = `<div class="hr-panel">
      <div class="hr-panel-header">
        <h2>Kalshi Hourly Range Contracts</h2>
      </div>
      <div class="hr-grid-wrapper">`;

    for (const sym of MAIN_COINS) {
      const ranges = _cachedRanges[sym] || [];
      const currentPrice = _cachedPrices[sym];
      const ladder = buildRangeLadder(sym, ranges, currentPrice);
      const color = COIN_COLORS[sym];
      
      const priceDisplay = currentPrice ? `$${currentPrice.toFixed(2)}` : 'Loading...';
      
      html += `
        <div class="hr-coin-section">
          <div class="hr-coin-label" style="color:${color}">${sym}</div>
          <div class="hr-coin-price">Current: ${priceDisplay}</div>
          ${ladder}
        </div>
      `;
    }

    html += `</div></div>`;
    return html;
  }

  // ── Render panel ─────────────────────────────────────────────────
  function renderPanel() {
    if (!isHourlyRangesActive()) return;
    const container = document.getElementById('content');
    if (!container) {
      console.warn('[HR] Content container not found');
      return;
    }

    const panelHTML = buildPanelHTML();
    const panel = document.createElement('div');
    panel.id = 'hourly-ranges-panel';
    panel.innerHTML = panelHTML;
    
    container.replaceChildren(panel);
    window.dispatchEvent(new CustomEvent('hourly-ranges:ready'));
    console.log('[HR] Panel rendered');
  }

  // ── Auto-load ranges periodically ────────────────────────────────
  async function startAutoLoad(intervalMs = 30000) {
    console.log('[HR] Starting auto-load loop');
    if (_pollTimer) {
      clearTimeout(_pollTimer);
      _pollTimer = null;
    }

    // Render immediately so the tab never appears blank while network calls resolve.
    renderPanel();

    const refreshOnce = async () => {
      if (!isHourlyRangesActive()) return;
      await loadAllRanges();
      renderPanel();
    };

    await refreshOnce().catch((e) => {
      console.warn('[HR] Initial refresh failed:', e?.message || e);
    });

    const scheduleNext = () => {
      if (!isHourlyRangesActive()) {
        _pollTimer = null;
        return;
      }
      
      const now = Date.now();
      // Align to exact interval boundaries (e.g., 00, 30 seconds)
      // Add a 250ms offset to give the exchange servers time to publish their new data
      const offset = 250;
      const next = Math.ceil((now - offset) / intervalMs) * intervalMs + offset;
      const waitMs = next - now;
      
      _pollTimer = setTimeout(async () => {
        if (!isHourlyRangesActive()) return;
        console.log(`[HR] Polling ranges... (aligned)`);
        await refreshOnce().catch((e) => {
          console.warn('[HR] Poll refresh failed:', e?.message || e);
        });
        scheduleNext();
      }, waitMs);
    };

    scheduleNext();
  }

  // ── Public API ───────────────────────────────────────────────────
  window.HourlyRangesPanel = {
    render: renderPanel,
    load: loadAllRanges,
    startAutoLoad,
    getRanges: (sym) => _cachedRanges[sym] || [],
    stopAutoLoad: () => {
      if (_pollTimer) clearTimeout(_pollTimer);
      _pollTimer = null;
    },
  };

  console.log('[HourlyRangesPanel] ✓ Ready — call load() then render()');
})();
