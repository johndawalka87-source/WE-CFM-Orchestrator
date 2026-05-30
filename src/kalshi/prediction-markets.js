// ================================================================
// WE|||CRYPTO — Prediction Markets Intelligence Layer v2.1
// Aggregates Kalshi 15M + Kalshi 5M + Polymarket sentiment for crypto markets
//
// Sources (no auth required for market data):
//   Kalshi 15M  — Direct 15-min UP/DOWN direction markets (KXBTC15M etc.)
//                 YES price = market-implied probability price rises in 15 min
//                 Perfectly aligned with our h15 prediction horizon
//   Kalshi 5M   — Direct 5-min UP/DOWN direction markets (KXBTC5M etc.)
//                 Polled on every 2nd cycle to avoid rate limits
//   Polymarket  — Decentralised prediction market on Polygon
//                 Gamma API primary; CLOB API fallback on failure
//
// Exposes window.PredictionMarkets:
//   .start()      — begin 30-second polling
//   .getAll()     — per-coin sentiment map
//   .getCoin(sym) — { kalshi, poly, combinedProb, kalshi15m, kalshi5m, poly5m, sources, ... }
//   .getStatus()  — last fetch metadata
// ================================================================

(function () {
  'use strict';

  const KALSHI_BASE = 'https://api.elections.kalshi.com/trade-api/v2';
  
  
  // 15-second refresh — keeps Yes/No vote initialization tightly synced to
  // active 15M contracts, especially during boundary rollovers.
  const POLL_MS = 15_000;
  const KALSHI_MARKET_LIMIT = 25;
  const BUCKET_MS_15M = 15 * 60_000;
  const BUCKET_MS_5M = 5 * 60_000;
  const MIN_TRADABLE_MS_15M = 45_000;
  const MIN_TRADABLE_MS_5M = 20_000;
  const MIN_TRADABLE_MS_15M_PROXY = 30_000;

  // Direct 15-minute UP/DOWN series: YES = price higher in 15 min
  const KALSHI_15M_SERIES = {
    BTC: 'KXBTC15M',
    ETH: 'KXETH15M',
    SOL: 'KXSOL15M',
    XRP: 'KXXRP15M',
    DOGE: 'KXDOGE15M',
    BNB: 'KXBNB15M',
    HYPE: 'KXHYPE15M',
  };

  // Direct 5-minute UP/DOWN series — BNB/HYPE gracefully null if not live on Kalshi
  const KALSHI_5M_SERIES = {
    BTC: 'KXBTC5M',
    ETH: 'KXETH5M',
    SOL: 'KXSOL5M',
    XRP: 'KXXRP5M',
    DOGE: 'KXDOGE5M',
  };

  

  let cache = {};
  let lastFetch = 0;
  let inFlight = null;
  let timer = null;
  let _quarterDebugTicksRemaining = 80; // ~20 minutes at 15s poll
  // Rate-limit state: if non-zero, skip fetching until this timestamp
  let _rateLimitUntil = 0;
  let _consecutive429 = 0;

  // ── Kalshi probability velocity tracking ──────────────────────────────────
  // Tracks the last 12 probability readings per coin to detect smart-money
  // drift BEFORE the model catches up. velocity > 0 = Kalshi odds rising (bullish).
  const _probHistory = {};
  const PROB_HIST_MAX = 12;

  // ---- Route through Tauri suppFetch to bypass WebView2 CORS / geo-blocks ----
  async function readJsonPayload(payload) {
    if (!payload) return null;
    if (typeof Response !== 'undefined' && payload instanceof Response) {
      if (!payload.ok) throw new Error(`HTTP ${payload.status}`);
      return payload.json();
    }
    if (typeof payload.json === 'function' && typeof payload.ok === 'boolean') {
      if (!payload.ok) throw new Error(`HTTP ${payload.status}`);
      return payload.json();
    }
    if (typeof payload === 'string') return JSON.parse(payload);
    return payload;
  }

  async function apiFetch(url, opts = {}) {
    if (typeof window.suppFetch === 'function') {
      try {
        return await readJsonPayload(await window.suppFetch(url, opts));
      } catch (err) {
        console.warn(`[PredictionMarkets] suppFetch failed for ${url}:`, err?.message || err);
      }
    }
    // Try IPC fetch (main process, no CORS) when running in Electron
    if (window.electron?.ipcFetch) {
      try {
        const r = await window.electron.ipcFetch(url, opts);
        if (r.ok) return typeof r.text === 'string' ? JSON.parse(r.text) : r.text;
        throw new Error(`HTTP ${r.status || 0}${r.error ? ` ${r.error}` : ''}`);
      } catch (err) {
        console.warn(`[PredictionMarkets] ipcFetch failed for ${url}:`, err?.message || err);
      }
    }
    const res = await fetch(url, { headers: { Accept: 'application/json' }, ...opts });
    if (!res.ok) throw new Error(res.status);
    return res.json();
  }

  // ---- Rate-limit-aware Kalshi fetch helper --------------------------
  // Routes through ProxyOrchestrator for:
  //   - Per-endpoint rate limiting
  //   - Deduplication (coalesce identical requests within 500ms)
  //   - Fallback chains (Kalshi → Polymarket → Cache)
  //   - Multi-layer caching (memory → localStorage)
  //
  // Fallback to direct fetch if ProxyOrchestrator not initialized.

  function parseKalshiUrl(url) {
    try {
      const u = new URL(url);
      return {
        series_ticker: u.searchParams.get('series_ticker') || null,
        status: u.searchParams.get('status') || 'open',
        limit: parseInt(u.searchParams.get('limit') || String(KALSHI_MARKET_LIMIT), 10),
      };
    } catch (_) {
      return { series_ticker: null, status: 'open', limit: KALSHI_MARKET_LIMIT };
    }
  }

  async function kalshiFetch(url, attempt = 0) {
    if (_rateLimitUntil > Date.now()) {
      console.warn(`[PredictionMarkets] Rate limited until ${new Date(_rateLimitUntil).toISOString()}`);
      return null;
    }

    const params = parseKalshiUrl(url);
    let data = null;
    let transport = 'http';

    if (window.EndpointTransport?.fetchKalshiMarkets) {
      try {
        data = await window.EndpointTransport.fetchKalshiMarkets(params);
        transport = data?._transport || 'rpc/http';
      } catch (err) {
        console.warn(`[PredictionMarkets] EndpointTransport failed:`, err?.message || err);
        window._kalshiErrors = window._kalshiErrors || [];
        window._kalshiErrors.push({ ts: Date.now(), sym: params.series_ticker || 'SYS', msg: 'Proxy ' + (err?.message || 'Error') });
      }
    }

<<<<<<< Updated upstream
=======
    if (!data && usedEndpointTransport) {
      markKalshiRateLimit(series, { status: 429, message: 'Transport Cooldown' });
      return getSeriesCache(series);
    }

>>>>>>> Stashed changes
    if (!data) {
      try {
        data = await apiFetch(url);
        transport = 'http';
      } catch (err) {
        console.error(`[PredictionMarkets] Fetch error for ${url}:`, err?.message || err);
        window._kalshiErrors = window._kalshiErrors || [];
        window._kalshiErrors.push({ ts: Date.now(), sym: params.series_ticker || 'SYS', msg: 'Fetch ' + (err?.message || 'Error') });
        return null;
      }
    }

    if (data && typeof data === 'object' && data.status === 429) {
      _consecutive429++;
      const wait = _consecutive429 >= 3
        ? 60_000
        : Math.min(30_000, 3_000 * (2 ** attempt));
      console.warn(`[PredictionMarkets] HTTP 429 — backoff ${wait}ms`);
      _rateLimitUntil = Date.now() + wait;
      await new Promise(r => setTimeout(r, wait));
      _rateLimitUntil = 0;
      return attempt < 2 ? kalshiFetch(url, attempt + 1) : null;
    }

    _consecutive429 = 0;
    if (data && transport) {
      try {
        window.NetworkHealth?.update?.('Kalshi', {
          status: 'healthy',
          lastFetch: Date.now(),
          fallback: transport !== 'wss',
          reason: transport,
        });
      } catch (_) { }
    }
    return data;
  }

  function toFiniteProbability(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return null;
    return Math.max(0, Math.min(1, n));
  }

  function deriveAskFromReciprocal(directAsk, opposingBid) {
    const ask = toFiniteProbability(directAsk);
    if (ask != null && ask > 0) return ask;
    const oppBid = toFiniteProbability(opposingBid);
    if (oppBid == null) return null;
    return toFiniteProbability(1 - oppBid);
  }

  function resolveKalshiQuote(raw = {}) {
    const yesBid = toFiniteProbability(raw.yes_bid_dollars ?? raw.yes_bid);
    const noBid = toFiniteProbability(raw.no_bid_dollars ?? raw.no_bid);
    const yesAsk = deriveAskFromReciprocal(raw.yes_ask_dollars ?? raw.yes_ask, noBid);
    const noAsk = deriveAskFromReciprocal(raw.no_ask_dollars ?? raw.no_ask, yesBid);
    const last = toFiniteProbability(raw.last_price_dollars ?? raw.last_traded_price ?? raw.last_traded);

    let probability = null;
    if (yesAsk != null && yesBid != null && yesAsk > 0 && yesBid > 0) probability = (yesAsk + yesBid) / 2;
    else if (yesAsk != null && yesAsk > 0) probability = yesAsk;
    else if (yesBid != null && yesBid > 0) probability = yesBid;
    else if (noAsk != null && noBid != null && noAsk > 0 && noBid > 0) probability = 1 - (noAsk + noBid) / 2;
    else if (last != null && last > 0) probability = last;

    if (probability != null) {
      probability = Math.min(0.99, Math.max(0.01, probability));
    }

    return { yesAsk, yesBid, noAsk, noBid, last, probability };
  }

  function applyWsTickerToContract(contract) {
    if (!contract?.ticker || !window.KalshiWS?.getSnapshot) return contract;
    const tick = window.KalshiWS.getSnapshot().tickers?.[contract.ticker];
    if (!tick || Date.now() - (tick.ts || 0) > 45_000) return contract;

    const { yesAsk, yesBid, last, probability: wsProbability } = resolveKalshiQuote(tick);
    const probability = wsProbability != null ? wsProbability : contract.probability;

    return {
      ...contract,
      probability,
      yesAsk: yesAsk ?? contract.yesAsk,
      yesBid: yesBid ?? contract.yesBid,
      last: last ?? contract.last,
      _liveTransport: 'wss',
    };
  }

  function toMs(ts) {
    const n = new Date(ts).getTime();
    return Number.isFinite(n) ? n : null;
  }

  function ceilToBucket(ms, bucketMs) {
    return Math.ceil(ms / bucketMs) * bucketMs;
  }

  function isQuarterHourClose(ms) {
    const d = new Date(ms);
    const m = d.getUTCMinutes();
    return m === 0 || m === 15 || m === 30 || m === 45;
  }

  function selectKalshiContract(markets, options = {}) {
    const nowMs = Number.isFinite(options.nowMs) ? options.nowMs : Date.now();
    const bucketMs = Number.isFinite(options.bucketMs) ? options.bucketMs : BUCKET_MS_15M;
    const minTradableMs = Number.isFinite(options.minTradableMs) ? options.minTradableMs : 30_000;
    const strictQuarterHour = !!options.strictQuarterHour;
    const targetCloseMs = ceilToBucket(nowMs + minTradableMs, bucketMs);

    const eligible = (Array.isArray(markets) ? markets : [])
      .map(mk => ({ mk, closeMs: toMs(mk?.close_time) }))
      .filter(x => x.closeMs != null && x.closeMs > nowMs + minTradableMs);

    if (!eligible.length) return null;

    const strictPool = strictQuarterHour
      ? eligible.filter(x => isQuarterHourClose(x.closeMs))
      : eligible;

    const pool = strictPool.length ? strictPool : eligible;

    pool.sort((a, b) => {
      const da = Math.abs(a.closeMs - targetCloseMs);
      const db = Math.abs(b.closeMs - targetCloseMs);
      if (da !== db) return da - db;

      const liqA = parseFloat(a.mk?.liquidity_dollars || 0) || 0;
      const liqB = parseFloat(b.mk?.liquidity_dollars || 0) || 0;
      if (liqA !== liqB) return liqB - liqA;

      const volA = parseFloat(a.mk?.volume_fp || 0) || 0;
      const volB = parseFloat(b.mk?.volume_fp || 0) || 0;
      if (volA !== volB) return volB - volA;

      return a.closeMs - b.closeMs;
    });

    return pool[0].mk;
  }

  function buildKalshiContractData(m, extra = {}) {
    const { yesAsk, yesBid, last, probability } = resolveKalshiQuote(m);

    const floorStrike = m.floor_strike != null ? parseFloat(m.floor_strike) : null;
    const floorPriceRaw = m.floor_price != null ? parseFloat(m.floor_price) : null;
    const floorPrice = (Number.isFinite(floorStrike) && floorStrike > 0) ? floorStrike
      : (Number.isFinite(floorPriceRaw) && floorPriceRaw > 0) ? floorPriceRaw : null;
    const capStrike = m.cap_strike != null ? parseFloat(m.cap_strike) : null;
    const capPriceRaw = m.cap_price != null ? parseFloat(m.cap_price) : null;
    const capPrice = (Number.isFinite(capStrike) && capStrike > 0) ? capStrike
      : (Number.isFinite(capPriceRaw) && capPriceRaw > 0) ? capPriceRaw : null;
    const rawStrike = m.strike_type ? String(m.strike_type).toLowerCase() : null;
    const subtitle = (m.yes_sub_title || m.subtitle || '');

    let strikeDir = null;
    if (rawStrike) {
      if (rawStrike === 'below' || rawStrike === 'under') strikeDir = 'below';
      else if (rawStrike === 'above' || rawStrike === 'over' || rawStrike === 'at_least' || rawStrike === 'greater_or_equal') strikeDir = 'above';
    }
    if (!strikeDir) {
      const sub = subtitle.toLowerCase();
      strikeDir = (sub.includes('below') || sub.includes('under')) ? 'below' : 'above';
    }

    let targetPriceNum = (Number.isFinite(floorPrice) && floorPrice > 0) ? floorPrice : null;
    if (targetPriceNum == null) {
      const numMatch = subtitle.replace(/[$,]/g, '').match(/\d+\.?\d*/);
      if (numMatch) targetPriceNum = parseFloat(numMatch[0]);
    }
    const targetPrice = targetPriceNum != null ? `$${targetPriceNum.toLocaleString()}` : null;

    return {
      probability, yesAsk, yesBid, last,
      status: m.status,
      closeTime: m.close_time,
      openTime: m.open_time,
      ticker: m.ticker,
      title: m.title,
      subtitle,
      strikeDir,
      strikeType: rawStrike,
      floorPrice,
      capPrice,
      targetPrice,
      targetPriceNum,
      volume: Number(m.volume_fp || 0) || 0,
      liquidity: Number(m.liquidity_dollars || 0) || 0,
      openInterest: Number(m.open_interest_fp || 0) || 0,
      ...extra,
    };
  }

  // ---- Generic Kalshi series fetch ------------------------------------
  // Used for both 15M and 5M series — pass a windowMin for the fallback search.

  async function fetchKalshiSeriesForSym(series, opts = {}) {
    const suppressWarnings = !!opts.suppressWarnings;
    const bucketMs = Number.isFinite(opts.bucketMs)
      ? opts.bucketMs
      : (String(series).endsWith('15M') ? BUCKET_MS_15M : BUCKET_MS_5M);
    const minTradableMs = Number.isFinite(opts.minTradableMs)
      ? opts.minTradableMs
      : (bucketMs === BUCKET_MS_15M ? MIN_TRADABLE_MS_15M : MIN_TRADABLE_MS_5M);
    const strictQuarterHour = !!opts.strictQuarterHour;

    let d = await kalshiFetch(`${KALSHI_BASE}/markets?series_ticker=${series}&status=open&limit=${KALSHI_MARKET_LIMIT}`);
    if (!d) {
      if (!suppressWarnings) {
        console.warn(`[PredictionMarkets] No data returned from Kalshi for series ${series}`);
      }
      return null;
    }

    const markets = d?.markets || [];
    let nearClose = false;
    let m = selectKalshiContract(markets, {
      nowMs: Date.now(),
      bucketMs,
      minTradableMs,
      strictQuarterHour,
    });
    if (!m && opts.allowNearExpiry !== false && markets.length) {
      m = selectKalshiContract(markets, {
        nowMs: Date.now(),
        bucketMs,
        minTradableMs: 0,
        strictQuarterHour,
      });
      nearClose = !!m;
    }
    if (!m) {
      const nowMs = Date.now();
      const msUntilClose = bucketMs - (nowMs % bucketMs);
      const inRolloverDeadband = markets.length > 0 && msUntilClose <= (minTradableMs + 15000);

      if (!suppressWarnings && !inRolloverDeadband) {
        console.warn(`[PredictionMarkets] No open markets found for series ${series}. Markets available: ${markets.length}`);
      }
      return null;
    }

    const built = buildKalshiContractData(m, nearClose ? { tradable: false, nearClose: true } : { tradable: true });
    return applyWsTickerToContract(built);
  }

  // ---- Kalshi 15M -----------------------------------------------------

  async function fetchKalshi15M() {
    const result = {};
    const coins = Object.keys(KALSHI_15M_SERIES);
<<<<<<< Updated upstream
    for (let i = 0; i < coins.length; i++) {
      const sym = coins[i];
      const series = KALSHI_15M_SERIES[sym];
      result[sym] = await fetchKalshiSeriesForSym(series, {
        bucketMs: BUCKET_MS_15M,
        minTradableMs: MIN_TRADABLE_MS_15M,
        strictQuarterHour: true,
      });
=======
     // Fetch in parallel chunks of 3 to reduce latency while avoiding instant 429s
    const CHUNK_SIZE = 3;
    for (let i = 0; i < coins.length; i += CHUNK_SIZE) {
      const chunk = coins.slice(i, i + CHUNK_SIZE);
      const promises = chunk.map(sym => 
        fetchKalshiSeriesForSym(KALSHI_15M_SERIES[sym], {
          bucketMs: BUCKET_MS_15M,
          minTradableMs: MIN_TRADABLE_MS_15M,
          strictQuarterHour: true,
        }).then(res => { result[sym] = res; })
      );
      await Promise.allSettled(promises);
      if (i + CHUNK_SIZE < coins.length) await sleep(KALSHI_SERIES_FETCH_GAP_MS);
>>>>>>> Stashed changes
    }

    if (_quarterDebugTicksRemaining > 0) {
      const nowMs = Date.now();
      const debugRow = coins.map(sym => {
        const c = result[sym];
        const closeMs = c?.closeTime ? new Date(c.closeTime).getTime() : null;
        if (!Number.isFinite(closeMs)) return `${sym}:none`;
        const minute = new Date(closeMs).getUTCMinutes();
        const second = new Date(closeMs).getUTCSeconds();
        const isCanon = minute === 0 || minute === 15 || minute === 30 || minute === 45;
        const ttc = Math.max(0, Math.floor((closeMs - nowMs) / 1000));
        return `${sym}:${String(minute).padStart(2, '0')}:${String(second).padStart(2, '0')} canon=${isCanon ? 'Y' : 'N'} ttc=${ttc}s ${c?.ticker || 'no-ticker'}`;
      }).join(' | ');
      console.log(`[PredictionMarkets][Q15-VERIFY] ${debugRow}`);
      _quarterDebugTicksRemaining--;
      if (_quarterDebugTicksRemaining === 0) {
        console.log('[PredictionMarkets][Q15-VERIFY] Session debug logging complete; auto-disabled');
      }
    }

    return result;
  }

  // ---- Kalshi 5M — covers all 7 coins; dedicated 5M series tried first,
  // falls back to nearest-expiry 15M market as real-time proxy ----

  async function fetchKalshi5M() {
    // Cover all 7 coins — use 5M series if available, else nearest-expiry 15M as proxy
    const result = {};
    const coins = Object.keys(KALSHI_15M_SERIES); // BTC ETH SOL XRP DOGE BNB HYPE
    for (let i = 0; i < coins.length; i++) {
      const sym = coins[i];
      const series5m = KALSHI_5M_SERIES[sym] || null;

      // 1. Try dedicated 5M series (e.g. KXBTC5M) — may not exist on Kalshi
      let data = series5m ? await fetchKalshiSeriesForSym(series5m, {
        suppressWarnings: true,
        bucketMs: BUCKET_MS_5M,
        minTradableMs: MIN_TRADABLE_MS_5M,
        strictQuarterHour: false,
      }) : null;

      // 2. Fallback: use strict 15M quarter-hour contract as 5M proxy
      if (!data) {
        const baseSeries = KALSHI_15M_SERIES[sym];
        const d = await kalshiFetch(`${KALSHI_BASE}/markets?series_ticker=${baseSeries}&status=open&limit=${KALSHI_MARKET_LIMIT}`);
        const m = selectKalshiContract(d?.markets || [], {
          nowMs: Date.now(),
          bucketMs: BUCKET_MS_15M,
          minTradableMs: MIN_TRADABLE_MS_15M_PROXY,
          strictQuarterHour: true,
        });
        if (m) {
          data = buildKalshiContractData(m, { _proxy15m: true });
        }
      }
      result[sym] = data;
    }
    return result;
  }

  // ---- Snipe detection: contracts closing within 5 min with strong bias ----
  const SNIPE_WINDOW_MS = 5 * 60_000;
  const SNIPE_THRESHOLD = 0.65;

  function detectSnipes(c) {
    const snipes = [];
    const now = Date.now();
    for (const [sym, data] of Object.entries(c)) {
      for (const [label, market] of [['Kalshi 15M', data?.kalshi15m], ['Kalshi 5M', data?.kalshi5m]]) {
        if (!market?.closeTime || market.probability == null) continue;
        const ms = new Date(market.closeTime).getTime() - now;
        if (ms <= 0 || ms > SNIPE_WINDOW_MS) continue;
        const p = market.probability;
        const dir = p >= SNIPE_THRESHOLD ? 'UP' : p <= (1 - SNIPE_THRESHOLD) ? 'DOWN' : null;
        if (!dir) continue;
        snipes.push({ sym, dir, prob: p, ms, label: market._proxy15m ? 'Kalshi Nearest' : label, ticker: market.ticker, targetPrice: market.targetPrice });
      }
    }
    return snipes.sort((a, b) => a.ms - b.ms);
  }

  // ---- Probability velocity tracker -----------------------------------
  // Records each new Kalshi YES probability reading (deduped by change + time).
  // Linear regression over the rolling window gives ¢/min velocity — i.e. how
  // fast Kalshi's implied probability is drifting. Positive = bullish pressure.
  function trackProbability(sym, prob) {
    if (prob == null) return;
    if (!_probHistory[sym]) _probHistory[sym] = [];
    const hist = _probHistory[sym];
    const last = hist[hist.length - 1];
    // Require >0.3¢ change OR >15s elapsed since last reading
    if (last && Math.abs(last.prob - prob) < 0.003 && Date.now() - last.ts < 15_000) return;
    hist.push({ prob, ts: Date.now() });
    if (hist.length > PROB_HIST_MAX) hist.shift();
  }

  function getProbVelocity(sym) {
    const hist = _probHistory[sym];
    const latestProb = hist?.[hist.length - 1]?.prob ?? null;
    if (!hist || hist.length < 3) {
      return { velocity: 0, velCentsPerMin: 0, acceleration: 0, trend: 'flat', samples: hist?.length || 0, latestProb };
    }
    const n = hist.length;
    // Linear regression: x = seconds elapsed since first sample, y = prob
    const t0 = hist[0].ts;
    const xs = hist.map(h => (h.ts - t0) / 1000);
    const ys = hist.map(h => h.prob);
    const xMean = xs.reduce((a, b) => a + b) / n;
    const yMean = ys.reduce((a, b) => a + b) / n;
    const num = xs.reduce((s, x, i) => s + (x - xMean) * (ys[i] - yMean), 0);
    const den = xs.reduce((s, x) => s + (x - xMean) ** 2, 0);
    const slope = den > 0 ? num / den : 0; // prob per second
    const velCentsPerMin = slope * 60 * 100; // → ¢/min

    // Acceleration: velocity of 2nd half vs 1st half
    const compHalfVel = (half) => {
      if (half.length < 2) return 0;
      const dProb = half[half.length - 1].prob - half[0].prob;
      const dSec = (half[half.length - 1].ts - half[0].ts) / 1000;
      return dSec > 0 ? dProb / dSec * 60 * 100 : 0;
    };
    const mid = Math.floor(n / 2);
    const acceleration = compHalfVel(hist.slice(mid)) - compHalfVel(hist.slice(0, mid));

    const trend = velCentsPerMin >= 1.5 ? 'rising' : velCentsPerMin <= -1.5 ? 'falling' : 'flat';
    return {
      velocity: slope,
      velCentsPerMin: +velCentsPerMin.toFixed(2),
      acceleration: +acceleration.toFixed(2),
      trend,
      samples: n,
      latestProb,
    };
  }

  // ---- Aggregation --------------------------------------------------
  // Polymarket: poll every cycle — it's now the primary source
  // Kalshi 5M:  every 2nd cycle (~60s)
  let _polyCycleCount = 0;
  
  let _k5mCache = {};

  async function _doFetch() {
    _polyCycleCount++;
    const fetch5M = false; // Disabled 5M polling due to Kalshi 400/429 limits and new 15M architecture

    const kalshi15m = await fetchKalshi15M();

    if (fetch5M) {
      const k5m = await fetchKalshi5M();
      if (Object.keys(k5m).length > 0) _k5mCache = k5m;
    }

    // --- Network Health Reporting ---
    if (window.NetworkHealth) {
      // Kalshi
      const kalshiStatus = {
        status: kalshi15m && Object.values(kalshi15m).some(x => x) ? 'healthy' : 'down',
        lastFetch: Date.now(),
        fallback: false,
        reason: kalshi15m && Object.values(kalshi15m).some(x => x) ? '' : 'No Kalshi 15M data',
      };
      window.NetworkHealth.update('Kalshi', kalshiStatus);

      

      // ProxyOrchestrator (if present)
      let proxyStatus = { status: 'unknown', lastFetch: Date.now(), fallback: false, reason: '' };
      if (typeof window._proxyOrchestrator !== 'undefined') {
        proxyStatus.status = 'healthy';
      } else {
        proxyStatus.status = 'down';
        proxyStatus.reason = 'Not initialized';
      }
      window.NetworkHealth.update('ProxyOrchestrator', proxyStatus);
    }
    // Debug: log what we got from Kalshi 15M
    const k15Coins = Object.entries(kalshi15m).filter(([sym, data]) => data !== null).map(([sym]) => sym);
    const k15Empty = Object.entries(kalshi15m).filter(([sym, data]) => data === null).map(([sym]) => sym);
    if (k15Coins.length === 0) {
      console.error(`[PredictionMarkets] CRITICAL: No Kalshi 15M contracts loaded. Empty coins: ${k15Empty.join(', ')}`);
    } else {
      console.log(`[PredictionMarkets] Loaded Kalshi 15M for: ${k15Coins.join(', ')} (failed: ${k15Empty.join(', ')})`);
    }

    const next = {};
    for (const sym of Object.keys(KALSHI_15M_SERIES)) {
      const k15 = kalshi15m[sym] ?? null;
      const k5 = _k5mCache[sym] ?? null;
      
      const sources = [];
      if (k15?.probability != null) sources.push({ name: 'Kalshi15M', prob: k15.probability, vol: k15.volume || 1 });
      
      let combinedProb = k15?.probability ?? null;

      next[sym] = {
        kalshi: k15?.probability != null ? parseFloat(k15.probability.toFixed(4)) : null,
        combinedProb: combinedProb !== null ? parseFloat(combinedProb.toFixed(4)) : null,
        sources,
        kalshi15m: k15,
        kalshi5m: k5,
        kalshiTitle: k15?.title ?? null,
        probVelocity: getProbVelocity(sym),  // Kalshi YES-price drift (¢/min)
      };
      // Update velocity history AFTER building next[sym] so this cycle feeds next read
      if (k15?.probability != null) trackProbability(sym, k15.probability);
    }

    cache = next;
    lastFetch = Date.now();

    const liveTickers = Object.values(next)
      .map(c => c?.kalshi15m?.ticker)
      .filter(Boolean);
    window.EndpointTransport?.subscribeKalshiMarketTickers?.(liveTickers);

    window.dispatchEvent(new CustomEvent('predictionmarketsready', { detail: next }));
  }

  function onKalshiTicker(e) {
    const { market_ticker } = e.detail || {};
    if (!market_ticker) return;
    let touched = false;
    for (const sym of Object.keys(cache)) {
      const k15 = cache[sym]?.kalshi15m;
      if (!k15 || k15.ticker !== market_ticker) continue;
      const updated = applyWsTickerToContract(k15);
      if (updated.probability === k15.probability) continue;
      cache[sym] = { ...cache[sym], kalshi15m: updated, kalshi: updated.probability };
      if (cache[sym].combinedProb != null && cache[sym].sources?.length) {
        const kSrc = cache[sym].sources.find(s => s.name === 'Kalshi15M');
        if (kSrc) kSrc.prob = updated.probability;
        cache[sym].combinedProb = updated.probability;
      }
      touched = true;
    }
    if (touched) {
      window.dispatchEvent(new CustomEvent('predictionmarketsready', { detail: cache }));
    }
  }

  async function fetchAll() {
    if (inFlight) return inFlight;
    inFlight = _doFetch().finally(() => { inFlight = null; });
    return inFlight;
  }

  // ---- Public API ---------------------------------------------------

  window.PredictionMarkets = {
    start() {
      if (PredictionMarkets._started) return;
      PredictionMarkets._started = true;
      window.EndpointTransport?.ensureKalshiWs?.();
      if (!PredictionMarkets._tickerBound) {
        PredictionMarkets._tickerBound = true;
        window.addEventListener('kalshi:ticker', onKalshiTicker);
      }
      if (timer) return;
      fetchAll();
      timer = setInterval(() => { if (!document.hidden) fetchAll(); }, POLL_MS);
      // Fast-poll: when any 15M contract is < 2 min from close, re-fetch Kalshi every 10s.
      // Ensures price is at most 10s stale for last-call trades.
      setInterval(() => {
        if (document.hidden || inFlight) return;
        const now = Date.now();
        const nearClose = Object.values(cache).some(c => {
          const ct = c && c.kalshi15m && c.kalshi15m.closeTime;
          if (!ct) return false;
          const ms = new Date(ct).getTime() - now;
          return ms > 0 && ms < 120_000;
        });
        if (nearClose) fetchAll();
      }, 10_000);
    },
    getAll() { return cache; },
    getCoin(sym) { return cache[sym] ?? null; },
    getSnipes() { return detectSnipes(cache); },
    // Funding-rate bias for a coin: { avg, bias, strength, sources } or null.
    // Populated by cfm-engine.js _computeFundingBias() after each poll cycle.
    getFundingBias(sym) { return window._cfm?.[sym]?.fundingBias || null; },
    // Fear & Greed Index: { value, label, ts } or null.
    // Fetched by cfm-engine.js fetchFNG() every 5 minutes.
    getFNG() { return window._cfm?._fng || null; },
    getVelocity(sym) { return getProbVelocity(sym); },
    getAllVelocities() { return Object.fromEntries(Object.keys(KALSHI_15M_SERIES).map(s => [s, getProbVelocity(s)])); },
    getStatus() {
      return {
        lastFetch,
        age: lastFetch ? Date.now() - lastFetch : null,
        hasData: Object.keys(cache).length > 0,
        coinCount: Object.values(cache).filter(c => c.combinedProb !== null).length,
      };
    },
    fetchAll,
  };

})();
