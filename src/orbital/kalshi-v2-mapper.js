// kalshi-v2-mapper.js — Pure mapper from orbital intent to Kalshi V2 payload
// ═══════════════════════════════════════════════════════════════════════════
// Builds a Kalshi V2 order payload using strict fixed-point string formatting:
//   count: 2 decimal places (e.g. "10.00")
//   yes_price / no_price: 4 decimal places (e.g. "0.4500")
// Side mapping from orbital pDelta:
//   pDelta > 0  → ask  (fade up via sell YES)   action="sell", side="yes"
//   pDelta < 0  → bid  (buy YES)                 action="buy",  side="yes"
//   pDelta == 0 → null (no payload)
// time_in_force defaults to "immediate_or_cancel".
// Submission is disabled unless explicit env flag is set.
// ═══════════════════════════════════════════════════════════════════════════

(function (root) {
  'use strict';

  function readEnv(name) {
    try {
      if (root && root.__env && root.__env[name] != null) return root.__env[name];
    } catch (_) {}
    try {
      if (typeof process !== 'undefined' && process && process.env && process.env[name] != null) {
        return process.env[name];
      }
    } catch (_) {}
    return null;
  }

  function readBoolEnv(name, fallback) {
    var raw = readEnv(name);
    if (raw == null) return !!fallback;
    var txt = String(raw).trim().toLowerCase();
    if (txt === '1' || txt === 'true' || txt === 'yes' || txt === 'on') return true;
    if (txt === '0' || txt === 'false' || txt === 'no' || txt === 'off') return false;
    return !!fallback;
  }

  function uuidv4() {
    try {
      if (root && root.crypto && typeof root.crypto.randomUUID === 'function') {
        return root.crypto.randomUUID();
      }
    } catch (_) {}
    try {
      if (typeof require === 'function') {
        var nodeCrypto = require('crypto');
        if (nodeCrypto && typeof nodeCrypto.randomUUID === 'function') return nodeCrypto.randomUUID();
      }
    } catch (_) {}
    // Fallback: RFC 4122 v4-style, sufficient for client_order_id idempotency
    var bytes = new Array(16);
    for (var i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    var hex = bytes.map(function (b) { return (b + 0x100).toString(16).slice(1); }).join('');
    return hex.slice(0, 8) + '-' + hex.slice(8, 12) + '-' + hex.slice(12, 16) + '-' + hex.slice(16, 20) + '-' + hex.slice(20);
  }

  function formatCount(count) {
    var n = Number(count);
    if (!Number.isFinite(n) || n <= 0) n = 1;
    return n.toFixed(2);
  }

  function formatPrice(price) {
    var n = Number(price);
    if (!Number.isFinite(n)) n = 0.5;
    if (n < 0.0001) n = 0.0001;
    if (n > 0.9999) n = 0.9999;
    return n.toFixed(4);
  }

  function buildOrderPayload(input) {
    if (!input || typeof input !== 'object') return null;
    var pDelta = Number(input.pDelta);
    if (!Number.isFinite(pDelta) || pDelta === 0) return null;

    var ticker = input.ticker || null;
    var count = formatCount(input.count != null ? input.count : 1);
    var price = formatPrice(input.price != null ? input.price : 0.5);

    var side = 'yes';
    var action = pDelta > 0 ? 'sell' : 'buy';

    var payload = {
      ticker: ticker,
      client_order_id: uuidv4(),
      side: side,
      action: action,
      type: 'limit',
      count: count,
      yes_price: price,
      time_in_force: input.time_in_force || 'immediate_or_cancel',
    };

    return payload;
  }

  function isSubmitEnabled() {
    return readBoolEnv('WECRYP_KALSHI_V2_SUBMIT_ENABLED', false);
  }

  // Submission is intentionally stubbed in dry-run mode. The wiring point for
  // live submission is gated by isSubmitEnabled() AND requires an explicit
  // submit transport (kalshi-client, kalshi-rest, or a Tauri/Electron bridge)
  // to be passed in. This module deliberately does NOT take HTTP actions.
  function submitIfEnabled(payload, transport) {
    if (!payload) return { submitted: false, reason: 'no_payload' };
    if (!isSubmitEnabled()) {
      return { submitted: false, reason: 'submit_disabled', payload: payload };
    }
    if (!transport || typeof transport.placeOrder !== 'function') {
      return { submitted: false, reason: 'no_transport', payload: payload };
    }
    try {
      var resp = transport.placeOrder(payload);
      return { submitted: true, response: resp };
    } catch (err) {
      return { submitted: false, reason: 'transport_error', error: err && err.message ? err.message : String(err) };
    }
  }

  var api = {
    buildOrderPayload: buildOrderPayload,
    isSubmitEnabled: isSubmitEnabled,
    submitIfEnabled: submitIfEnabled,
    formatCount: formatCount,
    formatPrice: formatPrice,
    uuidv4: uuidv4,
  };

  if (root && typeof root === 'object') {
    root.KalshiV2Mapper = api;
  }
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
