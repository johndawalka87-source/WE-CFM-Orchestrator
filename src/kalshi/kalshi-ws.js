/**
 * Kalshi WebSocket Handler — Real-time prediction market feeds
 *
 * Public channels (no auth):
 *   - ticker: Market price snapshots
 *   - trade: Recent trades
 *   - market_lifecycle_v2: Market open/close events
 *
 * Private channels (auth required):
 *   - orderbook_delta: Live order book updates
 *   - fill: Your filled orders
 *   - market_positions: Your positions
 *   - order_group_updates: Batch order status
 *
 * Authentication:
 *   Uses RSA private key to sign: timestamp + "GET" + "/trade-api/ws/v2"
 *   Signature sent as HTTP header during WebSocket upgrade
 */

(function () {
  'use strict';

  const PUBLIC_WS_URL = 'wss://api.elections.kalshi.com/trade-api/ws/v2';
  const DEMO_WS_URL = 'wss://demo-api.kalshi.co/trade-api/ws/v2';

  // Use demo by default; set to false for production trading
  const USE_DEMO = false;
  const WS_URL = USE_DEMO ? DEMO_WS_URL : PUBLIC_WS_URL;
  const WS_PATH = '/trade-api/ws/v2';

  // Heartbeat: Kalshi closes idle connections; ping every 20 s
  const HEARTBEAT_INTERVAL_MS = 20_000;
  const RECONNECT_BASE_MS = 1_000;
  const RECONNECT_MAX_MS = 30_000;
  const CONNECT_ATTEMPT_TIMEOUT_MS = 20_000;
  const STALE_MESSAGE_MS = 75_000;
  const STALE_CHECK_MS = 12_000;
  const STALE_CONFIRM_WINDOWS = 2;
  const STALE_RECONNECT_MIN_MS = 24_000;
  let _heartbeatTimer = null;
  let _staleTimer = null;

  // Credentials from KALSHI-API-KEY.txt (first line = UUID, lines 5+ = RSA private key)
  const KALSHI_API_KEY = 'a8f1995c-7b78-430b-a1fe-7c415c67cc91'; // Replace with actual value
  const KALSHI_PRIVATE_KEY = `-----BEGIN RSA PRIVATE KEY-----
MIIEowIBAAKCAQEAurJQhLw8T4p6UkUvFvR+bSZnbmdyX4rhFepNQlg7x3c6D/+X
8A21L5UCBxuNxocYa9UswqFqljk/EEnyOdbyc0n2603Q51NH7QLmco3DwmIo7AKV
SrjyIh+GK9s8oWSUkgeJ3hJABO+5trBvz9jz8IVM3Y+Pdj/X/JyrIi2DMFSvcKBF
/Z/XVxaI/ndaKb5servjByGTKTIMa970I88edpeAZmDtHrYMC15RR71SJplSrz3i
jxgn5SKaPFMcVdNzkAWlZVovaC0YQ4GWK6g7l2occicf4ObzPmTtBMz7YVh0L/2J
FjhzO6iOPlGBu7sMYPUfEilQyPABtxpjR1SPGQIDAQABAoIBABT6La1oaB9o2Bsv
3l1mLeFuR/9h/LorBOT9PV6XwunD5gB/r87/f00AIWjyieDVc6NEIeIhmHQWLRWT
tXWVxwq4tBeW2ALx+tow8ftLngQUmvP/y04Iz14RrDX3zY1123K4CZ/r7YkQdY3H
L90LC8fJ9ovLkmtPO6HM6baupfezTub3TgcGCoMJjO1sW/p4u7KsdQrJMk/KxH5r
+jnKXDn7fdXS7Eq/zmgBQ0qBlHi/i6OHLXuWevX/I3buyzm9FQARRGWmt9qBZbJe
T+IHqrwhlFImVPvDixbbWSgrtZIpPaO8WtTDQJmneRYs9S5BuKFnYszGLiUGVWUC
kKfkQkECgYEA7+CYFCLQQHtUD3IJqL+BQh6lkW1/z6ngr13qHDHP9qfJZRbgNSrd
Gu/o9SvpEsbfsDwalAy2drI4lFj2VACTrhuGavuUKc7+1llH428pcfPtJGR6f9gH
8MSYpTrDzri6tggiqoRbyPopnuikq0HkG4E9AXuHZKDaMxW+x/Us0PkCgYEAxz6s
yhQrq+xZWw1M+Vc7iMjPGqMWnSBAHm17j6I5xL32bn3yy6iCLAOltR1oHLOwwY2X
eSOjzfwqKCnxjazAFsPUcmVshPyOXd/CxrArXC3/emEJBFP60WiZp1BUHoFSLfXc
/N0A3mgMLSH+3t08YU7Txc0t5/pIf0azelkRVyECgYEAqumEkfxIE1mMCEFBfpmM
WHcLkvXI9kZcz7aDgrk/Kshb54oID/nNdk7v1hgGRhmq8Z+xdEEmlKXhSFmmkS2k
C46TFJDR/YP98O3GGddvWUDqe16YJZTf+32oITogn57hcaeUQ5hw6V7M3ut1wIv/
IlXQCMliK6GsNm/M8h3PY8kCgYBucaeGPLgYjOLbPfw1Gs29fNKQiWa3onDobPfZ
Hqu3CzXW+ankinvdugfY5XwYrOKF597XH5JlVCpqKRXk2qV/+P2CjAYjkXu5PZfS
W0Uty7GaPL+qzoJyIfFKdZSrdDQBlg/xevBIWJSnT/jfwPL/XZq2Qo330RzusFo8
r7KVAQKBgFFqO/iSNPqpLDm7Bf/EZM0O4xJv5nc1R9LmNajBRy26E0xbKk7lGK1q
tRdZLNiraCyO3cPmiI+UrbRWP/v7X0wepj/t16ogE2y8A01svW6PiqW3VEDMdujw
N0uSfQxKmjGjqHSuaUN0OLaQAXHckEFsnOTBnSvwBRCei3N4C/36
-----END RSA PRIVATE KEY-----`;

  // ─────────────────────────────────────────────────────────────────────────────
  // Authentication (RSA signature for HTTP header during WS upgrade)
  // ─────────────────────────────────────────────────────────────────────────────

  // Use crypto from preload (Electron context) or fallback gracefully
  const crypto = (typeof window !== 'undefined' && window.desktopApp) ? window.desktopApp.crypto : null;

  /**
   * Generate RSA signature for Kalshi auth header
   * Message format: timestamp + "GET" + "/trade-api/ws/v2"
   */
  function generateSignature(timestamp) {
    const message = `${timestamp}GET${WS_PATH}`;
    try {
      const signature = crypto
        .createSign('sha256')
        .update(message)
        .sign(KALSHI_PRIVATE_KEY, 'hex');
      return signature;
    } catch (err) {
      console.error('[KalshiWS] Signature generation failed:', err.message);
      return null;
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // State
  // ─────────────────────────────────────────────────────────────────────────────

  const store = {
    // Market tickers: market_ticker → {yes_bid, yes_ask, no_bid, no_ask, last_traded, ts}
    tickers: {},
    // Recent trades: market_ticker → [{timestamp, yes_price, no_price, size}, ...]
    trades: {},
    // Order book snapshots: market_ticker → {yes_bids: [...], yes_asks: [...], no_bids: [...], no_asks: [...]}
    orderbooks: {},
    // Filled orders and open positions (populated on auth)
    fills: [],
    positions: {},
    // Error log: [{code, msg, ts}, ...]
    errors: [],
  };

  let ws = null;
  let connected = false;
  let authenticated = false;
  let reconnectAttempts = 0;
  let messageId = 1;
  let messageQueue = [];
  let readyToSend = false;
  let connectPromise = null;
  let reconnectTimer = null;
  let reconnectDueAt = 0;
  let intentionalDisconnect = false;
  let connecting = false;
  let connectStartedAt = 0;
  let connectAttemptSeq = 0;
  let lastConnectAttempt = null;
  let lastMessageTs = 0;
  let lastConnectTs = 0;
  let lastCloseReason = '';
  let lastCloseCode = null;
  let lastError = '';
  let lastRouteEventReason = '';
  let lastRouteReconnectTs = 0;
  let staleWindowCount = 0;
  let staleSinceTs = 0;
  let lastAuthStatus = 'not-attempted';
  let lastAuthError = '';
  let lastFailureClass = '';
  const pendingSubscriptions = new Map();
  const desiredMarketTickers = new Set();

  // Markets to subscribe to — resolved dynamically by market-resolver.js.
  // Falls back to these if resolver hasn't run yet.
  // Series tickers for active BTC/ETH/SOL/XRP 15-min contracts on Kalshi.
  // Series tickers — resolved to live market_tickers via market-resolver / PredictionMarkets
  const DEFAULT_SERIES = ['KXBTC15M', 'KXETH15M', 'KXSOL15M', 'KXXRP15M'];

  // ─────────────────────────────────────────────────────────────────────────────
  // Connection Management
  // ─────────────────────────────────────────────────────────────────────────────

  function _jitter(ms) {
    const extra = Math.floor(Math.random() * Math.max(80, Math.floor(ms * 0.35)));
    return ms + extra;
  }

  function _logTransport(type, detail = {}) {
    try {
      window.NetworkLog?.record?.(type, {
        provider: 'Kalshi',
        url: 'kalshi://wss',
        ...detail,
      });
    } catch (_) { }
  }

  function _isStale() {
    if (!connected) return true;
    if (!lastMessageTs) return false;
    return (Date.now() - lastMessageTs) > STALE_MESSAGE_MS;
  }

  function _resetStaleCounters() {
    staleWindowCount = 0;
    staleSinceTs = 0;
  }

  function _emitStatusUpdate(reason = '') {
    try {
      window.dispatchEvent(new CustomEvent('kalshi:ws-state', {
        detail: {
          connected,
          reconnectAttempts,
          stale: _isStale(),
          reason: reason || lastCloseReason || '',
          ts: Date.now(),
        },
      }));
    } catch (_) { }
  }

  function _formatError(err) {
    if (!err) return '';
    if (typeof err === 'string') return err;
    if (err.message) return String(err.message);
    return String(err);
  }

  function _classifyFailure(errLike) {
    const msg = _formatError(errLike).toLowerCase();
    if (msg.includes('name_not_resolved') || msg.includes('enotfound') || msg.includes('eai_again') || msg.includes('dns')) return 'dns-fail';
    if (msg.includes('cert') || msg.includes('ssl') || msg.includes('tls') || msg.includes('self signed')) return 'tls-fail';
    if (msg.includes('unexpected-response') || msg.includes('handshake') || msg.includes('upgrade')) return 'handshake-fail';
    if (msg.includes('timed out') || msg.includes('timeout') || msg.includes('abort')) return 'timeout';
    if (msg.includes('network changed') || msg.includes('err_network_changed')) return 'route-change';
    if (msg.includes('econnreset') || msg.includes('socket hang up')) return 'socket-reset';
    return 'network-fail';
  }

  function _setConnectAttemptStatus(status, extra = {}) {
    if (!lastConnectAttempt) return;
    lastConnectAttempt = {
      ...lastConnectAttempt,
      status,
      endedAt: Date.now(),
      ...extra,
    };
  }

  function _attachSocketHandlers(socket, handlers) {
    if (!socket) return;
    const add = (eventName, fn) => {
      if (typeof socket.on === 'function') {
        socket.on(eventName, fn);
      } else if (typeof socket.addEventListener === 'function') {
        socket.addEventListener(eventName, fn);
      }
    };

    add('open', () => handlers.onOpen?.());
    add('message', (...args) => {
      const first = args[0];
      const payload = first && typeof first === 'object' && Object.prototype.hasOwnProperty.call(first, 'data')
        ? first.data
        : first;
      handlers.onMessage?.(payload);
    });
    add('error', (...args) => {
      const first = args[0];
      const payload = first && typeof first === 'object' && first.error ? first.error : first;
      handlers.onError?.(payload);
    });
    add('close', (...args) => {
      const first = args[0];
      if (first && typeof first === 'object' && Object.prototype.hasOwnProperty.call(first, 'code')) {
        handlers.onClose?.(first.code, first.reason);
      } else {
        handlers.onClose?.(first, args[1]);
      }
    });
  }

  function _onceSocketEvent(socket, eventName, handler) {
    if (!socket) return () => { };
    if (typeof socket.once === 'function') {
      socket.once(eventName, handler);
      return () => { };
    }
    if (typeof socket.addEventListener === 'function') {
      const wrapped = (...args) => {
        try {
          socket.removeEventListener(eventName, wrapped);
        } catch (_) { }
        handler(...args);
      };
      socket.addEventListener(eventName, wrapped);
      return () => {
        try {
          socket.removeEventListener(eventName, wrapped);
        } catch (_) { }
      };
    }
    return () => { };
  }

  function _currentDesiredMarkets() {
    if (desiredMarketTickers.size) return [...desiredMarketTickers];
    const active = Array.isArray(window._kalshiActiveMarkets) ? window._kalshiActiveMarkets.filter(Boolean) : [];
    if (active.length) return active;
    try {
      const pm = window.PredictionMarkets?.getAll?.() || {};
      const inferred = Object.values(pm)
        .map((coin) => coin?.kalshi15m?.ticker)
        .filter(Boolean);
      return inferred;
    } catch (_) {
      return [];
    }
  }

  function _startStaleWatchdog() {
    _stopStaleWatchdog();
    _staleTimer = setInterval(() => {
      if (!connected) {
        _resetStaleCounters();
        return;
      }
      if (!_isStale()) {
        _resetStaleCounters();
        return;
      }
      staleWindowCount += 1;
      if (!staleSinceTs) staleSinceTs = Date.now();
      const ageSec = Math.round((Date.now() - lastMessageTs) / 1000);
      const staleForMs = Date.now() - staleSinceTs;
      const staleForSec = Math.round(staleForMs / 1000);
      const hasEnoughWindows = staleWindowCount >= STALE_CONFIRM_WINDOWS;
      const hasEnoughDuration = staleForMs >= STALE_RECONNECT_MIN_MS;
      if (!hasEnoughWindows && !hasEnoughDuration) {
        _emitStatusUpdate(`stale-pending:${ageSec}s`);
        return;
      }
      const reason = `stale stream (${ageSec}s without messages)`;
      console.warn(`[KalshiWS] ${reason}; forcing reconnect`);
      _logTransport('TRANSPORT_FAIL', { error: `${reason}; confirmed ${staleWindowCount} window(s), stale ${staleForSec}s` });
      _resetStaleCounters();
      reconnect('stale-watchdog');
    }, STALE_CHECK_MS);
  }

  function _stopStaleWatchdog() {
    if (_staleTimer) {
      clearInterval(_staleTimer);
      _staleTimer = null;
    }
  }

  function _closeSocketSafely() {
    if (!ws) return;
    ws = null;
  }

  function _resubscribeAfterConnect() {
    const activeMarkets = _currentDesiredMarkets();
    subscribeToTicker(activeMarkets);
    if (activeMarkets.length) {
      subscribeToOrderbook(activeMarkets);
      subscribeToTrades(activeMarkets);
    }
  }

  async function connect(meta = {}) {
    if (connected && ws) return ws;
    if (connectPromise) return connectPromise;
    connectPromise = new Promise((resolve, reject) => {
      try {
        connecting = true;
        connectStartedAt = Date.now();
        const attemptId = ++connectAttemptSeq;
        lastConnectAttempt = {
          id: attemptId,
          status: 'connecting',
          reason: String(meta.reason || 'manual-connect'),
          startedAt: connectStartedAt,
          endedAt: null,
          error: '',
        };
        const why = meta.reason ? ` (${meta.reason})` : '';
        console.log(`[KalshiWS] Connecting to ${WS_URL}${why} [attempt ${attemptId}]`);
        const WebSocketClass = (typeof window !== 'undefined' && window.desktopApp?.ws) ? window.desktopApp.ws : WebSocket;
        const usingNodeWs = !!(typeof window !== 'undefined' && window.desktopApp?.ws && WebSocketClass === window.desktopApp.ws);
        ws = usingNodeWs
          ? new WebSocketClass(WS_URL, { handshakeTimeout: CONNECT_ATTEMPT_TIMEOUT_MS, perMessageDeflate: false })
          : new WebSocketClass(WS_URL);
        _attachSocketHandlers(ws, { onOpen, onMessage, onError, onClose });

        let settled = false;
        const settle = (ok, err) => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          stopOpenOnce();
          stopErrorOnce();
          stopCloseOnce();
          connecting = false;
          if (ok) {
            _setConnectAttemptStatus('connected', { error: '' });
            resolve();
          } else {
            const errorText = _formatError(err) || 'connect attempt failed';
            const failureClass = _classifyFailure(err);
            lastFailureClass = failureClass;
            _setConnectAttemptStatus('failed', { error: errorText, failureClass });
            reject(err instanceof Error ? err : new Error(errorText));
          }
          _emitStatusUpdate(ok ? 'connect-open' : `connect-failed:${_formatError(err)}`);
        };

        const timeout = setTimeout(() => {
          settle(false, new Error(`Connection timeout (${Math.round(CONNECT_ATTEMPT_TIMEOUT_MS / 1000)}s)`));
          try { ws?.close?.(); } catch (_) { }
        }, CONNECT_ATTEMPT_TIMEOUT_MS);

        const stopOpenOnce = _onceSocketEvent(ws, 'open', () => settle(true));
        const stopErrorOnce = _onceSocketEvent(ws, 'error', (err) => settle(false, err));
        const stopCloseOnce = _onceSocketEvent(ws, 'close', (...args) => {
          if (connected) return;
          const first = args[0];
          const closeCode = first && typeof first === 'object' && Object.prototype.hasOwnProperty.call(first, 'code')
            ? first.code
            : first;
          const closeReason = first && typeof first === 'object' && Object.prototype.hasOwnProperty.call(first, 'reason')
            ? first.reason
            : args[1];
          settle(false, new Error(`closed-before-open code=${closeCode || 'n/a'} reason=${String(closeReason || '').trim() || 'none'}`));
        });
        if (typeof ws.on === 'function') {
          ws.once('unexpected-response', (_req, res) => {
            const code = res?.statusCode || 'n/a';
            const text = res?.statusMessage || 'unexpected response';
            settle(false, new Error(`unexpected-response ${code} ${text}`));
          });
        }
      } catch (err) {
        connecting = false;
        _setConnectAttemptStatus('failed', { error: _formatError(err) });
        reject(err);
      }
    }).finally(() => {
      connectPromise = null;
    });
    return connectPromise;
  }

  function onOpen() {
    console.log('[KalshiWS] Connected');
    connected = true;
    intentionalDisconnect = false;
    reconnectAttempts = 0;
    readyToSend = true;
    connecting = false;
    connectStartedAt = 0;
    lastConnectTs = Date.now();
    lastMessageTs = Date.now();
    lastCloseCode = null;
    lastCloseReason = '';
    lastError = '';
    lastFailureClass = '';
    _resetStaleCounters();
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
      reconnectDueAt = 0;
    }

    while (messageQueue.length > 0) {
      const msg = messageQueue.shift();
      ws.send(JSON.stringify(msg));
    }

    _startHeartbeat();
    _startStaleWatchdog();
    authenticatePrivate();
    _resubscribeAfterConnect();
    _logTransport('TRANSPORT_OK', { error: 'kalshi-wss-connected' });
    _emitStatusUpdate('connected');
  }

  function onMessage(data) {
    lastMessageTs = Date.now();
    _resetStaleCounters();
    _emitStatusUpdate('message');
    try {
      const msg = JSON.parse(data.toString());
      handleMessage(msg);
    } catch (err) {
      console.error('[KalshiWS] Parse error:', err.message);
    }
  }

  function onError(err) {
    lastError = String(err?.message || err || 'unknown');
    lastFailureClass = _classifyFailure(err);
    console.error('[KalshiWS] Error:', lastFailureClass, lastError);
    _emitStatusUpdate(`socket-error:${lastFailureClass}:${lastError}`);
  }

  function onClose(code, reason) {
    lastCloseCode = Number.isFinite(code) ? code : null;
    lastCloseReason = String(reason || '').trim() || lastError || 'socket closed';
    if (!lastFailureClass) {
      lastFailureClass = _classifyFailure(lastCloseReason || `code-${lastCloseCode || 'unknown'}`);
    }
    console.log('[KalshiWS] Disconnected', lastCloseCode || '', lastCloseReason);
    connected = false;
    authenticated = false;
    readyToSend = false;
    connecting = false;
    connectStartedAt = 0;
    _resetStaleCounters();
    _stopHeartbeat();
    _stopStaleWatchdog();
    _closeSocketSafely();
    _logTransport('TRANSPORT_FAIL', {
      error: `kalshi-wss-closed ${lastCloseCode || ''} ${lastCloseReason}`.trim(),
      failureClass: lastFailureClass || '',
    });
    _emitStatusUpdate(lastCloseReason);
    if (!intentionalDisconnect) reconnect('close');
  }

  function reconnect(reason = 'unknown') {
    if (intentionalDisconnect) return;
    if (reconnectTimer) return;
    if (connected && ws) {
      try {
        ws.close();
      } catch (_) { }
      connected = false;
      readyToSend = false;
      _emitStatusUpdate(`reconnect-closing:${reason}`);
    }
    reconnectAttempts++;
    const expMs = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * Math.pow(2, Math.max(0, reconnectAttempts - 1)));
    const delay = _jitter(expMs);
    console.warn(`[KalshiWS] Reconnecting in ${delay}ms (attempt ${reconnectAttempts}, reason: ${reason})`);
    _emitStatusUpdate(`reconnecting:${reason}`);
    reconnectDueAt = Date.now() + delay;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      reconnectDueAt = 0;
      connect({ reason: `reconnect:${reason}` }).catch((err) => {
        lastError = String(err?.message || err || 'connect failed');
        console.error('[KalshiWS] Reconnect failed:', lastError);
        reconnect(`connect-failed:${lastError}`);
      });
    }, delay);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Authentication
  // ─────────────────────────────────────────────────────────────────────────────

  function authenticatePrivate() {
    const timestamp = Date.now();
    // BUG FIX: was generateSignature(KALSHI_SECRET, ...) — KALSHI_SECRET undefined
    const signature = generateSignature(timestamp);
    if (!signature) {
      lastAuthStatus = 'failed';
      lastAuthError = 'signature generation failed';
      console.warn('[KalshiWS] Auth skipped: signature generation failed');
      return false;
    }

    const authMsg = {
      type: 'login',
      api_key: KALSHI_API_KEY,
      signature: signature,
      timestamp: timestamp,
    };

    sendMessage(authMsg);
    lastAuthStatus = 'sent';
    lastAuthError = '';
    console.log('[KalshiWS] Authentication request sent');
    return true;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Message Handling
  // ─────────────────────────────────────────────────────────────────────────────

  function handleMessage(msg) {
    const { type, msg: payload } = msg;

    switch (type) {
      case 'subscribed':
        // Server confirmed subscription — mark as authenticated if login succeeded
        if (!authenticated) {
          authenticated = true;
          console.log('[KalshiWS] Authenticated ✓');
        }
        {
          const subPayload = payload && typeof payload === 'object' ? payload : {};
          const ackId = subPayload.id ?? subPayload.request_id ?? null;
          const pending = ackId ? pendingSubscriptions.get(ackId) : null;
          if (ackId) pendingSubscriptions.delete(ackId);
          const ackChannels = subPayload.channels || subPayload.channel || pending?.channels || [];
          console.info('[KalshiWS] Subscription ack', {
            ackId,
            channels: Array.isArray(ackChannels) ? ackChannels : [ackChannels].filter(Boolean),
            sid: subPayload.sid ?? null,
            marketTickers: subPayload.market_tickers || pending?.marketTickers || [],
          });
          _emitStatusUpdate('subscription-ack');
        }
        break;
      case 'ticker':
        handleTicker(payload);
        break;
      case 'orderbook_snapshot':
        handleOrderbookSnapshot(payload);
        break;
      case 'orderbook_delta':
        handleOrderbookDelta(payload);
        break;
      case 'trade':
        handleTrade(payload);
        break;
      case 'pong':
        // Heartbeat acknowledged — nothing to do
        break;
      case 'error':
        if (payload?.code === 9) {
          lastAuthStatus = 'failed';
          lastAuthError = String(payload?.msg || 'authentication required');
          authenticated = false;
        }
        handleError(payload);
        break;
      default:
        console.log('[KalshiWS] Unknown message type:', type, msg);
    }
  }

  function handleTicker(payload) {
    const { market_ticker, yes_bid_dollars, yes_ask_dollars, no_bid_dollars, no_ask_dollars, last_traded_price } = payload;
    if (!market_ticker) return;

    store.tickers[market_ticker] = {
      yes_bid: yes_bid_dollars,
      yes_ask: yes_ask_dollars,
      no_bid: no_bid_dollars,
      no_ask: no_ask_dollars,
      last_traded: last_traded_price,
      ts: Date.now(),
    };

    // Emit event for app.js
    if (typeof window !== 'undefined') {
      window.dispatchEvent(
        new CustomEvent('kalshi:ticker', {
          detail: {
            market_ticker,
            yes_bid: yes_bid_dollars,
            yes_ask: yes_ask_dollars,
            no_bid: no_bid_dollars,
            no_ask: no_ask_dollars,
            last_traded: last_traded_price,
            ts: Date.now(),
          },
        })
      );
    }
  }

  function handleOrderbookSnapshot(payload) {
    const { market_ticker, yes_bid_levels, yes_ask_levels, no_bid_levels, no_ask_levels } = payload;
    if (!market_ticker) return;

    store.orderbooks[market_ticker] = {
      yes_bids: yes_bid_levels || [],
      yes_asks: yes_ask_levels || [],
      no_bids: no_bid_levels || [],
      no_asks: no_ask_levels || [],
      ts: Date.now(),
    };

    console.log(`[KalshiWS] Orderbook snapshot for ${market_ticker}`);
  }

  function handleOrderbookDelta(payload) {
    const { market_ticker, client_order_id, yes_bid_levels, yes_ask_levels, no_bid_levels, no_ask_levels } = payload;
    if (!market_ticker) return;

    // Merge delta price levels into existing snapshot
    if (store.orderbooks[market_ticker]) {
      const ob = store.orderbooks[market_ticker];

      // Helper: apply delta array — entries with size=0 remove the level
      function applyDelta(existing, delta) {
        if (!Array.isArray(delta)) return existing;
        const map = new Map(existing.map(l => [l[0], l]));
        for (const [price, size] of delta) {
          if (size === 0) {
            map.delete(price);
          } else {
            map.set(price, [price, size]);
          }
        }
        return Array.from(map.values());
      }

      if (yes_bid_levels) ob.yes_bids = applyDelta(ob.yes_bids, yes_bid_levels);
      if (yes_ask_levels) ob.yes_asks = applyDelta(ob.yes_asks, yes_ask_levels);
      if (no_bid_levels)  ob.no_bids  = applyDelta(ob.no_bids,  no_bid_levels);
      if (no_ask_levels)  ob.no_asks  = applyDelta(ob.no_asks,  no_ask_levels);
      ob.ts = Date.now();
    }

    if (client_order_id) {
      console.log(`[KalshiWS] Your order ${client_order_id} caused orderbook change on ${market_ticker}`);
    }

    if (typeof window !== 'undefined') {
      window.dispatchEvent(
        new CustomEvent('kalshi:orderbook_delta', {
          detail: {
            market_ticker,
            client_order_id,
            ts: Date.now(),
          },
        })
      );
    }
  }

  function handleTrade(payload) {
    const { market_ticker, yes_price, no_price, size, timestamp } = payload;
    if (!market_ticker) return;

    if (!store.trades[market_ticker]) {
      store.trades[market_ticker] = [];
    }

    store.trades[market_ticker].push({
      yes_price,
      no_price,
      size,
      ts: timestamp || Date.now(),
    });

    // Keep only last 100 trades per market
    if (store.trades[market_ticker].length > 100) {
      store.trades[market_ticker].shift();
    }

    if (typeof window !== 'undefined') {
      window.dispatchEvent(
        new CustomEvent('kalshi:trade', {
          detail: { market_ticker, yes_price, no_price, size, ts: timestamp || Date.now() },
        })
      );
    }
  }

  function handleError(payload) {
    const { code, msg: errorMsg } = payload;
    const errorDescription = ERROR_CODES[code] || 'Unknown error';

    console.error(`[KalshiWS] Error ${code}: ${errorMsg} (${errorDescription})`);

    store.errors.push({
      code,
      msg: errorMsg,
      description: errorDescription,
      ts: Date.now(),
    });

    // Keep last 50 errors
    if (store.errors.length > 50) {
      store.errors.shift();
    }

    // Handle specific error codes with recovery
    handleErrorRecovery(code, errorMsg);

    if (typeof window !== 'undefined') {
      window.dispatchEvent(
        new CustomEvent('kalshi:error', {
          detail: { code, msg: errorMsg, description: errorDescription, ts: Date.now() },
        })
      );
    }
  }

  function handleErrorRecovery(code, errorMsg) {
    switch (code) {
      case 2: // Params required
        console.warn('[KalshiWS] Missing params in message — check subscription format');
        break;
      case 3: // Channels required
        console.warn('[KalshiWS] Missing channels array — subscription requires "channels"');
        break;
      case 5: // Unknown command
        console.error('[KalshiWS] Invalid command — check cmd field');
        break;
      case 6: // Already subscribed
        console.warn('[KalshiWS] Duplicate subscription — skipping');
        break;
      case 8: // Unknown channel name
        console.error('[KalshiWS] Invalid channel — valid: ticker, trade, orderbook_delta, orderbook_snapshot');
        break;
      case 9: // Authentication required
        console.error('[KalshiWS] Private channel requires authentication');
        break;
      case 14: // Market Ticker required
        console.error('[KalshiWS] Market specification required — provide market_ticker or market_id');
        break;
      case 16: // Market not found
        console.error('[KalshiWS] Market not found — verify market_ticker is valid');
        break;
      case 17: // Internal error
        console.error('[KalshiWS] Server-side error — retry later');
        break;
      case 18: // Command timeout
        console.warn('[KalshiWS] Server timeout — retrying subscription');
        // Could implement retry logic here
        break;
      default:
        console.log('[KalshiWS] Error code:', code);
    }
  }

  const ERROR_CODES = {
    1: 'Unable to process message',
    2: 'Params required',
    3: 'Channels required',
    4: 'Subscription IDs required',
    5: 'Unknown command',
    6: 'Already subscribed',
    7: 'Unknown subscription ID',
    8: 'Unknown channel name',
    9: 'Authentication required',
    10: 'Channel error',
    11: 'Invalid parameter',
    12: 'Exactly one subscription ID is required',
    13: 'Unsupported action',
    14: 'Market Ticker required',
    15: 'Action required',
    16: 'Market not found',
    17: 'Internal error',
    18: 'Command timeout',
    19: 'shard_factor must be > 0',
    20: 'shard_factor is required when shard_key is set',
    21: 'shard_key must be >= 0 and < shard_factor',
    22: 'shard_factor must be <= 100',
  };

  // ─────────────────────────────────────────────────────────────────────────────
  // Subscriptions
  // ─────────────────────────────────────────────────────────────────────────────

  function subscribeToTicker(marketTickers = []) {
    const list = (Array.isArray(marketTickers) ? marketTickers : []).filter(Boolean);
    const msg = {
      id: messageId++,
      cmd: 'subscribe',
      params: {
        channels: ['ticker', 'market_lifecycle_v2'],
        ...(list.length ? { market_tickers: list } : {}),
      },
    };
    pendingSubscriptions.set(msg.id, {
      channels: [...msg.params.channels],
      marketTickers: list,
      ts: Date.now(),
    });
    sendMessage(msg);
    console.log(`[KalshiWS] Subscribing to ticker channel (${list.length || 'global'} markets)`);
  }

  function subscribeToOrderbook(marketTickers) {
    if (!marketTickers || marketTickers.length === 0) {
      console.warn('[KalshiWS] No markets specified for orderbook subscription');
      return;
    }

    const msg = {
      id: messageId++,
      cmd: 'subscribe',
      params: {
        channels: ['orderbook_delta', 'orderbook_snapshot'],
        market_tickers: marketTickers,
      },
    };
    pendingSubscriptions.set(msg.id, {
      channels: [...msg.params.channels],
      marketTickers: [...marketTickers],
      ts: Date.now(),
    });
    sendMessage(msg);
    console.log(`[KalshiWS] Subscribing to orderbook for ${marketTickers.length} markets`);
  }

  function subscribeToTrades(marketTickers) {
    if (!marketTickers || marketTickers.length === 0) {
      console.warn('[KalshiWS] No markets specified for trade subscription');
      return;
    }

    const msg = {
      id: messageId++,
      cmd: 'subscribe',
      params: {
        channels: ['trade'],
        market_tickers: marketTickers,
      },
    };
    pendingSubscriptions.set(msg.id, {
      channels: [...msg.params.channels],
      marketTickers: [...marketTickers],
      ts: Date.now(),
    });
    sendMessage(msg);
    console.log(`[KalshiWS] Subscribing to trades for ${marketTickers.length} markets`);
  }

  function unsubscribe(subscriptionIds) {
    if (!subscriptionIds || subscriptionIds.length === 0) {
      console.warn('[KalshiWS] No subscription IDs specified');
      return;
    }

    const msg = {
      id: messageId++,
      cmd: 'unsubscribe',
      params: {
        sids: subscriptionIds,
      },
    };
    sendMessage(msg);
    console.log(`[KalshiWS] Unsubscribing from ${subscriptionIds.length} subscription(s)`);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Utilities
  // ─────────────────────────────────────────────────────────────────────────────

  function sendMessage(msg) {
    if (!readyToSend) {
      messageQueue.push(msg);
      return;
    }

    try {
      ws.send(JSON.stringify(msg));
    } catch (err) {
      console.error('[KalshiWS] Send error:', err.message);
      messageQueue.push(msg); // Retry on reconnect
    }
  }

  async function disconnect() {
    intentionalDisconnect = true;
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
      reconnectDueAt = 0;
    }
    _stopHeartbeat();
    _stopStaleWatchdog();
    if (ws) {
      ws.close();
      ws = null;
    }
    connected = false;
    authenticated = false;
    readyToSend = false;
    _emitStatusUpdate('disconnected');
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Heartbeat — keeps the connection alive; Kalshi closes idle sockets
  // ─────────────────────────────────────────────────────────────────────────────

  function _startHeartbeat() {
    _stopHeartbeat();
    _heartbeatTimer = setInterval(() => {
      if (!connected || !readyToSend) return;
      try {
        ws.send(JSON.stringify({ id: messageId++, cmd: 'ping' }));
      } catch (err) {
        console.warn('[KalshiWS] Heartbeat send failed:', err.message);
      }
    }, HEARTBEAT_INTERVAL_MS);
    console.log('[KalshiWS] Heartbeat started (every', HEARTBEAT_INTERVAL_MS / 1000, 's)');
  }

  function _stopHeartbeat() {
    if (_heartbeatTimer) {
      clearInterval(_heartbeatTimer);
      _heartbeatTimer = null;
    }
  }

  function getState() {
    const reconnectInMs = reconnectTimer ? Math.max(0, reconnectDueAt - Date.now()) : 0;
    const connectingForMs = connecting && connectStartedAt ? Math.max(0, Date.now() - connectStartedAt) : 0;
    return {
      connected,
      connecting,
      connectingForMs,
      authenticated,
      stale: _isStale(),
      reconnectAttempts,
      reconnectInMs,
      lastMessageTs: lastMessageTs || null,
      lastConnectTs: lastConnectTs || null,
      lastCloseCode,
      lastCloseReason,
      lastError,
      lastFailureClass,
      lastRouteEventReason,
      lastConnectAttempt,
      lastAuthStatus,
      lastAuthError,
      tickers: Object.keys(store.tickers).length,
      trades: Object.values(store.trades).reduce((sum, t) => sum + t.length, 0),
      fills: store.fills.length,
      positions: Object.keys(store.positions).length,
    };
  }

  function getSnapshot() {
    return store;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Export
  // ─────────────────────────────────────────────────────────────────────────────

  function subscribeMarkets(marketTickers) {
    const list = (Array.isArray(marketTickers) ? marketTickers : []).filter(Boolean);
    if (!list.length) return;
    window._kalshiActiveMarkets = list;
    desiredMarketTickers.clear();
    for (const ticker of list) desiredMarketTickers.add(ticker);
    if (!connected) return;
    subscribeToTicker(list);
    subscribeToOrderbook(list);
    subscribeToTrades(list);
  }

  function reconnectNow(reason = 'manual') {
    intentionalDisconnect = false;
    lastRouteEventReason = reason;
    reconnectAttempts = 0;
    if (connected && ws) {
      try { ws.close(); } catch (_) { }
      return;
    }
    reconnect(reason);
  }

  const KalshiWS = {
    connect,
    disconnect,
    reconnectNow,
    sendMessage,
    getState,
    getSnapshot,
    subscribeMarkets,
    store, // Direct access for debugging
    DEFAULT_SERIES,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = KalshiWS;
  }

  if (typeof window !== 'undefined') {
    window.addEventListener('proxy-route-change', (event) => {
      const detail = event?.detail || {};
      const stage = String(detail.stage || '');
      const reason = String(detail.reason || 'route-change');
      const proxied = String(detail.proxied || '').toLowerCase();
      const reasonLower = reason.toLowerCase();
      const provider = String(detail.provider || '').toLowerCase();
      const kalshiScoped = provider === 'kalshi' || proxied.includes('/kalshi') || reasonLower.includes('kalshi');
      const wsUnhealthy = !connected || _isStale();
      const nowTs = Date.now();
      const cooldownOk = (nowTs - lastRouteReconnectTs) > 12_000;

      // Avoid reconnect storms from optional-provider proxy churn.
      if ((stage === 'reinit-done' || stage === 'route-error') && cooldownOk && kalshiScoped) {
        lastRouteReconnectTs = nowTs;
        lastRouteEventReason = reason;
        console.info(`[KalshiWS] Route change event (${stage}) → reconnect (${reason})`);
        reconnectNow(`route:${reason}`);
      } else if (!kalshiScoped && wsUnhealthy && stage === 'network-failure') {
        lastFailureClass = String(detail.failureClass || 'network-fail');
        _emitStatusUpdate(`non-kalshi-network-failure:${lastFailureClass}`);
      }
    });

    window.KalshiWS = KalshiWS;
  }
})();
