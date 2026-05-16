/**
 * SignalSchedulerAgent
 *
 * Lightweight browser-side work scheduler for fetch-heavy prediction loops.
 * It keeps price, momentum, validation, and background lanes from stampeding
 * external APIs while preserving simple Promise semantics for callers.
 */
(function () {
  'use strict';

  const DEFAULT_LANES = {
    microstructure: { concurrency: 4, gapMs: 10, maxJobMs: 12000 },
    price: { concurrency: 3, gapMs: 25, maxJobMs: 20000 },
    momentum: { concurrency: 3, gapMs: 75, maxJobMs: 22000 },
    validation: { concurrency: 1, gapMs: 250, maxJobMs: 15000 },
    background: { concurrency: 2, gapMs: 150, maxJobMs: 25000 },
  };

  const DEFAULT_PROVIDERS = {
    default: { cooldownMs: 0, cooldownMaxMs: 30000, circuitThreshold: 4, circuitMs: 60000 },
  };

  function now() {
    return Date.now();
  }

  function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
  }

  function normalizeLaneConfig(config) {
    const laneConfig = { ...DEFAULT_LANES, ...(config || {}) };
    const lanes = {};
    Object.entries(laneConfig).forEach(([name, lane]) => {
      lanes[name] = {
        concurrency: Math.max(1, Number(lane.concurrency) || 1),
        gapMs: Math.max(0, Number(lane.gapMs) || 0),
        maxJobMs: Math.max(0, Number(lane.maxJobMs) || 0),
        active: 0,
        lastStart: 0,
        queue: [],
        timer: null,
      };
    });
    return lanes;
  }

  function normalizeProviderConfig(config) {
    return { ...DEFAULT_PROVIDERS, ...(config || {}) };
  }

  class SignalSchedulerAgent {
    constructor(options = {}) {
      this.lanes = normalizeLaneConfig(options.lanes);
      this.providers = normalizeProviderConfig(options.providers);
      this.providerState = new Map();
      this.pendingDedupe = new Map();
      this.sourceSnapshots = new Map();
      this.sequence = 0;
    }

    schedule(work, options = {}) {
      if (typeof work !== 'function') {
        return Promise.reject(new TypeError('SignalSchedulerAgent.schedule requires a function'));
      }

      const laneName = this.lanes[options.lane] ? options.lane : 'background';
      const dedupeKey = options.dedupeKey ? String(options.dedupeKey) : null;
      if (dedupeKey && this.pendingDedupe.has(dedupeKey)) {
        return this.pendingDedupe.get(dedupeKey);
      }

      const promise = new Promise((resolve, reject) => {
        const job = {
          id: ++this.sequence,
          work,
          options,
          provider: options.provider || 'default',
          earliestAt: now() + Math.max(0, Number(options.delayMs) || 0),
          priority: Number(options.priorityBoost) || 0,
          createdAt: now(),
          resolve,
          reject,
        };

        const lane = this.lanes[laneName];
        lane.queue.push(job);
        this._pumpLane(laneName);
      });

      if (dedupeKey) {
        this.pendingDedupe.set(dedupeKey, promise);
        promise.finally(() => this.pendingDedupe.delete(dedupeKey)).catch(() => {});
      }

      return promise;
    }

    inferLaneFromUrl(url, fallback = 'background') {
      const provider = this.inferProviderFromUrl(url);
      if (provider === 'llm' || provider === 'kalshi') return 'validation';
      if (/orderbook|depth|l2|book|trades|recent-trade|histories/i.test(String(url || ''))) {
        return 'microstructure';
      }
      if (['pyth-lazer', 'coinbase', 'binance', 'kraken', 'bybit', 'okx', 'cdc'].includes(provider)) {
        return 'price';
      }
      if (['gecko', 'cmc', 'mempool', 'blockscout', 'solana', 'hyperliquid'].includes(provider)) {
        return 'momentum';
      }
      return fallback;
    }

    inferProviderFromUrl(url) {
      try {
        const host = new URL(String(url), window.location.href).hostname.toLowerCase();
        if (host.includes('pyth')) return 'pyth-lazer';
        if (host.includes('coinbase')) return 'coinbase';
        if (host.includes('binance')) return 'binance';
        if (host.includes('kraken')) return 'kraken';
        if (host.includes('bybit')) return 'bybit';
        if (host.includes('okx')) return 'okx';
        if (host.includes('crypto.com')) return 'cdc';
        if (host.includes('coingecko')) return 'gecko';
        if (host.includes('coinmarketcap')) return 'cmc';
        if (host.includes('kalshi')) return 'kalshi';
        if (host.includes('polymarket')) return 'polymarket';
        if (host.includes('mempool.space')) return 'mempool';
        if (host.includes('blockscout')) return 'blockscout';
        if (host.includes('solana')) return 'solana';
        if (host.includes('hyperliquid')) return 'hyperliquid';
        if (host.includes('openai') || host.includes('generativelanguage') || host.includes('googleapis')) return 'llm';
        return host.replace(/^api\./, '').split('.')[0] || 'default';
      } catch (_) {
        return 'default';
      }
    }

    markSourceFresh(provider, data, timestamp = now()) {
      this.sourceSnapshots.set(String(provider || 'default'), { data, timestamp: Number(timestamp) || now() });
    }

    getFreshSourceSnapshot(provider, ttlMs = 3000) {
      const entry = this.sourceSnapshots.get(String(provider || 'default'));
      if (!entry) return null;
      if (now() - entry.timestamp > Math.max(0, Number(ttlMs) || 0)) return null;
      return entry.data;
    }

    getHealthStatus() {
      const lanes = {};
      Object.entries(this.lanes).forEach(([name, lane]) => {
        lanes[name] = { active: lane.active, queued: lane.queue.length, gapMs: lane.gapMs };
      });
      const providers = {};
      this.providerState.forEach((state, name) => {
        providers[name] = {
          failures: state.failures,
          cooldownUntil: state.cooldownUntil,
          circuitUntil: state.circuitUntil,
        };
      });
      return { lanes, providers, dedupe: this.pendingDedupe.size };
    }

    _pumpLane(laneName) {
      const lane = this.lanes[laneName];
      if (!lane || lane.timer || lane.active >= lane.concurrency || lane.queue.length === 0) return;

      const delayForGap = Math.max(0, lane.gapMs - (now() - lane.lastStart));
      if (delayForGap > 0) {
        lane.timer = setTimeout(() => {
          lane.timer = null;
          this._pumpLane(laneName);
        }, delayForGap);
        return;
      }

      lane.queue.sort((a, b) => (b.priority - a.priority) || (a.createdAt - b.createdAt));
      const nextIndex = lane.queue.findIndex(job => job.earliestAt <= now());
      if (nextIndex === -1) {
        const nextAt = Math.min(...lane.queue.map(job => job.earliestAt));
        lane.timer = setTimeout(() => {
          lane.timer = null;
          this._pumpLane(laneName);
        }, Math.max(0, nextAt - now()));
        return;
      }

      const [job] = lane.queue.splice(nextIndex, 1);
      lane.active++;
      lane.lastStart = now();

      this._runJob(job)
        .then(job.resolve, job.reject)
        .finally(() => {
          lane.active--;
          this._pumpLane(laneName);
        });

      this._pumpLane(laneName);
    }

    async _runJob(job) {
      const providerName = String(job.provider || 'default');
      const provider = this.providers[providerName] || this.providers.default || DEFAULT_PROVIDERS.default;
      const state = this._providerState(providerName);
      const laneName = this.lanes[job.options?.lane] ? job.options.lane : 'background';
      const lane = this.lanes[laneName];
      const waitUntil = Math.max(state.cooldownUntil || 0, state.circuitUntil || 0, job.earliestAt || 0);
      if (waitUntil > now()) {
        await sleep(waitUntil - now());
      }

      try {
        const timeoutMs = Number(job.options.timeoutMs) || Number(lane?.maxJobMs) || 0;
        const result = timeoutMs > 0
          ? await this._withTimeout(job.work, timeoutMs, job.options.tag)
          : await job.work();
        state.failures = 0;
        state.circuitUntil = 0;
        state.cooldownUntil = now() + Math.max(0, Number(provider.cooldownMs) || 0);
        return result;
      } catch (err) {
        state.failures++;
        const threshold = Math.max(1, Number(provider.circuitThreshold) || 4);
        const baseCooldown = Math.max(0, Number(provider.cooldownMs) || 0);
        const maxCooldown = Math.max(baseCooldown, Number(provider.cooldownMaxMs) || 30000);
        const backoff = Math.min(maxCooldown, baseCooldown * Math.pow(2, Math.max(0, state.failures - 1)));
        state.cooldownUntil = now() + backoff;
        if (state.failures >= threshold) {
          state.circuitUntil = now() + Math.max(0, Number(provider.circuitMs) || 60000);
        }
        throw err;
      }
    }

    _providerState(providerName) {
      if (!this.providerState.has(providerName)) {
        this.providerState.set(providerName, { failures: 0, cooldownUntil: 0, circuitUntil: 0 });
      }
      return this.providerState.get(providerName);
    }

    _withTimeout(work, timeoutMs, tag) {
      let timer = null;
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Scheduled task timed out${tag ? `: ${tag}` : ''}`)), timeoutMs);
      });
      return Promise.race([Promise.resolve().then(work), timeout]).finally(() => clearTimeout(timer));
    }
  }

  window.SignalSchedulerAgent = SignalSchedulerAgent;
})();
