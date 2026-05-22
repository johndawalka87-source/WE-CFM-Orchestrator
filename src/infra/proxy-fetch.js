// ================================================================
// WE CFM ALPHA-1.3 — Smart Proxy Shim
//
// CORS is just a browser bouncer with a clipboard — it only fires
// when the browser asks. Electron (webSecurity:false) already
// dismissed that bouncer. The proxy's REAL job is server-side:
//
//  BUCKET A — CF_PROTECTED   : Cloudflare Bot Mgmt / 403 without
//                               Chrome TLS fingerprint → ALWAYS proxy
//  BUCKET B — RATE_LIMITED   : Public APIs that throttle heavily
//                               → proxy adds caching headroom
//  BUCKET C — OPEN           : No server-side block
//                               → direct in Electron, proxy in browser
//
// In Electron (file://): only bucket A+B go through proxy
// In browser  (http://): everything goes through proxy (CORS is live)
//
// PORT CASCADE: proxy tries 3010→3014 and binds the first free port.
// proxy-fetch discovers the live port via XHR health-checks and
// updates PROXY_ORIGIN in-flight, then syncs via IPC confirmation.
// ================================================================

(function () {
  'use strict';

  const PORT_CASCADE = [3010, 3011, 3012, 3013, 3014, 3015, 3016, 3017, 3018, 3019, 3020];

  // Start in direct mode; enable proxy only after positive health discovery.
  let PROXY_ORIGIN = null;
  let proxyReady = false;

  const IS_ELECTRON = window.location.protocol === 'file:';

  // ── Bucket A: Cloudflare Bot Mgmt — always needs the proxy ──────────────
  const CF_PROTECTED = new Set([
    'api.bybit.com',
    'api.bytick.com',   // Bybit EU/Asia mirror — automatic geo-fence failover
    'www.okx.com',
    'api-pub.bitfinex.com',
    'api.kucoin.com',
    'api.mexc.com',
    'api.crypto.com',
    'clob.polymarket.com',
    'gamma-api.polymarket.com',
  ]);

  // ── Bucket B: rate-limited public APIs — proxy for headroom ─────────────
  const RATE_LIMITED = new Set([
    'api.coingecko.com',
    'api.dexscreener.com',
    'api.blockchair.com',
    'hypurrscan.io',
    'api.etherscan.io',
    'api.bscscan.com',
  ]);

  // ── Bucket C: open / first-party APIs — direct ok in Electron ───────────
  // (still proxied in browser so the CORS bouncer doesn't fire)
  // api.binance.us, fapi.binance.com, api.coinbase.com,
  // api.exchange.coinbase.com, api.kraken.com, api.elections.kalshi.com,
  // s2.ripple.com, xrplcluster.com, api.mainnet-beta.solana.com,
  // eth.blockscout.com, bsc.blockscout.com, api.blockcypher.com, mempool.space, api.hyperliquid.xyz

  // hostname → proxy exchange prefix (config.toml keys)
  const HOST_MAP = {
    'api.binance.us': 'binance',
    'api.binance.com': 'binance',  // Binance spot geoblocked (451)
    'fapi.binance.com': 'binance-f',
    'api.coingecko.com': 'coingecko',
    'api.coinbase.com': 'coinbase',
    'api.exchange.coinbase.com': 'coinbase-ex',
    'api.kraken.com': 'kraken',
    'api.bybit.com': 'bybit',
    'api.bytick.com': 'bybit',   // EU mirror — same proxy route
    'www.okx.com': 'okx',
    'api.elections.kalshi.com': 'kalshi',
    'gamma-api.polymarket.com': 'polymarket',
    'clob.polymarket.com': 'polymarket-clob',
    'api-pub.bitfinex.com': 'bitfinex',
    'api.kucoin.com': 'kucoin',
    'api.mexc.com': 'mexc',
    'hypurrscan.io': 'hypurrscan',
    'api.dexscreener.com': 'dexscreener',
    'mempool.space': 'mempool',
    'api.blockchair.com': 'blockchair',
    'api.etherscan.io': 'etherscan',
    'api.bscscan.com': 'bscscan',
    'eth.blockscout.com': 'blockscout-eth',
    'bsc.blockscout.com': 'blockscout-bsc',
    'api.hyperliquid.xyz': 'hyperliquid',
    'api.blockcypher.com': 'blockcypher',
    's2.ripple.com': 'ripple',
    'xrplcluster.com': 'xrpl',
    'api.mainnet-beta.solana.com': 'solana',
    'api.crypto.com': 'crypto-com',
  };

  const _origFetch = window.fetch.bind(window);
  const EXTERNAL = /^https?:\/\//;

  function needsProxy(hostname) {
    if (!IS_ELECTRON) return true;           // browser: CORS bouncer is live → proxy everything
    return CF_PROTECTED.has(hostname) || RATE_LIMITED.has(hostname);
  }

  function rewrite(url) {
    if (!EXTERNAL.test(url)) return url;
    try {
      const u = new URL(url);
      if (!needsProxy(u.hostname)) return url; // Bucket C in Electron → go direct

      // Proxy offline (never found on any port) → pass through and let it fail naturally
      if (!PROXY_ORIGIN) return url;

      const prefix = HOST_MAP[u.hostname];
      if (prefix) {
        const p = u.pathname.replace(/^\//, '');
        return `${PROXY_ORIGIN}/${prefix}/${p}${u.search}`;
      }
      // Unknown host → generic escape hatch
      return `${PROXY_ORIGIN}/proxy?url=${encodeURIComponent(url)}`;
    } catch (_) {
      return url;
    }
  }

  const IGNORE_DOMAINS = /timeapi\.io|kalshi\.com|polymarket\.com/i;

  window.fetch = function (input, init) {
    if (typeof input === 'string') {
      if (!IGNORE_DOMAINS.test(input)) input = rewrite(input);
    } else if (input instanceof Request && EXTERNAL.test(input.url)) {
      if (!IGNORE_DOMAINS.test(input.url)) {
        const rw = rewrite(input.url);
        if (rw !== input.url) input = new Request(rw, input);
      }
    }
    return _origFetch(input, init);
  };

  // ── Port cascade discovery via XHR (avoids patching our own patched fetch) ──
  // Uses XMLHttpRequest so it bypasses the window.fetch patch above.
  // Runs immediately; PROXY_ORIGIN is updated as soon as a live port is found.
  (function discoverProxyPort() {
    let idx = 0;

    // We previously trusted window.__PROXY_PORT__ here, but main.js sometimes injects
    // a stale default (3010) before the Rust proxy has bound to a dynamic port (e.g. 3012).
    // To ensure 100% reliability, we ALWAYS ping the cascade ports to verify health.
    function tryNext() {
      if (idx >= PORT_CASCADE.length) {
        if (!window.__PROXY_PORT__) {
          setTimeout(discoverProxyPort, 1000); // retry every 1s
          return;
        }
        PROXY_ORIGIN = null;
        console.warn('[WE] proxy-fetch — proxy not found on any port; proxied calls will go direct');
        return;
      }
      const port = PORT_CASCADE[idx++];
      const xhr = new XMLHttpRequest();
      xhr.timeout = 500;
      xhr.onload = function () {
        if (xhr.status === 200 && xhr.responseText.trim() === 'OK') {
          PROXY_ORIGIN = `http://127.0.0.1:${port}`;
          proxyReady = true;
          console.info(`[WE] proxy-fetch v1.4 — live on port ${port}`);
          // Also let the IPC confirm (in case main.js finishes parsing stdout later)
          if (window.desktopApp?.proxyPort) {
            window.desktopApp.proxyPort().then(p => {
              if (p && p !== port) {
                PROXY_ORIGIN = `http://127.0.0.1:${p}`;
                console.info(`[WE] proxy-fetch — IPC corrected port to ${p}`);
              }
            }).catch(() => { });
          }
        } else {
          tryNext();
        }
      };
      xhr.onerror = tryNext;
      xhr.ontimeout = tryNext;
      xhr.open('GET', `http://127.0.0.1:${port}/health`, true);
      xhr.send();
    }

    tryNext();
  })();

  const mode = IS_ELECTRON ? 'Electron (A+B→proxy, C→direct)' : 'browser (all→proxy)';
  console.info(`[WE] proxy-fetch v1.4 — ${mode} — cascade: ${PORT_CASCADE.join(',')}`);
})();

