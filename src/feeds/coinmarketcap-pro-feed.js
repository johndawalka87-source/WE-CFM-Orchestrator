/**
 * coinmarketcap-pro-feed.js — CoinMarketCap Pro API Integration
 *
 * Provides real-time market data via CoinMarketCap Pro API:
 * - Latest quotes (price, market cap, volume, change %)
 * - Fear & Greed Index (macro sentiment)
 * - Global market metrics
 *
 * ★ TRIAL MODE (DEFAULT): Works WITHOUT API key — no user setup required!
 * ★ PRO MODE: Auto-upgrades when API key is provided for higher quota
 *
 * Trial Docs: https://pro-api.coinmarketcap.com/trial-pro-api
 * Pro Docs: https://pro-api.coinmarketcap.com/v1/cryptocurrency/quotes/latest
 */

(function () {
  'use strict';

  // ── Config ──────────────────────────────────────────────────────
  const CMC_TRIAL_BASE_URL = 'https://pro-api.coinmarketcap.com/trial-pro-api';  // ★ No API key!
  const CMC_PRO_BASE_URL = 'https://pro-api.coinmarketcap.com/v1';  // Requires API key
  const CMC_QUOTES_PATH = '/cryptocurrency/quotes/latest';
  const CMC_GLOBAL_PATH = '/global-metrics/quotes/latest';
  const CMC_FEAR_INDEX_PATH = '/fear-and-greed/latest';
  const CACHE_TTL_MS = 5 * 60 * 1000;  // 5-min cache for live quotes
  const POLL_MS = 60_000;  // 60-sec poll (anti-throttle)
  const CMC_RATE_LIMIT_COOLDOWN_MS = 10 * 60 * 1000;
  const CMC_AUTH_COOLDOWN_MS = 30 * 60 * 1000;
  const FNG_TIMEOUT_MS = 5000;
  const cache = {};   // sym → { price, marketCap, volume24h, change24h, ts }
  const globalMetrics = {}; // { dominance, totalMarketCap, totalVolume24h, ts }
  const fearGreed = {}; // { value, label, ts }
  let cmcFearGreedUnsupported = false;
  let cmcRateLimitedUntil = 0;
  let cmcProDisabledUntil = 0;

  // ── Credential helpers ──────────────────────────────────────────────────────
  function getApiKey() {
    try {
      const stored = localStorage.getItem('cmc_pro_api_key');
      if (stored && stored.trim()) return stored.trim();
    } catch (_) { }
    try {
      const env = window.__env?.CMC_PRO_API_KEY || window.__env?.COINMARKETCAP_API_KEY;
      if (env && String(env).trim()) return String(env).trim();
    } catch (_) { }
    return '';
  }

  function setApiKey(key) {
    const normalized = String(key || '').trim();
    if (normalized) localStorage.setItem('cmc_pro_api_key', normalized);
    else localStorage.removeItem('cmc_pro_api_key');
    cmcProDisabledUntil = 0;
  }

  function hasApiKey() { return !!getApiKey() && Date.now() >= cmcProDisabledUntil; }
  function getBaseUrl() { return hasApiKey() ? CMC_PRO_BASE_URL : CMC_TRIAL_BASE_URL; }

  function symbolList(symbols) {
    return Array.isArray(symbols)
      ? symbols.map(s => String(s).trim()).filter(Boolean)
      : String(symbols || '').split(',').map(s => s.trim()).filter(Boolean);
  }

  function cachedQuotes(symbols) {
    const out = {};
    symbolList(symbols).forEach(sym => {
      const cached = getCachedQuote(sym);
      if (cached) out[sym] = cached;
    });
    return out;
  }

  function cmcPayloadError(json) {
    const raw = json?.status?.error_code;
    const code = raw == null ? 0 : Number(raw);
    return Number.isFinite(code) && code !== 0
      ? json?.status?.error_message || `CMC status error ${raw}`
      : '';
  }

  function handleCmcFailure(status, message) {
    if (status === 429 || /rate|limit|quota/i.test(message || '')) {
      cmcRateLimitedUntil = Date.now() + CMC_RATE_LIMIT_COOLDOWN_MS;
      console.warn(`[CMC] Rate limited; cooling down until ${new Date(cmcRateLimitedUntil).toLocaleTimeString()}`);
    }
    if (status === 401 || /api key|unauthorized/i.test(message || '')) {
      cmcProDisabledUntil = Date.now() + CMC_AUTH_COOLDOWN_MS;
      console.warn('[CMC] Pro key rejected; using keyless trial mode for this session window.');
    }
  }

  function isCoolingDown() {
    return Date.now() < cmcRateLimitedUntil;
  }

  // ── Rate limiter (CMC Trial: ~30 req/min; Pro: 10K/month = ~14 req/min) ──────────────────
  let _lastRequestTime = 0;
  const REQUEST_MIN_GAP_MS = 2000; // ~30 req/min; safe for both modes

  async function _rateLimitedFetch(url, options) {
    const now = Date.now();
    const gap = now - _lastRequestTime;
    if (gap < REQUEST_MIN_GAP_MS) {
      await new Promise(r => setTimeout(r, REQUEST_MIN_GAP_MS - gap));
    }
    _lastRequestTime = Date.now();
    return fetch(url, options);
  }

  // ── Latest quotes (multi-symbol) ────────────────────────────────────────────
  async function getLatestQuotes(symbols) {
    const apiKey = getApiKey();
    const symbolStr = symbolList(symbols).join(',');
    const baseUrl = getBaseUrl();
    const isProMode = hasApiKey();

    if (!symbolStr) return {};
    if (isCoolingDown()) return cachedQuotes(symbols);

    try {
      // Trial uses /trial-pro-api/v1/... vs Pro uses /v1/... (both same path)
      const url = `${baseUrl}${CMC_QUOTES_PATH}?symbol=${encodeURIComponent(symbolStr)}&convert=USD`;

      // Try ProxyOrchestrator if available for deduplication and caching
      if (typeof window.ProxyOrchestrator !== 'undefined' && window._proxyOrchestrator) {
        try {
          const result = await window._proxyOrchestrator.fetch(url, {
            endpoint: 'cmc',
            cacheType: 'price-quotes',
            retries: 2,
            fallbackChain: ['cmc', 'pyth', 'cache'],
          });

          // Cache result in local cache for backwards compatibility
          const payloadError = cmcPayloadError(result);
          if (payloadError) {
            handleCmcFailure(200, payloadError);
            console.warn(`[CMC ${isProMode ? 'Pro' : 'Trial'}] Quotes payload error: ${payloadError}`);
            return cachedQuotes(symbols);
          }

          if (result && result.data) {
            Object.entries(result.data).forEach(([sym, data]) => {
              const usd = data.quote?.USD || {};
              cache[sym] = {
                price: usd.price || 0,
                marketCap: usd.market_cap || 0,
                volume24h: usd.volume_24h || 0,
                change24h: usd.percent_change_24h || 0,
                ts: Date.now()
              };
            });
          }

          console.info(`[CMC ${isProMode ? 'Pro' : 'Trial'}] Quotes via proxy: ${Object.keys(result?.data || {}).length} coins ✓`);
          return result?.data || {};
        } catch (err) {
          console.warn(`[CMC] ProxyOrchestrator failed, falling back:`, err.message);
        }
      }

      // Fallback: direct fetch with rate limiting
      const headers = { 'Accept': 'application/json' };
      if (isProMode) headers['X-CMC_PRO_API_KEY'] = apiKey;

      // Add rate limiter call before fetch
      if (window.ApiRateLimiter) {
        const limiter = window.ApiRateLimiter.getLimiter('coinmarketcap');
        await limiter.acquire();
      }

      const resp = await _rateLimitedFetch(url, { method: 'GET', headers });

      if (!resp.ok) {
        const err = await resp.text().catch(() => '');
        handleCmcFailure(resp.status, err);
        if (resp.status === 401) {
          console.error('[CMC] 401 Unauthorized - Invalid or missing API key');
          console.info('[CMC] Falling back to trial mode...');
        } else {
          console.warn(`[CMC ${isProMode ? 'Pro' : 'Trial'}] Quotes (${resp.status}):`, err.slice(0, 100));
        }
        return cachedQuotes(symbols);
      }

      const json = await resp.json();
      const payloadError = cmcPayloadError(json);
      if (payloadError) {
        handleCmcFailure(200, payloadError);
        console.warn(`[CMC ${isProMode ? 'Pro' : 'Trial'}] Quotes payload error: ${payloadError}`);
        return cachedQuotes(symbols);
      }
      if (!json.data) return cachedQuotes(symbols);

      const result = {};
      Object.entries(json.data).forEach(([sym, data]) => {
        const usd = data.quote?.USD || {};
        result[sym] = {
          price: usd.price || 0,
          marketCap: usd.market_cap || 0,
          volume24h: usd.volume_24h || 0,
          change24h: usd.percent_change_24h || 0,
          ts: Date.now()
        };
        cache[sym] = result[sym];
      });

      console.info(`[CMC ${isProMode ? 'Pro' : 'Trial'}] Quotes: ${Object.keys(result).length} coins ✓`);
      return result;
    } catch (e) {
      console.warn(`[CMC ${isProMode ? 'Pro' : 'Trial'}] Quotes error:`, e.message);
      return cachedQuotes(symbols);
    }
  }

  // ── Global market metrics ────────────────────────────────────────────────────
  async function getGlobalMetrics() {
    const baseUrl = getBaseUrl();
    const isProMode = hasApiKey();
    const apiKey = getApiKey();

    if (isCoolingDown()) return globalMetrics;

    try {
      const url = `${baseUrl}${CMC_GLOBAL_PATH}?convert=USD`;
      const headers = { 'Accept': 'application/json' };
      if (isProMode) headers['X-CMC_PRO_API_KEY'] = apiKey;

      const resp = await _rateLimitedFetch(url, { method: 'GET', headers });

      if (!resp.ok) {
        const err = await resp.text().catch(() => '');
        handleCmcFailure(resp.status, err);
        console.warn(`[CMC ${isProMode ? 'Pro' : 'Trial'}] Metrics (${resp.status})`);
        return globalMetrics;
      }

      const json = await resp.json();
      const payloadError = cmcPayloadError(json);
      if (payloadError) {
        handleCmcFailure(200, payloadError);
        console.warn(`[CMC ${isProMode ? 'Pro' : 'Trial'}] Metrics payload error: ${payloadError}`);
        return globalMetrics;
      }
      if (!json.data) return globalMetrics;

      const data = json.data;
      globalMetrics.totalMarketCap = data.quote?.USD?.total_market_cap || 0;
      globalMetrics.totalVolume24h = data.quote?.USD?.total_volume_24h || 0;
      globalMetrics.btcDominance = data.btc_dominance || 0;
      globalMetrics.cryptoCount = data.active_cryptocurrencies || 0;
      globalMetrics.ts = Date.now();

      console.info(`[CMC ${isProMode ? 'Pro' : 'Trial'}] Metrics (BTC dom: ${globalMetrics.btcDominance.toFixed(1)}%) ✓`);
      return globalMetrics;
    } catch (e) {
      console.warn(`[CMC ${isProMode ? 'Pro' : 'Trial'}] Metrics error:`, e.message);
      return globalMetrics;
    }
  }

  // ── Fear & Greed Index ────────────────────────────────────────────────────
  async function getFearGreedIndex() {
    try {
      // Primary: CoinMarketCap (if available)
      if (!isCoolingDown() && !cmcFearGreedUnsupported) {
        const cmcUrl = `${getBaseUrl()}${CMC_FEAR_INDEX_PATH}`;
        const cmcHeaders = { 'Accept': 'application/json' };
        if (hasApiKey()) cmcHeaders['X-CMC_PRO_API_KEY'] = getApiKey();

        try {
          const resp = await _rateLimitedFetch(cmcUrl, { method: 'GET', headers: cmcHeaders });
          if (resp.ok) {
            // Add rate limiter call before processing response
            if (window.ApiRateLimiter) {
              const limiter = window.ApiRateLimiter.getLimiter('coinmarketcap');
              await limiter.acquire();
            }

            const json = await resp.json();
            const payloadError = cmcPayloadError(json);
            if (payloadError) {
              handleCmcFailure(200, payloadError);
              console.info('[CMC] F&G payload unavailable; using Alternative.me.');
            } else if (json.data) {
              const data = Array.isArray(json.data) ? json.data[0] : json.data;
              fearGreed.value = data.value || null;
              fearGreed.label = data.value_classification || 'N/A';
              fearGreed.ts = Date.now();
              console.info(`[CMC] F&G: ${fearGreed.value} (${fearGreed.label}) ✓`);
              return fearGreed;
            }
          } else if (resp.status === 404) {
            cmcFearGreedUnsupported = true;
            console.info('[CMC] F&G endpoint unsupported (404); using Alternative.me only for this session.');
          } else if (resp.status === 401) {
            handleCmcFailure(resp.status, await resp.text().catch(() => ''));
            console.error('[CMC] 401 Unauthorized - Invalid or missing API key');
            console.info('[CMC] Falling back to Alternative.me...');
          } else if (resp.status === 429) {
            handleCmcFailure(resp.status, await resp.text().catch(() => ''));
            console.info('[CMC] F&G rate limited; using Alternative.me.');
          }
        } catch (cmcErr) {
          console.debug('[CMC] F&G failed, trying Alternative.me:', cmcErr.message);
        }
      }

      // Fallback: Alternative.me (free, no auth required)
      // Timeout: 5s (still non-blocking, less noisy on slow routes)
      const altUrl = 'https://api.alternative.me/fng/';
      const altResp = await fetch(altUrl, { signal: AbortSignal.timeout(FNG_TIMEOUT_MS) });
      if (altResp.ok) {
        const json = await altResp.json();
        const data = json.data?.[0] || json;
        fearGreed.value = parseInt(data.value, 10);
        fearGreed.label = data.value_classification || 'NEUTRAL';
        fearGreed.ts = Date.now();
        console.info(`[Alternative.me] F&G: ${fearGreed.value} (${fearGreed.label}) ✓`);
        return fearGreed;
      }

      console.warn('[F&G] Both CMC and Alternative.me failed - using cached value');
      return fearGreed;
    } catch (e) {
      console.warn(`[F&G] Timeout/error after ${FNG_TIMEOUT_MS / 1000}s: ${e.message} - using cached value`);
      return fearGreed;  // Return cached value on timeout/error
    }
  }

  // ── Cached quote accessor ──────────────────────────────────────────────────────
  function getCachedQuote(symbol) {
    const cached = cache[symbol];
    if (!cached) return null;
    const age = Date.now() - cached.ts;
    if (age > CACHE_TTL_MS) return null;
    return cached;
  }

  // ── Poll handler (auto-refresh on interval) ──────────────────────────────────
  let _pollTimer = null;

  function startPolling(symbols, interval = POLL_MS) {
    if (_pollTimer) return;
    const pollFn = async () => {
      const mode = hasApiKey() ? 'Pro' : 'Trial';
      console.debug(`[CMC ${mode}] Poll (${symbols.length} coins)…`);
      await getLatestQuotes(symbols);
      await getGlobalMetrics();
      await getFearGreedIndex();
    };
    pollFn().catch(e => console.warn('[CMC] Poll init failed:', e.message));
    _pollTimer = setInterval(pollFn, interval);
    console.info(`[CMC ${hasApiKey() ? 'Pro' : 'Trial'}] Polling: ${interval}ms (${symbols.length} coins)`);
  }

  function stopPolling() {
    if (_pollTimer) {
      clearInterval(_pollTimer);
      _pollTimer = null;
      console.info('[CMC] Polling stopped');
    }
  }

  // ── Public API ──────────────────────────────────────────────────────────────
  window._cmcProFeed = {
    setApiKey,
    getApiKey,
    hasApiKey,
    getLatestQuotes,
    getGlobalMetrics,
    getFearGreedIndex,
    getCachedQuote,
    startPolling,
    stopPolling,
    cache: () => cache,
    globalMetrics: () => globalMetrics,
    fearGreed: () => fearGreed
  };

  console.info(`[CMC] Stack initialized: ${hasApiKey() ? '✓ Pro mode' : '✓ Trial mode (keyless)'}`);
})();
