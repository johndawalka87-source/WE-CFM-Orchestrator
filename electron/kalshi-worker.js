#!/usr/bin/env node
/**
 * Kalshi Standalone Worker
 * 
 * Independent Node.js process for Kalshi market data.
 * No Electron dependency. Runs in background.
 * 
 * Usage:
 *   node kalshi-worker.js
 *   node kalshi-worker.js --port 3050 --env production
 * 
 * IPC: Listens on port 3050 for JSON commands
 */

const KalshiRestClient = require('../src/kalshi/kalshi-rest.js');
const WebSocketModule = require('../src/kalshi/kalshi-ws.js');
const fs = require('fs');
const path = require('path');
const http = require('http');

function parseCredentialFile(content) {
  const rawLines = content.split(/\r?\n/);
  const nonEmpty = rawLines.map(l => l.trim()).filter(Boolean);
  const apiKeyId = nonEmpty[0] || null;

  const beginIdx = rawLines.findIndex(l => l.includes('-----BEGIN'));
  const endIdx = rawLines.findIndex(l => l.includes('-----END'));
  let privateKeyPem = null;

  if (beginIdx !== -1 && endIdx !== -1 && endIdx >= beginIdx) {
    privateKeyPem = rawLines.slice(beginIdx, endIdx + 1).join('\n').trim();
  } else if (nonEmpty.length > 1) {
    privateKeyPem = nonEmpty.slice(1).join('\n').trim();
  }

  return { apiKeyId, privateKeyPem };
}

// Parse CLI args
const args = process.argv.slice(2);
const config = {
  port: 3050,
  env: 'production',
  apiKeyId: null,
  privateKeyPem: null
};

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--port' && args[i + 1]) config.port = parseInt(args[i + 1]);
  if (args[i] === '--env' && args[i + 1]) config.env = args[i + 1];
  if (args[i] === '--key' && args[i + 1]) config.apiKeyId = args[i + 1];
  if (args[i] === '--file' && args[i + 1]) {
    const credFile = args[i + 1];
    if (fs.existsSync(credFile)) {
      const content = fs.readFileSync(credFile, 'utf8');
      const parsed = parseCredentialFile(content);
      config.apiKeyId = parsed.apiKeyId;
      config.privateKeyPem = parsed.privateKeyPem;
    }
  }
}

// Load credentials from file if not provided
if (!config.apiKeyId) {
  const credPath = path.join(__dirname, '../secrets/KALSHI-API-KEY.txt');
  if (fs.existsSync(credPath)) {
    const content = fs.readFileSync(credPath, 'utf8');
    const parsed = parseCredentialFile(content);
    config.apiKeyId = parsed.apiKeyId;
    config.privateKeyPem = parsed.privateKeyPem;
  }
}

if (!config.apiKeyId || !config.privateKeyPem) {
  console.error('[Kalshi Worker] ERROR: No API credentials found');
  console.error('  Provide via --key or --file, or place KALSHI-API-KEY.txt in current directory');
  process.exit(1);
}

console.log('[Kalshi Worker] Credentials loaded:');
console.log(`  API Key ID: ${config.apiKeyId.substring(0, 8)}...`);
console.log(`  Private Key: ${config.privateKeyPem ? 'Yes (' + config.privateKeyPem.length + ' bytes)' : 'NO'};`);
console.log(`  Environment: ${config.env}`);

// ──────────────────────────────────────────────────────────────────────────
// Worker State
// ──────────────────────────────────────────────────────────────────────────

const state = {
  connected: false,
  client: null,
  rest: null,
  ws: null,
  subscriptions: [],
  lastBalance: null,
  lastTicker: {},
  lastTrades: [],
  errors: [],
  startTime: Date.now(),
  stats: {
    requests: 0,
    errors: 0,
    messages: 0
  }
};

// ──────────────────────────────────────────────────────────────────────────
// Initialize Kalshi Client
// ──────────────────────────────────────────────────────────────────────────

async function initializeKalshi() {
  try {
    console.log('[Kalshi Worker] Initializing...');
    
    state.rest = new KalshiRestClient(
      config.apiKeyId,
      config.privateKeyPem,
      config.env
    );

    // For WebSocket, we'd need window context
    // For now, just REST
    
    // Health check
    const health = await state.rest.healthCheck();
    if (health.status !== 'healthy') {
      throw new Error(`REST health check failed: ${health.error}`);
    }

    // Get initial balance
    const balance = await state.rest.getBalance();
    if (balance.success) {
      state.lastBalance = balance.data;
    }

    state.connected = true;
    console.log('[Kalshi Worker] Connected to Kalshi');
    return true;
  } catch (error) {
    console.error('[Kalshi Worker] Initialization failed:', error.message);
    recordError('initialization', error.message);
    return false;
  }
}

// ──────────────────────────────────────────────────────────────────────────
// HTTP Server (JSON RPC-like API)
// ──────────────────────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Content-Type', 'application/json');

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  if (req.method === 'GET') {
    handleGetRequest(req, res);
  } else if (req.method === 'POST') {
    handlePostRequest(req, res);
  } else {
    res.writeHead(405);
    res.end(JSON.stringify({ error: 'Method not allowed' }));
  }
});

async function handleGetRequest(req, res) {
  const url = new URL(req.url, `http://localhost:${config.port}`);
  const path = url.pathname;

  try {
    // Health check
    if (path === '/health' || path === '/ping') {
      res.writeHead(200);
      res.end(JSON.stringify({
        status: 'ok',
        connected: state.connected,
        uptime: Date.now() - state.startTime,
        environment: config.env
      }));
      return;
    }

    // Status
    if (path === '/status') {
      res.writeHead(200);
      res.end(JSON.stringify({
        connected: state.connected,
        environment: config.env,
        balance: state.lastBalance,
        subscriptions: state.subscriptions.length,
        stats: state.stats,
        uptime: Date.now() - state.startTime,
        errors: state.errors.slice(-10)
      }));
      return;
    }

    // Get balance
    if (path === '/balance') {
      const result = await state.rest.getBalance();
      if (result.success) {
        state.lastBalance = result.data;
      }
      res.writeHead(result.success ? 200 : 400);
      res.end(JSON.stringify(result));
      return;
    }

    // Get markets
    if (path === '/markets') {
      const limit = parseInt(url.searchParams.get('limit') || '50', 10);
      const series_ticker = url.searchParams.get('series_ticker') || undefined;
      const status = url.searchParams.get('status') || undefined;
      const result = await state.rest.getMarkets({ limit, series_ticker, status });
      res.writeHead(result.success ? 200 : 400);
      res.end(JSON.stringify(result));
      return;
    }

    // Get events
    if (path === '/events') {
      const ticker = url.searchParams.get('ticker');
      const result = await state.rest.getEvents({
        eventTicker: ticker,
        withNestedMarkets: true
      });
      res.writeHead(result.success ? 200 : 400);
      res.end(JSON.stringify(result));
      return;
    }

    // Get positions
    if (path === '/positions') {
      const result = await state.rest.getPositions();
      res.writeHead(result.success ? 200 : 400);
      res.end(JSON.stringify(result));
      return;
    }

    // Get orders
    if (path === '/orders') {
      const result = await state.rest.getOrders();
      res.writeHead(result.success ? 200 : 400);
      res.end(JSON.stringify(result));
      return;
    }

    res.writeHead(404);
    res.end(JSON.stringify({ error: 'Not found' }));
  } catch (error) {
    res.writeHead(500);
    res.end(JSON.stringify({ error: error.message }));
  }
}

async function handlePostRequest(req, res) {
  let body = '';
  
  req.on('data', chunk => {
    body += chunk.toString();
  });

  req.on('end', async () => {
    try {
      const data = JSON.parse(body);
      const { command, params } = data;

      state.stats.requests++;

      // Place order
      if (command === 'placeOrder') {
        const result = await state.rest.placeOrder(params);
        res.writeHead(result.success ? 200 : 400);
        res.end(JSON.stringify(result));
        return;
      }

      // Cancel order
      if (command === 'cancelOrder') {
        const result = await state.rest.cancelOrder(params.orderId);
        res.writeHead(result.success ? 200 : 400);
        res.end(JSON.stringify(result));
        return;
      }

      // Cancel all orders
      if (command === 'cancelAllOrders') {
        const result = await state.rest.cancelAllOrders(params.filters);
        res.writeHead(result.success ? 200 : 400);
        res.end(JSON.stringify(result));
        return;
      }

      // Get market
      if (command === 'getMarket') {
        const result = await state.rest.getMarket(params.marketId);
        res.writeHead(result.success ? 200 : 400);
        res.end(JSON.stringify(result));
        return;
      }

      // Get trades
      if (command === 'getTrades') {
        const result = await state.rest.getTrades(params.marketId, params.filters);
        res.writeHead(result.success ? 200 : 400);
        res.end(JSON.stringify(result));
        return;
      }

      res.writeHead(400);
      res.end(JSON.stringify({ error: 'Unknown command' }));
    } catch (error) {
      res.writeHead(400);
      res.end(JSON.stringify({ error: error.message }));
    }
  });
}

// ──────────────────────────────────────────────────────────────────────────
// Utilities
// ──────────────────────────────────────────────────────────────────────────

function recordError(type, message) {
  state.stats.errors++;
  state.errors.push({
    type,
    message,
    timestamp: Date.now()
  });
  if (state.errors.length > 100) {
    state.errors = state.errors.slice(-100);
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Startup
// ──────────────────────────────────────────────────────────────────────────

async function startup() {
  console.log('╔════════════════════════════════════════════╗');
  console.log('║  Kalshi Standalone Worker                 ║');
  console.log('╚════════════════════════════════════════════╝');
  console.log();
  console.log(`Environment: ${config.env}`);
  console.log(`API Key: ${config.apiKeyId.slice(0, 8)}...`);
  console.log();

  const connected = await initializeKalshi();
  if (!connected) {
    console.error('[Kalshi Worker] Failed to initialize. Exiting.');
    process.exit(1);
  }

  server.listen(config.port, '127.0.0.1', () => {
    console.log(`[Kalshi Worker] HTTP server listening on http://127.0.0.1:${config.port}`);
    console.log();
    console.log('Available endpoints:');
    console.log(`  GET  /health              — Health check`);
    console.log(`  GET  /status              — Full worker status`);
    console.log(`  GET  /balance             — Account balance`);
    console.log(`  GET  /markets             — List markets`);
    console.log(`  GET  /events              — List events`);
    console.log(`  GET  /positions           — Your positions`);
    console.log(`  GET  /orders              — Your orders`);
    console.log(`  POST /                    — Execute command (placeOrder, cancelOrder, etc.)`);
    console.log();
    console.log('Examples:');
    console.log(`  curl http://127.0.0.1:${config.port}/health`);
    console.log(`  curl http://127.0.0.1:${config.port}/balance`);
    console.log(`  curl http://127.0.0.1:${config.port}/markets?limit=20`);
    console.log();
    console.log('Press Ctrl+C to stop');
  });
}

// Handle signals
process.on('SIGINT', () => {
  console.log('\n[Kalshi Worker] Shutting down...');
  server.close(() => {
    console.log('[Kalshi Worker] Server closed');
    process.exit(0);
  });
});

process.on('SIGTERM', () => {
  console.log('\n[Kalshi Worker] Terminating...');
  server.close(() => {
    console.log('[Kalshi Worker] Server closed');
    process.exit(0);
  });
});

// Start
startup().catch(error => {
  console.error('[Kalshi Worker] Fatal error:', error.message);
  process.exit(1);
});
