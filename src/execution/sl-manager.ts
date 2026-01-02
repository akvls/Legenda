import { EventEmitter } from 'eventemitter3';
import { setStopLoss } from '../bybit/rest-client.js';
import { getStrategyEngine } from '../strategy/engine.js';
import { getPositionTracker } from './position-tracker.js';
import { getTradeExecutor } from './trade-executor.js';
import { getOrderManager } from './order-manager.js';
import { createLogger } from '../utils/logger.js';
import type { TradeSide, StrategyState, TradeContract } from '../types/index.js';

const logger = createLogger('sl-manager');

/**
 * Two-Layer Stop Loss Manager
 * 
 * Layer 1: Emergency SL - Bybit preset at strategic level ± buffer (4% default)
 *          → Protects against flash crashes
 *          → Set directly on Bybit, always active
 * 
 * Layer 2: Strategic SL - Checked on candle close
 *          → Triggers when candle CLOSES below/above level
 *          → Avoids wicks/stop hunts
 */

const DEFAULT_EMERGENCY_BUFFER_PERCENT = 4; // 4% buffer for emergency SL

export interface SLLevels {
  strategicSL: number;      // The actual SL level (swing/supertrend)
  emergencySL: number;      // Bybit preset (strategic ± buffer)
  bufferPercent: number;
}

export interface SLManagerEvents {
  emergencySlSet: (symbol: string, price: number) => void;
  strategicSlTriggered: (symbol: string, closePrice: number, slLevel: number) => void;
  emergencySlTriggered: (symbol: string) => void;
  slLevelsUpdated: (symbol: string, levels: SLLevels) => void;
  error: (error: Error) => void;
}

export class SLManager extends EventEmitter<SLManagerEvents> {
  private slLevels: Map<string, SLLevels> = new Map();
  private strategyEngine = getStrategyEngine();
  private positionTracker = getPositionTracker();
  private bufferPercent: number;

  constructor(bufferPercent: number = DEFAULT_EMERGENCY_BUFFER_PERCENT) {
    super();
    this.bufferPercent = bufferPercent;
    this.setupListeners();
  }

  private setupListeners(): void {
    // Check strategic SL on each candle close
    this.strategyEngine.on('stateUpdate', (state) => {
      this.checkStrategicSL(state);
    });
  }

  /**
   * Set both SL layers for a trade
   */
  async setTwoLayerSL(
    symbol: string,
    side: TradeSide,
    strategicSLPrice: number,
    bufferPercent?: number
  ): Promise<SLLevels> {
    const buffer = bufferPercent ?? this.bufferPercent;
    
    // Calculate emergency SL with buffer
    let emergencySL: number;
    if (side === 'LONG') {
      // For LONG: emergency SL is BELOW strategic (more room)
      emergencySL = strategicSLPrice * (1 - buffer / 100);
    } else {
      // For SHORT: emergency SL is ABOVE strategic (more room)
      emergencySL = strategicSLPrice * (1 + buffer / 100);
    }

    const levels: SLLevels = {
      strategicSL: strategicSLPrice,
      emergencySL,
      bufferPercent: buffer,
    };

    // Store levels
    this.slLevels.set(symbol, levels);

    // Set emergency SL on Bybit
    try {
      await setStopLoss(symbol, side, emergencySL);
      this.emit('emergencySlSet', symbol, emergencySL);
      
      logger.info({
        symbol,
        side,
        strategicSL: strategicSLPrice.toFixed(2),
        emergencySL: emergencySL.toFixed(2),
        buffer: `${buffer}%`,
      }, 'Two-layer SL set');

    } catch (error) {
      logger.error({ error, symbol }, 'Failed to set emergency SL on Bybit');
      this.emit('error', error as Error);
      throw error;
    }

    return levels;
  }

  /**
   * Check if strategic SL was triggered on candle close
   */
  private async checkStrategicSL(state: StrategyState): Promise<void> {
    const symbol = state.symbol;
    const levels = this.slLevels.get(symbol);
    
    if (!levels) return;

    const position = this.positionTracker.getPosition(symbol);
    if (!position) return;

    const executor = getTradeExecutor();
    const trade = executor.getActiveTrade(symbol);
    if (!trade) return;

    const closePrice = state.snapshot.price;
    const { strategicSL } = levels;

    let triggered = false;

    if (trade.side === 'LONG') {
      // LONG: triggered if candle CLOSED below strategic SL
      triggered = closePrice < strategicSL;
    } else {
      // SHORT: triggered if candle CLOSED above strategic SL
      triggered = closePrice > strategicSL;
    }

    if (triggered) {
      this.emit('strategicSlTriggered', symbol, closePrice, strategicSL);
      
      logger.warn({
        symbol,
        side: trade.side,
        closePrice: closePrice.toFixed(2),
        strategicSL: strategicSL.toFixed(2),
      }, '🛑 Strategic SL triggered on candle close');

      // Execute exit
      await this.executeStrategicExit(symbol, trade.side, closePrice, strategicSL);
    }
  }

  /**
   * Execute exit when strategic SL is triggered
   */
  private async executeStrategicExit(
    symbol: string,
    side: TradeSide,
    closePrice: number,
    slLevel: number
  ): Promise<void> {
    try {
      const executor = getTradeExecutor();
      await executor.executeExit(symbol, 'STOP_LOSS');
      
      // Clean up
      this.slLevels.delete(symbol);
      
      logger.info({ symbol, closePrice, slLevel }, 'Strategic SL exit executed');
    } catch (error) {
      logger.error({ error, symbol }, 'Failed to execute strategic SL exit');
      this.emit('error', error as Error);
    }
  }

  /**
   * Update SL levels (e.g., when trailing)
   */
  async updateSLLevels(
    symbol: string,
    side: TradeSide,
    newStrategicSL: number
  ): Promise<SLLevels | null> {
    const currentLevels = this.slLevels.get(symbol);
    if (!currentLevels) return null;

    // Only update if SL moved in our favor
    if (side === 'LONG' && newStrategicSL <= currentLevels.strategicSL) {
      return currentLevels; // Don't move SL down for longs
    }
    if (side === 'SHORT' && newStrategicSL >= currentLevels.strategicSL) {
      return currentLevels; // Don't move SL up for shorts
    }

    // Calculate new emergency SL
    const buffer = currentLevels.bufferPercent;
    let newEmergencySL: number;
    if (side === 'LONG') {
      newEmergencySL = newStrategicSL * (1 - buffer / 100);
    } else {
      newEmergencySL = newStrategicSL * (1 + buffer / 100);
    }

    const newLevels: SLLevels = {
      strategicSL: newStrategicSL,
      emergencySL: newEmergencySL,
      bufferPercent: buffer,
    };

    // Update on Bybit
    try {
      await setStopLoss(symbol, side, newEmergencySL);
      this.slLevels.set(symbol, newLevels);
      this.emit('slLevelsUpdated', symbol, newLevels);
      
      logger.info({
        symbol,
        oldStrategic: currentLevels.strategicSL.toFixed(2),
        newStrategic: newStrategicSL.toFixed(2),
        newEmergency: newEmergencySL.toFixed(2),
      }, 'SL levels updated (trailing)');

    } catch (error) {
      logger.error({ error, symbol }, 'Failed to update emergency SL on Bybit');
    }

    return newLevels;
  }

  /**
   * Get current SL levels for a symbol
   */
  getSLLevels(symbol: string): SLLevels | null {
    return this.slLevels.get(symbol) ?? null;
  }

  /**
   * Remove SL tracking for a symbol (on position close)
   */
  removeSL(symbol: string): void {
    this.slLevels.delete(symbol);
    logger.debug({ symbol }, 'SL tracking removed');
  }

  /**
   * Set buffer percent for emergency SL
   */
  setBufferPercent(percent: number): void {
    this.bufferPercent = percent;
    logger.info({ bufferPercent: percent }, 'Emergency SL buffer updated');
  }

  /**
   * Get buffer percent
   */
  getBufferPercent(): number {
    return this.bufferPercent;
  }
}

// Singleton
let slManagerInstance: SLManager | null = null;

export function getSLManager(): SLManager {
  if (!slManagerInstance) {
    slManagerInstance = new SLManager();
  }
  return slManagerInstance;
}

