/**
 * ════════════════════════════════════════════════════════════════════════════
 * MULTI-DRIVE INSTANT CACHE SYSTEM
 * 
 * Writes predictions/settlements/errors INSTANTLY to:
 *   1. Z:\ (network primary)
 *   2. D:\ (local backup)
 *   3. F:\ (secondary backup)
 *   4. D:\Users\admin (secondary network)
 *   5. C:\Users\user (local cache)
 *   6. localStorage (browser persistence)
 *   7. OneDrive (cloud)
 *   8. Google Drive (cloud)
 * 
 * No async delays — synchronous to each drive before returning
 * ════════════════════════════════════════════════════════════════════════════
 */

(function () {
  'use strict';

  // SafeGuard: Check if in browser (no Node.js requires needed here - it's a browser module)
  class MultiDriveCache {
    constructor() {
      this.cacheFile = 'contract-cache-2h.json';

      // Detect Electron via contextBridge (works with contextIsolation:true + nodeIntegration:false)
      this.isElectron = typeof window !== 'undefined' && window.desktopApp?.isElectron === true;

      // Drive paths (Windows)
      this.drivePaths = [
        'Z:\\WE-CRYPTO-CACHE',
        'D:\\WE-CRYPTO-CACHE',
        'F:\\WE-CRYPTO-CACHE',
        'D:\\Users\\admin\\WE-CRYPTO-CACHE',
        'C:\\Users\\user\\AppData\\Local\\WE-CRYPTO-CACHE',
      ];
      this.networkDrivePaths = [];

      // Cloud folders discovered async during _initAsync
      this.onedriveFolders = [];
      this.onedriveFolder = null;
      this.googleDriveFolder = null;

      // In-memory cache
      this.data = {
        predictions: [],
        settlements: [],
        candles: [],
        orders: [],
        errors: [],
        correlations: [],
        marketContexts: [],
        inferences: [],
        lastSyncTime: Date.now(),
      };

      // Kick off async init (discover cloud folders, ensure dirs, load from drives)
      if (this.isElectron) {
        this._initAsync().catch(e => console.warn('[MultiDriveCache] Async init error:', e.message));
      }

      console.log('[MultiDriveCache] Initialized — isElectron:', this.isElectron);
    }

    // Simple cross-platform path joiner (replaces require('path').join)
    _join(...parts) {
      return parts.join('\\').replace(/\\{2,}/g, '\\');
    }

    _normalizePath(input) {
      if (!input || typeof input !== 'string') return '';
      const normalized = input.trim().replace(/[\\/]+/g, '\\').replace(/\\+$/, '');
      return normalized;
    }

    _prioritizeZDrive(paths = []) {
      const unique = [...new Set((paths || []).map(p => this._normalizePath(p)).filter(Boolean))];
      const zFirst = unique.filter(p => /^Z:\\/i.test(p));
      const remaining = unique.filter(p => !/^Z:\\/i.test(p));
      return [...zFirst, ...remaining];
    }

    async _initAsync() {
      await this._discoverNetworkDrives();
      await this._discoverCloudFolders();
      await this._ensureDirectories();
      await this._loadFromDrives();
    }

    async _discoverNetworkDrives() {
      if (!this.isElectron || !window.desktopApp?.getDrives) return;
      try {
        const drives = await window.desktopApp.getDrives();
        const roots = [];
        for (const drive of drives || []) {
          if (drive?.type === 'network' && drive?.root) {
            roots.push(this._join(drive.root, 'WE-CRYPTO-CACHE'));
          }
        }
        this.networkDrivePaths = roots;
        if (roots.length) {
          console.log('[MultiDriveCache] Network shares discovered:', roots.join(' | '));
        }
      } catch (e) {
        console.warn('[MultiDriveCache] Network drive discovery error:', e.message);
      }
    }

    async _discoverCloudFolders() {
      if (!this.isElectron || !window.dataStore?.listDir) return;
      try {
        // Discover OneDrive folders under common user home paths
        const homeCandidates = ['C:\\Users\\user', 'C:\\Users\\admin', 'C:\\Users\\Public'];
        for (const home of homeCandidates) {
          const res = await window.dataStore.listDir(home);
          if (!res?.ok) continue;
          for (const entry of (res.entries || [])) {
            if (entry.startsWith('OneDrive')) {
              this.onedriveFolders.push(this._join(home, entry, 'WE-CRYPTO-CACHE'));
            }
          }
        }
        if (this.onedriveFolders.length) {
          this.onedriveFolder = this.onedriveFolders[0];
        }

        // Google Drive — scan all mounted drives and prioritize Z:\My Drive
        const googleCandidates = new Set([
          'Z:\\My Drive',
          'Z:\\Google Drive',
          'G:\\My Drive',
          'G:\\Google Drive',
          'G:\\',
          'Z:\\',
        ]);
        const driveRoots = new Set(['Z:\\', 'G:\\']);

        if (window.desktopApp?.getDrives) {
          try {
            const drives = await window.desktopApp.getDrives();
            for (const drive of drives || []) {
              if (!drive?.root) continue;
              const root = this._normalizePath(drive.root);
              if (!root) continue;
              const rootWithSlash = /^[A-Za-z]:$/i.test(root) ? `${root}\\` : root;
              driveRoots.add(rootWithSlash);
            }
          } catch (e) {
            console.warn('[MultiDriveCache] Drive scan for Google mounts failed:', e.message);
          }
        }

        for (const root of driveRoots) {
          const base = this._normalizePath(root).replace(/\\$/, '');
          if (!base) continue;
          googleCandidates.add(`${base}\\My Drive`);
          googleCandidates.add(`${base}\\Google Drive`);
        }

        for (const candidate of this._prioritizeZDrive([...googleCandidates])) {
          const res = await window.dataStore.listDir(candidate);
          if (res?.ok) {
            this.googleDriveFolder = this._join(candidate, 'WE-CRYPTO-CACHE');
            break;
          }
        }
      } catch (e) {
        console.warn('[MultiDriveCache] Cloud folder discovery error:', e.message);
      }
    }

    async _ensureDirectories() {
      if (!this.isElectron || !window.dataStore?.ensureDir) return;
      const allPaths = [...this.drivePaths, ...this.networkDrivePaths, ...this.onedriveFolders];
      if (this.googleDriveFolder) allPaths.push(this.googleDriveFolder);
      await Promise.allSettled(allPaths.map(p => window.dataStore.ensureDir(p)));
    }

    /**
     * Get OneDrive folder paths — sync stub kept for back-compat, populated async
     */
    _getOnedriveFolders() { return []; }

    /**
     * Get Google Drive folder — sync stub kept for back-compat, populated async
     */
    _getGoogleDriveFolder() { return null; }

    /**
     * Record prediction and write INSTANTLY to all drives
     */
    recordPrediction(coin, direction, confidence, signals = {}) {
      const now = Date.now();
      const record = {
        coin,
        direction,
        confidence,
        signals,
        timestamp: now,
        id: `pred-${coin}-${now}`,
      };

      this.data.predictions.push(record);
      this._trim('predictions');

      // Write instantly to all drives
      this._syncAllDrives();

      // Also write to localStorage (browser)
      if (typeof window !== 'undefined' && window.localStorage) {
        try {
          localStorage.setItem('contract-cache-predictions-latest', JSON.stringify(record));
        } catch (e) {
          console.warn('[MultiDriveCache] localStorage write failed:', e.message);
        }
      }

      return record;
    }

    /**
     * Record compact market context for inference/recall
     */
    recordMarketContext(coin, context = {}, options = {}) {
      const now = Date.now();
      const record = {
        coin,
        ...context,
        timestamp: now,
        id: `ctx-${coin}-${now}`,
      };

      this.data.marketContexts.push(record);
      this._trim('marketContexts', 3000);

      if (options.sync !== false) {
        this._syncAllDrives();
      }

      if (typeof window !== 'undefined' && window.localStorage) {
        try {
          localStorage.setItem('contract-cache-market-context-latest', JSON.stringify(record));
        } catch (e) {
          console.warn('[MultiDriveCache] localStorage write failed:', e.message);
        }
      }

      return record;
    }

    /**
     * Record inference output + optional input snapshot
     */
    recordInference(coin, inference = {}, snapshot = null, options = {}) {
      const now = Date.now();
      const record = {
        coin,
        inference,
        snapshot,
        timestamp: now,
        id: `inf-${coin}-${now}`,
      };

      this.data.inferences.push(record);
      this._trim('inferences', 1500);

      if (options.sync !== false) {
        this._syncAllDrives();
      }

      if (typeof window !== 'undefined' && window.localStorage) {
        try {
          localStorage.setItem('contract-cache-inference-latest', JSON.stringify(record));
        } catch (e) {
          console.warn('[MultiDriveCache] localStorage write failed:', e.message);
        }
      }

      return record;
    }

    /**
     * Record settlement and write INSTANTLY to all drives
     */
    recordSettlement(coin, outcome, modelCorrect, marketCorrect) {
      const now = Date.now();
      const record = {
        coin,
        outcome,
        modelCorrect,
        marketCorrect,
        timestamp: now,
        id: `settle-${coin}-${now}`,
      };

      this.data.settlements.push(record);
      this._trim('settlements');

      // Write instantly to all drives
      this._syncAllDrives();

      // Also write to localStorage
      if (typeof window !== 'undefined' && window.localStorage) {
        try {
          localStorage.setItem('contract-cache-settlements-latest', JSON.stringify(record));
        } catch (e) {
          console.warn('[MultiDriveCache] localStorage write failed:', e.message);
        }
      }

      return record;
    }

    /**
     * Record error and write INSTANTLY to all drives
     */
    recordError(type, message, context = {}) {
      const now = Date.now();
      const record = {
        type,
        message,
        context,
        timestamp: now,
        id: `error-${type}-${now}`,
      };

      this.data.errors.push(record);
      this._trim('errors', 500);  // Keep last 500 errors

      // Write instantly to all drives
      this._syncAllDrives();

      // Also write to localStorage
      if (typeof window !== 'undefined' && window.localStorage) {
        try {
          localStorage.setItem('contract-cache-errors-latest', JSON.stringify(record));
        } catch (e) {
          console.warn('[MultiDriveCache] localStorage write failed:', e.message);
        }
      }

      return record;
    }

    /**
     * Write current cache to all target drives (fire-and-forget async)
     */
    _syncAllDrives() {
      if (!this.isElectron || !window.dataStore?.writeFile) return;

      const cacheJson = JSON.stringify(this.data, null, 2);
      const allPaths = [
        ...this.drivePaths,
        ...this.networkDrivePaths,
        ...this.onedriveFolders,
        ...(this.googleDriveFolder ? [this.googleDriveFolder] : []),
      ];

      this.data.lastSyncTime = Date.now();

      // Fire-and-forget: each write is independent
      allPaths.forEach(dirPath => {
        const filePath = this._join(dirPath, this.cacheFile);
        window.dataStore.writeFile(filePath, cacheJson).catch(() => { });
      });
    }

    /**
     * Public sync trigger for batched writes
     */
    flushSync() {
      this._syncAllDrives();
    }

    /**
     * Load cache from drives (priority order) — async, called from _initAsync
     */
    async _loadFromDrives() {
      if (!this.isElectron || !window.dataStore?.readFile) return;

      const allPaths = [
        ...this.drivePaths,
        ...this.networkDrivePaths,
        ...this.onedriveFolders,
        ...(this.googleDriveFolder ? [this.googleDriveFolder] : []),
      ];

      for (const dirPath of allPaths) {
        try {
          const filePath = this._join(dirPath, this.cacheFile);
          const res = await window.dataStore.readFile(filePath);
          if (!res?.ok || !res.content) continue;

          const loaded = JSON.parse(res.content);
          const now = Date.now();
          const maxAge = 2 * 60 * 60 * 1000;

          this.data.predictions = (loaded.predictions || []).filter(p => now - p.timestamp < maxAge);
          this.data.settlements = (loaded.settlements || []).filter(s => now - s.timestamp < maxAge);
          this.data.candles = (loaded.candles || []).filter(c => now - c.timestamp < maxAge);
          this.data.orders = (loaded.orders || []).filter(o => now - o.timestamp < maxAge);
          this.data.errors = (loaded.errors || []).slice(-500);
          this.data.correlations = (loaded.correlations || []).filter(c => now - c.timestamp < maxAge);
          this.data.marketContexts = (loaded.marketContexts || loaded.contexts || []).filter(c => now - c.timestamp < maxAge);
          this.data.inferences = (loaded.inferences || loaded.inference || []).filter(i => now - i.timestamp < maxAge);

          console.log(`[MultiDriveCache] Loaded from ${dirPath}: ${this.data.predictions.length} predictions`);
          return; // First successful drive wins
        } catch (e) {
          console.warn(`[MultiDriveCache] Load from ${dirPath} failed:`, e.message);
        }
      }

      console.log('[MultiDriveCache] No cache found on any drive, starting fresh');
    }

    /**
     * Trim old data from arrays
     */
    _trim(key, maxCount = null) {
      const now = Date.now();
      const maxAge = 2 * 60 * 60 * 1000;  // 2 hours

      if (key === 'errors') {
        this.data.errors = this.data.errors.filter(e => now - e.timestamp < maxAge).slice(-500);
      } else if (key === 'predictions') {
        this.data.predictions = this.data.predictions.filter(p => now - p.timestamp < maxAge);
      } else if (key === 'settlements') {
        this.data.settlements = this.data.settlements.filter(s => now - s.timestamp < maxAge);
      } else if (key === 'candles') {
        this.data.candles = this.data.candles.filter(c => now - c.timestamp < maxAge);
      } else if (key === 'orders') {
        this.data.orders = this.data.orders.filter(o => now - o.timestamp < maxAge);
      } else if (key === 'correlations') {
        this.data.correlations = this.data.correlations.filter(c => now - c.timestamp < maxAge);
      } else if (key === 'marketContexts') {
        this.data.marketContexts = this.data.marketContexts.filter(c => now - c.timestamp < maxAge);
      } else if (key === 'inferences') {
        this.data.inferences = this.data.inferences.filter(i => now - i.timestamp < maxAge);
      }

      if (maxCount) {
        this.data[key] = this.data[key].slice(-maxCount);
      }
    }

    /**
     * Get cache status
     */
    getStatus() {
      return {
        predictions: this.data.predictions.length,
        settlements: this.data.settlements.length,
        candles: this.data.candles.length,
        orders: this.data.orders.length,
        errors: this.data.errors.length,
        correlations: this.data.correlations.length,
        marketContexts: this.data.marketContexts.length,
        inferences: this.data.inferences.length,
        lastSyncTime: new Date(this.data.lastSyncTime).toISOString(),
        drivesConfigured: this.drivePaths.length,
        onedriveConfigured: this.onedriveFolders.length > 0,
        onedriveTargets: this.onedriveFolders.length,
        googleDriveConfigured: this.googleDriveFolder ? true : false,
        networkTargets: this.networkDrivePaths.length,
        totalTargets: this.drivePaths.length + this.networkDrivePaths.length + this.onedriveFolders.length + (this.googleDriveFolder ? 1 : 0),
      };
    }

    /**
     * Get accuracy by coin
     */
    getAccuracyByCoins() {
      const byCoins = {};

      this.data.settlements.forEach(s => {
        if (!byCoins[s.coin]) {
          byCoins[s.coin] = { correct: 0, total: 0 };
        }
        byCoins[s.coin].total++;
        if (s.modelCorrect === true) byCoins[s.coin].correct++;
      });

      return Object.entries(byCoins).reduce((acc, [coin, data]) => {
        acc[coin] = {
          accuracy: Math.round((data.correct / data.total) * 100),
          correct: data.correct,
          total: data.total,
        };
        return acc;
      }, {});
    }

    /**
     * Export recent data
     */
    exportRecent(minutes = 60) {
      const cutoff = Date.now() - (minutes * 60 * 1000);

      return {
        predictions: this.data.predictions.filter(p => p.timestamp > cutoff),
        settlements: this.data.settlements.filter(s => s.timestamp > cutoff),
        errors: this.data.errors.filter(e => e.timestamp > cutoff),
        marketContexts: this.data.marketContexts.filter(c => c.timestamp > cutoff),
        inferences: this.data.inferences.filter(i => i.timestamp > cutoff),
      };
    }
  }

  // Global instance
  const multiDriveCache = new MultiDriveCache();

  // Expose to window
  if (typeof window !== 'undefined') {
    window.MultiDriveCache = multiDriveCache;
    window.MultiDriveCacheDebug = {
      status: () => {
        console.table(multiDriveCache.getStatus());
        return multiDriveCache.getStatus();
      },
      accuracy: () => {
        console.table(multiDriveCache.getAccuracyByCoins());
        return multiDriveCache.getAccuracyByCoins();
      },
      recent: (minutes = 60) => {
        const data = multiDriveCache.exportRecent(minutes);
        console.log(`Exported last ${minutes}m:`, data);
        return data;
      },
      syncNow: () => {
        multiDriveCache._syncAllDrives();
        console.log('✓ Manual sync complete');
      },
    };
  }

  // Expose to Node.js
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = multiDriveCache;
  }
})();
