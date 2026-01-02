import { EventEmitter } from 'eventemitter3';
import { getStrategyEngine } from '../strategy/engine.js';
import { getPositionTracker } from './position-tracker.js';
import { getTradeExecutor } from './trade-executor.js';
import { createLogger } from '../utils/logger.js';
import type { StrategyState, TradeSide } from '../types/index.js';

const logger = createLogger('invalidation-manager');

/**
 * Invalidation Manager - HARD EXIT on swing break
 * 
 * This cannot be overridden by the user.
 * When swing breaks on candle CLOSE → EXIT IMMEDIATELY
 * 
 * LONG: Exit if candle CLOSES below protected swing low
 * SHORT: Exit if candle CLOSES above protected swing high
 */

export interface InvalidationEvents {
  swingBreak: (symbol: string, side: TradeSide, price: number, swingLevel: number) => void;
  autoExit: (symbol: string, reason: string) => void;
  error: (error: Error) => void;
}

export class InvalidationManager extends EventEmitter<InvalidationEvents> {
  private strategyEngine = getStrategyEngine();
  private positionTracker = getPositionTracker();
  private enabled: boolean = true;

  constructor() {
    super();
    this.setupListeners();
    logger.info('Invalidation Manager initialized - Swing break auto-exit ACTIVE');
  }

  private setupListeners(): void {
    // Check for invalidation on each candle close
    this.strategyEngine.on('stateUpdate', (state) => {
      if (this.enabled) {
        this.checkSwingBreak(state);
      }
    });
  }

  /**
   * Check if swing level is broken - HARD EXIT
   * User CANNOT override this
   */
  private async checkSwingBreak(state: StrategyState): Promise<void> {
    const symbol = state.symbol;
    
    // Get current position
    const position = this.positionTracker.getPosition(symbol);
    if (!position || parseFloat(String(position.size)) === 0) {
      return; // No position to check
    }

    const executor = getTradeExecutor();
    const trade = executor.getActiveTrade(symbol);
    if (!trade) {
      return; // No active trade
    }

    const closePrice = state.snapshot.price;
    const side = trade.side;
    
    // Get protected swing levels from strategy state
    const { protectedSwingLow, protectedSwingHigh } = state.keyLevels;

    let swingBroken = false;
    let brokenLevel: number | null = null;
    let reason = '';

    if (side === 'LONG' && protectedSwingLow !== null) {
      // LONG: Check if candle CLOSED below protected swing low
      if (closePrice < protectedSwingLow) {
        swingBroken = true;
        brokenLevel = protectedSwingLow;
        reason = `SWING_BREAK: Price ${closePrice.toFixed(2)} closed below protected swing low ${protectedSwingLow.toFixed(2)}`;
      }
    } else if (side === 'SHORT' && protectedSwingHigh !== null) {
      // SHORT: Check if candle CLOSED above protected swing high
      if (closePrice > protectedSwingHigh) {
        swingBroken = true;
        brokenLevel = protectedSwingHigh;
        reason = `SWING_BREAK: Price ${closePrice.toFixed(2)} closed above protected swing high ${protectedSwingHigh.toFixed(2)}`;
      }
    }

    if (swingBroken && brokenLevel !== null) {
      logger.warn({
        symbol,
        side,
        closePrice: closePrice.toFixed(2),
        brokenLevel: brokenLevel.toFixed(2),
      }, '🚨 SWING BREAK DETECTED - HARD EXIT (no override)');

      this.emit('swingBreak', symbol, side, closePrice, brokenLevel);

      // Execute IMMEDIATE exit - user cannot prevent this
      await this.executeHardExit(symbol, reason);
    }
  }

  /**
   * Execute hard exit - CANNOT be overridden
   */
  private async executeHardExit(symbol: string, reason: string): Promise<void> {
    try {
      const executor = getTradeExecutor();
      
      // Check if position still exists (might have been closed by SL)
      const position = this.positionTracker.getPosition(symbol);
      if (!position || parseFloat(String(position.size)) === 0) {
        logger.info({ symbol }, 'Position already closed, skipping hard exit');
        return;
      }

      logger.warn({ symbol, reason }, '🔴 EXECUTING HARD EXIT - Swing invalidation');

      // Execute exit with INVALIDATION reason
      const success = await executor.executeExit(symbol, 'INVALIDATION');

      if (success) {
        this.emit('autoExit', symbol, reason);
        logger.info({ symbol, reason }, '✅ Hard exit completed');
      } else {
        logger.error({ symbol }, 'Hard exit failed - position may still be open!');
        
        // Retry once
        await new Promise(resolve => setTimeout(resolve, 1000));
        const retrySuccess = await executor.executeExit(symbol, 'INVALIDATION');
        
        if (retrySuccess) {
          logger.info({ symbol }, 'Hard exit succeeded on retry');
          this.emit('autoExit', symbol, reason);
        } else {
          logger.error({ symbol }, '❌ CRITICAL: Hard exit failed twice - manual intervention needed!');
          this.emit('error', new Error(`Hard exit failed for ${symbol}`));
        }
      }
    } catch (error) {
      logger.error({ error, symbol }, 'Error executing hard exit');
      this.emit('error', error as Error);
    }
  }

  /**
   * Enable/disable invalidation checks
   * Note: This should only be used for maintenance, not to avoid exits
   */
  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    logger.info({ enabled }, 'Invalidation manager enabled state changed');
  }

  /**
   * Check if manager is enabled
   */
  isEnabled(): boolean {
    return this.enabled;
  }
}

// Singleton
let invalidationManagerInstance: InvalidationManager | null = null;

export function getInvalidationManager(): InvalidationManager {
  if (!invalidationManagerInstance) {
    invalidationManagerInstance = new InvalidationManager();
  }
  return invalidationManagerInstance;
}

