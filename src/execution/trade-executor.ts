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
  riskPercent: number;
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
      const { size, riskAmountUsdt, slPrice } = await this.calculatePositionSize(
        symbol,
        side,
        params.riskPercent,
        appliedLeverage,
        params.slRule,
        params.slPrice,
        strategyState
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
          riskPercent: params.riskPercent,
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

      // 6. Place entry order
      const order = await this.orderManager.placeMarket({
        symbol,
        side,
        size,
        reduceOnly: false,
        tradeId,
        isEntry: true,
      });

      // 7. Set Two-Layer SL (via SL Manager)
      // Wait a moment for fill to register
      setTimeout(async () => {
        if (slPrice) {
          try {
            // Use Two-Layer SL System:
            // - Emergency SL: Bybit preset at slPrice - 4% buffer
            // - Strategic SL: Checked on candle close at slPrice
            const slManager = getSLManager();
            const slLevels = await slManager.setTwoLayerSL(symbol, side, slPrice);
            
            this.emit('slSet', tradeId, slPrice);
            logger.info({ 
              tradeId, 
              symbol, 
              strategicSL: slPrice.toFixed(2),
              emergencySL: slLevels.emergencySL.toFixed(2),
              buffer: `${slLevels.bufferPercent}%`,
            }, 'Two-layer stop loss set');
          } catch (error) {
            logger.error({ error, tradeId }, 'Failed to set stop loss');
          }
        }

        // 8. Set TP if specified
        if (params.tpPrice) {
          try {
            await setTakeProfit(symbol, side, params.tpPrice);
            this.emit('tpSet', tradeId, params.tpPrice);
            logger.info({ tradeId, symbol, tpPrice: params.tpPrice }, 'Take profit set');
          } catch (error) {
            logger.error({ error, tradeId }, 'Failed to set take profit');
          }
        } else if (params.tpRR && slPrice) {
          // Calculate TP from RR
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
            } catch (error) {
              logger.error({ error, tradeId }, 'Failed to set TP from RR');
            }
          }
        }
      }, 1000);

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
    strategyState: StrategyState | null
  ): Promise<{ size: number; riskAmountUsdt: number; slPrice: number | null }> {
    
    // Get wallet balance
    const balance = await getWalletBalance();
    const riskAmountUsdt = balance.availableBalance * (riskPercent / 100);

    // Get current price
    const position = this.positionTracker.getPosition(symbol);
    const currentPrice = position?.markPrice ?? strategyState?.snapshot.price ?? 0;

    if (currentPrice === 0) {
      return { size: 0, riskAmountUsdt, slPrice: null };
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

      return { size: finalSize, riskAmountUsdt, slPrice };
    } catch {
      // Fallback: round to 3 decimals
      return { size: Math.floor(size * 1000) / 1000, riskAmountUsdt, slPrice };
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

