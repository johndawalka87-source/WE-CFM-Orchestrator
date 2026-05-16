/**
 * Kalshi Renderer Bridge
 * 
 * Easy API for renderer process to access Kalshi worker.
 * Just use window.Kalshi.* in app.js
 * 
 * Usage:
 *   const balance = await window.Kalshi.getBalance();
 *   const markets = await window.Kalshi.getMarkets(50);
 */

window.Kalshi = {
  // Connection
  health: async () => {
    if (!window.electron?.invoke) throw new Error('Electron IPC not available');
    return await window.electron.invoke('kalshi:health');
  },

  status: async () => {
    if (!window.electron?.invoke) throw new Error('Electron IPC not available');
    return await window.electron.invoke('kalshi:status');
  },

  // Portfolio
  getBalance: async () => {
    if (!window.electron?.invoke) throw new Error('Electron IPC not available');
    return await window.electron.invoke('kalshi:balance');
  },

  getPositions: async () => {
    if (!window.electron?.invoke) throw new Error('Electron IPC not available');
    return await window.electron.invoke('kalshi:positions');
  },

  getOrders: async () => {
    if (!window.electron?.invoke) throw new Error('Electron IPC not available');
    return await window.electron.invoke('kalshi:orders');
  },

  // Market Data
  getMarkets: async (options = {}) => {
    if (!window.electron?.invoke) throw new Error('Electron IPC not available');
    const opts = typeof options === 'number' ? { limit: options } : (options || {});
    return await window.electron.invoke('kalshi:markets', opts);
  },

  getEvents: async (ticker = null) => {
    if (!window.electron?.invoke) throw new Error('Electron IPC not available');
    return await window.electron.invoke('kalshi:events', { ticker });
  },

  // Orders
  placeOrder: async (order) => {
    if (!window.electron?.invoke) throw new Error('Electron IPC not available');
    return await window.electron.invoke('kalshi:placeOrder', order);
  },

  cancelOrder: async (orderId) => {
    if (!window.electron?.invoke) throw new Error('Electron IPC not available');
    return await window.electron.invoke('kalshi:cancelOrder', orderId);
  },

  cancelAllOrders: async (filters = {}) => {
    if (!window.electron?.invoke) throw new Error('Electron IPC not available');
    return await window.electron.invoke('kalshi:cancelAllOrders', filters);
  },

  // Market Details
  getTrades: async (marketId, filters = {}) => {
    if (!window.electron?.invoke) throw new Error('Electron IPC not available');
    return await window.electron.invoke('kalshi:getTrades', marketId, filters);
  }
};

console.log('[Kalshi] Renderer bridge loaded. Use window.Kalshi.*');
