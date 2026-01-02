import { createLogger } from '../utils/logger.js';
import { prisma } from '../db/index.js';
import { getWalletBalance } from '../bybit/rest-client.js';

const logger = createLogger('circuit-breaker');

/**
 * Circuit Breaker - Risk Protection
 * 
 * Prevents trading after significant losses to stop revenge trading.
 * 
 * Rules:
 * - If 70% of budget lost in 24 hours → Block trading for 24 hours
 * - Manual override available for emergencies
 */

interface CircuitBreakerState {
  isTripped: boolean;
  trippedAt: number | null;
  trippedReason: string | null;
  unlockAt: number | null;
  dailyStartBalance: number;
  dailyStartTime: number;
  totalLossToday: number;
  lossPercent: number;
}

const LOSS_THRESHOLD_PERCENT = 50; // 50% loss triggers lockout
const LOCKOUT_DURATION_MS = 24 * 60 * 60 * 1000; // 24 hours
const DAY_MS = 24 * 60 * 60 * 1000;

class CircuitBreaker {
  private state: CircuitBreakerState = {
    isTripped: false,
    trippedAt: null,
    trippedReason: null,
    unlockAt: null,
    dailyStartBalance: 0,
    dailyStartTime: Date.now(),
    totalLossToday: 0,
    lossPercent: 0,
  };

  private manualOverride: boolean = false;

  constructor() {
    this.initialize();
  }

  private async initialize(): Promise<void> {
    try {
      // Get current balance as starting point
      const wallet = await getWalletBalance();
      this.state.dailyStartBalance = wallet.totalEquity;
      this.state.dailyStartTime = Date.now();
      logger.info({ startBalance: wallet.totalEquity }, 'Circuit breaker initialized');
    } catch (error) {
      logger.warn({ error }, 'Failed to get initial balance, will retry on first trade');
    }
  }

  /**
   * Check if trading is allowed
   */
  canTrade(): { allowed: boolean; reason?: string; unlockIn?: string } {
    // Check if manually overridden
    if (this.manualOverride) {
      return { allowed: true };
    }

    // Check if circuit breaker is tripped
    if (this.state.isTripped) {
      const now = Date.now();
      
      // Check if lockout has expired
      if (this.state.unlockAt && now >= this.state.unlockAt) {
        this.reset();
        return { allowed: true };
      }

      // Still locked out
      const remainingMs = (this.state.unlockAt || 0) - now;
      const remainingHours = Math.ceil(remainingMs / (60 * 60 * 1000));
      
      return {
        allowed: false,
        reason: `🛑 CIRCUIT BREAKER: ${this.state.trippedReason}`,
        unlockIn: `${remainingHours} hours`,
      };
    }

    return { allowed: true };
  }

  /**
   * Record a trade result (P&L)
   */
  async recordPnL(pnl: number): Promise<void> {
    const now = Date.now();

    // Check if we need to reset daily tracking
    if (now - this.state.dailyStartTime >= DAY_MS) {
      await this.resetDailyTracking();
    }

    // Ensure we have a starting balance
    if (this.state.dailyStartBalance <= 0) {
      try {
        const wallet = await getWalletBalance();
        this.state.dailyStartBalance = wallet.totalEquity - pnl; // Adjust for this trade
        this.state.dailyStartTime = now;
      } catch {
        logger.warn('Could not get balance for circuit breaker');
        return;
      }
    }

    // Track losses (only negative P&L)
    if (pnl < 0) {
      this.state.totalLossToday += Math.abs(pnl);
    }

    // Calculate loss percentage
    if (this.state.dailyStartBalance > 0) {
      this.state.lossPercent = (this.state.totalLossToday / this.state.dailyStartBalance) * 100;
    }

    logger.info({
      pnl,
      totalLossToday: this.state.totalLossToday,
      lossPercent: this.state.lossPercent.toFixed(2),
      threshold: LOSS_THRESHOLD_PERCENT,
    }, 'P&L recorded');

    // Check if we need to trip the circuit breaker
    if (this.state.lossPercent >= LOSS_THRESHOLD_PERCENT) {
      this.trip(`Lost ${this.state.lossPercent.toFixed(1)}% of daily balance`);
    }
  }

  /**
   * Trip the circuit breaker
   */
  private trip(reason: string): void {
    const now = Date.now();
    
    this.state.isTripped = true;
    this.state.trippedAt = now;
    this.state.trippedReason = reason;
    this.state.unlockAt = now + LOCKOUT_DURATION_MS;

    logger.warn({
      reason,
      unlockAt: new Date(this.state.unlockAt).toISOString(),
      lossPercent: this.state.lossPercent.toFixed(2),
    }, '🛑 CIRCUIT BREAKER TRIPPED - Trading blocked for 24 hours');
  }

  /**
   * Reset the circuit breaker
   */
  reset(): void {
    this.state.isTripped = false;
    this.state.trippedAt = null;
    this.state.trippedReason = null;
    this.state.unlockAt = null;
    this.manualOverride = false;
    
    logger.info('Circuit breaker reset');
  }

  /**
   * Reset daily tracking
   */
  private async resetDailyTracking(): Promise<void> {
    try {
      const wallet = await getWalletBalance();
      this.state.dailyStartBalance = wallet.totalEquity;
      this.state.dailyStartTime = Date.now();
      this.state.totalLossToday = 0;
      this.state.lossPercent = 0;
      
      logger.info({ newDayBalance: wallet.totalEquity }, 'Daily tracking reset');
    } catch (error) {
      logger.warn({ error }, 'Failed to reset daily tracking');
    }
  }

  /**
   * Manual override (emergency access)
   */
  override(): void {
    this.manualOverride = true;
    logger.warn('⚠️ Circuit breaker manually overridden - USE WITH CAUTION');
  }

  /**
   * Get current state
   */
  getState(): CircuitBreakerState & { manualOverride: boolean } {
    return {
      ...this.state,
      manualOverride: this.manualOverride,
    };
  }

  /**
   * Get status for display
   */
  getStatus(): {
    isTripped: boolean;
    lossPercent: number;
    threshold: number;
    unlockIn?: string;
    message: string;
  } {
    const canTradeResult = this.canTrade();
    
    return {
      isTripped: this.state.isTripped,
      lossPercent: Math.round(this.state.lossPercent * 10) / 10,
      threshold: LOSS_THRESHOLD_PERCENT,
      unlockIn: canTradeResult.unlockIn,
      message: this.state.isTripped
        ? `🛑 Locked: ${this.state.trippedReason}. Unlocks in ${canTradeResult.unlockIn}`
        : `✅ Trading allowed. Daily loss: ${this.state.lossPercent.toFixed(1)}% / ${LOSS_THRESHOLD_PERCENT}%`,
    };
  }
}

// Singleton
export const circuitBreaker = new CircuitBreaker();

