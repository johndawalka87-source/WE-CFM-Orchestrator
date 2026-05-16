// window.NetworkHealth.js
// Global network health state for all market data providers
(function () {
    if (window.NetworkHealth) return; // Singleton

    const PROVIDERS = [
        'Kalshi',
        'Polymarket',
        'ProxyOrchestrator',
        'Pyth',
        // Add more as needed
    ];

    const DEFAULT_STATUS = {
        status: 'unknown', // healthy | degraded | down | unknown
        lastFetch: null,
        fallback: false,
        reason: '',
    };


    const state = {};
    const failureCounters = {}; // provider -> { count, lastDown }
    const FAILURE_THRESHOLD = 3; // cycles before alert
    const OPTIONAL_PROVIDERS = new Set([
        'Alternative.me',
        'CoinMarketCap',
        'CoinGecko',
        'Blockscout',
        'LocalProxy',
        'Blockcypher',
        'BSCScan',
        'DexScreener',
        'Chain.so',
    ]);
    const OPTIONAL_PROVIDER_KEYS = new Set([
        'alternative.me',
        'coinmarketcap',
        'coingecko',
        'blockscout',
        'localproxy',
        'blockcypher',
        'bscscan',
        'dexscreener',
        'chain.so',
        'chainso',
    ]);
    const TRANSIENT_REASON_RE = /(abort|timed?\s*out|timeout|502|503|504|429|network\s*changed|econnreset|socket hang up|failed to fetch)/i;
    const transport = {
        lastSync: null,
        priority: ['wss', 'grpc', 'rpc', 'http'],
        preferred: {},
        byKey: {},
        policy: {},
        proxy: {},
        ws: {},
        route: {},
        bus: {},
        coordination: {},
    };
    for (const p of PROVIDERS) {
        state[p] = { ...DEFAULT_STATUS };
        failureCounters[p] = { count: 0, lastDown: null, alertActive: false };
    }


    function classify(provider, statusObj) {
        const reason = String(statusObj?.reason || '');
        const inputStatus = statusObj?.status || 'unknown';
        const providerKey = String(provider || '').toLowerCase().replace(/\s+/g, '');
        const isOptional = OPTIONAL_PROVIDERS.has(provider) || OPTIONAL_PROVIDER_KEYS.has(providerKey);
        const isTransient = !!statusObj?.transient || TRANSIENT_REASON_RE.test(reason);

        let status = inputStatus;
        if (inputStatus === 'down' && (isOptional || isTransient)) {
            status = 'degraded';
        }
        if (inputStatus === 'healthy' && isTransient) {
            status = 'degraded';
        }

        return { status, isOptional, isTransient };
    }

    function update(provider, statusObj) {
        if (!state[provider]) state[provider] = { ...DEFAULT_STATUS };
        const { status, isOptional, isTransient } = classify(provider, statusObj || {});
        Object.assign(state[provider], statusObj, {
            status,
            optional: isOptional,
            transient: isTransient,
        });
        state[provider].lastUpdate = Date.now();

        // Persistent failure tracking
        if (status === 'down' && !isOptional && !isTransient) {
            failureCounters[provider].count++;
            failureCounters[provider].lastDown = Date.now();
        } else {
            failureCounters[provider].count = 0;
            failureCounters[provider].alertActive = false;
        }

        // Escalation: trigger alert if threshold breached
        if (failureCounters[provider].count >= FAILURE_THRESHOLD && !failureCounters[provider].alertActive) {
            failureCounters[provider].alertActive = true;
            // Emit alert event for UI
            if (typeof window.dispatchEvent === 'function') {
                window.dispatchEvent(new CustomEvent('network-health-alert', { detail: { provider, count: failureCounters[provider].count, since: failureCounters[provider].lastDown, reason: state[provider].reason } }));
            }
        }

        // Optionally: emit event for UI listeners
        if (typeof window.dispatchEvent === 'function') {
            window.dispatchEvent(new CustomEvent('network-health-update', { detail: { provider, ...state[provider] } }));
        }
    }

    function get(provider) {
        return provider ? state[provider] : { ...state };
    }

    function getAll() {
        return { ...state };
    }

    function updateTransport(summary) {
        if (!summary || typeof summary !== 'object') return;
        transport.lastSync = summary.lastSync || transport.lastSync || Date.now();
        if (Array.isArray(summary.priority)) transport.priority = summary.priority;
        if (summary.preferred) transport.preferred = { ...summary.preferred };
        if (summary.byKey) transport.byKey = { ...summary.byKey };
        if (summary.policy) transport.policy = { ...summary.policy };
        if (summary.proxy) transport.proxy = { ...summary.proxy };
        if (summary.ws) transport.ws = { ...summary.ws };
        if (summary.route) transport.route = { ...summary.route };
        if (summary.bus) transport.bus = { ...summary.bus };
        if (summary.coordination) transport.coordination = { ...summary.coordination };

        const kalshiPref = transport.preferred.kalshi;
        const ws = transport.ws || {};
        const now = Date.now();
        const staleAgeMs = transport.lastSync ? Math.max(0, now - transport.lastSync) : Number.POSITIVE_INFINITY;
        const syncStale = staleAgeMs > 90_000;
        const wsConnected = !!ws.connected;
        const wsStale = !!ws.stale || syncStale;
        const reconnecting = !wsConnected && Number(ws.reconnectAttempts || 0) > 0;
        const routeHint = transport.route?.reason ? ` route=${transport.route.reason}` : '';
        const failureHint = ws.lastFailureClass ? ` failure=${ws.lastFailureClass}` : '';

        if (wsConnected && !wsStale) {
            update('Kalshi', {
                status: 'healthy',
                lastFetch: ws.lastMessageTs || transport.lastSync || now,
                fallback: kalshiPref && kalshiPref !== 'wss' && kalshiPref !== 'rpc',
                reason: kalshiPref ? `via ${kalshiPref}` : 'wss live',
            });
        } else if (reconnecting || wsStale) {
            update('Kalshi', {
                status: 'degraded',
                lastFetch: ws.lastMessageTs || transport.lastSync || now,
                fallback: true,
                transient: true,
                reason: wsStale
                    ? `WSS stale${routeHint}${failureHint}`
                    : `WSS reconnecting (${ws.reconnectAttempts || 0})${routeHint}${failureHint}`,
            });
        } else if (kalshiPref) {
            update('Kalshi', {
                status: 'degraded',
                lastFetch: transport.lastSync || now,
                fallback: true,
                transient: true,
                reason: `WSS off; via ${kalshiPref}${routeHint}${failureHint}`,
            });
        } else {
            update('Kalshi', {
                status: 'down',
                lastFetch: transport.lastSync || null,
                fallback: false,
                transient: true,
                reason: `WSS disconnected${routeHint}${failureHint}`,
            });
        }

        if (typeof window.dispatchEvent === 'function') {
            window.dispatchEvent(new CustomEvent('network-transport-update', { detail: { ...transport } }));
        }

        const proxy = transport.proxy || {};
        if (proxy.mode || proxy.healthy === false || proxy.bypassActive) {
            update('LocalProxy', {
                status: proxy.mode === 'proxy' && proxy.healthy ? 'healthy' : 'degraded',
                lastFetch: proxy.ts || Date.now(),
                fallback: proxy.mode === 'bypass' || !!proxy.bypassActive,
                transient: !!proxy.bypassActive || proxy.healthy === false,
                reason: proxy.mode === 'bypass'
                    ? `hybrid bypass (${Math.round((proxy.bypassMsLeft || 0) / 1000)}s)`
                    : (proxy.healthy ? 'proxy healthy' : `proxy degraded (${proxy.failures || 0})`),
            });
        }
    }

    function getTransport() {
        return {
            lastSync: transport.lastSync,
            priority: [...transport.priority],
            preferred: { ...transport.preferred },
            byKey: { ...transport.byKey },
            policy: { ...transport.policy },
            proxy: { ...transport.proxy },
            ws: { ...transport.ws },
            route: { ...transport.route },
            bus: { ...transport.bus },
            coordination: { ...transport.coordination },
        };
    }

    window.NetworkHealth = {
        update,
        updateTransport,
        get,
        getAll,
        getTransport,
        PROVIDERS,
        failureCounters,
    };
})();
