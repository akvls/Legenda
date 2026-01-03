import { Router, Request, Response } from 'express';
import { prisma } from '../../db/index.js';
import { createLogger } from '../../utils/logger.js';

const router = Router();
const logger = createLogger('journal-api');

// ============================================
// TRADE JOURNAL ENDPOINTS
// ============================================

/**
 * GET /api/journal/trades
 * Get all trades with full details
 */
router.get('/trades', async (req: Request, res: Response) => {
  try {
    const { 
      symbol, 
      side, 
      strategyId, 
      limit = '50', 
      offset = '0',
      startDate,
      endDate,
      sortBy = 'createdAt',
      sortOrder = 'desc'
    } = req.query;

    const where: any = {};
    
    if (symbol) where.symbol = symbol;
    if (side) where.side = side;
    if (strategyId) where.strategyId = strategyId;
    
    // Date filters
    if (startDate || endDate) {
      where.createdAt = {};
      if (startDate) where.createdAt.gte = new Date(startDate as string);
      if (endDate) where.createdAt.lte = new Date(endDate as string);
    }

    // Only get closed trades (with exit)
    where.closedAt = { not: null };

    const trades = await prisma.trade.findMany({
      where,
      include: {
        orders: {
          select: {
            id: true,
            side: true,
            orderType: true,
            price: true,
            size: true,
            status: true,
            isEntry: true,
            isExit: true,
            isStopLoss: true,
            isTakeProfit: true,
            filledAt: true,
            avgFillPrice: true,
          }
        },
        fills: {
          select: {
            price: true,
            size: true,
            fee: true,
            filledAt: true,
          }
        },
        events: {
          select: {
            eventType: true,
            message: true,
            timestamp: true,
          },
          orderBy: { timestamp: 'asc' }
        }
      },
      orderBy: { [sortBy as string]: sortOrder },
      take: parseInt(limit as string),
      skip: parseInt(offset as string),
    });

    // Get total count
    const total = await prisma.trade.count({ where });

    // Parse JSON fields for each trade
    const enrichedTrades = trades.map(trade => ({
      ...trade,
      userTags: trade.userTags ? JSON.parse(trade.userTags) : [],
      aiKeyPoints: trade.aiKeyPoints ? JSON.parse(trade.aiKeyPoints) : [],
      invalidationRules: trade.invalidationRules ? JSON.parse(trade.invalidationRules) : {},
      strategySnapshotAtEntry: trade.strategySnapshotAtEntry ? JSON.parse(trade.strategySnapshotAtEntry) : null,
      strategySnapshotAtExit: trade.strategySnapshotAtExit ? JSON.parse(trade.strategySnapshotAtExit) : null,
    }));

    return res.json({
      success: true,
      total,
      limit: parseInt(limit as string),
      offset: parseInt(offset as string),
      trades: enrichedTrades,
    });
  } catch (error) {
    logger.error({ error }, 'Failed to fetch trades');
    return res.status(500).json({ success: false, error: (error as Error).message });
  }
});

/**
 * GET /api/journal/trades/:id
 * Get single trade with full details
 */
router.get('/trades/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    const trade = await prisma.trade.findUnique({
      where: { id },
      include: {
        orders: true,
        fills: true,
        events: {
          orderBy: { timestamp: 'asc' }
        }
      }
    });

    if (!trade) {
      return res.status(404).json({ success: false, error: 'Trade not found' });
    }

    // Parse JSON fields
    const enrichedTrade = {
      ...trade,
      userTags: trade.userTags ? JSON.parse(trade.userTags) : [],
      aiKeyPoints: trade.aiKeyPoints ? JSON.parse(trade.aiKeyPoints) : [],
      invalidationRules: trade.invalidationRules ? JSON.parse(trade.invalidationRules) : {},
      strategySnapshotAtEntry: trade.strategySnapshotAtEntry ? JSON.parse(trade.strategySnapshotAtEntry) : null,
      strategySnapshotAtExit: trade.strategySnapshotAtExit ? JSON.parse(trade.strategySnapshotAtExit) : null,
    };

    return res.json({ success: true, trade: enrichedTrade });
  } catch (error) {
    logger.error({ error }, 'Failed to fetch trade');
    return res.status(500).json({ success: false, error: (error as Error).message });
  }
});

/**
 * PATCH /api/journal/trades/:id
 * Update trade with user notes/score
 */
router.patch('/trades/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { userScore, userNote, userReview, userTags } = req.body;

    const updateData: any = {};
    if (userScore !== undefined) updateData.userScore = userScore;
    if (userNote !== undefined) updateData.userNote = userNote;
    if (userReview !== undefined) updateData.userReview = userReview;
    if (userTags !== undefined) updateData.userTags = JSON.stringify(userTags);

    const trade = await prisma.trade.update({
      where: { id },
      data: updateData,
    });

    return res.json({ success: true, trade });
  } catch (error) {
    logger.error({ error }, 'Failed to update trade');
    return res.status(500).json({ success: false, error: (error as Error).message });
  }
});

/**
 * GET /api/journal/trades/active
 * Get currently active (open) trades
 */
router.get('/active', async (_req: Request, res: Response) => {
  try {
    const trades = await prisma.trade.findMany({
      where: { closedAt: null },
      include: {
        orders: {
          where: { status: { in: ['OPEN', 'PARTIALLY_FILLED'] } }
        }
      },
      orderBy: { createdAt: 'desc' }
    });

    return res.json({ success: true, count: trades.length, trades });
  } catch (error) {
    logger.error({ error }, 'Failed to fetch active trades');
    return res.status(500).json({ success: false, error: (error as Error).message });
  }
});

// ============================================
// STATISTICS ENDPOINTS
// ============================================

/**
 * GET /api/journal/stats
 * Get overall trading statistics
 */
router.get('/stats', async (req: Request, res: Response) => {
  try {
    const { startDate, endDate, symbol } = req.query;

    const where: any = { closedAt: { not: null } };
    if (symbol) where.symbol = symbol;
    if (startDate || endDate) {
      where.createdAt = {};
      if (startDate) where.createdAt.gte = new Date(startDate as string);
      if (endDate) where.createdAt.lte = new Date(endDate as string);
    }

    // Get all closed trades
    const trades = await prisma.trade.findMany({
      where,
      select: {
        id: true,
        symbol: true,
        side: true,
        strategyId: true,
        realizedPnl: true,
        realizedPnlPercent: true,
        rMultiple: true,
        fees: true,
        aiScore: true,
        userScore: true,
        durationSeconds: true,
        exitReason: true,
        createdAt: true,
        closedAt: true,
      }
    });

    // Calculate stats
    const totalTrades = trades.length;
    const winningTrades = trades.filter(t => (t.realizedPnl || 0) > 0);
    const losingTrades = trades.filter(t => (t.realizedPnl || 0) < 0);
    const breakEvenTrades = trades.filter(t => (t.realizedPnl || 0) === 0);

    const totalPnl = trades.reduce((sum, t) => sum + (t.realizedPnl || 0), 0);
    const totalR = trades.reduce((sum, t) => sum + (t.rMultiple || 0), 0);
    const totalFees = trades.reduce((sum, t) => sum + (t.fees || 0), 0);

    const winRate = totalTrades > 0 ? (winningTrades.length / totalTrades) * 100 : 0;
    const avgR = totalTrades > 0 ? totalR / totalTrades : 0;
    const avgPnl = totalTrades > 0 ? totalPnl / totalTrades : 0;

    // Best and worst trades
    const bestTrade = trades.reduce((best, t) => 
      (t.realizedPnl || 0) > (best?.realizedPnl || -Infinity) ? t : best, trades[0]);
    const worstTrade = trades.reduce((worst, t) => 
      (t.realizedPnl || 0) < (worst?.realizedPnl || Infinity) ? t : worst, trades[0]);

    // By symbol
    const bySymbol: Record<string, { trades: number; pnl: number; winRate: number }> = {};
    trades.forEach(t => {
      if (!bySymbol[t.symbol]) {
        bySymbol[t.symbol] = { trades: 0, pnl: 0, winRate: 0 };
      }
      bySymbol[t.symbol].trades++;
      bySymbol[t.symbol].pnl += t.realizedPnl || 0;
    });
    Object.keys(bySymbol).forEach(sym => {
      const symTrades = trades.filter(t => t.symbol === sym);
      const symWins = symTrades.filter(t => (t.realizedPnl || 0) > 0);
      bySymbol[sym].winRate = symTrades.length > 0 ? (symWins.length / symTrades.length) * 100 : 0;
    });

    // By strategy
    const byStrategy: Record<string, { trades: number; pnl: number; winRate: number }> = {};
    trades.forEach(t => {
      if (!byStrategy[t.strategyId]) {
        byStrategy[t.strategyId] = { trades: 0, pnl: 0, winRate: 0 };
      }
      byStrategy[t.strategyId].trades++;
      byStrategy[t.strategyId].pnl += t.realizedPnl || 0;
    });
    Object.keys(byStrategy).forEach(strat => {
      const stratTrades = trades.filter(t => t.strategyId === strat);
      const stratWins = stratTrades.filter(t => (t.realizedPnl || 0) > 0);
      byStrategy[strat].winRate = stratTrades.length > 0 ? (stratWins.length / stratTrades.length) * 100 : 0;
    });

    // By side
    const longs = trades.filter(t => t.side === 'LONG');
    const shorts = trades.filter(t => t.side === 'SHORT');
    const longWins = longs.filter(t => (t.realizedPnl || 0) > 0);
    const shortWins = shorts.filter(t => (t.realizedPnl || 0) > 0);

    // By exit reason
    const byExitReason: Record<string, number> = {};
    trades.forEach(t => {
      const reason = t.exitReason || 'UNKNOWN';
      byExitReason[reason] = (byExitReason[reason] || 0) + 1;
    });

    // Average duration
    const tradesWithDuration = trades.filter(t => t.durationSeconds);
    const avgDuration = tradesWithDuration.length > 0 
      ? tradesWithDuration.reduce((sum, t) => sum + (t.durationSeconds || 0), 0) / tradesWithDuration.length 
      : 0;

    // Profit factor
    const grossProfit = winningTrades.reduce((sum, t) => sum + (t.realizedPnl || 0), 0);
    const grossLoss = Math.abs(losingTrades.reduce((sum, t) => sum + (t.realizedPnl || 0), 0));
    const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0;

    // Consecutive wins/losses
    let maxConsecutiveWins = 0;
    let maxConsecutiveLosses = 0;
    let currentWins = 0;
    let currentLosses = 0;
    
    trades.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
    trades.forEach(t => {
      if ((t.realizedPnl || 0) > 0) {
        currentWins++;
        currentLosses = 0;
        maxConsecutiveWins = Math.max(maxConsecutiveWins, currentWins);
      } else if ((t.realizedPnl || 0) < 0) {
        currentLosses++;
        currentWins = 0;
        maxConsecutiveLosses = Math.max(maxConsecutiveLosses, currentLosses);
      }
    });

    return res.json({
      success: true,
      stats: {
        overview: {
          totalTrades,
          winningTrades: winningTrades.length,
          losingTrades: losingTrades.length,
          breakEvenTrades: breakEvenTrades.length,
          winRate: parseFloat(winRate.toFixed(2)),
          profitFactor: parseFloat(profitFactor.toFixed(2)),
        },
        pnl: {
          totalPnl: parseFloat(totalPnl.toFixed(2)),
          avgPnl: parseFloat(avgPnl.toFixed(2)),
          totalR: parseFloat(totalR.toFixed(2)),
          avgR: parseFloat(avgR.toFixed(2)),
          totalFees: parseFloat(totalFees.toFixed(2)),
          grossProfit: parseFloat(grossProfit.toFixed(2)),
          grossLoss: parseFloat(grossLoss.toFixed(2)),
        },
        bestWorst: {
          bestTrade: bestTrade ? {
            id: bestTrade.id,
            symbol: bestTrade.symbol,
            pnl: bestTrade.realizedPnl,
            rMultiple: bestTrade.rMultiple,
          } : null,
          worstTrade: worstTrade ? {
            id: worstTrade.id,
            symbol: worstTrade.symbol,
            pnl: worstTrade.realizedPnl,
            rMultiple: worstTrade.rMultiple,
          } : null,
        },
        streaks: {
          maxConsecutiveWins,
          maxConsecutiveLosses,
        },
        timing: {
          avgDurationSeconds: Math.round(avgDuration),
          avgDurationFormatted: formatDuration(avgDuration),
        },
        bySide: {
          longs: {
            count: longs.length,
            wins: longWins.length,
            winRate: longs.length > 0 ? parseFloat(((longWins.length / longs.length) * 100).toFixed(2)) : 0,
            pnl: parseFloat(longs.reduce((sum, t) => sum + (t.realizedPnl || 0), 0).toFixed(2)),
          },
          shorts: {
            count: shorts.length,
            wins: shortWins.length,
            winRate: shorts.length > 0 ? parseFloat(((shortWins.length / shorts.length) * 100).toFixed(2)) : 0,
            pnl: parseFloat(shorts.reduce((sum, t) => sum + (t.realizedPnl || 0), 0).toFixed(2)),
          },
        },
        bySymbol,
        byStrategy,
        byExitReason,
      }
    });
  } catch (error) {
    logger.error({ error }, 'Failed to calculate stats');
    return res.status(500).json({ success: false, error: (error as Error).message });
  }
});

/**
 * GET /api/journal/stats/daily
 * Get daily stats for a date range
 */
router.get('/stats/daily', async (req: Request, res: Response) => {
  try {
    const { days = '30' } = req.query;
    const daysNum = parseInt(days as string);
    
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - daysNum);
    startDate.setHours(0, 0, 0, 0);

    // Get trades in date range
    const trades = await prisma.trade.findMany({
      where: {
        closedAt: { not: null },
        createdAt: { gte: startDate },
      },
      select: {
        realizedPnl: true,
        rMultiple: true,
        createdAt: true,
        side: true,
      },
      orderBy: { createdAt: 'asc' }
    });

    // Group by date
    const dailyStats: Record<string, { 
      date: string; 
      trades: number; 
      pnl: number; 
      rTotal: number;
      wins: number;
      losses: number;
    }> = {};

    trades.forEach(t => {
      const dateStr = new Date(t.createdAt).toISOString().split('T')[0];
      if (!dailyStats[dateStr]) {
        dailyStats[dateStr] = { date: dateStr, trades: 0, pnl: 0, rTotal: 0, wins: 0, losses: 0 };
      }
      dailyStats[dateStr].trades++;
      dailyStats[dateStr].pnl += t.realizedPnl || 0;
      dailyStats[dateStr].rTotal += t.rMultiple || 0;
      if ((t.realizedPnl || 0) > 0) dailyStats[dateStr].wins++;
      if ((t.realizedPnl || 0) < 0) dailyStats[dateStr].losses++;
    });

    // Convert to array and fill in missing dates
    const result: any[] = [];
    const currentDate = new Date(startDate);
    const endDate = new Date();
    
    while (currentDate <= endDate) {
      const dateStr = currentDate.toISOString().split('T')[0];
      result.push(dailyStats[dateStr] || { 
        date: dateStr, 
        trades: 0, 
        pnl: 0, 
        rTotal: 0, 
        wins: 0, 
        losses: 0 
      });
      currentDate.setDate(currentDate.getDate() + 1);
    }

    return res.json({ success: true, days: daysNum, dailyStats: result });
  } catch (error) {
    logger.error({ error }, 'Failed to get daily stats');
    return res.status(500).json({ success: false, error: (error as Error).message });
  }
});

// ============================================
// EVENT LOG ENDPOINTS
// ============================================

/**
 * GET /api/journal/events
 * Get event log (audit trail)
 */
router.get('/events', async (req: Request, res: Response) => {
  try {
    const { 
      symbol, 
      tradeId, 
      eventType, 
      limit = '100', 
      offset = '0' 
    } = req.query;

    const where: any = {};
    if (symbol) where.symbol = symbol;
    if (tradeId) where.tradeId = tradeId;
    if (eventType) where.eventType = eventType;

    const events = await prisma.event.findMany({
      where,
      orderBy: { timestamp: 'desc' },
      take: parseInt(limit as string),
      skip: parseInt(offset as string),
    });

    const total = await prisma.event.count({ where });

    // Parse payload JSON
    const enrichedEvents = events.map(e => ({
      ...e,
      payload: e.payload ? JSON.parse(e.payload) : null,
    }));

    return res.json({
      success: true,
      total,
      limit: parseInt(limit as string),
      offset: parseInt(offset as string),
      events: enrichedEvents,
    });
  } catch (error) {
    logger.error({ error }, 'Failed to fetch events');
    return res.status(500).json({ success: false, error: (error as Error).message });
  }
});

/**
 * GET /api/journal/events/types
 * Get all event types
 */
router.get('/events/types', async (_req: Request, res: Response) => {
  try {
    const types = await prisma.event.groupBy({
      by: ['eventType'],
      _count: true,
    });

    return res.json({
      success: true,
      types: types.map(t => ({ type: t.eventType, count: t._count })),
    });
  } catch (error) {
    logger.error({ error }, 'Failed to fetch event types');
    return res.status(500).json({ success: false, error: (error as Error).message });
  }
});

// ============================================
// HELPERS
// ============================================

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  if (seconds < 86400) return `${(seconds / 3600).toFixed(1)}h`;
  return `${(seconds / 86400).toFixed(1)}d`;
}

export default router;



