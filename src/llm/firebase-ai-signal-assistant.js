/**
 * Firebase AI Logic Signal Assistant
 *
 * Uses Firebase AI Logic SDK (Gemini Developer API) to generate
 * plain-English narration of WE CFM Orchestrator prediction signals.
 *
 * Provider:  Firebase AI Logic → Gemini Developer API (free tier)
 * Model:     gemini-2.5-flash-latest
 * Mode:      Non-blocking, safe-gated, streaming-capable
 *
 * Drop-in complement to llm_signal_assistant.js.
 * Activated when LLM_PROVIDER=firebase or WECRYPTO_FIREBASE_AI_ENABLED=true.
 *
 * IMPORTANT: Firebase config is loaded from env vars — no secrets in source.
 */

'use strict';

const path = require('path');

// ── Lazy load dotenv so this module works standalone or inside Electron ──────
function loadEnv() {
  try {
    const dotenv = require('dotenv');
    const roots = [
      process.env.LLM_ENV_PATH,
      path.resolve(process.cwd(), '.env'),
      path.resolve(__dirname, '../../.env'),
      process.resourcesPath ? path.resolve(process.resourcesPath, '..', '.env') : null,
      process.execPath ? path.resolve(path.dirname(process.execPath), '.env') : null,
    ].filter(Boolean);
    for (const p of roots) {
      try { dotenv.config({ path: p, quiet: true }); } catch (_) {}
    }
  } catch (_) {}
}
loadEnv();

// ── Firebase config from env (never hardcoded) ───────────────────────────────
function buildFirebaseConfig() {
  return {
    apiKey:            process.env.WECRYPTO_FIREBASE_API_KEY       || process.env.FIREBASE_API_KEY       || '',
    authDomain:        process.env.WECRYPTO_FIREBASE_AUTH_DOMAIN   || `${process.env.WECRYPTO_FIREBASE_PROJECT_ID || 'wecrypto'}.firebaseapp.com`,
    projectId:         process.env.WECRYPTO_FIREBASE_PROJECT_ID    || process.env.WECRYPTO_GOOGLE_PROJECT_ID || 'wecrypto',
    storageBucket:     process.env.WECRYPTO_FIREBASE_STORAGE_BUCKET|| `${process.env.WECRYPTO_FIREBASE_PROJECT_ID || 'wecrypto'}.firebasestorage.app`,
    messagingSenderId: process.env.WECRYPTO_FIREBASE_SENDER_ID     || process.env.WECRYPTO_GOOGLE_PROJECT_NUMBER || '',
    appId:             process.env.WECRYPTO_FIREBASE_APP_ID        || '',
    measurementId:     process.env.WECRYPTO_FIREBASE_MEASUREMENT_ID|| '',
  };
}

const FIREBASE_AI_MODEL  = process.env.WECRYPTO_FIREBASE_AI_MODEL || 'gemini-2.5-flash-latest';
const ENABLED_FLAG       = (() => {
  const v = (process.env.WECRYPTO_FIREBASE_AI_ENABLED || process.env.LLM_PROVIDER || '').toLowerCase();
  return v === 'true' || v === '1' || v === 'firebase';
})();

// Rate limiting — one Gemini call per coin per N ms (default 30s = 1 per cycle)
const MIN_CALL_INTERVAL_MS = Number(process.env.WECRYPTO_FIREBASE_AI_INTERVAL_MS || 30000);
const _lastCallTs = new Map();

// ── Firebase app singleton ───────────────────────────────────────────────────
let _firebaseApp  = null;
let _aiInstance   = null;
let _model        = null;
let _initError    = null;

function _init() {
  if (_model) return true;
  if (_initError) return false;
  try {
    const { initializeApp, getApps, getApp } = require('firebase/app');
    const { getAI, getGenerativeModel, GoogleAIBackend } = require('firebase/ai');

    const cfg = buildFirebaseConfig();
    if (!cfg.apiKey) {
      _initError = 'WECRYPTO_FIREBASE_API_KEY not set';
      console.warn('[FirebaseAI] Disabled —', _initError);
      return false;
    }

    _firebaseApp = getApps().find(a => a.name === 'wecfm-ai') || initializeApp(cfg, 'wecfm-ai');
    _aiInstance  = getAI(_firebaseApp, { backend: new GoogleAIBackend() });
    _model       = getGenerativeModel(_aiInstance, {
      model: FIREBASE_AI_MODEL,
      generationConfig: {
        candidateCount: 1,
        maxOutputTokens: 512,
        temperature: 0.35,   // focused, deterministic for trading narration
        topP: 0.90,
        topK: 32,
      },
    });

    console.log(`[FirebaseAI] Initialized ✓ model=${FIREBASE_AI_MODEL} project=${cfg.projectId}`);
    return true;
  } catch (e) {
    _initError = e.message;
    console.error('[FirebaseAI] Init failed —', e.message);
    return false;
  }
}

// ── Prompt builder ────────────────────────────────────────────────────────────
function buildSignalPrompt(coin, pred) {
  const dir     = pred.direction || pred.predDir   || 'UNKNOWN';
  const conf    = pred.confidence  != null ? `${(pred.confidence * 100).toFixed(0)}%` : 'n/a';
  const h15     = pred.h15         || pred.horizon15 || {};
  const cfm     = pred.cfmRate     != null ? `$${Number(pred.cfmRate).toFixed(2)}` : 'n/a';
  const oeq     = pred.oeq         != null ? pred.oeq.toFixed(3) : 'n/a';
  const regime  = pred.regime      || pred.regimeLabel || 'unknown';
  const rsi     = pred.rsi         != null ? pred.rsi.toFixed(1) : 'n/a';
  const ema     = pred.emaCross    || 'n/a';
  const kalshi  = pred.kalshiSide  || (dir === 'UP' ? 'YES' : dir === 'DOWN' ? 'NO' : 'NONE');

  return (
    `You are a concise crypto trading signal narrator for the WE CFM Orchestrator. ` +
    `Summarize the following 15-minute prediction signal in 2 sentences max. ` +
    `Focus on: why the signal fired, its confidence level, and the recommended Kalshi action. ` +
    `Be direct — no filler words.\n\n` +
    `Asset: ${coin}\n` +
    `Direction: ${dir}  (Kalshi: ${kalshi})\n` +
    `Confidence: ${conf}\n` +
    `CFM rate: ${cfm}\n` +
    `Regime: ${regime}\n` +
    `OEQ: ${oeq}\n` +
    `RSI(14): ${rsi}\n` +
    `EMA cross: ${ema}\n` +
    (h15.signal ? `15m signal: ${h15.signal}\n` : '') +
    (pred.blockers && pred.blockers.length ? `Active blockers: ${pred.blockers.join(', ')}\n` : '')
  );
}

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * summarizeSignal(coin, predictionState) → Promise<string|null>
 *
 * Returns a 1-2 sentence plain-English narration of the current signal.
 * Returns null if disabled, rate-limited, or on error (non-blocking).
 */
async function summarizeSignal(coin, predictionState) {
  if (!ENABLED_FLAG) return null;
  if (!_init()) return null;

  const now  = Date.now();
  const last = _lastCallTs.get(coin) || 0;
  if (now - last < MIN_CALL_INTERVAL_MS) return null;
  _lastCallTs.set(coin, now);

  try {
    const prompt = buildSignalPrompt(coin, predictionState || {});
    const result = await _model.generateContent(prompt);
    return result.response.text().trim();
  } catch (e) {
    console.warn(`[FirebaseAI] summarizeSignal(${coin}) error:`, e.message);
    _lastCallTs.set(coin, now + 15000); // extra back-off on error
    return null;
  }
}

/**
 * summarizeSignalStream(coin, predictionState, onChunk) → Promise<string>
 *
 * Streaming variant — calls onChunk(text) for each partial result.
 * Returns the full accumulated text on completion.
 */
async function summarizeSignalStream(coin, predictionState, onChunk) {
  if (!ENABLED_FLAG) return null;
  if (!_init()) return null;

  const now  = Date.now();
  const last = _lastCallTs.get(coin) || 0;
  if (now - last < MIN_CALL_INTERVAL_MS) return null;
  _lastCallTs.set(coin, now);

  try {
    const prompt = buildSignalPrompt(coin, predictionState || {});
    const result = await _model.generateContentStream(prompt);
    let full = '';
    for await (const chunk of result.stream) {
      const txt = chunk.text();
      full += txt;
      if (typeof onChunk === 'function') onChunk(txt);
    }
    return full.trim();
  } catch (e) {
    console.warn(`[FirebaseAI] summarizeSignalStream(${coin}) error:`, e.message);
    _lastCallTs.set(coin, now + 15000);
    return null;
  }
}

/**
 * isEnabled() — returns true when the module is active and initialized.
 */
function isEnabled() {
  return ENABLED_FLAG && _init();
}

/**
 * getDiagnostics() — surface initialization state for debug panel.
 */
function getDiagnostics() {
  return {
    enabled: ENABLED_FLAG,
    initialized: !!_model,
    initError: _initError || null,
    model: FIREBASE_AI_MODEL,
    projectId: buildFirebaseConfig().projectId,
    rateLimitIntervalMs: MIN_CALL_INTERVAL_MS,
  };
}

module.exports = {
  summarizeSignal,
  summarizeSignalStream,
  isEnabled,
  getDiagnostics,
};
