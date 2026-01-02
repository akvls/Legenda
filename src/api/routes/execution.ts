import { Router } from 'express';
import { getTradeExecutor } from '../../execution/trade-executor.js';
import { getPositionTracker } from '../../execution/position-tracker.js';
import { getOrderManager } from '../../execution/order-manager.js';
import { getTrailingManager } from '../../execution/trailing-manager.js';
import { apiLogger as logger } from '../../utils/logger.js';
import { prisma } from '../../db/index.js';
import type { TradeSide, SLRule, TPRule, TrailMode } from '../../types/index.js';

const router = Router();

/**
 * Execute a trade entry
 */
router.post('/enter', async (req, res) => {
  try {
    const {
      symbol,
      side,
      riskPercent = 0.5,
      leverage = 5,
      slRule = 'SWING',
      slPrice,
      tpRule = 'NONE',
      tpPrice,
      tpRR,
      trailMode = 'NONE',
      userNote,
      userTags,
    } = req.body;

    if (!symbol || !side) {
      return res.status(400).json({
        success: false,
        error: 'symbol and side are required',
      });
    }

    if (side !== 'LONG' && side !== 'SHORT') {
      return res.status(400).json({
        success: false,
        error: 'side must be LONG or SHORT',
      });
    }

    const executor = getTradeExecutor();
    const result = await executor.executeEntry({
      symbol,
      side: side as TradeSide,
      riskPercent,
      requestedLeverage: leverage,
      slRule: slRule as SLRule,
      slPrice,
      tpRule: tpRule as TPRule,
      tpPrice,
      tpRR,
      trailMode: trailMode as TrailMode,
      userNote,
      userTags,
    });

    if (result.blocked) {
      return res.status(403).json({
        success: false,
        blocked: true,
        reason: result.blockReason,
      });
    }

    if (!result.success) {
      return res.status(400).json({
        success: false,
        error: result.error,
      });
    }

    res.json({
      success: true,
      data: {
        tradeId: result.tradeId,
        symbol,
        side,
        strategyId: result.contract?.strategyId,
        leverage: result.contract?.entry.appliedLeverage,
        slPrice: result.contract?.sl.price,
        warning: result.warning,
      },
    });
  } catch (error) {
    logger.error({ error }, 'Entry execution failed');
    res.status(500).json({ success: false, error: 'Entry execution failed' });
  }
});

/**
 * Exit a position
 */
router.post('/exit', async (req, res) => {
  try {
    const { symbol, reason = 'MANUAL_CLOSE', percent = 100 } = req.body;

    if (!symbol) {
      return res.status(400).json({
        success: false,
        error: 'symbol is required',
      });
    }

    const executor = getTradeExecutor();
    const success = await executor.executeExit(symbol, reason, percent);

    if (!success) {
      return res.status(400).json({
        success: false,
        error: 'No position to exit or exit failed',
      });
    }

    res.json({
      success: true,
      message: `Exited ${percent}% of ${symbol} position`,
    });
  } catch (error) {
    logger.error({ error }, 'Exit execution failed');
    res.status(500).json({ success: false, error: 'Exit execution failed' });
  }
});

/**
 * Move stop loss to breakeven
 */
router.post('/move-sl-be', async (req, res) => {
  try {
    const { symbol } = req.body;

    if (!symbol) {
      return res.status(400).json({
        success: false,
        error: 'symbol is required',
      });
    }

    const executor = getTradeExecutor();
    const success = await executor.moveSlToBreakeven(symbol);

    if (!success) {
      return res.status(400).json({
        success: false,
        error: 'No position or failed to move SL',
      });
    }

    res.json({
      success: true,
      message: `Stop loss moved to breakeven for ${symbol}`,
    });
  } catch (error) {
    logger.error({ error }, 'Move SL to BE failed');
    res.status(500).json({ success: false, error: 'Failed to move SL' });
  }
});

/**
 * Get current positions
 */
router.get('/positions', async (_req, res) => {
  try {
    const tracker = getPositionTracker();
    const positions = tracker.getAllPositions();

    res.json({ success: true, data: positions });
  } catch (error) {
    logger.error({ error }, 'Failed to get positions');
    res.status(500).json({ success: false, error: 'Failed to get positions' });
  }
});

/**
 * Get position for a symbol
 */
router.get('/positions/:symbol', async (req, res) => {
  try {
    const { symbol } = req.params;
    const tracker = getPositionTracker();
    const position = tracker.getPosition(symbol);

    if (!position) {
      return res.status(404).json({
        success: false,
        error: `No position for ${symbol}`,
      });
    }

    res.json({ success: true, data: position });
  } catch (error) {
    logger.error({ error }, 'Failed to get position');
    res.status(500).json({ success: false, error: 'Failed to get position' });
  }
});

/**
 * Get active trades (in-memory)
 */
router.get('/trades/active', async (_req, res) => {
  try {
    const executor = getTradeExecutor();
    const trades = executor.getAllActiveTrades();

    res.json({ success: true, data: trades });
  } catch (error) {
    logger.error({ error }, 'Failed to get trades');
    res.status(500).json({ success: false, error: 'Failed to get trades' });
  }
});

/**
 * Get trade history from database (for journal)
 */
router.get('/trades', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit as string) || 50;
    const offset = parseInt(req.query.offset as string) || 0;

    const trades = await prisma.trade.findMany({
      orderBy: { createdAt: 'desc' },
      take: limit,
      skip: offset,
      select: {
        id: true,
        symbol: true,
        side: true,
        strategyId: true,
        timeframe: true,
        entryPrice: true,
        exitPrice: true,
        entrySize: true,
        entrySizeUsdt: true,
        slPrice: true,
        tpPrice: true,
        realizedPnl: true,
        realizedPnlPercent: true,
        fees: true,
        exitReason: true,
        riskPercent: true,
        appliedLeverage: true,
        userNote: true,
        userTags: true,
        createdAt: true,
        entryFilledAt: true,
        closedAt: true,
      },
    });

    // Format for frontend
    const formattedTrades = trades.map(t => ({
      id: t.id,
      symbol: t.symbol,
      side: t.side,
      strategyId: t.strategyId,
      entryPrice: t.entryPrice,
      exitPrice: t.exitPrice,
      entrySize: t.entrySize,
      pnl: t.realizedPnl,
      pnlPercent: t.realizedPnlPercent,
      createdAt: t.createdAt.toISOString(),
      exitedAt: t.closedAt?.toISOString(),
      status: t.closedAt ? 'CLOSED' : 'OPEN',
      exitReason: t.exitReason,
      leverage: t.appliedLeverage,
      slPrice: t.slPrice,
      note: t.userNote,
    }));

    res.json({ success: true, trades: formattedTrades });
  } catch (error) {
    logger.error({ error }, 'Failed to get trade history');
    res.status(500).json({ success: false, error: 'Failed to get trade history' });
  }
});

/**
 * Get open orders
 */
router.get('/orders/:symbol', async (req, res) => {
  try {
    const { symbol } = req.params;
    const orderManager = getOrderManager();
    const orders = orderManager.getOpenOrdersForSymbol(symbol);

    res.json({ success: true, data: orders });
  } catch (error) {
    logger.error({ error }, 'Failed to get orders');
    res.status(500).json({ success: false, error: 'Failed to get orders' });
  }
});

/**
 * Cancel all orders for a symbol
 */
router.post('/cancel-orders', async (req, res) => {
  try {
    const { symbol } = req.body;

    if (!symbol) {
      return res.status(400).json({
        success: false,
        error: 'symbol is required',
      });
    }

    const orderManager = getOrderManager();
    await orderManager.cancelAll(symbol);

    res.json({
      success: true,
      message: `All orders cancelled for ${symbol}`,
    });
  } catch (error) {
    logger.error({ error }, 'Failed to cancel orders');
    res.status(500).json({ success: false, error: 'Failed to cancel orders' });
  }
});

/**
 * Activate trailing stop
 */
router.post('/trail/activate', async (req, res) => {
  try {
    const { symbol } = req.body;

    if (!symbol) {
      return res.status(400).json({
        success: false,
        error: 'symbol is required',
      });
    }

    const trailingManager = getTrailingManager();
    const success = trailingManager.activateTrailing(symbol);

    if (!success) {
      return res.status(400).json({
        success: false,
        error: 'No trade found or trail mode is NONE',
      });
    }

    res.json({
      success: true,
      message: `Trailing activated for ${symbol}`,
    });
  } catch (error) {
    logger.error({ error }, 'Failed to activate trailing');
    res.status(500).json({ success: false, error: 'Failed to activate trailing' });
  }
});

/**
 * Deactivate trailing stop
 */
router.post('/trail/deactivate', async (req, res) => {
  try {
    const { symbol } = req.body;

    if (!symbol) {
      return res.status(400).json({
        success: false,
        error: 'symbol is required',
      });
    }

    const trailingManager = getTrailingManager();
    trailingManager.deactivateTrailing(symbol);

    res.json({
      success: true,
      message: `Trailing deactivated for ${symbol}`,
    });
  } catch (error) {
    logger.error({ error }, 'Failed to deactivate trailing');
    res.status(500).json({ success: false, error: 'Failed to deactivate trailing' });
  }
});

export default router;

