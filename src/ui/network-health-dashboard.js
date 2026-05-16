// network-health-dashboard.js
// UI panel for displaying network health of all market data providers
(function () {
    if (window.NetworkHealthDashboard) return;

    const MINIMIZED_STORAGE_KEY = 'wecrypto.networkHealthDashboard.minimized';
    const dash = document.createElement('div');
    dash.id = 'network-health-dashboard';
    dash.style.position = 'fixed';
    dash.style.bottom = '18px';
    dash.style.left = 'max(16px, calc(var(--sidebar-w, 280px) + 16px))';
    dash.style.right = 'auto';
    dash.style.maxWidth = 'min(380px, calc(100vw - 32px))';
    dash.style.zIndex = 8990;
    dash.style.background = 'rgba(24,28,36,0.98)';
    dash.style.border = '1.5px solid #333';
    dash.style.borderRadius = '10px';
    dash.style.boxShadow = '0 2px 12px #0008';
    dash.style.padding = '14px 18px 10px 18px';
    dash.style.minWidth = '280px';
    dash.style.fontFamily = 'JetBrains Mono, monospace';
    dash.style.fontSize = '14px';
    dash.style.color = '#e0e6f0';
    dash.style.pointerEvents = 'auto';

    dash.innerHTML = `
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;">
            <div style="font-weight:600;font-size:15px;letter-spacing:0.5px;">Network Health</div>
            <button id="network-health-min-btn" class="hud-icon-btn" type="button" title="Minimize"
                style="padding:2px 6px;border-radius:6px;font-size:12px;color:#aab2c0;background:transparent;border:1px solid #333;cursor:pointer;">▼</button>
        </div>
        <div id="network-health-body">
            <div id="network-health-alert" style="display:none;margin-bottom:8px;"></div>
            <div id="network-health-list"></div>
            <div style="font-size:12px;color:#8ab4f8;margin-top:10px;font-weight:600;">Transports (WSS → gRPC → RPC → HTTP)</div>
            <div id="network-transport-stats" style="margin-top:4px;padding-top:6px;border-top:1px solid #333;font-size:12px;"></div>
            <div id="network-health-lastupdate" style="font-size:12px;color:#aaa;margin-top:6px;"></div>
        </div>
    `;

    document.body.appendChild(dash);
    let minimized = false;

    try {
        minimized = window.localStorage.getItem(MINIMIZED_STORAGE_KEY) === '1';
    } catch (_) {
        minimized = false;
    }

    function applyMinimizedState() {
        const body = document.getElementById('network-health-body');
        const btn = document.getElementById('network-health-min-btn');
        if (!body || !btn) return;
        body.style.display = minimized ? 'none' : '';
        dash.style.padding = minimized ? '10px 14px' : '14px 18px 10px 18px';
        dash.style.minWidth = minimized ? '220px' : '280px';
        btn.textContent = minimized ? '▲' : '▼';
        btn.title = minimized ? 'Expand' : 'Minimize';
    }

    function persistMinimizedState() {
        try {
            window.localStorage.setItem(MINIMIZED_STORAGE_KEY, minimized ? '1' : '0');
        } catch (_) {
            // Session-only fallback when localStorage is unavailable.
        }
    }

    document.getElementById('network-health-min-btn')?.addEventListener('click', () => {
        minimized = !minimized;
        persistMinimizedState();
        applyMinimizedState();
    });
    applyMinimizedState();

    function statusColor(status) {
        if (status === 'healthy') return '#3ecf8e';
        if (status === 'degraded') return '#ffd166';
        if (status === 'down') return '#ff5e5e';
        return '#888';
    }

    function formatAgo(ts) {
        if (!ts) return '—';
        const s = Math.floor((Date.now() - ts) / 1000);
        if (s < 2) return 'just now';
        if (s < 60) return `${s}s ago`;
        if (s < 3600) return `${Math.floor(s / 60)}m ago`;
        return new Date(ts).toLocaleTimeString();
    }

    function renderTransport() {
        const el = document.getElementById('network-transport-stats');
        if (!el) return;

        const t = window.NetworkHealth?.getTransport?.() || {};
        const byKey = t.byKey || {};
        const preferred = t.preferred || {};
        const priority = t.priority || ['wss', 'grpc', 'rpc', 'http'];
        const proxy = t.proxy || {};
        const bus = t.bus || {};
        const coordination = t.coordination || {};

        if (!Object.keys(byKey).length) {
            el.innerHTML = '<span style="color:#888;">No transport activity yet</span>';
            return;
        }

        const providers = [...new Set(Object.keys(byKey).map(k => k.split(':')[0]))];
        const rows = providers.map((provider) => {
            const pref = preferred[provider] || '—';
            const cells = priority.map((transport) => {
                const row = byKey[`${provider}:${transport}`];
                if (!row) return `<span style="color:#555;margin-right:6px;">${transport}:—</span>`;
                const active = pref === transport;
                const color = row.fail > row.ok ? '#ff5e5e' : (active ? '#3ecf8e' : '#aaa');
                return `<span style="color:${color};margin-right:6px;${active ? 'font-weight:600;' : ''}">${transport}:${row.ok}/${row.fail}</span>`;
            }).join('');
            return `<div style="margin-bottom:5px;"><span style="color:#e0e6f0;width:72px;display:inline-block;">${provider}</span> ${cells}</div>`;
        }).join('');

        const wsState = window.KalshiWS?.getState?.() || {};
        let wsHint = '<span style="color:#888;">Kalshi WSS off</span>';
        if (wsState.connected && !wsState.stale) {
            wsHint = '<span style="color:#3ecf8e;">Kalshi WSS live</span>';
        } else if (wsState.connected && wsState.stale) {
            wsHint = '<span style="color:#ffd166;">Kalshi WSS stale</span>';
        } else if (!wsState.connected && (wsState.reconnectAttempts || 0) > 0) {
            wsHint = `<span style="color:#ffd166;">Kalshi WSS recovering (${wsState.reconnectAttempts})</span>`;
        }

        let hybridHint = '<span style="color:#888;">Hybrid mode: normal</span>';
        if (proxy.mode === 'bypass' || proxy.bypassActive) {
            hybridHint = `<span style="color:#ffd166;">Hybrid mode: proxy bypass (${Math.round((proxy.bypassMsLeft || 0) / 1000)}s)</span>`;
        } else if (proxy.healthy === false) {
            hybridHint = `<span style="color:#ffd166;">Hybrid mode: degraded proxy (${proxy.failures || 0} fails)</span>`;
        } else if (proxy.mode === 'proxy') {
            hybridHint = '<span style="color:#3ecf8e;">Hybrid mode: proxy active</span>';
        }

        const endpointCount = Object.keys(bus.endpoints || {}).length;
        const busHint = endpointCount
            ? `<span style="color:#8ab4f8;">Bus ${bus.updates || 0} upd/${bus.errors || 0} err (${endpointCount} ep)</span>`
            : '<span style="color:#888;">Bus idle</span>';
        const coordDomainCount = Object.keys(coordination.domains || {}).length;
        const coordHint = coordDomainCount
            ? `<span style="color:#8ab4f8;">Coord ${coordDomainCount} domains</span>`
            : '<span style="color:#888;">Coord idle</span>';

        const domainRows = Object.entries(coordination.domains || {})
            .slice(0, 4)
            .map(([domain, row]) => {
                const selected = row?.selected || '—';
                const reason = row?.reason || '';
                return `<div style="color:#9aa6b2;margin-top:2px;">${domain}: <span style="color:#e0e6f0;">${selected}</span>${reason ? ` <span style="color:#888;">(${reason})</span>` : ''}</div>`;
            }).join('');

        el.innerHTML = rows
            + `<div style="margin-top:6px;">${wsHint} · ${hybridHint} · ${busHint} · ${coordHint} · sync ${formatAgo(t.lastSync)}</div>`
            + (domainRows ? `<div style="margin-top:4px;border-top:1px dotted #3a3f4a;padding-top:4px;">${domainRows}</div>` : '');
    }

    function render() {
        const state = window.NetworkHealth?.getAll?.() || {};
        const list = Object.entries(state).map(([provider, v]) => {
            return `<div style="display:flex;align-items:center;margin-bottom:4px;">
        <span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:${statusColor(v.status)};margin-right:8px;"></span>
        <span style="font-weight:500;width:110px;display:inline-block;">${provider}</span>
        <span style="color:#aaa;font-size:12px;width:80px;display:inline-block;">${formatAgo(v.lastFetch)}</span>
        <span style="font-size:12px;color:${v.fallback ? '#ffd166' : '#aaa'};margin-left:6px;">${v.fallback ? 'Fallback' : ''}</span>
        <span style="font-size:12px;color:#ff5e5e;margin-left:6px;">${v.status === 'degraded' || v.status === 'down' ? v.reason : ''}</span>
      </div>`;
        }).join('');
        document.getElementById('network-health-list').innerHTML = list;
        document.getElementById('network-health-lastupdate').textContent = 'Updated ' + formatAgo(Date.now());
        renderTransport();

        const alertDiv = document.getElementById('network-health-alert');
        let alertMsg = '';
        if (window.NetworkHealth?.failureCounters) {
            for (const [provider, fc] of Object.entries(window.NetworkHealth.failureCounters)) {
                if (fc.alertActive) {
                    alertMsg += `<div style="background:#ff5e5e;color:#fff;padding:7px 12px;border-radius:6px;font-weight:600;margin-bottom:2px;">
                        ${provider} is DOWN (${fc.count} cycles): ${state[provider]?.reason || ''}
                    </div>`;
                }
            }
        }
        alertDiv.innerHTML = alertMsg;
        alertDiv.style.display = alertMsg ? '' : 'none';
    }

    window.addEventListener('network-health-update', render);
    window.addEventListener('network-health-alert', render);
    window.addEventListener('network-transport-update', render);
    setInterval(render, 2000);
    setTimeout(render, 100);

    window.NetworkHealthDashboard = { render };
})();
