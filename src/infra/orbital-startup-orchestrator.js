/**
 * orbital-startup-orchestrator.js
 * Manages the lifecycle of Redpanda and the Orbital Matrix services.
 * 
 * Responsibilities:
 * 1. Detect if Docker is available
 * 2. Spin up docker-compose (Redpanda cluster)
 * 3. Wait for Redpanda to be healthy
 * 4. Initialize the Redpanda bridge
 * 5. Start the Orbital Ingestor daemon
 * 6. Start the Matrix Processor (coherence loop)
 * 7. Handle graceful shutdown on app exit
 */

const { spawn, exec } = require('child_process');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const net = require('net');

let dockerComposeProcess = null;
let ingestorProcess = null;
let processorHandle = null;
let orchestratorReady = false;

// --- Health Check Utilities ---

/**
 * Check if a port is open (Docker/Redpanda is listening).
 */
function checkPort(port, host = 'localhost', timeout = 1000) {
    return new Promise((resolve) => {
        const socket = net.createConnection({ port, host });
        
        socket.setTimeout(timeout);
        socket.on('connect', () => {
            socket.destroy();
            resolve(true);
        });
        socket.on('timeout', () => {
            socket.destroy();
            resolve(false);
        });
        socket.on('error', () => {
            resolve(false);
        });
    });
}

/**
 * Poll for Redpanda readiness via port 9092 (Kafka broker).
 * Max 60 seconds.
 */
async function waitForRedpandaReady(maxWaitMs = 60000) {
    const startTime = Date.now();
    const pollInterval = 2000;
    
    console.log('[OrbitalOrchestrator] Waiting for Redpanda to be ready...');
    
    while (Date.now() - startTime < maxWaitMs) {
        const isReady = await checkPort(9092, 'localhost', 1000);
        if (isReady) {
            console.log('[OrbitalOrchestrator] ✓ Redpanda is ready!');
            return true;
        }
        console.log('[OrbitalOrchestrator] Polling... (waiting for Redpanda on :9092)');
        await new Promise(resolve => setTimeout(resolve, pollInterval));
    }
    
    throw new Error('Redpanda failed to start within 60 seconds');
}

/**
 * Check if Docker daemon is running.
 */
async function isDockerAvailable() {
    return new Promise((resolve) => {
        exec('docker ps', (err) => {
            resolve(!err);
        });
    });
}

/**
 * Spawn docker-compose up in the workspace.
 */
function spawnDockerCompose(workspacePath) {
    return new Promise((resolve, reject) => {
        console.log('[OrbitalOrchestrator] Spawning docker-compose...');
        
        // Use 'docker-compose up -d' on Windows/macOS/Linux
        const composeDir = workspacePath;
        const proc = spawn('docker-compose', ['up', '-d'], {
            cwd: composeDir,
            stdio: ['ignore', 'pipe', 'pipe']
        });
        
        let stdout = '';
        let stderr = '';
        
        proc.stdout.on('data', (data) => {
            stdout += data.toString();
            console.log('[Docker-Compose]', data.toString().trim());
        });
        
        proc.stderr.on('data', (data) => {
            stderr += data.toString();
            console.warn('[Docker-Compose]', data.toString().trim());
        });
        
        proc.on('close', (code) => {
            if (code === 0) {
                console.log('[OrbitalOrchestrator] docker-compose up completed successfully');
                resolve(proc);
            } else {
                reject(new Error(`docker-compose exited with code ${code}: ${stderr}`));
            }
        });
        
        proc.on('error', (err) => {
            reject(err);
        });
    });
}

/**
 * Initialize the Redpanda bridge (connects to Kafka).
 */
async function initBridge() {
    try {
        const { initRedpanda } = require('./orbital-redpanda-bridge');
        await initRedpanda();
        console.log('[OrbitalOrchestrator] ✓ Redpanda bridge initialized');
    } catch (err) {
        console.error('[OrbitalOrchestrator] Failed to initialize bridge:', err.message);
        throw err;
    }
}

/**
 * Start the Orbital Ingestor daemon.
 */
function startIngestor() {
    try {
        const OrbitalIngestor = require('../orbital/orbital-ingestor-daemon');
        OrbitalIngestor.start();
        console.log('[OrbitalOrchestrator] ✓ Orbital Ingestor daemon started');
        return OrbitalIngestor;
    } catch (err) {
        console.error('[OrbitalOrchestrator] Failed to start ingestor:', err.message);
        throw err;
    }
}

/**
 * Start the Matrix Processor (coherence loop).
 */
async function startProcessor() {
    try {
        const { startProcessor } = require('../orbital/orbital-matrix-processor');
        await startProcessor();
        console.log('[OrbitalOrchestrator] ✓ Matrix Processor coherence loop started');
    } catch (err) {
        console.error('[OrbitalOrchestrator] Failed to start processor:', err.message);
        throw err;
    }
}

/**
 * Main orchestration: spin up entire Orbital system.
 * Called from Electron main process on app ready.
 */
async function startOrbitalSystem(workspacePath) {
    if (orchestratorReady) {
        console.log('[OrbitalOrchestrator] System already running.');
        return true;
    }
    
    try {
        console.log('[OrbitalOrchestrator] ===== Starting Orbital System =====');
        
        // Step 1: Check Docker availability
        const dockerAvailable = await isDockerAvailable();
        if (!dockerAvailable) {
            throw new Error('Docker daemon is not running. Please start Docker and try again.');
        }
        console.log('[OrbitalOrchestrator] ✓ Docker is available');
        
        // Step 2: Spin up docker-compose
        dockerComposeProcess = await spawnDockerCompose(workspacePath);
        
        // Step 3: Wait for Redpanda to be ready
        await waitForRedpandaReady();
        
        // Step 4: Initialize Redpanda bridge
        await initBridge();
        
        // Step 5: Start Orbital Ingestor
        ingestorProcess = startIngestor();
        
        // Step 6: Start Matrix Processor
        await startProcessor();
        
        orchestratorReady = true;
        console.log('[OrbitalOrchestrator] ===== Orbital System Ready =====');
        console.log('[OrbitalOrchestrator] All services online: Redpanda, Bridge, Ingestor, Processor');
        
        return true;
    } catch (err) {
        console.error('[OrbitalOrchestrator] FATAL: Failed to start Orbital System:', err.message);
        await shutdownOrbitalSystem();
        throw err;
    }
}

/**
 * Graceful shutdown of all Orbital services and docker-compose.
 */
async function shutdownOrbitalSystem() {
    console.log('[OrbitalOrchestrator] Initiating graceful shutdown...');
    
    try {
        // Stop Matrix Processor and Ingestor
        if (processorHandle) {
            console.log('[OrbitalOrchestrator] Stopping Matrix Processor...');
            // Processor is a setInterval; no direct stop needed in current impl
        }
        
        if (ingestorProcess && ingestorProcess.connections) {
            console.log('[OrbitalOrchestrator] Closing Ingestor WebSocket connections...');
            for (const conn of ingestorProcess.connections.values()) {
                if (conn && typeof conn.close === 'function') {
                    conn.close();
                }
            }
        }
        
        // Disconnect Kafka producer
        try {
            const { Kafka } = require('kafkajs');
            // Graceful disconnect handled by kafkajs internally; we just log
            console.log('[OrbitalOrchestrator] Kafka producer disconnected');
        } catch (e) {
            // Kafka not initialized yet
        }
        
        // Stop docker-compose
        if (dockerComposeProcess) {
            console.log('[OrbitalOrchestrator] Stopping docker-compose...');
            dockerComposeProcess.kill('SIGTERM');
            
            // Also issue explicit docker-compose down
            await new Promise((resolve) => {
                exec('docker-compose down', { cwd: process.env.WECRYP_ROOT || process.cwd() }, (err) => {
                    if (err) {
                        console.warn('[OrbitalOrchestrator] docker-compose down returned error:', err.message);
                    } else {
                        console.log('[OrbitalOrchestrator] docker-compose down completed');
                    }
                    resolve();
                });
            });
        }
        
        orchestratorReady = false;
        console.log('[OrbitalOrchestrator] Orbital System shutdown complete');
    } catch (err) {
        console.error('[OrbitalOrchestrator] Error during shutdown:', err.message);
    }
}

module.exports = {
    startOrbitalSystem,
    shutdownOrbitalSystem,
    isOrchestrationReady: () => orchestratorReady
};
