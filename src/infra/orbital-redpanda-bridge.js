/**
 * orbital-redpanda-bridge.js
 * Ingestion bridge for the Orbital Matrix.
 * Pushes raw high-velocity ticks into Redpanda topics.
 */

const { Kafka } = require('kafkajs');

const KAFKA_BROKERS = process.env.KAFKA_BROKERS ? process.env.KAFKA_BROKERS.split(',') : ['localhost:9092'];

let producer = null;
let kafka = null;

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
    } catch (err) {
        console.error('[OrbitalBridge] Failed to connect to Redpanda:', err.message);
        producer = null;
    }
}

/**
 * Pushes a tick to an orbital topic.
 * @param {string} orbital - 's', 'p', 'd', or 'f'
 * @param {string} asset - Ticker (BTC, HYPE, etc)
 * @param {object} payload - Raw data
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
    } catch (err) {
        // Silent fail to prevent blocking the WS stream
        console.warn(`[OrbitalBridge] Failed to produce to ${topic}:`, err.message);
    }
}

module.exports = {
    initRedpanda,
    produceOrbitalTick
};
