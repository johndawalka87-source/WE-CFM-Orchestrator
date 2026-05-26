const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

let firebaseAdmin = null;
try {
  firebaseAdmin = require('firebase-admin');
} catch (_) {
  firebaseAdmin = null;
}

let firebaseApp = null;
let firestore = null;
let initError = null;
let initSource = 'uninitialized';
function resolveProjectId(...candidates) {
  for (const candidate of candidates) {
    const value = String(candidate || '').trim();
    if (value) return value;
  }
  return null;
}

let projectId = resolveProjectId(
  process.env.WECRYPTO_FIREBASE_PROJECT_ID,
  process.env.WECRYPTO_GOOGLE_PROJECT_ID,
  process.env.GOOGLE_CLOUD_PROJECT
);
let clientEmailHash = null;
let firestoreDatabaseId = process.env.WECRYPTO_FIREBASE_DATABASE_ID || '(default)';

function envFlagEnabled(value) {
  if (typeof value === 'boolean') return value;
  const normalized = String(value == null ? '' : value).trim().toLowerCase();
  return ['1', 'true', 'yes', 'on', 'enabled'].includes(normalized);
}

function hashEmail(email) {
  const normalized = String(email || '').trim().toLowerCase();
  if (!normalized) return null;
  return crypto.createHash('sha256').update(normalized).digest('hex').slice(0, 12);
}

function safeJsonParse(raw) {
  try {
    return JSON.parse(raw);
  } catch (_) {
    return null;
  }
}

function readServiceAccountFromEnv() {
  const inlineJson = process.env.WECRYPTO_FIREBASE_SERVICE_ACCOUNT_JSON;
  if (inlineJson) {
    const parsed = safeJsonParse(inlineJson);
    if (parsed) return { credentials: parsed, source: 'WECRYPTO_FIREBASE_SERVICE_ACCOUNT_JSON' };
  }

  const inlineBase64 = process.env.WECRYPTO_FIREBASE_SERVICE_ACCOUNT_BASE64;
  if (inlineBase64) {
    try {
      const decoded = Buffer.from(inlineBase64, 'base64').toString('utf8');
      const parsed = safeJsonParse(decoded);
      if (parsed) return { credentials: parsed, source: 'WECRYPTO_FIREBASE_SERVICE_ACCOUNT_BASE64' };
    } catch (_) { }
  }

  const credentialPath = process.env.WECRYPTO_FIREBASE_SERVICE_ACCOUNT_PATH || process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (credentialPath) {
    const resolved = path.resolve(credentialPath);
    if (fs.existsSync(resolved)) {
      const parsed = safeJsonParse(fs.readFileSync(resolved, 'utf8'));
      if (parsed) return { credentials: parsed, source: resolved };
    }
  }

  return null;
}

async function ensureInitialized() {
  if (firestore) {
    return { success: true, available: true, configured: true, source: initSource, projectId, clientEmailHash };
  }

  if (!firebaseAdmin) {
    initError = 'firebase-admin dependency is not installed';
    return { success: false, available: false, configured: false, error: initError };
  }

  const enabled = envFlagEnabled(process.env.WECRYPTO_FIREBASE_ENABLED || '0');
  const required = envFlagEnabled(process.env.WECRYPTO_FIREBASE_REQUIRED || '0');
  if (!enabled && !required) {
    initSource = 'disabled';
    return {
      success: false,
      available: false,
      configured: false,
      disabled: true,
      error: 'Firebase disabled (set WECRYPTO_FIREBASE_ENABLED=1 to enable)',
    };
  }

  const serviceAccount = readServiceAccountFromEnv();
  const useApplicationDefault = envFlagEnabled(process.env.WECRYPTO_FIREBASE_USE_APPLICATION_DEFAULT || '0');
  if (!serviceAccount && !useApplicationDefault) {
    initError = 'No Firebase service account found';
    return {
      success: false,
      available: false,
      configured: false,
      error: `${initError}. Set WECRYPTO_FIREBASE_SERVICE_ACCOUNT_PATH or WECRYPTO_FIREBASE_SERVICE_ACCOUNT_JSON`,
    };
  }

  try {
    const options = {};
    if (serviceAccount?.credentials) {
      options.credential = firebaseAdmin.credential.cert(serviceAccount.credentials);
      projectId = resolveProjectId(
        process.env.WECRYPTO_FIREBASE_PROJECT_ID,
        process.env.WECRYPTO_GOOGLE_PROJECT_ID,
        process.env.GOOGLE_CLOUD_PROJECT,
        serviceAccount.credentials.project_id,
        projectId
      );
      clientEmailHash = hashEmail(serviceAccount.credentials.client_email);
      initSource = serviceAccount.source;
    } else {
      options.credential = firebaseAdmin.credential.applicationDefault();
      projectId = resolveProjectId(
        process.env.WECRYPTO_FIREBASE_PROJECT_ID,
        process.env.WECRYPTO_GOOGLE_PROJECT_ID,
        process.env.GOOGLE_CLOUD_PROJECT,
        projectId
      );
      initSource = 'application-default-credentials';
    }
    if (projectId) options.projectId = projectId;

    firebaseApp = firebaseAdmin.apps.length
      ? firebaseAdmin.app()
      : firebaseAdmin.initializeApp(options);
    firestoreDatabaseId = process.env.WECRYPTO_FIREBASE_DATABASE_ID || '(default)';
    try {
      const firestoreModule = require('firebase-admin/firestore');
      if (firestoreDatabaseId && firestoreDatabaseId !== '(default)' && typeof firestoreModule.getFirestore === 'function') {
        firestore = firestoreModule.getFirestore(firebaseApp, firestoreDatabaseId);
      } else if (typeof firestoreModule.getFirestore === 'function') {
        firestore = firestoreModule.getFirestore(firebaseApp);
      } else {
        firestore = firebaseAdmin.firestore(firebaseApp);
      }
    } catch (_) {
      firestore = firebaseAdmin.firestore(firebaseApp);
    }
    firestore.settings({ ignoreUndefinedProperties: true });
    initError = null;

    return {
      success: true,
      available: true,
      configured: true,
      source: initSource,
      projectId,
      clientEmailHash,
      databaseId: firestoreDatabaseId,
    };
  } catch (error) {
    initError = error.message || String(error);
    return { success: false, available: false, configured: false, source: initSource, error: initError };
  }
}

function getStatus() {
  const enabled = envFlagEnabled(process.env.WECRYPTO_FIREBASE_ENABLED || '0');
  const required = envFlagEnabled(process.env.WECRYPTO_FIREBASE_REQUIRED || '0');
  return {
    available: !!firestore,
    configured: !!firestore,
    initialized: !!firestore,
    source: initSource,
    projectId: projectId || null,
    databaseId: firestoreDatabaseId || '(default)',
    clientEmailHash,
    enabled,
    required,
    error: initError,
  };
}

async function startupCheck(options = {}) {
  const required = !!options.required;
  const probe = options.probe !== false;

  const init = await ensureInitialized();
  if (!init.success) {
    if (required) {
      throw new Error(init.error || 'Firebase startup check failed');
    }
    return {
      success: false,
      configured: false,
      required,
      probe,
      projectId: projectId || null,
      databaseId: firestoreDatabaseId || '(default)',
      clientEmailHash,
      source: initSource,
      error: init.error || initError || 'Firebase unavailable',
    };
  }

  if (probe && firestore) {
    try {
      await firestore.collection('_health').doc('startup').set(
        {
          ts: Date.now(),
          source: 'wecrypto-electron',
        },
        { merge: true }
      );
    } catch (error) {
      if (required) throw error;
      return {
        success: false,
        configured: true,
        required,
        probe,
        projectId: projectId || null,
        databaseId: firestoreDatabaseId || '(default)',
        clientEmailHash,
        source: initSource,
        error: error.message || 'Firestore probe failed',
      };
    }
  }

  return {
    success: true,
    configured: true,
    required,
    probe,
    projectId: projectId || null,
    databaseId: firestoreDatabaseId || '(default)',
    clientEmailHash,
    source: initSource,
  };
}

function normalizeLimit(limit, fallback = 30) {
  const n = Number(limit);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(1, Math.min(200, Math.floor(n)));
}

function normalizeRecord(record = {}) {
  const now = Date.now();
  const sourceTs = Number(record.ts || record.createdAtMs || now);
  return {
    schemaVersion: String(record.schemaVersion || 'wecrypto.inference.v1'),
    kind: String(record.kind || 'inference'),
    sym: String(record.sym || record.coin || record.symbol || 'UNKNOWN').toUpperCase(),
    ts: Number.isFinite(sourceTs) ? sourceTs : now,
    source: String(record.source || 'wecrypto'),
    provider: record.provider ? String(record.provider) : null,
    snapshot: record.snapshot && typeof record.snapshot === 'object' ? record.snapshot : null,
    diagnostics: record.diagnostics && typeof record.diagnostics === 'object' ? record.diagnostics : null,
    output: record.output && typeof record.output === 'object' ? record.output : null,
    forecast: record.forecast && typeof record.forecast === 'object' ? record.forecast : null,
    rawResponse: record.rawResponse && typeof record.rawResponse === 'object' ? record.rawResponse : null,
    createdAtMs: now,
  };
}

function collectionName() {
  return String(process.env.WECRYPTO_FIREBASE_INFERENCE_COLLECTION || 'wecrypto_inferences').trim() || 'wecrypto_inferences';
}

async function appendInferenceRecord(record = {}) {
  const init = await ensureInitialized();
  if (!init.success || !firestore) {
    return { success: false, error: init.error || 'Firestore unavailable' };
  }

  const payload = normalizeRecord(record);
  try {
    const ref = firestore.collection(collectionName()).doc();
    await ref.set({
      ...payload,
      createdAt: firebaseAdmin.firestore.FieldValue.serverTimestamp(),
    });
    return { success: true, id: ref.id, collection: collectionName() };
  } catch (error) {
    const msg = error.message || '';
    if (msg.includes('PERMISSION_DENIED') || msg.includes('403') || msg.includes('Quota') || msg.includes('billing')) {
      console.warn(`[Firestore] Permission/Quota error appending inference (${msg}). Yielding to graceful local fallback.`);
      return { success: false, gracefulFallback: true, error: msg };
    }
    return { success: false, error: msg || 'Failed to append inference record' };
  }
}

async function getSystemWeights() {
  const init = await ensureInitialized();
  if (!init.success || !firestore) {
    return { success: false, weights: null, error: init.error || 'Firestore unavailable' };
  }
  try {
    const doc = await firestore.collection('wecrypto_config').doc('system_weights').get();
    if (!doc.exists) return { success: true, weights: null };
    return { success: true, weights: doc.data().weights };
  } catch (error) {
    return { success: false, weights: null, error: error.message };
  }
}

async function updateSystemWeights(weights) {
  const init = await ensureInitialized();
  if (!init.success || !firestore) {
    return { success: false, error: init.error || 'Firestore unavailable' };
  }
  try {
    await firestore.collection('wecrypto_config').doc('system_weights').set({
      weights,
      updatedAt: firebaseAdmin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

async function getInferenceRecords(limitCount = 30) {
  const init = await ensureInitialized();
  if (!init.success || !firestore) {
    throw new Error(init.error || 'Firestore unavailable');
  }

  const cappedLimit = normalizeLimit(limitCount);
  const snapshot = await firestore
    .collection(collectionName())
    .orderBy('createdAtMs', 'desc')
    .limit(cappedLimit)
    .get();

  return snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
}

function getFirestore() {
  if (!firestore) {
    // Fire-and-forget lazy init for callers that need a sync handle.
    ensureInitialized().catch(() => { });
  }
  return firestore;
}

module.exports = {
  envFlagEnabled,
  getFirestore,
  getStatus,
  startupCheck,
  appendInferenceRecord,
  getInferenceRecords,
  getSystemWeights,
  updateSystemWeights,
};
