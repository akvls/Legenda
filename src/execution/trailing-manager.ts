import { EventEmitter } from 'eventemitter3';
import { getStrategyEngine } from '../strategy/engine.js';
import { getPositionTracker, TrackedPosition } from './position-tracker.js';
import { getTradeExecutor } from './trade-executor.js';
import { getSLManager } from './sl-manager.js';
import { createLogger } from '../utils/logger.js';
import type { TradeSide, TrailMode, StrategyState, TradeContract } from '../types/index.js';

const logger = createLogger('trailing');

/**
 * Trailing SL Manager
 * Updates stop loss on each candle close based on trail mode
 */

export interface TrailingManagerEvents {
  slTrailed: (symbol: string, oldSl: number, newSl: number) => void;
  trailActivated: (symbol: string, mode: TrailMode) => void;
  error: (error: Error) => void;
}

export class TrailingManager extends EventEmitter<TrailingManagerEvents> {
  private strategyEngine = getStrategyEngine();
  private positionTracker = getPositionTracker();

  constructor() {
    super();
    this.setupListeners();
  }

  private setupListeners(): void {
    // Listen for strategy state updates (candle close)
    this.strategyEngine.on('stateUpdate', (state) => {
      this.onStrategyUpdate(state);
    });
  }

  /**
   * Called on each candle close / strategy update
   */
  private async onStrategyUpdate(state: StrategyState): Promise<void> {
    const symbol = state.symbol;
    
    // Check if we have a position in this symbol
    const position = this.positionTracker.getPosition(symbol);
    if (!position) return;

    // Get the active trade contract
    const executor = getTradeExecutor();
    const trade = executor.getActiveTrade(symbol);
    if (!trade) return;

    // Check if trailing is active
    if (trade.trail.mode === 'NONE' || !trade.trail.active) return;

    // Calculate new SL based on trail mode
    const newSl = this.calculateTrailingSL(trade, state, position);
    if (!newSl) return;

    // Only update if SL moved in our favor
    const currentSl = trade.sl.price;
    const shouldUpdate = this.shouldUpdateSL(trade.side, currentSl, newSl);

    if (shouldUpdate) {
      try {
        // Update both layers via SL Manager
        const slManager = getSLManager();
        const updatedLevels = await slManager.updateSLLevels(symbol, trade.side, newSl);
        
        if (updatedLevels) {
          const oldSl = trade.sl.price;
          trade.sl.price = newSl;
          
          this.emit('slTrailed', symbol, oldSl ?? 0, newSl);
          logger.info(
            { 
              symbol, 
              side: trade.side, 
              oldSl, 
              newStrategicSL: newSl,
              newEmergencySL: updatedLevels.emergencySL,
              mode: trade.trail.mode 
            },
            'Trailing SL updated (both layers)'
          );
        }
      } catch (error) {
        logger.error({ error, symbol }, 'Failed to update trailing SL');
        this.emit('error', error as Error);
      }
    }
  }

  /**
   * Calculate new SL based on trail mode
   */
  private calculateTrailingSL(
    trade: TradeContract,
    state: StrategyState,
    position: TrackedPosition
  ): number | null {
    const { side } = trade;

    switch (trade.trail.mode) {
      case 'SUPERTREND':
        // Trail with Supertrend value
        return state.snapshot.supertrendValue;

      case 'STRUCTURE':
        // Trail with swing levels
        if (side === 'LONG') {
          return state.keyLevels.protectedSwingLow;
        } else {
          return state.keyLevels.protectedSwingHigh;
        }

      default:
        return null;
    }
  }

  /**
   * Check if SL should be updated (only moves in our favor)
   */
  private shouldUpdateSL(
    side: TradeSide,
    currentSl: number | null,
    newSl: number
  ): boolean {
    if (!currentSl) return true; // No SL set yet

    if (side === 'LONG') {
      // For LONG: SL should only move UP (higher)
      return newSl > currentSl;
    } else {
      // For SHORT: SL should only move DOWN (lower)
      return newSl < currentSl;
    }
  }

  /**
   * Activate trailing for a trade
   */
  activateTrailing(symbol: string): boolean {
    const executor = getTradeExecutor();
    const trade = executor.getActiveTrade(symbol);
    
    if (!trade) {
      logger.warn({ symbol }, 'No trade found to activate trailing');
      return false;
    }

    if (trade.trail.mode === 'NONE') {
      logger.warn({ symbol }, 'Trail mode is NONE, cannot activate');
      return false;
    }

    trade.trail.active = true;
    this.emit('trailActivated', symbol, trade.trail.mode);
    logger.info({ symbol, mode: trade.trail.mode }, 'Trailing activated');
    
    return true;
  }

  /**
   * Deactivate trailing for a trade
   */
  deactivateTrailing(symbol: string): void {
    const executor = getTradeExecutor();
    const trade = executor.getActiveTrade(symbol);
    
    if (trade) {
      trade.trail.active = false;
      logger.info({ symbol }, 'Trailing deactivated');
    }
  }

  /**
   * Check breakeven trigger and auto-activate trailing
   * Common pattern: activate trailing once price hits +1R
   */
  checkBreakevenActivation(symbol: string, rrThreshold: number = 1): boolean {
    const executor = getTradeExecutor();
    const trade = executor.getActiveTrade(symbol);
    const position = this.positionTracker.getPosition(symbol);

    if (!trade || !position || !trade.sl.price) return false;

    const entryPrice = position.avgPrice;
    const currentPrice = position.markPrice;
    const slDistance = Math.abs(entryPrice - trade.sl.price);
    
    // Calculate current R
    let currentR: number;
    if (trade.side === 'LONG') {
      currentR = (currentPrice - entryPrice) / slDistance;
    } else {
      currentR = (entryPrice - currentPrice) / slDistance;
    }

    // Activate trailing if threshold reached
    if (currentR >= rrThreshold && !trade.trail.active) {
      this.activateTrailing(symbol);
      return true;
    }

    return false;
  }
}

// Singleton
let trailingInstance: TrailingManager | null = null;

export function getTrailingManager(): TrailingManager {
  if (!trailingInstance) {
    trailingInstance = new TrailingManager();
  }
  return trailingInstance;
}

// Singleton reference for easy import
export const trailingManager = getTrailingManager();

