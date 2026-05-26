/**
 * orbital-matrix-processor.js
 * The Synchronous Consumer (The Coherence Loop).
 * Implements the Time-Windowed Barrier logic for the Orbital Matrix.
 */

const { Kafka } = require('kafkajs');
const OrbitalBroadcaster = require('./orbital-firebase-broadcaster');

const KAFKA_BROKERS = process.env.KAFKA_BROKERS ? process.env.KAFKA_BROKERS.split(',') : ['localhost:9092'];
const INTERVAL_MS = 15 * 60 * 1000; // 15 minutes
const BARRIER_TOLERANCE_MS = 15 * 1000; // 15 seconds
const MAX_PRICE_DELTA_PCT = 0.005; // 0.5%

// In-Memory Buffer: Map<Asset, { s: [], p: [], d: [], f: [] }>
const buffer = new Map();

const kafka = new Kafka({
    clientId: 'orbital-matrix-processor',
    brokers: KAFKA_BROKERS,
});

const consumer = kafka.consumer({ groupId: 'orbital-coherence-group' });

async function startProcessor() {
    await consumer.connect();
    console.log('[OrbitalProcessor] Connected to Redpanda.');

    const topics = [
        'wecrypto.orbital.s',
        'wecrypto.orbital.p',
        'wecrypto.orbital.d',
        'wecrypto.orbital.f'
    ];

    for (const topic of topics) {
        await consumer.subscribe({ topic, fromBeginning: false });
    }

    await consumer.run({
        eachMessage: async ({ topic, message }) => {
            const asset = message.key.toString();
            const payload = JSON.parse(message.value.toString());
            const type = topic.split('.').pop(); // s, p, d, f

            if (!buffer.has(asset)) {
                buffer.set(asset, { s: [], p: [], d: [], f: [] });
            }

            const state = buffer.get(asset);
            state[type].push({
                data: payload,
                ts: Date.now()
            });

            // Keep only the last 20 minutes of data to avoid memory leaks
            const cutoff = Date.now() - (20 * 60 * 1000);
            state[type] = state[type].filter(tick => tick.ts > cutoff);
        }
    });

    console.log('[OrbitalProcessor] Coherence loop active.');

    // Time-Windowed Barrier
    setInterval(() => {
        const now = Date.now();
        console.log(`[OrbitalProcessor] Executing 15-minute synchronization barrier at ${new Date().toISOString()}`);

        for (const [asset, state] of buffer.entries()) {
            const latestS = state.s.length ? state.s[state.s.length - 1] : null;
            if (!latestS) continue;

            // 1. Cross-Reference Execution
            const priceGecko = latestS.data.price_usd_coingecko;
            const priceCoinbase = latestS.data.price_usd_coinbase_val;
            
            if (priceGecko && priceCoinbase) {
                const delta = Math.abs(priceGecko - priceCoinbase) / priceGecko;
                if (delta > MAX_PRICE_DELTA_PCT) {
                    console.warn(`[OrbitalProcessor] [${asset}] Price Divergence Detected: ${(delta * 100).toFixed(4)}%. Sync blocked.`);
                    continue;
                }
            }

            // 2. Barrier Synchronization (Decay Detection)
            const decayed = [];
            ['s', 'p', 'd', 'f'].forEach(ring => {
                const latest = state[ring].length ? state[ring][state[ring].length - 1] : null;
                if (!latest || (now - latest.ts) > BARRIER_TOLERANCE_MS) {
                    decayed.push(`orbital_${ring}`);
                }
            });

            // 3. Payload Synthesis
            const element = {
                asset,
                timestamp: Math.floor(now / 1000),
                atomic_weight_class: determineWeightClass(asset),
                decayed_orbitals: decayed.length > 0 ? decayed : undefined,
                orbitals: {
                    s_core: latestS.data,
                    p_momentum: state.p.length ? state.p[state.p.length - 1].data : {},
                    d_complex: state.d.length ? state.d[state.d.length - 1].data : {},
                    f_diffuse: state.f.length ? state.f[state.f.length - 1].data : {}
                }
            };

            // 4. Dispatch to TIDE
            try {
                OrbitalBroadcaster.pushMatrixElement(element);
                console.log(`[OrbitalProcessor] [${asset}] Dispatched element to TIDE.`);
            } catch (err) {
                console.error(`[OrbitalProcessor] [${asset}] Dispatch failed:`, err.message);
            }
        }
    }, INTERVAL_MS);
}

function determineWeightClass(asset) {
    const classes = {
        'BTC': 'Noble Gas',
        'ETH': 'Alkali Metal',
        'HYPE': 'Reactive Non-Metal',
        'SOL': 'Transition Metal'
    };
    return classes[asset] || 'Transition Metal';
}

module.exports = { startProcessor };
