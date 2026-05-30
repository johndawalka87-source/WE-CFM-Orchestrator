const fs = require('fs');
let content = fs.readFileSync('src/core/predictions.js', 'utf8');

// 1. Inject SMC helper functions
const smcHelpers =   // -- SMC: Smart Money Concepts Helpers -------------------------------------
  function detectLiquidityPools(candles) {
    const pools = { highs: [], lows: [] };
    const n = candles.length;
    if (n < 20) return pools;
    
    const pivots = { highs: [], lows: [] };
    for (let i = 2; i < n - 2; i++) {
      const c = candles[i];
      if (c.h > candles[i-1].h && c.h > candles[i-2].h && c.h > candles[i+1].h && c.h > candles[i+2].h) {
        pivots.highs.push({ price: c.h, index: i });
      }
      if (c.l < candles[i-1].l && c.l < candles[i-2].l && c.l < candles[i+1].l && c.l < candles[i+2].l) {
        pivots.lows.push({ price: c.l, index: i });
      }
    }

    const cluster = (pivotsArray, type) => {
      const merged = [];
      for (const p of pivotsArray) {
        let found = false;
        for (const m of merged) {
          if (Math.abs(p.price - m.price) / m.price <= 0.001) {
            m.touches++;
            m.price = type === 'high' ? Math.max(m.price, p.price) : Math.min(m.price, p.price);
            m.latestIndex = Math.max(m.latestIndex, p.index);
            found = true;
            break;
          }
        }
        if (!found) {
          merged.push({ price: p.price, touches: 1, latestIndex: p.index });
        }
      }
      return merged.filter(m => m.touches >= 2);
    };

    pools.highs = cluster(pivots.highs, 'high');
    pools.lows = cluster(pivots.lows, 'low');
    return pools;
  }

  function detectLiquiditySweeps(candles, pools) {
    const sweeps = [];
    const n = candles.length;
    if (n < 5) return sweeps;
    for (let i = n - 4; i < n - 1; i++) {
      const c = candles[i];
      for (const pool of pools.highs) {
        if (c.h > pool.price && c.c < pool.price) {
          sweeps.push({ dir: -1, pool: pool.price, index: i, type: 'mitigated' });
        }
      }
      for (const pool of pools.lows) {
        if (c.l < pool.price && c.c > pool.price) {
          sweeps.push({ dir: 1, pool: pool.price, index: i, type: 'mitigated' });
        }
      }
    }
    return sweeps;
  }

  function detectFVGs(candles) {
    const fvgs = [];
    const n = candles.length;
    if (n < 5) return fvgs;
    for (let i = n - 5; i < n - 1; i++) {
      const c1 = candles[i-1];
      const c2 = candles[i];
      const c3 = candles[i+1];
      if (!c1 || !c2 || !c3) continue;

      if (c1.h < c3.l && c2.c > c2.o) {
        fvgs.push({ dir: 1, ce: (c1.h + c3.l) / 2, top: c3.l, bottom: c1.h, index: i });
      }
      if (c1.l > c3.h && c2.c < c2.o) {
        fvgs.push({ dir: -1, ce: (c1.l + c3.h) / 2, top: c1.l, bottom: c3.h, index: i });
      }
    }
    return fvgs;
  }

  // -- detectReversalFlags: identify price/indicator divergences and exhaustion signals --;
content = content.replace('  // -- detectReversalFlags: identify price/indicator divergences and exhaustion signals --', smcHelpers);

// 2. Inject SMC hook in buildSignalModel
const smcHook =     // -- SMC: Evaluate Liquidity Sweeps + FVGs + Kalshi Edge -----------
    const smcPools = detectLiquidityPools(candles);
    const smcSweeps = detectLiquiditySweeps(candles, smcPools);
    const smcFVGs = detectFVGs(candles);
    let smcFlags = [];

    const mktData = options.sym ? (window.PredictionMarkets?.getCoin(options.sym) ?? null) : null;
    const kalshiProb = mktData?.combinedProb ?? 0.5;

    for (const sweep of smcSweeps) {
      const fvg = smcFVGs.find(f => f.dir === sweep.dir && f.index > sweep.index);
      if (fvg) {
        let aggressive = false;
        if (sweep.dir === 1 && kalshiProb < 0.35) aggressive = true; 
        if (sweep.dir === -1 && kalshiProb > 0.65) aggressive = true;

        const lastC = candles[candles.length - 1];
        const retraced = sweep.dir === 1 ? lastC.l <= fvg.ce : lastC.h >= fvg.ce;

        if (aggressive || retraced) {
          const bias = sweep.dir === 1 ? 'bullish' : 'bearish';
          smcFlags.push({
            id: 'SMC_SWEEP_FVG',
            severity: 'critical',
            bias: bias,
            label: 'SMC Sweep + FVG',
            desc: \Swept liquidity at \, formed \ FVG. \\,
            strength: 0.95
          });
        }
      }
    }

    // -- MDT: Momentum Decision Tree (preemptive bias engine) --------------
    const reversalFlags = detectReversalFlags(candles, rsi, macdResult, adxResult, obvSlope, mom);
    reversalFlags.push(...smcFlags);;
content = content.replace('    // -- MDT: Momentum Decision Tree (preemptive bias engine) --------------\\r\\n    const reversalFlags = detectReversalFlags(candles, rsi, macdResult, adxResult, obvSlope, mom);', smcHook);
content = content.replace('    // -- MDT: Momentum Decision Tree (preemptive bias engine) --------------\\n    const reversalFlags = detectReversalFlags(candles, rsi, macdResult, adxResult, obvSlope, mom);', smcHook);

// 3. Swap Bybit priorities
const bybitCandlesOrig =   async function fetchBybitCandles(sym, tf = '5m', limit = 200) {
    const symbol = BYBIT_SYMS[sym];
    if (!symbol) return [];
    await waitExchangeJitter();
    const res = await fetchWithTimeout(getBybitUrl(\/market/kline?category=spot&symbol=\&interval=\&limit=\\), 10000);
    if (!res.ok) return fetchBINCandles(sym, tf === '1m' ? '1m' : tf === '5m' ? '5m' : '15m', limit);;
const bybitCandlesNew =   async function fetchBybitCandles(sym, tf = '5m', limit = 200) {
    try {
      const binData = await fetchBINCandles(sym, tf === '1m' ? '1m' : tf === '5m' ? '5m' : '15m', limit);
      if (binData && binData.length > 0) return binData;
    } catch(e) {}

    const symbol = BYBIT_SYMS[sym];
    if (!symbol) return [];
    await waitExchangeJitter();
    const res = await fetchWithTimeout(getBybitUrl(\/market/kline?category=spot&symbol=\&interval=\&limit=\\), 10000);
    if (!res.ok) return [];;

const bybitCandlesReturn =     })).filter(c => Number.isFinite(c.t) && Number.isFinite(c.c)).sort((a, b) => a.t - b.t);
    return candles.length ? candles : fetchBINCandles(sym, tf === '1m' ? '1m' : tf === '5m' ? '5m' : '15m', limit);;
const bybitCandlesReturnNew =     })).filter(c => Number.isFinite(c.t) && Number.isFinite(c.c)).sort((a, b) => a.t - b.t);
    return candles.length ? candles : [];;

const bybitBookOrig =   async function fetchBybitBook(sym) {
    const symbol = BYBIT_SYMS[sym];
    if (!symbol) return null;
    await waitExchangeJitter();
    const res = await fetchWithTimeout(getBybitUrl(\/market/orderbook?category=spot&symbol=\&limit=20\), 7000);
    if (!res.ok) return fetchBINBook(sym);;
const bybitBookNew =   async function fetchBybitBook(sym) {
    try {
      const binData = await fetchBINBook(sym);
      if (binData && (binData.bids?.length > 0 || binData.asks?.length > 0)) return binData;
    } catch(e) {}

    const symbol = BYBIT_SYMS[sym];
    if (!symbol) return null;
    await waitExchangeJitter();
    const res = await fetchWithTimeout(getBybitUrl(\/market/orderbook?category=spot&symbol=\&limit=20\), 7000);
    if (!res.ok) return null;;

const bybitBookReturnOrig =     if (!bids.length && !asks.length) return fetchBINBook(sym);;
const bybitBookReturnNew =     if (!bids.length && !asks.length) return null;;

const bybitTradesOrig =   async function fetchBybitTrades(sym, limit = 100) {
    const symbol = BYBIT_SYMS[sym];
    if (!symbol) return [];
    await waitExchangeJitter();
    const res = await fetchWithTimeout(getBybitUrl(\/market/recent-trade?category=spot&symbol=\&limit=\\), 7000);
    if (!res.ok) return fetchBINTrades(sym, limit);;
const bybitTradesNew =   async function fetchBybitTrades(sym, limit = 100) {
    try {
      const binData = await fetchBINTrades(sym, limit);
      if (binData && binData.length > 0) return binData;
    } catch(e) {}

    const symbol = BYBIT_SYMS[sym];
    if (!symbol) return [];
    await waitExchangeJitter();
    const res = await fetchWithTimeout(getBybitUrl(\/market/recent-trade?category=spot&symbol=\&limit=\\), 7000);
    if (!res.ok) return [];;

const bybitTradesReturnOrig =     return trades.length ? trades : fetchBINTrades(sym, limit);;
const bybitTradesReturnNew =     return trades.length ? trades : [];;

content = content.replace(bybitCandlesOrig, bybitCandlesNew);
content = content.replace(bybitCandlesReturn, bybitCandlesReturnNew);
content = content.replace(bybitBookOrig, bybitBookNew);
content = content.replace(bybitBookReturnOrig, bybitBookReturnNew);
content = content.replace(bybitTradesOrig, bybitTradesNew);
content = content.replace(bybitTradesReturnOrig, bybitTradesReturnNew);

fs.writeFileSync('src/core/predictions.js', content, 'utf8');
console.log('Patched correctly');
