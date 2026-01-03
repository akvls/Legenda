import { Router } from 'express';
import { getTicker, getKlines, getWalletBalance, getPosition, getAllPositions } from '../../bybit/rest-client.js';
import { getCandleManager } from '../../data/candle-manager.js';
import { apiLogger as logger } from '../../utils/logger.js';

const router = Router();

/**
 * Get ticker for a symbol
 */
router.get('/ticker/:symbol', async (req, res) => {
  try {
    const { symbol } = req.params;
    const ticker = await getTicker(symbol);
    res.json({ success: true, data: ticker });
  } catch (error) {
    logger.error({ error }, 'Failed to get ticker');
    res.status(500).json({ success: false, error: 'Failed to fetch ticker' });
  }
});

/**
 * Get candles for a symbol
 */
router.get('/candles/:symbol/:timeframe', async (req, res) => {
  try {
    const { symbol, timeframe } = req.params;
    const limit = parseInt(req.query.limit as string) || 200;
    
    // Try to get from candle manager first (if subscribed)
    const candleManager = getCandleManager();
    let candles = candleManager.getCandles(symbol, timeframe, limit);
    
    // If not enough candles in buffer, fetch from API
    if (candles.length < limit) {
      candles = await getKlines(symbol, timeframe, limit);
    }
    
    res.json({ success: true, data: candles });
  } catch (error) {
    logger.error({ error }, 'Failed to get candles');
    res.status(500).json({ success: false, error: 'Failed to fetch candles' });
  }
});

/**
 * Subscribe to candle updates
 */
router.post('/candles/subscribe', async (req, res) => {
  try {
    const { symbol, timeframe } = req.body;
    
    if (!symbol || !timeframe) {
      return res.status(400).json({ 
        success: false, 
        error: 'symbol and timeframe are required' 
      });
    }
    
    const candleManager = getCandleManager();
    await candleManager.subscribe(symbol, timeframe);
    
    res.json({ 
      success: true, 
      message: `Subscribed to ${symbol} ${timeframe}` 
    });
  } catch (error) {
    logger.error({ error }, 'Failed to subscribe to candles');
    res.status(500).json({ success: false, error: 'Failed to subscribe' });
  }
});

/**
 * Unsubscribe from candle updates
 */
router.post('/candles/unsubscribe', async (req, res) => {
  try {
    const { symbol, timeframe } = req.body;
    
    if (!symbol || !timeframe) {
      return res.status(400).json({ 
        success: false, 
        error: 'symbol and timeframe are required' 
      });
    }
    
    const candleManager = getCandleManager();
    candleManager.unsubscribe(symbol, timeframe);
    
    res.json({ 
      success: true, 
      message: `Unsubscribed from ${symbol} ${timeframe}` 
    });
  } catch (error) {
    logger.error({ error }, 'Failed to unsubscribe from candles');
    res.status(500).json({ success: false, error: 'Failed to unsubscribe' });
  }
});

/**
 * Get wallet balance
 */
router.get('/balance', async (_req, res) => {
  try {
    const balance = await getWalletBalance();
    res.json({ success: true, data: balance });
  } catch (error) {
    logger.error({ error }, 'Failed to get balance');
    res.status(500).json({ success: false, error: 'Failed to fetch balance' });
  }
});

/**
 * Debug: Get ALL wallet balances from all account types
 */
router.get('/balance/debug', async (_req, res) => {
  try {
    const { getAllWalletBalances } = await import('../../bybit/rest-client.js');
    const allBalances = await getAllWalletBalances();
    res.json({ success: true, data: allBalances });
  } catch (error) {
    logger.error({ error }, 'Failed to get debug balance');
    res.status(500).json({ success: false, error: 'Failed to fetch debug balance' });
  }
});

/**
 * Get position for a symbol
 */
router.get('/position/:symbol', async (req, res) => {
  try {
    const { symbol } = req.params;
    const position = await getPosition(symbol);
    res.json({ success: true, data: position });
  } catch (error) {
    logger.error({ error }, 'Failed to get position');
    res.status(500).json({ success: false, error: 'Failed to fetch position' });
  }
});

/**
 * Get all positions
 */
router.get('/positions', async (_req, res) => {
  try {
    const positions = await getAllPositions();
    res.json({ success: true, data: positions });
  } catch (error) {
    logger.error({ error }, 'Failed to get positions');
    res.status(500).json({ success: false, error: 'Failed to fetch positions' });
  }
});

export default router;

