import { EventEmitter } from 'eventemitter3';
import { v4 as uuid } from 'uuid';
import { prisma } from '../db/index.js';
import { setLeverage, setTakeProfit, setStopLoss, getWalletBalance, getInstrumentInfo } from '../bybit/rest-client.js';
import { getOrderManager, OrderManager, ManagedOrder } from './order-manager.js';
import { getPositionTracker, PositionTracker } from './position-tracker.js';
import { getSLManager } from './sl-manager.js';
import { getStrategyEngine } from '../strategy/engine.js';
import { createLogger } from '../utils/logger.js';
import type { 
  TradeSide, 
  SLRule, 
  TPRule, 
  TrailMode,
  StrategyId,
  StrategyState,
  TradeContract,
} from '../types/index.js';

const logger = createLogger('trade-executor');

/**
 * Trade Executor
 * Handles the full trade entry flow with validation, leverage, SL/TP
 */

const MAX_LEVERAGE = 10;

export interface EntryParams {
  symbol: string;
  side: TradeSide;
  entryPrice?: number;  // Limit order price (if specified, uses limit order instead of market)
  riskPercent: number;
  positionSizeUsdt?: number;  // Dollar amount (overrides riskPercent if provided)
  requestedLeverage: number;
  slRule: SLRule;
  slPrice?: number;
  tpRule: TPRule;
  tpPrice?: number;
  tpRR?: number;
  trailMode: TrailMode;
  userNote?: string;
  userTags?: string[];
}

export interface EntryResult {
  success: boolean;
  tradeId?: string;
  order?: ManagedOrder;
  contract?: TradeContract;
  blocked?: boolean;
  blockReason?: string;
  warning?: string;
  error?: string;
}

export interface TradeExecutorEvents {
  entryExecuted: (tradeId: string, contract: TradeContract) => void;
  entryBlocked: (symbol: string, side: TradeSide, reason: string) => void;
  exitExecuted: (tradeId: string, reason: string) => void;
  slSet: (tradeId: string, price: number) => void;
  tpSet: (tradeId: string, price: number) => void;
  leverageClamped: (symbol: string, requested: number, applied: number) => void;
  error: (error: Error) => void;
}

export class TradeExecutor extends EventEmitter<TradeExecutorEvents> {
  private orderManager: OrderManager;
  private positionTracker: PositionTracker;
  private activeTrades: Map<string, TradeContract> = new Map();

  constructor() {
    super();
    this.orderManager = getOrderManager();
    this.positionTracker = getPositionTracker();
    this.setupEventHandlers();
  }

  private setupEventHandlers(): void {
    this.orderManager.on('orderFilled', (order) => {
      if (order.isEntry && order.tradeId) {
        this.onEntryFilled(order);
      }
    });
  }

  private async onEntryFilled(order: ManagedOrder): Promise<void> {
    const contract = this.activeTrades.get(order.tradeId!);
    if (!contract) return;

    // Update contract with fill info
    // SL/TP should already be set via Bybit position API
    logger.info(
      { tradeId: order.tradeId, symbol: order.symbol, price: order.avgFillPrice },
      'Entry filled'
    );
  }

  /**
   * Execute a trade entry
   */
  async executeEntry(params: EntryParams): Promise<EntryResult> {
    const { symbol, side } = params;
    const tradeId = uuid();

    try {
      // 1. Validate with Strategy Engine (Hard Gate)
      const strategyEngine = getStrategyEngine();
      const validation = strategyEngine.isEntryAllowed(symbol, side);
      
      if (!validation.allowed) {
        this.emit('entryBlocked', symbol, side, validation.reason!);
        logger.warn({ symbol, side, reason: validation.reason }, 'Entry blocked by strategy');
        
        return {
          success: false,
          blocked: true,
          blockReason: validation.reason,
        };
      }

      // Get strategy state for snapshot
      const strategyState = strategyEngine.getState(symbol);
      const riskWarning = strategyEngine.getRiskWarning(symbol);

      // 2. Check for existing position
      if (this.positionTracker.hasPosition(symbol)) {
        const existingSide = this.positionTracker.getPositionSide(symbol);
        return {
          success: false,
          blocked: true,
          blockReason: `Already have ${existingSide} position in ${symbol}`,
        };
      }

      // 3. Set leverage (clamped to max)
      const appliedLeverage = await this.setLeverageSafe(symbol, params.requestedLeverage);
      
      if (appliedLeverage !== params.requestedLeverage) {
        this.emit('leverageClamped', symbol, params.requestedLeverage, appliedLeverage);
      }

      // 4. Calculate position size
      const { size, riskAmountUsdt, slPrice, actualRiskPercent } = await this.calculatePositionSize(
        symbol,
        side,
        params.riskPercent,
        appliedLeverage,
        params.slRule,
        params.slPrice,
        strategyState,
        params.positionSizeUsdt
      );

      if (size <= 0) {
        return {
          success: false,
          error: 'Could not calculate position size',
        };
      }

      // 5. Create trade contract
      const contract: TradeContract = {
        tradeId,
        symbol,
        side,
        timeframe: strategyState?.timeframe ?? '5',
        strategyId: strategyState?.strategyId ?? 'S103',
        entry: {
          type: 'MARKET',
          riskPercent: actualRiskPercent, // Use actual calculated risk
          riskAmountUsdt,
          requestedLeverage: params.requestedLeverage,
          appliedLeverage,
        },
        sl: {
          rule: params.slRule,
          price: slPrice,
        },
        tp: {
          rule: params.tpRule,
          price: params.tpPrice,
          rrTarget: params.tpRR,
        },
        trail: {
          mode: params.trailMode,
          active: false,
        },
        invalidation: {
          biasFlipAgainstTrade: true,
          structureBreak: true,
          supertrendFlip: true,
        },
        reentryPolicy: {
          lockSameDirection: true,
          onlyOppositeAllowed: true,
        },
        reasons: {
          userTags: params.userTags ?? [],
          userNote: params.userNote,
          strategySnapshotAtEntry: strategyState?.snapshot ?? {} as any,
        },
      };

      this.activeTrades.set(tradeId, contract);

      // 6. Determine emergency SL for atomic order
      // When user explicitly provides SL price, use it EXACTLY (no buffer)
      // When SL is auto-calculated (swing/supertrend), apply buffer for protection
      const slManager = getSLManager();
      let emergencySlPrice: number | undefined;
      let strategicSlPrice: number | undefined = slPrice ?? undefined;
      
      if (slPrice) {
        if (params.slRule === 'PRICE' && params.slPrice) {
          // User explicitly set SL price - use EXACT price, no buffer
          emergencySlPrice = slPrice;
          strategicSlPrice = slPrice;
          logger.info({ symbol, slPrice: slPrice.toFixed(2) }, 'Using explicit SL price (no buffer)');
        } else {
          // Auto-calculated SL (swing/supertrend) - apply buffer for protection
          const bufferPercent = slManager.getBufferPercent();
          if (side === 'LONG') {
            emergencySlPrice = slPrice * (1 - bufferPercent / 100);
          } else {
            emergencySlPrice = slPrice * (1 + bufferPercent / 100);
          }
          strategicSlPrice = slPrice;
        }
      }

      // 7. Place entry order
      // Use LIMIT order if entry price specified, otherwise MARKET order
      const isLimitOrder = !!params.entryPrice;
      let order: ManagedOrder;
      
      if (isLimitOrder) {
        // Limit order - sent to Bybit IMMEDIATELY, waits for price to reach target
        order = await this.orderManager.placeLimit({
          symbol,
          side,
          size,
          price: params.entryPrice!,
          reduceOnly: false,
          tradeId,
          isEntry: true,
          stopLoss: slPrice ?? undefined, // Use strategic SL for limit orders (no buffer needed)
          takeProfit: params.tpPrice,
        });
        logger.info({
          tradeId,
          symbol,
          side,
          entryPrice: params.entryPrice,
          size,
          stopLoss: slPrice,
          takeProfit: params.tpPrice,
        }, '📋 Limit order sent to Bybit with SL/TP - waiting for fill');
        
        contract.entry.type = 'LIMIT';
        contract.entry.limitPrice = params.entryPrice;
      } else {
        // Market order - execute immediately WITH SL attached (atomic - SL active immediately)
        order = await this.orderManager.placeMarket({
          symbol,
          side,
          size,
          reduceOnly: false,
          tradeId,
          isEntry: true,
          stopLoss: emergencySlPrice,
          takeProfit: params.tpPrice,
        });
      }

      // 8. Register strategic SL with SL Manager (for candle-close checks)
      if (slPrice) {
        slManager.registerStrategicSL(symbol, side, slPrice, emergencySlPrice!);
        this.emit('slSet', tradeId, slPrice);
        logger.info({ 
          tradeId, 
          symbol, 
          strategicSL: slPrice.toFixed(2),
          emergencySL: emergencySlPrice!.toFixed(2),
          buffer: `${slManager.getBufferPercent()}%`,
        }, 'Two-layer stop loss set (atomic with order)');
      }

      // 9. Set TP from RR if not already set and we have RR target
      if (!params.tpPrice && params.tpRR && slPrice) {
        // Wait briefly for fill price, then calculate TP
        const entryPrice = order.avgFillPrice ?? this.positionTracker.getPosition(symbol)?.avgPrice;
        if (entryPrice) {
          const riskDistance = Math.abs(entryPrice - slPrice);
          const tpPrice = side === 'LONG' 
            ? entryPrice + (riskDistance * params.tpRR)
            : entryPrice - (riskDistance * params.tpRR);
          
          try {
            await setTakeProfit(symbol, side, tpPrice);
            this.emit('tpSet', tradeId, tpPrice);
            contract.tp.price = tpPrice;
            logger.info({ tradeId, symbol, tpPrice: tpPrice.toFixed(2) }, 'Take profit set from RR');
          } catch (error) {
            logger.error({ error, tradeId }, 'Failed to set TP from RR');
          }
        }
      }

      // 9. Save trade to database
      await this.saveTrade(contract, order);

      this.emit('entryExecuted', tradeId, contract);
      logger.info(
        { 
          tradeId, 
          symbol, 
          side, 
          size, 
          leverage: appliedLeverage,
          strategyId: contract.strategyId,
        },
        'Trade entry executed'
      );

      return {
        success: true,
        tradeId,
        order,
        contract,
        warning: riskWarning.isRisky ? riskWarning.message : undefined,
      };

    } catch (error) {
      logger.error({ error, symbol, side }, 'Trade entry failed');
      this.emit('error', error as Error);
      
      return {
        success: false,
        error: (error as Error).message,
      };
    }
  }

  /**
   * Execute exit (close position)
   */
  async executeExit(symbol: string, reason: string, percent: number = 100): Promise<boolean> {
    try {
      const position = this.positionTracker.getPosition(symbol);
      if (!position) {
        logger.warn({ symbol }, 'No position to exit');
        return false;
      }

      const exitSide: TradeSide = position.side === 'LONG' ? 'SHORT' : 'LONG';
      const exitSize = position.size * (percent / 100);

      await this.orderManager.placeMarket({
        symbol,
        side: exitSide,
        size: exitSize,
        reduceOnly: true,
        isExit: true,
      });

      // Find trade for this position
      for (const [tradeId, contract] of this.activeTrades) {
        if (contract.symbol === symbol) {
          this.emit('exitExecuted', tradeId, reason);
          
          // Update in database
          await prisma.trade.update({
            where: { id: tradeId },
            data: {
              exitReason: reason,
              closedAt: new Date(),
            },
          });

          if (percent >= 100) {
            this.activeTrades.delete(tradeId);
          }
          break;
        }
      }

      logger.info({ symbol, reason, percent }, 'Exit executed');
      return true;

    } catch (error) {
      logger.error({ error, symbol }, 'Exit failed');
      return false;
    }
  }

  /**
   * Set leverage with max cap
   */
  private async setLeverageSafe(symbol: string, requested: number): Promise<number> {
    const applied = Math.min(requested, MAX_LEVERAGE);
    
    if (requested > MAX_LEVERAGE) {
      logger.warn(
        { symbol, requested, applied },
        'Leverage clamped to max'
      );
    }

    await setLeverage(symbol, applied);
    return applied;
  }

  /**
   * Calculate position size based on risk
   */
  private async calculatePositionSize(
    symbol: string,
    side: TradeSide,
    riskPercent: number,
    leverage: number,
    slRule: SLRule,
    slPriceInput: number | undefined,
    strategyState: StrategyState | null,
    positionSizeUsdt?: number
  ): Promise<{ size: number; riskAmountUsdt: number; slPrice: number | null; actualRiskPercent: number }> {
    
    // Get wallet balance
    const balance = await getWalletBalance();
    
    // If dollar amount provided, use it; otherwise calculate from risk percent
    let riskAmountUsdt: number;
    let actualRiskPercent: number;
    
    if (positionSizeUsdt && positionSizeUsdt > 0) {
      // User specified dollar amount - calculate risk % from it
      riskAmountUsdt = positionSizeUsdt;
      actualRiskPercent = (positionSizeUsdt / balance.availableBalance) * 100;
      logger.info({ 
        positionSizeUsdt, 
        walletBalance: balance.availableBalance.toFixed(2),
        calculatedRiskPercent: actualRiskPercent.toFixed(2),
      }, 'Using dollar amount for position size');
    } else {
      // Use risk percent
      riskAmountUsdt = balance.availableBalance * (riskPercent / 100);
      actualRiskPercent = riskPercent;
    }

    // Get current price
    const position = this.positionTracker.getPosition(symbol);
    const currentPrice = position?.markPrice ?? strategyState?.snapshot.price ?? 0;

    if (currentPrice === 0) {
      return { size: 0, riskAmountUsdt, slPrice: null, actualRiskPercent };
    }

    // Determine SL price
    let slPrice: number | null = slPriceInput ?? null;
    
    if (!slPrice && strategyState) {
      if (slRule === 'SWING') {
        slPrice = side === 'LONG' 
          ? strategyState.keyLevels.protectedSwingLow
          : strategyState.keyLevels.protectedSwingHigh;
      } else if (slRule === 'SUPERTREND') {
        slPrice = strategyState.snapshot.supertrendValue;
      }
    }

    if (!slPrice) {
      // Fallback: 2% from entry
      slPrice = side === 'LONG' 
        ? currentPrice * 0.98 
        : currentPrice * 1.02;
    }

    // Calculate size: risk / (entry - sl)
    const slDistance = Math.abs(currentPrice - slPrice);
    const slDistancePercent = slDistance / currentPrice;
    
    // Position size = risk amount / SL distance in quote
    // With leverage: size = (risk * leverage) / SL distance
    const positionValue = riskAmountUsdt / slDistancePercent;
    const size = positionValue / currentPrice;

    // Get instrument info for min/step
    try {
      const info = await getInstrumentInfo(symbol);
      const minSize = info.minOrderQty;
      const stepSize = info.qtyStep;
      
      // Round to step size
      const roundedSize = Math.floor(size / stepSize) * stepSize;
      const finalSize = Math.max(roundedSize, minSize);

      return { size: finalSize, riskAmountUsdt, slPrice, actualRiskPercent };
    } catch {
      // Fallback: round to 3 decimals
      return { size: Math.floor(size * 1000) / 1000, riskAmountUsdt, slPrice, actualRiskPercent };
    }
  }

  /**
   * Save trade to database
   */
  private async saveTrade(contract: TradeContract, order: ManagedOrder): Promise<void> {
    try {
      await prisma.trade.create({
        data: {
          id: contract.tradeId,
          symbol: contract.symbol,
          side: contract.side,
          timeframe: contract.timeframe,
          strategyId: contract.strategyId,
          entryType: contract.entry.type,
          riskPercent: contract.entry.riskPercent,
          riskAmountUsdt: contract.entry.riskAmountUsdt,
          requestedLeverage: contract.entry.requestedLeverage,
          appliedLeverage: contract.entry.appliedLeverage,
          slRule: contract.sl.rule,
          slPrice: contract.sl.price,
          tpRule: contract.tp.rule,
          tpPrice: contract.tp.price,
          trailMode: contract.trail.mode,
          trailActive: contract.trail.active,
          invalidationRules: JSON.stringify(contract.invalidation),
          userNote: contract.reasons.userNote,
          userTags: JSON.stringify(contract.reasons.userTags),
          strategySnapshotAtEntry: JSON.stringify(contract.reasons.strategySnapshotAtEntry),
        },
      });
    } catch (error) {
      logger.error({ error, tradeId: contract.tradeId }, 'Failed to save trade');
    }
  }

  /**
   * Get active trade for a symbol
   */
  getActiveTrade(symbol: string): TradeContract | null {
    for (const contract of this.activeTrades.values()) {
      if (contract.symbol === symbol) {
        return contract;
      }
    }
    return null;
  }

  /**
   * Get all active trades
   */
  getAllActiveTrades(): TradeContract[] {
    return Array.from(this.activeTrades.values());
  }

  /**
   * Move stop loss to breakeven
   */
  async moveSlToBreakeven(symbol: string): Promise<boolean> {
    const trade = this.getActiveTrade(symbol);
    const position = this.positionTracker.getPosition(symbol);
    
    if (!trade || !position) {
      return false;
    }

    try {
      await setStopLoss(symbol, trade.side, position.avgPrice);
      trade.sl.price = position.avgPrice;
      logger.info({ symbol, bePrice: position.avgPrice }, 'SL moved to breakeven');
      return true;
    } catch (error) {
      logger.error({ error, symbol }, 'Failed to move SL to BE');
      return false;
    }
  }

  /**
   * Restore active trades from database on startup
   * This ensures we don't lose track of trades after a restart
   */
  async restoreFromDatabase(): Promise<number> {
    try {
      // Find trades that are not closed (no exitReason and no closedAt)
      const openTrades = await prisma.trade.findMany({
        where: {
          closedAt: null,
          exitReason: null,
        },
        orderBy: { createdAt: 'desc' },
      });

      let restored = 0;
      for (const dbTrade of openTrades) {
        // Verify position actually exists on exchange
        const position = this.positionTracker.getPosition(dbTrade.symbol);
        
        if (position && position.side === dbTrade.side) {
          // Position exists, restore contract
          const contract: TradeContract = {
            tradeId: dbTrade.id,
            symbol: dbTrade.symbol,
            side: dbTrade.side as TradeSide,
            timeframe: dbTrade.timeframe,
            strategyId: dbTrade.strategyId as StrategyId,
            entry: {
              type: dbTrade.entryType as 'MARKET' | 'LIMIT',
              riskPercent: dbTrade.riskPercent,
              riskAmountUsdt: dbTrade.riskAmountUsdt,
              requestedLeverage: dbTrade.requestedLeverage,
              appliedLeverage: dbTrade.appliedLeverage,
            },
            sl: {
              rule: dbTrade.slRule as SLRule,
              price: dbTrade.slPrice ?? null,
            },
            tp: {
              rule: dbTrade.tpRule as TPRule,
              price: dbTrade.tpPrice ?? undefined,
            },
            trail: {
              mode: dbTrade.trailMode as TrailMode,
              active: dbTrade.trailActive,
            },
            invalidation: JSON.parse(dbTrade.invalidationRules || '{}'),
            reentryPolicy: {
              lockSameDirection: true,
              onlyOppositeAllowed: true,
            },
            reasons: {
              userTags: JSON.parse(dbTrade.userTags || '[]'),
              userNote: dbTrade.userNote ?? undefined,
              strategySnapshotAtEntry: JSON.parse(dbTrade.strategySnapshotAtEntry || '{}'),
            },
          };

          this.activeTrades.set(dbTrade.id, contract);
          restored++;
          
          logger.info({ tradeId: dbTrade.id, symbol: dbTrade.symbol, side: dbTrade.side }, 'Trade restored from database');
        } else {
          // Position doesn't exist anymore, mark trade as closed
          await prisma.trade.update({
            where: { id: dbTrade.id },
            data: {
              closedAt: new Date(),
              exitReason: 'UNKNOWN_RESTART',
            },
          });
          logger.warn({ tradeId: dbTrade.id, symbol: dbTrade.symbol }, 'Trade marked closed (no matching position)');
        }
      }

      logger.info({ restored, total: openTrades.length }, 'Trade restoration complete');
      return restored;
    } catch (error) {
      logger.error({ error }, 'Failed to restore trades from database');
      return 0;
    }
  }

  /**
   * Clean up completed trades from memory
   * Keeps only recent trades (last 24 hours) to prevent memory bloat
   */
  cleanupCompletedTrades(maxAgeHours: number = 24): number {
    const cutoffTime = Date.now() - (maxAgeHours * 60 * 60 * 1000);
    let removed = 0;

    // activeTrades only contains active trades, so nothing to clean there
    // But we can log the count for monitoring
    logger.debug({ activeTradesCount: this.activeTrades.size }, 'Active trades count');
    
    return removed;
  }

  /**
   * Get count of active trades
   */
  getActiveTradeCount(): number {
    return this.activeTrades.size;
  }

  /**
   * Clear a specific trade from active trades (after close)
   */
  clearTrade(tradeId: string): void {
    this.activeTrades.delete(tradeId);
  }
}

// Singleton
let executorInstance: TradeExecutor | null = null;

export function getTradeExecutor(): TradeExecutor {
  if (!executorInstance) {
    executorInstance = new TradeExecutor();
  }
  return executorInstance;
}

// Singleton reference for easy import
export const tradeExecutor = getTradeExecutor();

