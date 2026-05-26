/**
 * LLM Signal Assistant — Real LLM-Powered Analysis Layer
 * 
 * Connects to Google Gemini SDK or any chat-completions compatible API
 * Uses SPECIALIZED prompt for 9-indicator crypto engine
 * Non-blocking, safe-gated, fully logged
 */

const fs = require("fs");
const path = require("path");
const { generateSystemPrompt, generateUserPrompt } = require("./specialized_prompt");
const {
  readSecretFromEnvOrFiles,
  extractGoogleApiKey,
} = require("../cloud/secrets-loader");

function loadLLMEnv() {
  const loadedPaths = [];

  try {
    const dotenv = require("dotenv");
    const candidatePaths = [
      process.env.LLM_ENV_PATH,
      path.resolve(process.cwd(), ".env"),
      path.resolve(__dirname, "../../.env"),
      process.resourcesPath ? path.resolve(process.resourcesPath, "..", ".env") : null,
      process.execPath ? path.resolve(path.dirname(process.execPath), ".env") : null,
    ].filter(Boolean);

    for (const envPath of candidatePaths) {
      try {
        if (!fs.existsSync(envPath)) continue;
        const result = dotenv.config({ path: envPath, quiet: true });
        if (!result.error) loadedPaths.push(envPath);
      } catch (_) { }
    }

    return [...new Set(loadedPaths)];
  } catch (_) { }

  return [];
}

const LLM_ENV_SOURCES = loadLLMEnv();

function resolveCompatibleApiKey() {
  const secret = readSecretFromEnvOrFiles(
    ['LLM_API_KEY', 'OPENAI_API_KEY', 'OPENAI_KEY'],
    [
      'OPENAI-WECRYPTO.txt',
      'OPENAI-Service-account.txt',
      'LLM-API-KEY.txt',
      'OPENAI-API-KEY.txt',
    ]
  );
  return String(secret?.value || '').trim();
}

function resolveGoogleApiKey() {
  const secret = readSecretFromEnvOrFiles(
    ['GOOGLE_API_KEY', 'GEMINI_API_KEY'],
    [
      'GOOGLE-CREDENTIAL-API.txt',
      'GOOGLE-GEMINI-API-KEY.txt',
      'GEMINI-API-KEY.txt',
      'GOOGLE-API-KEY.txt',
    ]
  );
  return extractGoogleApiKey(secret?.value || '');
}

// Configuration from environment
const LLM_API_URL = process.env.LLM_API_URL || process.env.OPENAI_BASE_URL || "https://api.openai.com/v1/chat/completions";
const LLM_API_KEY = resolveCompatibleApiKey();
const LLM_MODEL = process.env.LLM_MODEL || process.env.OPENAI_MODEL || "gpt-4-mini";
const GOOGLE_API_KEY = resolveGoogleApiKey();
const GOOGLE_MODEL = process.env.GOOGLE_MODEL || process.env.GEMINI_MODEL || "gemini-2.0-flash";
const LLM_PROVIDER = (process.env.LLM_PROVIDER || "auto").toLowerCase();
const CONTEXT_CACHE_TTL_MS = Number(process.env.LLM_CONTEXT_CACHE_TTL_MS || 15000);
const MARKET_MEMORY_LIMIT = Number(process.env.LLM_MARKET_MEMORY_LIMIT || 12);
const LLM_RATE_LIMIT_BASE_COOLDOWN_MS = Number(process.env.LLM_RATE_LIMIT_BASE_COOLDOWN_MS || 15000);
const LLM_RATE_LIMIT_MAX_COOLDOWN_MS = Number(process.env.LLM_RATE_LIMIT_MAX_COOLDOWN_MS || 5 * 60 * 1000);
const LLM_RATE_LIMIT_LOG_DEBOUNCE_MS = Number(process.env.LLM_RATE_LIMIT_LOG_DEBOUNCE_MS || 10000);

class LLMSignalAssistant {
  constructor() {
    this.provider = this.resolveProvider();
    this.enabled = this.provider === "google"
      ? !!GOOGLE_API_KEY
      : !!(LLM_API_URL && LLM_API_KEY);
    this.contextCache = new Map();      // short-lived prompt/result cache
    this.marketMemory = new Map();      // per-coin rolling recall memory
    this._googleClient = null;
    this._googleClientKind = null;
    this.envDiagnostics = {
      dotenvLoaded: LLM_ENV_SOURCES.length > 0,
      dotenvSources: LLM_ENV_SOURCES,
      hasCompatibleKey: !!LLM_API_KEY,
      hasGoogleKey: !!GOOGLE_API_KEY,
      providerOverride: process.env.LLM_PROVIDER || null,
    };

    this.stats = {
      calls: 0,
      successes: 0,
      failures: 0,
      influenceCount: 0,
      cacheHits: 0,
      cooldownSkips: 0,
    };

    this.rateLimitState = {
      cooldownUntilTs: 0,
      consecutiveFailures: 0,
      lastReason: null,
      lastRetryAfterMs: 0,
      lastRateLimitLogTs: 0,
    };

    console.log(
      `[LLMSignalAssistant] Initialized ${this.enabled ? "✓ ENABLED" : "⚠ DISABLED"} ` +
      `(provider=${this.provider}, model=${this.provider === "google" ? GOOGLE_MODEL : LLM_MODEL})`
    );
    if (this.envDiagnostics.dotenvLoaded) {
      console.log(`[LLMSignalAssistant] Loaded env from: ${this.envDiagnostics.dotenvSources.join(" | ")}`);
    }
  }

  resolveProvider() {
    if (LLM_PROVIDER === "google") return "google";
    if (LLM_PROVIDER === "openai" || LLM_PROVIDER === "compatible") return "compatible";
    if (GOOGLE_API_KEY) return "google";
    return "compatible";
  }

  /**
   * Main entry point: analyze market snapshot
   * Returns: { regime, confidence, suggestions, warnings }
   */
  async analyzeSnapshot(snapshot) {
    this.stats.calls++;

    if (!this.enabled) {
      return {
        regime: "unknown",
        confidence: 0,
        suggestions: { notes: "LLM disabled" },
        warnings: ["LLM not configured"],
      };
    }

    const cooldownFallback = this.getCooldownFallback();
    if (cooldownFallback) {
      this.stats.cooldownSkips++;
      return cooldownFallback;
    }

    try {
      const cacheKey = this.getCacheKey(snapshot);
      const now = Date.now();
      const cached = this.contextCache.get(cacheKey);
      if (cached && (now - cached.ts) < CONTEXT_CACHE_TTL_MS) {
        this.stats.cacheHits++;
        return cached.value;
      }

      // Use specialized prompt
      const systemPrompt = generateSystemPrompt();
      const rawUserPrompt = generateUserPrompt(snapshot);
      const userPrompt = this.enrichPromptWithRecall(snapshot, rawUserPrompt);

      const rawResponse = await this.callAPI(systemPrompt, userPrompt);
      const normalized = this.normalizeResponse(rawResponse);
      this.recordMarketMemory(snapshot, normalized);
      this.contextCache.set(cacheKey, { ts: now, value: normalized });
      this.stats.successes++;
      this.clearRateLimitState();
      return normalized;
    } catch (err) {
      this.stats.failures++;
      const rateLimited = this.handleRateLimitError(err);
      if (!rateLimited) {
        console.error("[LLMSignalAssistant] Analysis failed:", err.message);
      }
      return {
        regime: "unknown",
        confidence: 0,
        suggestions: {},
        warnings: [rateLimited ? this.formatCooldownWarning() : `LLM error: ${err.message}`],
      };
    }
  }

  /**
   * Call the LLM API with specialized prompts
   */
  getCacheKey(snapshot) {
    const coin = String(snapshot?.coin || "ALL");
    const horizon = String(snapshot?.horizon || "h15");
    const volatility = Number(snapshot?.volatility || 0).toFixed(4);
    const indicatorsHash = JSON.stringify(snapshot?.indicators || {});
    return `${coin}|${horizon}|${volatility}|${indicatorsHash}`;
  }

  getRecentMemory(coin, limit = 4) {
    const key = String(coin || "ALL");
    const rows = this.marketMemory.get(key) || [];
    return rows.slice(-limit);
  }

  enrichPromptWithRecall(snapshot, userPrompt) {
    const coin = String(snapshot?.coin || "ALL");
    const recent = this.getRecentMemory(coin, 4);
    if (!recent.length) return userPrompt;

    const recall = recent.map((row, idx) => {
      const conf = Math.round((row.confidence || 0) * 100);
      const notes = row?.suggestions?.notes || "";
      return `${idx + 1}. regime=${row.regime} conf=${conf}% notes=${notes.slice(0, 180)}`;
    }).join("\n");

    return `${userPrompt}

Recent memory for ${coin} (most recent last):
${recall}

Use this recall only as context, and prioritize current market snapshot data if conflict occurs.`;
  }

  recordMarketMemory(snapshot, output) {
    const key = String(snapshot?.coin || "ALL");
    const rows = this.marketMemory.get(key) || [];
    rows.push({
      ts: Date.now(),
      regime: output?.regime || "unknown",
      confidence: Number(output?.confidence || 0),
      suggestions: output?.suggestions || {},
      warnings: output?.warnings || [],
    });
    if (rows.length > MARKET_MEMORY_LIMIT) rows.splice(0, rows.length - MARKET_MEMORY_LIMIT);
    this.marketMemory.set(key, rows);
  }

  /**
   * Call the LLM API with specialized prompts
   */
  async callAPI(systemPrompt, userPrompt) {
    if (this.provider === "google") {
      return this.callGoogleAPI(systemPrompt, userPrompt);
    }

    return this.callCompatibleAPI(systemPrompt, userPrompt);
  }

  async callCompatibleAPI(systemPrompt, userPrompt) {
    const payload = {
      model: LLM_MODEL,
      messages: [
        {
          role: "system",
          content: systemPrompt,
        },
        {
          role: "user",
          content: userPrompt,
        },
      ],
      temperature: 0.1, // low temp for consistency
      max_tokens: 600,
    };

    const response = await fetch(LLM_API_URL, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${LLM_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      throw new Error(
        `LLM API error ${response.status}: ${response.statusText}`
      );
    }

    const data = await response.json();

    // Handle different API response formats
    let content = "";
    if (data.choices?.[0]?.message?.content) {
      content = data.choices[0].message.content.trim();
    } else if (data.error) {
      throw new Error(`LLM API error: ${data.error.message}`);
    } else {
      throw new Error("Unexpected LLM API response format");
    }

    // Extract JSON from markdown code blocks if present
    const jsonMatch = content.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
    if (jsonMatch) {
      content = jsonMatch[1];
    }

    return JSON.parse(content);
  }

  getGoogleClient() {
    if (this._googleClient) {
      return { kind: this._googleClientKind, client: this._googleClient };
    }

    try {
      const { GoogleGenAI } = require("@google/genai");
      this._googleClient = new GoogleGenAI({ apiKey: GOOGLE_API_KEY });
      this._googleClientKind = "genai";
      return { kind: this._googleClientKind, client: this._googleClient };
    } catch (_) { }

    try {
      const { GoogleGenerativeAI } = require("@google/generative-ai");
      this._googleClient = new GoogleGenerativeAI(GOOGLE_API_KEY);
      this._googleClientKind = "generative-ai";
      return { kind: this._googleClientKind, client: this._googleClient };
    } catch (_) { }

    throw new Error("Google provider selected but no supported SDK found (@google/genai or @google/generative-ai)");
  }

  extractJsonContent(rawText) {
    const content = String(rawText || "").trim();
    if (!content) throw new Error("Empty LLM response");

    const fenced = content.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
    if (fenced) return fenced[1];

    const firstBrace = content.indexOf("{");
    const lastBrace = content.lastIndexOf("}");
    if (firstBrace >= 0 && lastBrace > firstBrace) {
      return content.slice(firstBrace, lastBrace + 1);
    }

    return content;
  }

  async callGoogleAPI(systemPrompt, userPrompt) {
    if (!GOOGLE_API_KEY) {
      throw new Error("GOOGLE_API_KEY (or GEMINI_API_KEY) is required for Google provider");
    }

    const { kind, client } = this.getGoogleClient();
    const prompt = `${systemPrompt}\n\nReturn valid JSON only.\n\n${userPrompt}`;
    let content = "";

    if (kind === "genai") {
      const response = await client.models.generateContent({
        model: GOOGLE_MODEL,
        contents: prompt,
        config: {
          temperature: 0.1,
          responseMimeType: "application/json",
        },
      });
      content = typeof response?.text === "function" ? response.text() : response?.text;
    } else {
      const model = client.getGenerativeModel({
        model: GOOGLE_MODEL,
        generationConfig: {
          temperature: 0.1,
          responseMimeType: "application/json",
        },
      });
      const result = await model.generateContent(prompt);
      const response = await result.response;
      content = typeof response?.text === "function" ? response.text() : response?.text;
    }

    const json = this.extractJsonContent(content);
    return JSON.parse(json);
  }

  getCooldownFallback() {
    const remainingMs = this.getCooldownRemainingMs();
    if (remainingMs <= 0) return null;
    return {
      regime: "unknown",
      confidence: 0,
      suggestions: {
        notes: `LLM cooldown active for ${Math.ceil(remainingMs / 1000)}s due to provider rate limits`,
      },
      warnings: [this.formatCooldownWarning(remainingMs)],
    };
  }

  getCooldownRemainingMs() {
    const until = Number(this.rateLimitState?.cooldownUntilTs || 0);
    return Math.max(0, until - Date.now());
  }

  clearRateLimitState() {
    this.rateLimitState.consecutiveFailures = 0;
    this.rateLimitState.lastReason = null;
    this.rateLimitState.lastRetryAfterMs = 0;
    this.rateLimitState.cooldownUntilTs = 0;
  }

  formatCooldownWarning(remainingMs = this.getCooldownRemainingMs()) {
    const secs = Math.max(1, Math.ceil(Number(remainingMs || 0) / 1000));
    const reason = this.rateLimitState?.lastReason || 'provider rate limit';
    return `LLM cooldown active (${secs}s remaining): ${reason}`;
  }

  extractRetryAfterMs(err) {
    const retryInfo = err?.error?.details?.find?.((detail) => String(detail?.['@type'] || '').includes('RetryInfo'));
    const retryDelay = retryInfo?.retryDelay;
    if (typeof retryDelay === 'string') {
      const secs = Number.parseFloat(retryDelay.replace(/s$/i, ''));
      if (Number.isFinite(secs) && secs > 0) return secs * 1000;
    }

    const msg = String(err?.message || err || '');
    const match = msg.match(/retry in\s+([\d.]+)s/i);
    if (match) {
      const secs = Number.parseFloat(match[1]);
      if (Number.isFinite(secs) && secs > 0) return secs * 1000;
    }

    return 0;
  }

  isRateLimitError(err) {
    const msg = String(err?.message || err || '').toLowerCase();
    return /429|quota|resource_exhausted|resource exhausted|rate limit|too many requests/.test(msg);
  }

  handleRateLimitError(err) {
    if (!this.isRateLimitError(err)) return false;

    const retryAfterMs = this.extractRetryAfterMs(err);
    const nextFailureCount = Number(this.rateLimitState.consecutiveFailures || 0) + 1;
    const backoffMs = LLM_RATE_LIMIT_BASE_COOLDOWN_MS * Math.max(1, nextFailureCount);
    const cooldownMs = Math.min(
      LLM_RATE_LIMIT_MAX_COOLDOWN_MS,
      Math.max(LLM_RATE_LIMIT_BASE_COOLDOWN_MS, retryAfterMs, backoffMs)
    );

    this.rateLimitState.consecutiveFailures = nextFailureCount;
    this.rateLimitState.lastRetryAfterMs = retryAfterMs;
    this.rateLimitState.lastReason = String(err?.message || 'rate limit');
    this.rateLimitState.cooldownUntilTs = Date.now() + cooldownMs;

    const now = Date.now();
    if ((now - Number(this.rateLimitState.lastRateLimitLogTs || 0)) >= LLM_RATE_LIMIT_LOG_DEBOUNCE_MS) {
      this.rateLimitState.lastRateLimitLogTs = now;
      console.warn(
        `[LLMSignalAssistant] Rate limit detected; cooling down for ${Math.ceil(cooldownMs / 1000)}s ` +
        `(retryAfter=${Math.ceil((retryAfterMs || 0) / 1000)}s, failures=${nextFailureCount})`
      );
    }

    return true;
  }

  /**
   * Normalize and validate LLM response
   */
  normalizeResponse(raw) {
    if (!raw) {
      return {
        regime: "unknown",
        confidence: 0,
        suggestions: { notes: "null response" },
        warnings: ["LLM returned null"],
      };
    }

    const regime = this.validateRegime(raw.regime);
    const confidence = Math.max(0, Math.min(1, Number(raw.confidence) || 0));

    const increaseWeight = Array.isArray(raw.suggestions?.increase_weight)
      ? raw.suggestions.increase_weight
      : Array.isArray(raw.suggestions?.increase)
        ? raw.suggestions.increase
        : [];
    const decreaseWeight = Array.isArray(raw.suggestions?.decrease_weight)
      ? raw.suggestions.decrease_weight
      : Array.isArray(raw.suggestions?.decrease)
        ? raw.suggestions.decrease
        : [];

    const suggestions = {
      increase_weight: increaseWeight.filter(s => typeof s === 'string'),
      decrease_weight: decreaseWeight.filter(s => typeof s === 'string'),
      notes: typeof raw.suggestions?.notes === 'string' ? raw.suggestions.notes :
        typeof raw.suggestions?.reasoning === 'string' ? raw.suggestions.reasoning :
          typeof raw.suggestions?.summary === 'string' ? raw.suggestions.summary : "",
    };

    const warnings = Array.isArray(raw.warnings)
      ? raw.warnings.map(String).filter(w => w.length > 0)
      : Array.isArray(raw.suggestions?.issues)
        ? raw.suggestions.issues.map(String).filter(w => w.length > 0)
        : [];

    const ai_wording = raw.ai_wording || {
      primary_rationale: "",
      wait_rationale: "",
      high_confidence_rationale: "",
      scalp_setups: []
    };

    return {
      regime,
      confidence,
      suggestions,
      warnings,
      analysis: raw.analysis || {},
      ai_wording,
    };
  }

  validateRegime(regime) {
    const valid = [
      "trend_continuation",
      "mean_reversion",
      "chop_noise",
      "breakout_volatility",
    ];
    return valid.includes(regime) ? regime : "unknown";
  }

  /**
   * Apply LLM suggestions to weights with safety gates
   */
  applyWeights(llmOutput, currentWeights) {
    if (!llmOutput || llmOutput.regime === "unknown") {
      return { changed: false, newWeights: currentWeights };
    }

    if (llmOutput.confidence < 0.6) {
      // Safety gate: need high confidence
      return { changed: false, newWeights: currentWeights };
    }

    let newWeights = { ...currentWeights };
    let changed = false;

    const maxAdjustment = 1.05; // max 5% nudge
    const minAdjustment = 0.95;

    // Apply increases
    for (const signal of llmOutput.suggestions.increase_weight) {
      if (newWeights[signal]) {
        newWeights[signal] = Math.min(newWeights[signal] * maxAdjustment, 2.0); // cap at 2.0x
        changed = true;
      }
    }

    // Apply decreases
    for (const signal of llmOutput.suggestions.decrease_weight) {
      if (signal === "all") {
        for (const key of Object.keys(newWeights)) {
          newWeights[key] = Math.max(newWeights[key] * minAdjustment, 0.3); // floor at 0.3x
        }
        changed = true;
      } else if (newWeights[signal]) {
        newWeights[signal] = Math.max(newWeights[signal] * minAdjustment, 0.3);
        changed = true;
      }
    }

    if (changed) {
      this.stats.influenceCount++;
    }

    return { changed, newWeights };
  }

  /**
   * Log LLM analysis to disk for forensics
   */
  logAnalysis(coin, input, output, applied) {
    try {
      const logDir = path.join(process.cwd(), "logs", "llm");
      if (!fs.existsSync(logDir)) {
        fs.mkdirSync(logDir, { recursive: true });
      }

      const timestamp = new Date().toISOString();
      const filename = path.join(logDir, `${coin}-${Date.now()}.json`);

      fs.writeFileSync(
        filename,
        JSON.stringify(
          {
            timestamp,
            coin,
            input,
            output,
            applied,
          },
          null,
          2
        )
      );
    } catch (err) {
      console.warn("[LLMSignalAssistant] Failed to write log:", err.message);
    }
  }

  /**
   * Get diagnostics
   */
  getDiagnostics() {
    const rate = this.stats.calls > 0 ? (this.stats.successes / this.stats.calls * 100).toFixed(1) : 0;
    return {
      enabled: this.enabled,
      provider: this.provider,
      api_url: this.enabled
        ? (this.provider === "google" ? "google-sdk" : LLM_API_URL)
        : "disabled",
      model: this.enabled
        ? (this.provider === "google" ? GOOGLE_MODEL : LLM_MODEL)
        : "disabled",
      stats: {
        total_calls: this.stats.calls,
        successes: this.stats.successes,
        failures: this.stats.failures,
        success_rate: `${rate}%`,
        influence_count: this.stats.influenceCount,
        cache_hits: this.stats.cacheHits,
        cooldown_skips: this.stats.cooldownSkips,
      },
      cooldown: {
        active: this.getCooldownRemainingMs() > 0,
        remaining_ms: this.getCooldownRemainingMs(),
        last_reason: this.rateLimitState.lastReason,
        retry_after_ms: this.rateLimitState.lastRetryAfterMs,
        consecutive_failures: this.rateLimitState.consecutiveFailures,
      },
      env: this.envDiagnostics,
    };
  }
}

// ══════════════════════════════════════════════════════════════
// Export
// ══════════════════════════════════════════════════════════════

module.exports = new LLMSignalAssistant();

if (typeof window !== "undefined") {
  window.LLMSignalAssistant = module.exports;
}

console.log("[LLMSignalAssistant] Module loaded with SPECIALIZED prompts");

