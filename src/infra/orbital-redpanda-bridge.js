/**
 * orbital-redpanda-bridge.js
 * Ingestion bridge for the Orbital Matrix.
 * Pushes raw high-velocity ticks into Redpanda topics via KafkaJS.
 */

const { Kafka } = require('kafkajs');

const KAFKA_BROKERS = process.env.KAFKA_BROKERS
    ? process.env.KAFKA_BROKERS.split(',')
    : ['localhost:9092'];

let producer = null;
let kafka = null;
let lastProducedAt = null;

const MAX_ACTIVITY_EVENTS = 12;
const recentEvents = [];

// Per-topic message counters (for the UI status widget)
const messageCounts = {
    's': 0,
    'p': 0,
    'd': 0,
    'f': 0
};

// Last-tick timestamps per orbital (ISO string, for decay detection in UI)
const lastTickAt = {
    's': null,
    'p': null,
    'd': null,
    'f': null
};

function recordBridgeEvent(level, message, meta = {}) {
    recentEvents.unshift({
        ts: Date.now(),
        level: level || 'info',
        message: String(message || '').trim(),
        source: 'bridge',
        meta: meta && typeof meta === 'object' ? meta : {}
    });
    if (recentEvents.length > MAX_ACTIVITY_EVENTS) {
        recentEvents.length = MAX_ACTIVITY_EVENTS;
    }
}

async function initRedpanda() {
    if (producer) return;

    console.log('[OrbitalBridge] Initializing Redpanda Bridge...');
    kafka = new Kafka({
        clientId: 'wecrypto-ingestor',
        brokers: KAFKA_BROKERS,
        retry: {
            initialRetryTime: 100,
            retries: 8
        }
    });

    producer = kafka.producer();

    try {
        await producer.connect();
        console.log('[OrbitalBridge] Connected to Redpanda.');
        recordBridgeEvent('success', 'Kafka producer connected', { brokers: KAFKA_BROKERS });
    } catch (err) {
        console.error('[OrbitalBridge] Failed to connect to Redpanda:', err.message);
        recordBridgeEvent('error', 'Kafka producer failed to connect', { error: err.message });
        producer = null;
    }
}

/**
 * Gracefully disconnect the KafkaJS producer.
 * Called by the startup orchestrator on shutdown.
 */
async function disconnectRedpanda() {
    if (!producer) return;
    try {
        await producer.disconnect();
        console.log('[OrbitalBridge] Producer disconnected.');
    } catch (err) {
        console.warn('[OrbitalBridge] Producer disconnect error:', err.message);
    } finally {
        recordBridgeEvent('info', 'Kafka producer disconnected');
        producer = null;
        kafka = null;
    }
}

/**
 * Pushes a single tick to an orbital topic.
 * @param {string} orbital - 's', 'p', 'd', or 'f'
 * @param {string} asset   - Ticker symbol (e.g. 'BTC', 'HYPE')
 * @param {object} payload - Raw data object to serialize as JSON
 */
async function produceOrbitalTick(orbital, asset, payload) {
    if (!producer) return;

    const topic = `wecrypto.orbital.${orbital}`;

    try {
        await producer.send({
            topic,
            messages: [
                {
                    key: asset,
                    value: JSON.stringify(payload),
                    timestamp: Date.now().toString()
                }
            ],
        });

        // Track counts and timestamps for the status widget
        messageCounts[orbital] = (messageCounts[orbital] || 0) + 1;
        lastTickAt[orbital] = new Date().toISOString();
        lastProducedAt = new Date().toISOString();
        if (messageCounts[orbital] === 1 || (messageCounts[orbital] % 25) === 0) {
            recordBridgeEvent('info', `Orbital ${orbital} active`, {
                orbital,
                asset,
                count: messageCounts[orbital],
                topic
            });
        }
    } catch (err) {
        // Silent fail — never block the WebSocket ingestion stream
        console.warn(`[OrbitalBridge] Failed to produce to ${topic}:`, err.message);
        recordBridgeEvent('warn', `Produce failed for ${topic}`, {
            orbital,
            asset,
            error: err.message
        });
    }
}

/**
 * Returns current stats for the UI status widget.
 */
function getBridgeStats() {
    const totalMessages = Object.values(messageCounts).reduce((sum, count) => sum + Number(count || 0), 0);
    const activeOrbitals = Object.entries(lastTickAt)
        .filter(([, ts]) => !!ts)
        .map(([orbital]) => orbital);
    return {
        connected: !!producer,
        messageCounts: { ...messageCounts },
        lastTickAt: { ...lastTickAt },
        totalMessages,
        activeOrbitals,
        lastProducedAt,
        recentEvents: recentEvents.map((event) => ({ ...event }))
    };
}

module.exports = {
    initRedpanda,
    disconnectRedpanda,
    produceOrbitalTick,
    getBridgeStats
};
