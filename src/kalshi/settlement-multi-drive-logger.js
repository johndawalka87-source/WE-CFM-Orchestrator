/**
 * Settlement Multi-Drive Cloud Logger
 * 
 * Persists settlement data across:
 * - Local network drives (F:\, Z:\, etc.)
 * - OneDrive (both personal + business)
 * - Google Drive
 * 
 * Ensures data survives any single drive failure
 */

(function () {
  'use strict';

  // Guard: ipcRenderer only available in Electron renderer process
  const ipcRenderer = (typeof require !== 'undefined') ? require('electron').ipcRenderer : null;
  if (!ipcRenderer) {
    console.warn('[settlement-multi-drive-logger] ipcRenderer not available - module disabled');
    return;
  }

  async function discoverNetworkShareTargets() {
    try {
      if (!window.desktopApp?.getDrives) return [];
      const drives = await window.desktopApp.getDrives();
      return (drives || [])
        .filter(d => d && d.type === 'network' && d.root)
        .map(d => `${d.root}WECRYP\\settlement-logs`);
    } catch (e) {
      console.warn('[SettlementLogger] Network share discovery failed:', e.message);
      return [];
    }
  }

  const SYNC_TARGETS = {
    network_drives: [],
    onedrive: [
      // Personal OneDrive
      process.env.ONEDRIVE || '',
      process.env.OneDriveConsumer || '',
      // Business OneDrive (usually OneDrive for Business)
      process.env.ONEDRIVE_BUSINESS || '',
      process.env.OneDriveCommercial || '',
      // Fallback paths
      'C:\\Users\\' + (process.env.USERNAME || 'user') + '\\OneDrive',
      'C:\\Users\\' + (process.env.USERNAME || 'user') + '\\OneDrive - Personal',
      'C:\\Users\\' + (process.env.USERNAME || 'user') + '\\OneDrive - ctstate.edu',
      'C:\\Users\\' + (process.env.USERNAME || 'user') + '\\OneDrive - Azure ctstate.edu',
      'C:\\Users\\' + (process.env.USERNAME || 'user') + '\\OneDrive - Company',
    ],
    google_drive: [
      // Google Drive via Backup and Sync
      'H:\\My Drive',
      'C:\\Users\\' + (process.env.USERNAME || 'user') + '\\Google Drive',
      'C:\\Users\\' + (process.env.USERNAME || 'user') + '\\My Drive',
      'G:\\My Drive',
      process.env.GOOGLE_DRIVE_PATH || ''
    ]
  };

  const SESSION_START = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const LOG_FILENAME = `kalshi-settlements-${SESSION_START}.log`;

  let settlementBuffer = [];
  let syncStatus = {
    network_drives: {},
    onedrive: {},
    google_drive: {}
  };
  let isLogging = true;

  /**
   * Initialize all target directories
   */
  function initializeTargets() {
    discoverNetworkShareTargets().then(extraTargets => {
      if (extraTargets.length) {
        SYNC_TARGETS.network_drives = [...new Set([...(SYNC_TARGETS.network_drives || []), ...extraTargets].filter(Boolean))];
        console.log('[SettlementLogger] Network shares discovered:', extraTargets.join(' | '));
      }

      ipcRenderer.send('multi-drive:init-directories', {
        targets: SYNC_TARGETS,
        filename: LOG_FILENAME
      });
    }).catch(() => {
      ipcRenderer.send('multi-drive:init-directories', {
        targets: SYNC_TARGETS,
        filename: LOG_FILENAME
      });
    });

    // Listen for directory init results
    ipcRenderer.on('multi-drive:init-complete', (event, results) => {
      console.log('[SettlementLogger] Directory initialization complete:', results);
      syncStatus = results;
    });
  }

  /**
   * Write settlement record to all targets
   */
  function writeSettlementRecord(record) {
    if (!isLogging) return;

    settlementBuffer.push(record);

    // Batch write every 5 records
    if (settlementBuffer.length >= 5) {
      flushBuffer();
    }
  }

  /**
   * Flush buffer to all targets (network, OneDrive, Google Drive)
   */
  function flushBuffer() {
    if (settlementBuffer.length === 0) return;

    const lines = settlementBuffer.map(r => {
      const timestamp = new Date(r.ts).toISOString();
      const modelDir = r.modelDir || 'UNKNOWN';
      const outcome = r.outcome || 'PENDING';
      const correct = r.correct === true ? 'WIN' : r.correct === false ? 'LOSS' : 'PENDING';
      const confidence = r.confidence || 0;
      const kalshiProb = r.kalshiProb || 0;

      return `${timestamp},${r.sym},${modelDir},${outcome},${correct},${confidence},${kalshiProb}`;
    });

    const isNewFile = !window._settlementLogHeaderWritten;
    const content = isNewFile
      ? `timestamp,coin,model_direction,kalshi_outcome,result,confidence,kalshi_probability\n${lines.join('\n')}\n`
      : `${lines.join('\n')}\n`;

    // Send to main process for multi-target write
    ipcRenderer.send('multi-drive:write-settlement-log', {
      filename: LOG_FILENAME,
      content: content,
      isNewFile: isNewFile,
      targets: SYNC_TARGETS,
      recordCount: settlementBuffer.length
    });

    // Listen for write results
    ipcRenderer.once('multi-drive:write-complete', (event, results) => {
      console.log('[SettlementLogger] Multi-drive write complete:', results);
      // Update sync status
      syncStatus = results.syncStatus || syncStatus;
    });

    window._settlementLogHeaderWritten = true;
    settlementBuffer = [];
  }

  /**
   * Hook into dashboard to capture settlements
   */
  function setupHooks() {
    setInterval(() => {
      if (!window.KalshiSettlementDebug) return;

      const allData = window.KalshiSettlementDebug.getAllData?.();
      if (!allData || !Array.isArray(allData)) return;

      if (!window._loggedSettlementIds) {
        window._loggedSettlementIds = new Set();
      }

      for (const record of allData) {
        const id = `${record.ts}-${record.sym}`;
        if (!window._loggedSettlementIds.has(id)) {
          writeSettlementRecord(record);
          window._loggedSettlementIds.add(id);
        }
      }
    }, 5000);

    // Flush partial batches regularly so recent logs are not lost on abrupt exits.
    setInterval(() => {
      if (settlementBuffer.length > 0) flushBuffer();
    }, 30000);
  }

  /**
   * Public API
   */
  window.SettlementMultiDriveLogger = {
    /**
     * Get log filename
     */
    getFilename: () => LOG_FILENAME,

    /**
     * Get all target locations
     */
    getTargets: () => SYNC_TARGETS,

    /**
     * Get sync status for all targets
     */
    getSyncStatus: () => syncStatus,

    /**
     * Flush buffer to disk immediately
     */
    flush: () => flushBuffer(),

    /**
     * Stop logging
     */
    stop: () => {
      isLogging = false;
      flushBuffer();
    },

    /**
     * Resume logging
     */
    resume: () => {
      isLogging = true;
    },

    /**
     * Get buffer status
     */
    status: () => ({
      filename: LOG_FILENAME,
      bufferedRecords: settlementBuffer.length,
      isLogging: isLogging,
      loggedIds: window._loggedSettlementIds?.size || 0,
      syncStatus: syncStatus,
      targets: SYNC_TARGETS
    }),

    /**
     * Print sync status to console
     */
    printSyncStatus: () => {
      console.log('=== SETTLEMENT MULTI-DRIVE SYNC STATUS ===');
      console.log(`Log File: ${LOG_FILENAME}`);
      console.log('\nNetwork Drives:');
      Object.entries(syncStatus.network_drives).forEach(([path, status]) => {
        const icon = status.success ? '✅' : '❌';
        console.log(`  ${icon} ${path}: ${status.message}`);
      });
      console.log('\nOneDrive:');
      Object.entries(syncStatus.onedrive).forEach(([path, status]) => {
        const icon = status.success ? '✅' : '❌';
        console.log(`  ${icon} ${path}: ${status.message}`);
      });
      console.log('\nGoogle Drive:');
      Object.entries(syncStatus.google_drive).forEach(([path, status]) => {
        const icon = status.success ? '✅' : '❌';
        console.log(`  ${icon} ${path}: ${status.message}`);
      });
    }
  };

  // Auto-flush on page unload
  window.addEventListener('beforeunload', () => {
    flushBuffer();
  });

  // Initialize and setup monitoring
  initializeTargets();
  setupHooks();

  console.log('[SettlementMultiDriveLogger] Initialized for multi-target persistence');
  console.log('[SettlementMultiDriveLogger] Targets:', SYNC_TARGETS);
})();
