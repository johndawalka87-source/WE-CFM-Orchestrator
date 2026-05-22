const { contextBridge, ipcRenderer } = require('electron');

function safeRequire(name) {
  try {
    return require(name);
  } catch (_) {
    return null;
  }
}

const crypto = safeRequire('crypto');
const ws = safeRequire('ws');

function createWebSocketBridge(url, options = {}) {
  if (!ws) throw new Error('ws module unavailable in preload');
  const WebSocketCtor = ws.WebSocket || ws;
  const socket = new WebSocketCtor(url, {
    handshakeTimeout: options.handshakeTimeout,
    perMessageDeflate: options.perMessageDeflate,
    headers: options.headers,
  });

  const bufferedEvents = [];
  const handlers = {};

  const api = {
    url,
    readyState: socket.readyState,
    send: (data) => socket.send(data),
    ping: () => {
      api.readyState = socket.readyState;
      if (socket.readyState !== 1 || typeof socket.ping !== 'function') return false;
      socket.ping();
      return true;
    },
    close: (code, reason) => socket.close(code, reason),
    on: (eventName, callback) => {
      if (typeof callback !== 'function') return false;
      handlers[eventName] = handlers[eventName] || [];
      handlers[eventName].push(callback);
      
      // Replay buffered events
      const toReplay = bufferedEvents.filter(e => e.eventName === eventName);
      toReplay.forEach(e => {
        const idx = bufferedEvents.indexOf(e);
        if (idx !== -1) bufferedEvents.splice(idx, 1);
        callback(...e.args);
      });
      return true;
    },
    once: (eventName, callback) => {
      if (typeof callback !== 'function') return false;
      const onceCb = (...args) => {
        const idx = (handlers[eventName] || []).indexOf(onceCb);
        if (idx !== -1) handlers[eventName].splice(idx, 1);
        callback(...args);
      };
      handlers[eventName] = handlers[eventName] || [];
      handlers[eventName].push(onceCb);
      
      const toReplay = bufferedEvents.find(e => e.eventName === eventName);
      if (toReplay) {
        const idx = bufferedEvents.indexOf(toReplay);
        if (idx !== -1) bufferedEvents.splice(idx, 1);
        onceCb(...toReplay.args);
      }
      return true;
    },
  };

  const dispatch = (eventName, ...args) => {
    api.readyState = socket.readyState;
    if (handlers[eventName] && handlers[eventName].length > 0) {
      handlers[eventName].forEach(cb => cb(...args));
    } else {
      bufferedEvents.push({ eventName, args });
    }
  };

  socket.on('open', () => dispatch('open'));
  socket.on('message', (data) => dispatch('message', data?.toString?.() ?? String(data ?? '')));
  socket.on('error', (err) => {
    err = err || {};
    dispatch('error', {
      message: err.message || String(err),
      code: err.code || null,
      statusCode: err.statusCode || null,
      statusMessage: err.statusMessage || null,
    });
  });
  socket.on('close', (code, reason) => dispatch('close', code, reason?.toString?.() ?? String(reason || '')));
  socket.on('unexpected-response', (req, res) => {
    res = res || {};
    dispatch('unexpected-response', null, {
      statusCode: res.statusCode || null,
      statusMessage: res.statusMessage || '',
    });
  });

  return api;
}


contextBridge.exposeInMainWorld('desktopApp', {
  isElectron: true,
  // Expose optional Node modules when available in preload context.
  crypto: crypto,
  ws: ws,
  createWebSocket: createWebSocketBridge,
  hasNodeCrypto: !!crypto,
  hasNodeWs: !!ws,
  proxyPort: () => ipcRenderer.invoke('proxy:port'),
  loadKalshiCredentials: () => ipcRenderer.invoke('kalshi:loadCredentials'),
  getKalshiWsAuthHeaders: () => ipcRenderer.invoke('kalshi:wsAuthHeaders'),
  generateCoinbaseJWT: (opts) => ipcRenderer.invoke('coinbase:generate-jwt', opts || {}),
  // Returns all local drives (C-Z), UNC network shares, and cloud sync folders
  getDrives: () => ipcRenderer.invoke('storage:getDrives'),
  networkError: (type, details) => ipcRenderer.invoke('network:logError', type, details),
});

contextBridge.exposeInMainWorld('electron', {
  invoke: ipcRenderer.invoke.bind(ipcRenderer),
  web: {
    updateState: (stateUpdate) => ipcRenderer.send('web:update-state', stateUpdate),
    broadcastUpdate: (type, data) => ipcRenderer.send('web:broadcast-update', { type, data }),
  },
  ipcFetch: (url, opts) => ipcRenderer.invoke('ipc:fetch', url, opts),
  kalshi: {
    loadCSVTrades: (browserStateJson) => ipcRenderer.invoke('kalshi:loadCSVTrades', browserStateJson),
    fetchHistoricalContracts: (opts) => ipcRenderer.invoke('kalshi:fetchHistoricalContracts', opts),
  },
  llm: {
    getDiagnostics: () => ipcRenderer.invoke('llm:getDiagnostics'),
    envStatus: () => ipcRenderer.invoke('llm:envStatus'),
  },
  sab: {
    onInit: (callback) => {
      ipcRenderer.on('sab:init', (event, payload) => {
        if (payload && payload.sab) {
          callback(payload.sab);
        }
      });
    }
  }
});

// Power-user bridge alias for context-isolated renderer integrations
contextBridge.exposeInMainWorld('wecryp', {
  onTelemetry: (callback) => {
    if (typeof callback !== 'function') return;
    ipcRenderer.on('telemetry-update', (_event, value) => callback(value));
  },
  runInference: async (prompt, context) => {
    return await ipcRenderer.invoke('ai:run-inference', { prompt, context });
  },
  syncDrive: async (payload) => {
    return await ipcRenderer.invoke('drive:sync-backup', payload);
  },
  recoverDrive: async (options) => {
    return await ipcRenderer.invoke('drive:recover-backups', options || {});
  },
  cloudStatus: async () => {
    return await ipcRenderer.invoke('google:cloudStatus');
  },
  cloudSqlStatus: async (options) => {
    return await ipcRenderer.invoke('google:cloudSqlStatus', options || {});
  },
  testCloudSql: async () => {
    return await ipcRenderer.invoke('google:testCloudSql');
  },
  tideForecast: async (payload) => {
    return await ipcRenderer.invoke('google:tideForecast', payload);
  },
  firebaseStatus: async () => {
    return await ipcRenderer.invoke('firebase:status');
  },
  firebaseStartupCheck: async (options) => {
    return await ipcRenderer.invoke('firebase:startupCheck', options || {});
  },
  appendInference: async (record) => {
    return await ipcRenderer.invoke('firebase:appendInference', record || {});
  },
  getInferences: async (options) => {
    return await ipcRenderer.invoke('firebase:getInferences', options || {});
  },
});

// Orbital broadcaster bridge — renderer calls push(), main process relays to Firestore/RTDB.
contextBridge.exposeInMainWorld('_orbitalBroadcaster', {
  push: (orbitalResult) => {
    if (!orbitalResult) return;
    ipcRenderer.send('orbital:push', orbitalResult);
  },
  pushTick: (tick) => {
    if (!tick) return;
    ipcRenderer.send('orbital:pushTick', tick);
  },
  pushVertexExecution: (kind, data) => {
    ipcRenderer.send('orbital:pushVertex', { kind, data: data || {} });
  },
  getDiagnostics: () => ipcRenderer.invoke('orbital:broadcaster:diagnostics'),
});

contextBridge.exposeInMainWorld('dataStore', {
  appendLine: (filePath, line) => ipcRenderer.invoke('data:appendLine', filePath, line),
  writeFile: (filePath, content) => ipcRenderer.invoke('data:writeFile', filePath, content),
  ensureDir: (dirPath) => ipcRenderer.invoke('data:ensureDir', dirPath),
  readFile: (filePath) => ipcRenderer.invoke('data:readFile', filePath),
  listDir: (dirPath) => ipcRenderer.invoke('data:listDir', dirPath),
});

contextBridge.exposeInMainWorld('auditAPI', {
  validator: {
    getStats: () => ipcRenderer.invoke('validator:getStats'),
    getAll: () => ipcRenderer.invoke('validator:getAll'),
    getCoin: (sym) => ipcRenderer.invoke('validator:getCoin', sym),
  }
});

contextBridge.exposeInMainWorld('pythLazer', {
  onTickers: (cb) => ipcRenderer.on('pyth:tickers', (_e, data) => cb(data)),
  offTickers: () => ipcRenderer.removeAllListeners('pyth:tickers'),
  onStatus: (cb) => ipcRenderer.on('pyth:status', (_e, data) => cb(data)),
  onTimeout: (cb) => ipcRenderer.on('pyth:timeout-fallback', (_e, data) => cb(data)),
  onConnectionLost: (cb) => ipcRenderer.on('pyth:connection-lost', (_e, data) => cb(data)),
  onConnectionFailed: (cb) => ipcRenderer.on('pyth:connection-failed', (_e, data) => cb(data)),
  getCandles: (opts) => ipcRenderer.invoke('pyth:getCandles', opts),
  getProxyLatest: (feedIds) => ipcRenderer.invoke('pyth:getProxyLatest', feedIds),
});
