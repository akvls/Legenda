import { createLogger } from '../utils/logger.js';
import type { TradeState, TradeSide } from '../types/index.js';

const logger = createLogger('state-machine');

/**
 * State Machine for Trade Management
 * 
 * States:
 * - FLAT: No position, ready to trade
 * - IN_LONG: Currently in a long position
 * - IN_SHORT: Currently in a short position
 * - EXITING: Currently exiting a position (order pending)
 * - LOCK_LONG: Cannot enter long (after stopped out from long)
 * - LOCK_SHORT: Cannot enter short (after stopped out from short)
 * - PAUSED: All trading paused by user
 * 
 * Anti-Rage Logic:
 * When a trade is stopped out, we lock re-entry in that same direction
 * until the opposite direction signal appears, preventing revenge trading.
 */

interface SymbolState {
  state: TradeState;
  side?: TradeSide;
  entryTime?: Date;
  lastStopSide?: TradeSide; // Direction of last stop loss
  lockUntil?: Date; // Optional time-based unlock
}

export class StateMachine {
  private states: Map<string, SymbolState> = new Map();
  private globalPaused: boolean = false;

  constructor() {}

  /**
   * Get current state for a symbol
   */
  getState(symbol: string): SymbolState {
    if (!this.states.has(symbol)) {
      this.states.set(symbol, { state: 'FLAT' });
    }
    return this.states.get(symbol)!;
  }

  /**
   * Check if trading is paused globally
   */
  isPaused(): boolean {
    return this.globalPaused;
  }

  /**
   * Pause all trading
   */
  pause(): void {
    this.globalPaused = true;
    logger.warn('Trading PAUSED globally');
  }

  /**
   * Resume trading
   */
  resume(): void {
    this.globalPaused = false;
    logger.info('Trading RESUMED');
  }

  /**
   * Check if entry is allowed for a direction
   */
  canEnter(symbol: string, side: TradeSide): { allowed: boolean; reason?: string } {
    if (this.globalPaused) {
      return { allowed: false, reason: 'Trading is paused' };
    }

    const symbolState = this.getState(symbol);

    // Check current state
    switch (symbolState.state) {
      case 'IN_LONG':
      case 'IN_SHORT':
        return { allowed: false, reason: `Already in ${symbolState.state}` };

      case 'EXITING':
        return { allowed: false, reason: 'Currently exiting position' };

      case 'LOCK_LONG':
        if (side === 'LONG') {
          return { 
            allowed: false, 
            reason: 'LONG locked after stop loss. Wait for SHORT signal.' 
          };
        }
        break;

      case 'LOCK_SHORT':
        if (side === 'SHORT') {
          return { 
            allowed: false, 
            reason: 'SHORT locked after stop loss. Wait for LONG signal.' 
          };
        }
        break;

      case 'FLAT':
        // All good
        break;
    }

    return { allowed: true };
  }

  /**
   * Transition to IN_LONG or IN_SHORT
   */
  enterPosition(symbol: string, side: TradeSide): void {
    const symbolState = this.getState(symbol);
    
    symbolState.state = side === 'LONG' ? 'IN_LONG' : 'IN_SHORT';
    symbolState.side = side;
    symbolState.entryTime = new Date();
    
    // Clear any lock when entering opposite direction
    if (symbolState.lastStopSide && symbolState.lastStopSide !== side) {
      symbolState.lastStopSide = undefined;
    }

    logger.info({ symbol, side, state: symbolState.state }, 'Entered position');
  }

  /**
   * Transition to EXITING state
   */
  startExiting(symbol: string): void {
    const symbolState = this.getState(symbol);
    symbolState.state = 'EXITING';
    logger.info({ symbol }, 'Started exiting position');
  }

  /**
   * Transition to FLAT after clean exit
   */
  exitClean(symbol: string): void {
    const symbolState = this.getState(symbol);
    symbolState.state = 'FLAT';
    symbolState.side = undefined;
    symbolState.entryTime = undefined;
    logger.info({ symbol }, 'Exited cleanly to FLAT');
  }

  /**
   * Transition after stop loss hit (applies lock)
   */
  exitStopped(symbol: string): void {
    const symbolState = this.getState(symbol);
    const stoppedSide = symbolState.side;

    // Apply anti-rage lock
    if (stoppedSide === 'LONG') {
      symbolState.state = 'LOCK_LONG';
      symbolState.lastStopSide = 'LONG';
      logger.warn({ symbol }, 'Stopped out LONG. Locking LONG entries until SHORT signal.');
    } else if (stoppedSide === 'SHORT') {
      symbolState.state = 'LOCK_SHORT';
      symbolState.lastStopSide = 'SHORT';
      logger.warn({ symbol }, 'Stopped out SHORT. Locking SHORT entries until LONG signal.');
    } else {
      symbolState.state = 'FLAT';
    }

    symbolState.side = undefined;
    symbolState.entryTime = undefined;
  }

  /**
   * Clear lock for a direction (called when opposite signal appears)
   */
  clearLock(symbol: string, signalSide: TradeSide): void {
    const symbolState = this.getState(symbol);

    // Signal in opposite direction clears the lock
    if (symbolState.state === 'LOCK_LONG' && signalSide === 'SHORT') {
      symbolState.state = 'FLAT';
      symbolState.lastStopSide = undefined;
      logger.info({ symbol }, 'LONG lock cleared by SHORT signal');
    } else if (symbolState.state === 'LOCK_SHORT' && signalSide === 'LONG') {
      symbolState.state = 'FLAT';
      symbolState.lastStopSide = undefined;
      logger.info({ symbol }, 'SHORT lock cleared by LONG signal');
    }
  }

  /**
   * Force unlock (admin override)
   */
  forceUnlock(symbol: string): void {
    const symbolState = this.getState(symbol);
    symbolState.state = 'FLAT';
    symbolState.lastStopSide = undefined;
    logger.warn({ symbol }, 'Force unlocked by admin');
  }

  /**
   * Sync state from actual position (for recovery)
   */
  syncFromPosition(symbol: string, side: TradeSide | null): void {
    const symbolState = this.getState(symbol);
    
    if (side === null) {
      // No position - if we were in a trade, don't know if stopped or closed
      if (symbolState.state === 'IN_LONG' || symbolState.state === 'IN_SHORT') {
        // Assume clean exit (user can trigger lock manually if needed)
        symbolState.state = 'FLAT';
        symbolState.side = undefined;
      }
    } else {
      symbolState.state = side === 'LONG' ? 'IN_LONG' : 'IN_SHORT';
      symbolState.side = side;
    }
    
    logger.info({ symbol, state: symbolState.state }, 'State synced from position');
  }

  /**
   * Get all symbol states
   */
  getAllStates(): Map<string, SymbolState> {
    return this.states;
  }

  /**
   * Format state for display
   */
  formatState(symbol: string): string {
    const s = this.getState(symbol);
    let str = `${symbol}: ${s.state}`;
    if (s.side) str += ` (${s.side})`;
    if (s.lastStopSide) str += ` [Last stop: ${s.lastStopSide}]`;
    return str;
  }
}

// Singleton instance
export const stateMachine = new StateMachine();

