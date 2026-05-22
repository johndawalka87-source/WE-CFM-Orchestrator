#!/usr/bin/env node
/**
 * WE-CRYPTO WebSocket Proxy Server
 * Bootstraps all connections through a local proxy to bypass geo-blocking
 * Supports: Hyperliquid, Bybit, Mempool, Pyth Network, CoinGecko
 */

const WebSocket = require('ws');
const https = require('https');
const http = require('http');
const fs = require('fs');
const PythLazerWebSocketHandler = require('./pyth-lazer-websocket');

const PORT = 3011;
const WSS_PORT = 3012;

// Pyth API Key (from environment or hardcoded)
const LAZER_TOKEN = process.env.LAZER_TOKEN || 'HjkdyqJTX45K7nrqtkiKwHPuCpDkh2gmvKNof29RwTW';

// Initialize Pyth Lazer WebSocket handler (official SDK)
const pythHandler = new PythLazerWebSocketHandler();

// Log with timestamp
function log(msg, type = 'INFO') {
  const ts = new Date().toISOString().split('T')[1];
  console.log(`[${ts}] [${type}] ${msg}`);
}

// Upstream WebSocket endpoints (with geo-bypass)
const UPSTREAM = {
  'hyperliquid': 'wss://api.hyperliquid.xyz/ws',
  'bybit': 'wss://stream.bybit.com/v5/public/spot',
  'mempool': 'wss://mempool.space/api/v1/blocksBitcoin',
  'pyth': 'POLLER', // Special marker - uses HTTP polling instead of WebSocket
  'pyth-lazer': 'POLLER', // Special marker - uses HTTP polling
  'coingecko': 'wss://stream.coingecko.com/v1/stream'
};

// Store upstream connections
const upstreamConnections = new Map();
const clientConnections = new Map();

class ProxyManager {
  constructor() {
    this.reconnectAttempts = new Map();
    this.maxReconnectAttempts = 5;
    this.reconnectDelay = 2000;
  }

  // Connect to upstream service
  connectUpstream(service) {
    if (upstreamConnections.has(service)) {
      return upstreamConnections.get(service);
    }

    log(`Connecting to upstream: ${service}`, 'CONNECT');

    return new Promise((resolve, reject) => {
      const url = UPSTREAM[service];
      if (!url) {
        return reject(new Error(`Unknown service: ${service}`));
      }

      // Special handling for Pyth Lazer (Official SDK WebSocket)
      if (url === 'POLLER') {
        log(`Initializing Pyth Lazer WebSocket Handler (official SDK)...`, 'INFO');
        
        // Create a mock WebSocket-like object for consistency
        const pythProxy = {
          readyState: WebSocket.OPEN,
          on: () => {},
          terminate: async () => {
            await pythHandler.disconnect();
          }
        };
        
        // Connect to Pyth Lazer (will throw if failed)
        pythHandler.connect().then(() => {
          log(`✅ Connected to ${service} (WebSocket Pool)`, 'UPSTREAM');
        }).catch(err => {
          log(`Failed to connect Pyth: ${err.message}`, 'ERROR');
        });
        
        upstreamConnections.set(service, pythProxy);
        this.reconnectAttempts.delete(service);
        
        return resolve();
      }

      // Standard WebSocket handling for other services
      const headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'gzip, deflate, br',
        'Connection': 'Upgrade',
        'Upgrade': 'websocket'
      };

      const ws = new WebSocket(url, {
        headers,
        rejectUnauthorized: false
      });

      const timeout = setTimeout(() => {
        ws.terminate();
        reject(new Error(`Connection timeout for ${service}`));
      }, 10000);

      ws.on('open', () => {
        clearTimeout(timeout);
        log(`✅ Connected to ${service}`, 'UPSTREAM');
        
        // Store connection
        upstreamConnections.set(service, ws);
        this.reconnectAttempts.delete(service);

        // Handle messages from upstream
        ws.on('message', (data) => {
          // Relay to all connected clients for this service
          if (clientConnections.has(service)) {
            clientConnections.get(service).forEach(clientWs => {
              if (clientWs.readyState === WebSocket.OPEN) {
                try {
                  clientWs.send(data);
                } catch (e) {
                  log(`Error sending to client: ${e.message}`, 'ERROR');
                }
              }
            });
          }
        });

        ws.on('error', (err) => {
          log(`Upstream error (${service}): ${err.message}`, 'ERROR');
        });

        ws.on('close', () => {
          log(`Upstream closed (${service}), reconnecting...`, 'WARN');
          upstreamConnections.delete(service);
          const attempts = (this.reconnectAttempts.get(service) || 0) + 1;
          if (attempts <= this.maxReconnectAttempts) {
            this.reconnectAttempts.set(service, attempts);
            setTimeout(() => this.connectUpstream(service), this.reconnectDelay * attempts);
          }
        });

        resolve(ws);
      });

      ws.on('error', (err) => {
        clearTimeout(timeout);
        log(`Failed to connect to ${service}: ${err.message}`, 'ERROR');
        reject(err);
      });
    });
  }

  // Handle client connection
  handleClientConnection(ws, service) {
    if (!clientConnections.has(service)) {
      clientConnections.set(service, new Set());
    }
    clientConnections.get(service).add(ws);

    log(`Client connected to ${service} (${clientConnections.get(service).size} clients)`, 'CLIENT');

    // Special handling for Pyth services - register with handler
    if (service === 'pyth' || service === 'pyth-lazer') {
      pythHandler.addClient(ws);
    }

    // Ensure upstream is connected
    if (!upstreamConnections.has(service)) {
      this.connectUpstream(service).catch(err => {
        log(`Failed to connect upstream for ${service}: ${err.message}`, 'ERROR');
        ws.close(1011, `Failed to connect to ${service}`);
      });
    }

    ws.on('message', (data) => {
      // Pyth services don't accept client messages (WebSocket streaming only)
      if (service !== 'pyth' && service !== 'pyth-lazer') {
        const upstream = upstreamConnections.get(service);
        if (upstream && upstream.readyState === WebSocket.OPEN) {
          try {
            upstream.send(data);
          } catch (e) {
            log(`Error relaying to upstream: ${e.message}`, 'ERROR');
          }
        }
      }
    });

    ws.on('error', (err) => {
      log(`Client error (${service}): ${err.message}`, 'ERROR');
    });

    ws.on('close', () => {
      // Deregister from handler if Pyth
      if (service === 'pyth' || service === 'pyth-lazer') {
        pythHandler.removeClient(ws);
      }
      
      const clients = clientConnections.get(service);
      if (clients) {
        clients.delete(ws);
        log(`Client disconnected from ${service} (${clients.size} remaining)`, 'CLIENT');
      }
    });
  }
}

// Initialize proxy
const proxy = new ProxyManager();

// Create HTTP server (for upgrading to WebSocket)
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    status: 'WE-CRYPTO WebSocket Proxy',
    version: '1.0.0',
    uptime: process.uptime(),
    services: Array.from(upstreamConnections.keys()),
    clients: Array.from(clientConnections.entries()).map(([service, clients]) => ({
      service,
      count: clients.size
    }))
  }));
});

// WebSocket server for clients
const wss = new WebSocket.Server({ server });

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const service = url.searchParams.get('service') || url.pathname.replace('/', '');

  if (!UPSTREAM[service]) {
    log(`Invalid service requested: ${service}`, 'WARN');
    ws.close(1008, `Unknown service: ${service}`);
    return;
  }

  proxy.handleClientConnection(ws, service);
});

// Start listening with Port Cascading (3030 - 3035)
let currentPort = 3030;
const maxPort = 3035;

function startServer(port) {
  server.listen(port, () => {
    log(`🟢 WE-CRYPTO WebSocket Proxy running`, 'STARTUP');
    log(`   HTTP Endpoint: http://localhost:${port}`, 'INFO');
    log(`   WebSocket: ws://localhost:${port}?service=<service>`, 'INFO');
    log(`   Available services: ${Object.keys(UPSTREAM).join(', ')}`, 'INFO');
    console.log();
  });
}

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    log(`Port ${currentPort} is in use, trying next port...`, 'WARN');
    currentPort++;
    if (currentPort <= maxPort) {
      setTimeout(() => startServer(currentPort), 100);
    } else {
      log(`Could not find an open port between 3030 and ${maxPort}`, 'ERROR');
      process.exit(1);
    }
  } else {
    log(`Server error: ${e.message}`, 'ERROR');
  }
});

startServer(currentPort);

// Pre-connect to all upstream services
Object.keys(UPSTREAM).forEach(service => {
  setTimeout(() => {
    proxy.connectUpstream(service).catch(err => {
      log(`Initial connection to ${service} failed: ${err.message}`, 'WARN');
    });
  }, 1000);
});

// Graceful shutdown
process.on('SIGINT', () => {
  log('Shutting down...', 'INFO');
  
  // Close all connections
  upstreamConnections.forEach((ws, service) => {
    log(`Closing upstream: ${service}`, 'INFO');
    ws.close(1000, 'Server shutdown');
  });
  
  clientConnections.forEach((clients, service) => {
    clients.forEach(ws => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.close(1000, 'Server shutdown');
      }
    });
  });

  server.close(() => {
    log('Server closed', 'INFO');
    process.exit(0);
  });

  setTimeout(() => {
    log('Force exit', 'WARN');
    process.exit(1);
  }, 5000);
});

// Error handling
process.on('uncaughtException', (err) => {
  log(`Uncaught exception: ${err.message}`, 'ERROR');
  console.error(err.stack);
});

process.on('unhandledRejection', (reason, promise) => {
  log(`Unhandled rejection: ${reason}`, 'ERROR');
});
