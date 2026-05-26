/**
 * orbital-ingestor-daemon.js
 * Ingestion layer for the Orbital Matrix.
 * Maintains persistent WebSockets to CoinGecko, Coinbase, Hyperliquid, and Kalshi.
 * Pushes raw high-velocity data to Redpanda topics.
 */

const WebSocket = require('ws');
const { produceOrbitalTick } = require('../infra/orbital-redpanda-bridge');

const COINGECKO_WS_URL = 'wss://stream.coingecko.com/v1/stream';
const COINBASE_WS_URL = 'wss://advanced-trade-ws.coinbase.com';
const HYPERLIQUID_WS_URL = 'wss://api.hyperliquid.xyz/ws';

const ASSETS = ['BTC', 'ETH', 'SOL', 'XRP', 'DOGE', 'BNB', 'HYPE'];

class OrbitalIngestor {
    constructor() {
        this.connections = new Map();
    }

    start() {
        console.log('[OrbitalIngestor] Starting high-velocity ingestion layer...');
        this.connectCoinGecko();
        this.connectCoinbase();
        this.connectHyperliquid();
        // Kalshi and other feeds can be added here
    }

    connectCoinGecko() {
        const ws = new WebSocket(COINGECKO_WS_URL);
        ws.on('open', () => {
            console.log('[OrbitalIngestor] CoinGecko Connected.');
        });
        ws.on('message', (data) => {
            try {
                const msg = JSON.parse(data);
                // Map to s-orbital
                if (msg.asset && msg.price) {
                    produceOrbitalTick('s', msg.asset, {
                        price_usd_coingecko: msg.price,
                        source: 'coingecko',
                        ts: Date.now()
                    });
                }
            } catch (err) {}
        });
        ws.on('close', () => setTimeout(() => this.connectCoinGecko(), 5000));
    }

    connectCoinbase() {
        const ws = new WebSocket(COINBASE_WS_URL);
        ws.on('open', () => {
            console.log('[OrbitalIngestor] Coinbase Connected.');
            const products = ASSETS.map(a => `${a}-USD`);
            ws.send(JSON.stringify({
                type: 'subscribe',
                product_ids: products,
                channels: ['ticker']
            }));
        });
        ws.on('message', (data) => {
            try {
                const msg = JSON.parse(data);
                if (msg.type === 'ticker' || msg.channel === 'ticker') {
                    const asset = msg.product_id ? msg.product_id.split('-')[0] : null;
                    if (asset && ASSETS.includes(asset)) {
                        produceOrbitalTick('s', asset, {
                            price_usd_coinbase_val: parseFloat(msg.price),
                            source: 'coinbase',
                            ts: Date.now()
                        });
                        // Also produce p-orbital (Momentum) if we calculate VWAP here or elsewhere
                        // For now, we just pass the raw tick
                    }
                }
            } catch (err) {}
        });
        ws.on('close', () => setTimeout(() => this.connectCoinbase(), 5000));
    }

    connectHyperliquid() {
        const ws = new WebSocket(HYPERLIQUID_WS_URL);
        ws.on('open', () => {
            console.log('[OrbitalIngestor] Hyperliquid Connected.');
            // Subscribe to L2 Book or Info for funding/OI
            ASSETS.forEach(asset => {
                ws.send(JSON.stringify({ method: "subscribe", subscription: { type: "l2Book", coin: asset } }));
            });
        });
        ws.on('message', (data) => {
            try {
                const msg = JSON.parse(data);
                const asset = msg.coin || (msg.data && msg.data.coin);
                if (asset && ASSETS.includes(asset)) {
                    // Map to d-orbital (Complex: OI, Funding)
                    if (msg.data && msg.data.levels) {
                        produceOrbitalTick('d', asset, {
                            open_interest_usd: msg.data.oi || 0,
                            funding_rate: msg.data.funding || 0,
                            source: 'hyperliquid',
                            ts: Date.now()
                        });
                    }
                }
            } catch (err) {}
        });
        ws.on('close', () => setTimeout(() => this.connectHyperliquid(), 5000));
    }
}

module.exports = new OrbitalIngestor();
