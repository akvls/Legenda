import { Router } from 'express';
import { getStrategyEngine } from '../../strategy/engine.js';
import { getCandleManager } from '../../data/candle-manager.js';
import { calcSMA, calcEMA } from '../../strategy/indicators/moving-averages.js';
import { apiLogger as logger } from '../../utils/logger.js';

const router = Router();

/**
 * Quick register via GET (for easy browser testing)
 */
router.get('/register/:symbol', async (req, res) => {
  try {
    const { symbol } = req.params;
    const timeframe = (req.query.tf as string) || '5';
    
    const engine = getStrategyEngine();
    await engine.registerSymbol(symbol, { timeframe });
    
    const state = engine.getState(symbol);
    
    res.json({ 
      success: true, 
      message: `Registered ${symbol} on ${timeframe}m timeframe`,
      data: state,
    });
  } catch (error) {
    logger.error({ error }, 'Failed to register symbol');
    res.status(500).json({ success: false, error: 'Failed to register symbol' });
  }
});

/**
 * Register a symbol with the strategy engine
 */
router.post('/register', async (req, res) => {
  try {
    const { symbol, timeframe, supertrendPeriod, supertrendMultiplier } = req.body;
    
    if (!symbol) {
      return res.status(400).json({ 
        success: false, 
        error: 'symbol is required' 
      });
    }
    
    const engine = getStrategyEngine();
    await engine.registerSymbol(symbol, {
      timeframe: timeframe || '5',
      supertrendPeriod: supertrendPeriod || 10,
      supertrendMultiplier: supertrendMultiplier || 3.0,
    });
    
    // Get the computed state
    const state = engine.getState(symbol);
    
    res.json({ 
      success: true, 
      message: `Registered ${symbol}`,
      data: state,
    });
  } catch (error) {
    logger.error({ error }, 'Failed to register symbol');
    res.status(500).json({ success: false, error: 'Failed to register symbol' });
  }
});

/**
 * Get current strategy state for a symbol
 */
router.get('/state/:symbol', async (req, res) => {
  try {
    const { symbol } = req.params;
    const engine = getStrategyEngine();
    const state = engine.getState(symbol);
    
    if (!state) {
      return res.status(404).json({ 
        success: false, 
        error: `No strategy state for ${symbol}. Register it first.` 
      });
    }
    
    res.json({ success: true, data: state });
  } catch (error) {
    logger.error({ error }, 'Failed to get strategy state');
    res.status(500).json({ success: false, error: 'Failed to get strategy state' });
  }
});

/**
 * Get all current strategy states
 */
router.get('/states', async (_req, res) => {
  try {
    const engine = getStrategyEngine();
    const states = engine.getAllStates();
    
    res.json({ success: true, data: states });
  } catch (error) {
    logger.error({ error }, 'Failed to get strategy states');
    res.status(500).json({ success: false, error: 'Failed to get strategy states' });
  }
});

/**
 * Force recompute state for a symbol
 */
router.post('/recompute/:symbol', async (req, res) => {
  try {
    const { symbol } = req.params;
    const engine = getStrategyEngine();
    const state = await engine.recomputeState(symbol);
    
    if (!state) {
      return res.status(404).json({ 
        success: false, 
        error: `Cannot recompute - ${symbol} not registered` 
      });
    }
    
    res.json({ success: true, data: state });
  } catch (error) {
    logger.error({ error }, 'Failed to recompute strategy state');
    res.status(500).json({ success: false, error: 'Failed to recompute' });
  }
});

/**
 * Check if entry is allowed for a symbol/side
 */
router.get('/check-entry/:symbol/:side', async (req, res) => {
  try {
    const { symbol, side } = req.params;
    
    if (side !== 'LONG' && side !== 'SHORT') {
      return res.status(400).json({ 
        success: false, 
        error: 'side must be LONG or SHORT' 
      });
    }
    
    const engine = getStrategyEngine();
    const result = engine.isEntryAllowed(symbol, side as 'LONG' | 'SHORT');
    const riskWarning = engine.getRiskWarning(symbol);
    const state = engine.getState(symbol);
    
    res.json({ 
      success: true, 
      data: {
        ...result,
        riskWarning,
        strategyId: state?.strategyId,
        bias: state?.bias,
        snapshot: state?.snapshot,
      }
    });
  } catch (error) {
    logger.error({ error }, 'Failed to check entry');
    res.status(500).json({ success: false, error: 'Failed to check entry' });
  }
});

/**
 * Get strategy summary for display
 */
router.get('/summary/:symbol', async (req, res) => {
  try {
    const { symbol } = req.params;
    const engine = getStrategyEngine();
    const state = engine.getState(symbol);
    
    if (!state) {
      return res.status(404).json({ 
        success: false, 
        error: `No strategy state for ${symbol}` 
      });
    }
    
    // Build a human-readable summary
    const summary = {
      symbol,
      timeframe: state.timeframe,
      bias: state.bias,
      strategyId: state.strategyId,
      allowLong: state.allowLongEntry,
      allowShort: state.allowShortEntry,
      indicators: {
        supertrend: {
          direction: state.snapshot.supertrendDir,
          value: state.snapshot.supertrendValue.toFixed(2),
        },
        sma200: {
          value: state.snapshot.sma200.toFixed(2),
          priceAbove: state.snapshot.closeAboveSma200,
        },
        ema1000: {
          value: state.snapshot.ema1000.toFixed(2),
          priceAbove: state.snapshot.closeAboveEma1000,
        },
        structure: state.snapshot.structureBias,
      },
      keyLevels: {
        protectedSwingLow: state.keyLevels.protectedSwingLow?.toFixed(2),
        protectedSwingHigh: state.keyLevels.protectedSwingHigh?.toFixed(2),
      },
      price: state.snapshot.price.toFixed(2),
      lastUpdate: new Date(state.timestamp).toISOString(),
    };
    
    res.json({ success: true, data: summary });
  } catch (error) {
    logger.error({ error }, 'Failed to get strategy summary');
    res.status(500).json({ success: false, error: 'Failed to get summary' });
  }
});

/**
 * Debug: Show raw MA calculations for verification
 */
router.get('/debug-ma/:symbol', async (req, res) => {
  try {
    const { symbol } = req.params;
    const period = parseInt(req.query.period as string) || 1000;
    
    const candleManager = getCandleManager();
    const candles = candleManager.getCandles(symbol, '5', 1500);
    
    if (candles.length === 0) {
      return res.status(404).json({ 
        success: false, 
        error: `No candles for ${symbol}. Register it first.` 
      });
    }

    const smaValues = calcSMA(candles, period);
    const emaValues = calcEMA(candles, period);
    
    const lastClose = candles[candles.length - 1].close;
    const lastSMA = smaValues.length > 0 ? smaValues[smaValues.length - 1] : null;
    const lastEMA = emaValues.length > 0 ? emaValues[emaValues.length - 1] : null;

    res.json({ 
      success: true, 
      data: {
        symbol,
        period,
        candlesLoaded: candles.length,
        lastCandleTime: new Date(candles[candles.length - 1].openTime).toISOString(),
        lastClose: lastClose.toFixed(2),
        sma: lastSMA ? lastSMA.toFixed(2) : 'Not enough data',
        ema: lastEMA ? lastEMA.toFixed(2) : 'Not enough data',
        smaDataPoints: smaValues.length,
        emaDataPoints: emaValues.length,
        // Show last 5 EMA values for verification
        last5EMA: emaValues.slice(-5).map(v => v.toFixed(2)),
        last5Closes: candles.slice(-5).map(c => c.close.toFixed(2)),
      }
    });
  } catch (error) {
    logger.error({ error }, 'Failed to debug MA');
    res.status(500).json({ success: false, error: 'Failed to debug MA' });
  }
});

export default router;

