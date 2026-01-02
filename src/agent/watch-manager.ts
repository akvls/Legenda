import { EventEmitter } from 'eventemitter3';
import { getStrategyEngine } from '../strategy/engine.js';
import { createLogger } from '../utils/logger.js';
import { v4 as uuidv4 } from 'uuid';
import type { TradeSide, StrategyState, WatchTriggerType, WatchMode } from '../types/index.js';

const logger = createLogger('watch-manager');

/**
 * Watch/Scanner System
 * 
 * Create watches for:
 * - "Wait until price closer to SMA200"
 * - "Wait until price closer to EMA1000"
 * - "Wait until price closer to Supertrend"
 * 
 * Modes:
 * - NOTIFY_ONLY: Just alert when triggered
 * - AUTO_ENTER: Automatically enter trade when triggered (if hard gate passes)
 */

export type { WatchTriggerType, WatchMode };

export interface WatchRule {
  id: string;
  symbol: string;
  intendedSide: TradeSide;
  triggerType: WatchTriggerType;
  thresholdPercent: number;  // e.g., 0.5 = trigger when within 0.5% of target
  targetPrice?: number;      // For PRICE_ABOVE/PRICE_BELOW
  mode: WatchMode;
  expiryTime: number;        // Unix timestamp
  createdAt: number;
  
  // Trade preset (used if AUTO_ENTER)
  preset: {
    riskPercent: number;
    slRule: string;
    trailMode: string;
  };
  
  // Status
  status: 'ACTIVE' | 'TRIGGERED' | 'EXPIRED' | 'CANCELLED';
  triggeredAt?: number;
  triggeredPrice?: number;
}

export interface WatchEvents {
  watchCreated: (watch: WatchRule) => void;
  watchTriggered: (watch: WatchRule, currentPrice: number, targetPrice: number, distance: number) => void;
  watchExpired: (watch: WatchRule) => void;
  watchCancelled: (watch: WatchRule) => void;
}

export class WatchManager extends EventEmitter<WatchEvents> {
  private watches: Map<string, WatchRule> = new Map();
  private strategyEngine = getStrategyEngine();

  constructor() {
    super();
    this.setupListeners();
    logger.info('Watch Manager initialized');
  }

  private setupListeners(): void {
    // Check watches on each candle close
    this.strategyEngine.on('stateUpdate', (state) => {
      this.checkWatches(state);
    });

    // Also run expiry check periodically
    setInterval(() => this.checkExpiredWatches(), 60000); // Every minute
  }

  /**
   * Create a new watch
   */
  createWatch(params: {
    symbol: string;
    intendedSide: TradeSide;
    triggerType: WatchTriggerType;
    thresholdPercent?: number;
    targetPrice?: number;
    mode?: WatchMode;
    expiryMinutes?: number;
    preset?: {
      riskPercent?: number;
      slRule?: string;
      trailMode?: string;
    };
  }): WatchRule {
    const watch: WatchRule = {
      id: uuidv4(),
      symbol: params.symbol,
      intendedSide: params.intendedSide,
      triggerType: params.triggerType,
      thresholdPercent: params.thresholdPercent ?? 0.5, // Default 0.5%
      targetPrice: params.targetPrice,
      mode: params.mode ?? 'NOTIFY_ONLY',
      expiryTime: Date.now() + (params.expiryMinutes ?? 120) * 60 * 1000, // Default 2 hours
      createdAt: Date.now(),
      preset: {
        riskPercent: params.preset?.riskPercent ?? 0.5,
        slRule: params.preset?.slRule ?? 'SWING',
        trailMode: params.preset?.trailMode ?? 'SUPERTREND',
      },
      status: 'ACTIVE',
    };

    this.watches.set(watch.id, watch);
    this.emit('watchCreated', watch);

    logger.info({
      watchId: watch.id,
      symbol: watch.symbol,
      side: watch.intendedSide,
      triggerType: watch.triggerType,
      threshold: `${watch.thresholdPercent}%`,
      mode: watch.mode,
      expiresIn: `${params.expiryMinutes ?? 120} min`,
    }, '👁️ Watch created');

    return watch;
  }

  /**
   * Check all watches against current state
   */
  private checkWatches(state: StrategyState): void {
    const now = Date.now();

    for (const [id, watch] of this.watches) {
      if (watch.status !== 'ACTIVE') continue;
      if (watch.symbol !== state.symbol) continue;

      // Check expiry
      if (now > watch.expiryTime) {
        watch.status = 'EXPIRED';
        this.emit('watchExpired', watch);
        logger.info({ watchId: id }, 'Watch expired');
        continue;
      }

      // Calculate distance to target
      const { triggered, targetPrice, distance } = this.evaluateTrigger(watch, state);

      if (triggered) {
        watch.status = 'TRIGGERED';
        watch.triggeredAt = now;
        watch.triggeredPrice = state.snapshot.price;

        this.emit('watchTriggered', watch, state.snapshot.price, targetPrice, distance);

        logger.info({
          watchId: id,
          symbol: watch.symbol,
          side: watch.intendedSide,
          price: state.snapshot.price.toFixed(2),
          target: targetPrice.toFixed(2),
          distance: `${distance.toFixed(2)}%`,
          mode: watch.mode,
        }, '🎯 WATCH TRIGGERED!');
      }
    }
  }

  /**
   * Evaluate if watch trigger condition is met
   */
  private evaluateTrigger(
    watch: WatchRule,
    state: StrategyState
  ): { triggered: boolean; targetPrice: number; distance: number } {
    const price = state.snapshot.price;
    let targetPrice = 0;
    let distance = 0;

    switch (watch.triggerType) {
      case 'CLOSER_TO_SMA200':
        targetPrice = state.snapshot.sma200;
        distance = Math.abs(state.snapshot.distanceToSma200);
        break;

      case 'CLOSER_TO_EMA1000':
        targetPrice = state.snapshot.ema1000;
        distance = Math.abs(state.snapshot.distanceToEma1000);
        break;

      case 'CLOSER_TO_SUPERTREND':
        targetPrice = state.snapshot.supertrendValue;
        distance = Math.abs(state.snapshot.distanceToSupertrend);
        break;

      case 'PRICE_ABOVE':
        targetPrice = watch.targetPrice ?? 0;
        distance = ((price - targetPrice) / targetPrice) * 100;
        // Triggered if price is above target
        return { triggered: price > targetPrice, targetPrice, distance };

      case 'PRICE_BELOW':
        targetPrice = watch.targetPrice ?? 0;
        distance = ((targetPrice - price) / targetPrice) * 100;
        // Triggered if price is below target
        return { triggered: price < targetPrice, targetPrice, distance };
    }

    // For "closer to" triggers, check if within threshold
    const triggered = distance <= watch.thresholdPercent;

    return { triggered, targetPrice, distance };
  }

  /**
   * Check and expire old watches
   */
  private checkExpiredWatches(): void {
    const now = Date.now();

    for (const [id, watch] of this.watches) {
      if (watch.status === 'ACTIVE' && now > watch.expiryTime) {
        watch.status = 'EXPIRED';
        this.emit('watchExpired', watch);
        logger.info({ watchId: id }, 'Watch expired');
      }
    }
  }

  /**
   * Cancel a watch
   */
  cancelWatch(watchId: string): boolean {
    const watch = this.watches.get(watchId);
    if (!watch || watch.status !== 'ACTIVE') {
      return false;
    }

    watch.status = 'CANCELLED';
    this.emit('watchCancelled', watch);
    logger.info({ watchId }, 'Watch cancelled');

    return true;
  }

  /**
   * Get all active watches
   */
  getActiveWatches(): WatchRule[] {
    return Array.from(this.watches.values()).filter(w => w.status === 'ACTIVE');
  }

  /**
   * Get watches for a symbol
   */
  getWatchesForSymbol(symbol: string): WatchRule[] {
    return Array.from(this.watches.values()).filter(w => w.symbol === symbol);
  }

  /**
   * Get a specific watch
   */
  getWatch(watchId: string): WatchRule | null {
    return this.watches.get(watchId) ?? null;
  }

  /**
   * Get all watches (including inactive)
   */
  getAllWatches(): WatchRule[] {
    return Array.from(this.watches.values());
  }

  /**
   * Clear expired/cancelled watches older than X minutes
   */
  cleanup(olderThanMinutes: number = 60): number {
    const cutoff = Date.now() - olderThanMinutes * 60 * 1000;
    let removed = 0;

    for (const [id, watch] of this.watches) {
      if (
        (watch.status === 'EXPIRED' || watch.status === 'CANCELLED' || watch.status === 'TRIGGERED') &&
        watch.createdAt < cutoff
      ) {
        this.watches.delete(id);
        removed++;
      }
    }

    if (removed > 0) {
      logger.debug({ removed }, 'Cleaned up old watches');
    }

    return removed;
  }

  /**
   * Get current distance to a target for a symbol
   */
  async getCurrentDistance(
    symbol: string,
    triggerType: WatchTriggerType
  ): Promise<{ targetPrice: number; distance: number; price: number } | null> {
    const state = await this.strategyEngine.getState(symbol);
    if (!state) return null;

    const price = state.snapshot.price;
    let targetPrice = 0;
    let distance = 0;

    switch (triggerType) {
      case 'CLOSER_TO_SMA200':
        targetPrice = state.snapshot.sma200;
        distance = state.snapshot.distanceToSma200;
        break;
      case 'CLOSER_TO_EMA1000':
        targetPrice = state.snapshot.ema1000;
        distance = state.snapshot.distanceToEma1000;
        break;
      case 'CLOSER_TO_SUPERTREND':
        targetPrice = state.snapshot.supertrendValue;
        distance = state.snapshot.distanceToSupertrend;
        break;
    }

    return { targetPrice, distance, price };
  }
}

// Singleton
let watchManagerInstance: WatchManager | null = null;

export function getWatchManager(): WatchManager {
  if (!watchManagerInstance) {
    watchManagerInstance = new WatchManager();
  }
  return watchManagerInstance;
}

