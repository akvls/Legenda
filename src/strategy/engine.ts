import { EventEmitter } from 'eventemitter3';
import { prisma } from '../db/index.js';
import { getCandleManager } from '../data/candle-manager.js';
import { createLogger } from '../utils/logger.js';
import {
  getLatestSupertrend,
  detectSupertrendFlip,
  getLatestSMA,
  getLatestEMA,
  analyzeSwings,
  analyzeStructure,
} from './indicators/index.js';
import type {
  Candle,
  Bias,
  StructureBias,
  StrategyState,
  StrategySnapshot,
  KeyLevels,
  StrategyId,
  SymbolConfig,
} from '../types/index.js';

const logger = createLogger('strategy');

/**
 * Strategy Engine
 * Computes StrategyState from candle data
 * This is the SINGLE SOURCE OF TRUTH for trading decisions
 */

export interface StrategyEngineEvents {
  stateUpdate: (state: StrategyState) => void;
  biasFlip: (symbol: string, from: Bias, to: Bias) => void;
  supertrendFlip: (symbol: string, from: Bias, to: Bias) => void;
  error: (error: Error) => void;
}

export class StrategyEngine extends EventEmitter<StrategyEngineEvents> {
  private states: Map<string, StrategyState> = new Map(); // symbol -> state
  private configs: Map<string, SymbolConfig> = new Map();
  private candleManager = getCandleManager();

  constructor() {
    super();
    this.setupCandleListener();
  }

  private setupCandleListener(): void {
    this.candleManager.on('candleClose', async (candle) => {
      await this.onCandleClose(candle);
    });
  }

  /**
   * Handle new candle close
   */
  private async onCandleClose(candle: Candle): Promise<void> {
    const config = this.configs.get(candle.symbol);
    if (!config) return;

    // Only process if this is the configured timeframe
    if (candle.timeframe !== config.timeframe) return;

    try {
      const prevState = this.states.get(candle.symbol);
      const newState = await this.computeState(candle.symbol, config);
      
      if (newState) {
        this.states.set(candle.symbol, newState);
        this.emit('stateUpdate', newState);

        // Check for bias flip
        if (prevState && prevState.bias !== newState.bias) {
          logger.info(
            { symbol: candle.symbol, from: prevState.bias, to: newState.bias },
            'Bias flipped'
          );
          this.emit('biasFlip', candle.symbol, prevState.bias, newState.bias);
        }

        // Check for supertrend flip
        if (prevState && prevState.snapshot.supertrendDir !== newState.snapshot.supertrendDir) {
          logger.info(
            { symbol: candle.symbol, from: prevState.snapshot.supertrendDir, to: newState.snapshot.supertrendDir },
            'Supertrend flipped'
          );
          this.emit('supertrendFlip', candle.symbol, prevState.snapshot.supertrendDir, newState.snapshot.supertrendDir);
        }

        // Save to database
        await this.saveState(newState);
      }
    } catch (error) {
      logger.error({ error, symbol: candle.symbol }, 'Failed to compute strategy state');
      this.emit('error', error as Error);
    }
  }

  /**
   * Register a symbol to track
   */
  async registerSymbol(symbol: string, config?: Partial<SymbolConfig>): Promise<void> {
    // Get or create config from database
    let dbConfig = await prisma.symbolConfig.findUnique({
      where: { symbol },
    });

    if (!dbConfig) {
      dbConfig = await prisma.symbolConfig.create({
        data: {
          symbol,
          timeframe: config?.timeframe ?? '5',
          supertrendPeriod: config?.supertrendPeriod ?? 5,
          supertrendMult: config?.supertrendMultiplier ?? 8.0,
          sma200Period: config?.sma200Period ?? 200,
          ema1000Period: config?.ema1000Period ?? 1000,
          swingLookback: config?.swingLookback ?? 5,
          enabled: true,
        },
      });
    }

    const symbolConfig: SymbolConfig = {
      symbol: dbConfig.symbol,
      timeframe: dbConfig.timeframe,
      supertrendPeriod: dbConfig.supertrendPeriod,
      supertrendMultiplier: dbConfig.supertrendMult,
      sma200Period: dbConfig.sma200Period,
      ema1000Period: dbConfig.ema1000Period,
      swingLookback: dbConfig.swingLookback,
      enabled: dbConfig.enabled,
    };

    this.configs.set(symbol, symbolConfig);

    // Subscribe to candles
    await this.candleManager.subscribe(symbol, symbolConfig.timeframe);

    // Compute initial state
    const state = await this.computeState(symbol, symbolConfig);
    if (state) {
      this.states.set(symbol, state);
      await this.saveState(state);
      // Emit stateUpdate so frontend-ws can subscribe to ticker
      this.emit('stateUpdate', state);
    }

    logger.info({ symbol, config: symbolConfig }, 'Symbol registered with strategy engine');
  }

  /**
   * Compute StrategyState for a symbol
   */
  async computeState(symbol: string, config: SymbolConfig): Promise<StrategyState | null> {
    // Get candles from manager
    const candles = this.candleManager.getCandles(symbol, config.timeframe, 1200);
    
    if (candles.length < config.ema1000Period) {
      logger.warn(
        { symbol, candles: candles.length, required: config.ema1000Period },
        'Not enough candles for strategy computation'
      );
      return null;
    }

    const lastCandle = candles[candles.length - 1];

    // 1. Calculate Supertrend
    const supertrend = getLatestSupertrend(
      candles,
      config.supertrendPeriod,
      config.supertrendMultiplier
    );
    if (!supertrend) {
      logger.warn({ symbol }, 'Failed to calculate supertrend');
      return null;
    }

    // 2. Calculate Moving Averages
    const sma200 = getLatestSMA(candles, config.sma200Period);
    const ema1000 = getLatestEMA(candles, config.ema1000Period);
    
    if (!sma200 || !ema1000) {
      logger.warn({ symbol }, 'Failed to calculate moving averages');
      return null;
    }

    // 3. Analyze Structure
    const swingAnalysis = analyzeSwings(candles, config.swingLookback);
    const structureAnalysis = analyzeStructure(candles, config.swingLookback);

    // 4. Determine strategy ID and permissions
    const { strategyId, allowLongEntry, allowShortEntry } = this.evaluateStrategies(
      supertrend.direction,
      sma200,
      ema1000,
      structureAnalysis.bias
    );

    // 5. Determine overall bias (Supertrend is king)
    const bias: Bias = supertrend.direction;

    // 6. Calculate distance percentages
    const price = lastCandle.close;
    const calcDistance = (target: number) => ((price - target) / target) * 100;
    
    const distanceToSupertrend = calcDistance(supertrend.value);
    const distanceToSma200 = calcDistance(sma200.value);
    const distanceToEma1000 = calcDistance(ema1000.value);
    const distanceToSwingHigh = swingAnalysis.lastSwingHigh 
      ? calcDistance(swingAnalysis.lastSwingHigh.price) 
      : null;
    const distanceToSwingLow = swingAnalysis.lastSwingLow 
      ? calcDistance(swingAnalysis.lastSwingLow.price) 
      : null;

    // Distance to protected level
    const distanceToProtectedLevel = structureAnalysis.protectedLevel 
      ? calcDistance(structureAnalysis.protectedLevel) 
      : null;

    // 7. Build snapshot (includes all data for journaling/LLM analysis)
    const snapshot: StrategySnapshot = {
      supertrendDir: supertrend.direction,
      supertrendValue: supertrend.value,
      sma200: sma200.value,
      ema1000: ema1000.value,
      closeAboveSma200: sma200.priceAbove,
      closeBelowSma200: sma200.priceBelow,
      closeAboveEma1000: ema1000.priceAbove,
      closeBelowEma1000: ema1000.priceBelow,
      structureBias: structureAnalysis.bias,
      price,
      // Distance from price to indicators (%)
      distanceToSupertrend: Math.round(distanceToSupertrend * 100) / 100,
      distanceToSma200: Math.round(distanceToSma200 * 100) / 100,
      distanceToEma1000: Math.round(distanceToEma1000 * 100) / 100,
      distanceToSwingHigh: distanceToSwingHigh !== null ? Math.round(distanceToSwingHigh * 100) / 100 : null,
      distanceToSwingLow: distanceToSwingLow !== null ? Math.round(distanceToSwingLow * 100) / 100 : null,
      // Market Structure (for journaling/LLM)
      currentTrend: structureAnalysis.currentTrend,
      lastBOS: structureAnalysis.lastBOS,
      lastCHoCH: structureAnalysis.lastCHoCH,
      protectedLevel: structureAnalysis.protectedLevel,
      distanceToProtectedLevel: distanceToProtectedLevel !== null ? Math.round(distanceToProtectedLevel * 100) / 100 : null,
    };

    // 8. Build key levels
    const keyLevels: KeyLevels = {
      protectedSwingLow: swingAnalysis.lastSwingLow?.price ?? null,
      protectedSwingHigh: swingAnalysis.lastSwingHigh?.price ?? null,
      lastSwingLow: swingAnalysis.lastSwingLow?.price ?? null,
      lastSwingHigh: swingAnalysis.lastSwingHigh?.price ?? null,
    };

    // 8. Build final state
    const state: StrategyState = {
      symbol,
      timeframe: config.timeframe,
      timestamp: Date.now(),
      candleCloseTime: lastCandle.closeTime,
      bias,
      allowLongEntry,
      allowShortEntry,
      strategyId,
      keyLevels,
      snapshot,
    };

    return state;
  }

  /**
   * Evaluate which strategy conditions are met
   * Returns the best matching strategy ID
   * 
   * NOTE: Structure is NOT used for blocking - it's advisory only (shown in UI, used by LLM)
   * Only Supertrend + MAs determine entry permission
   */
  private evaluateStrategies(
    stDir: Bias,
    sma200: { priceAbove: boolean; priceBelow: boolean },
    ema1000: { priceAbove: boolean; priceBelow: boolean },
    _structureBias: StructureBias // Kept for logging but NOT used for blocking
  ): { strategyId: StrategyId | null; allowLongEntry: boolean; allowShortEntry: boolean } {
    
    // HARD RULE: Supertrend determines allowed direction
    // If ST is LONG → only longs allowed
    // If ST is SHORT → only shorts allowed
    // If ST is NEUTRAL → nothing allowed
    
    if (stDir === 'NEUTRAL') {
      return { strategyId: null, allowLongEntry: false, allowShortEntry: false };
    }

    let allowLongEntry = stDir === 'LONG';
    let allowShortEntry = stDir === 'SHORT';

    // Evaluate strategies in priority order (101 > 102 > 103)
    // Structure is ADVISORY ONLY - not used for blocking
    let strategyId: StrategyId | null = null;

    // Strategy 101: ST + SMA200 aligned (Best quality)
    if (stDir === 'LONG' && sma200.priceAbove) {
      strategyId = 'S101';
    } else if (stDir === 'SHORT' && sma200.priceBelow) {
      strategyId = 'S101';
    }
    
    // Strategy 102: ST + EMA1000 aligned (Good quality)
    if (!strategyId) {
      if (stDir === 'LONG' && ema1000.priceAbove) {
        strategyId = 'S102';
      } else if (stDir === 'SHORT' && ema1000.priceBelow) {
        strategyId = 'S102';
      }
    }

    // Strategy 103: ST-only (Aggressive - MAs not aligned)
    if (!strategyId) {
      strategyId = 'S103';
    }

    return { strategyId, allowLongEntry, allowShortEntry };
  }

  /**
   * Save state to database
   */
  private async saveState(state: StrategyState): Promise<void> {
    try {
      await prisma.strategyState.create({
        data: {
          symbol: state.symbol,
          timeframe: state.timeframe,
          timestamp: new Date(state.timestamp),
          candleCloseTime: new Date(state.candleCloseTime),
          bias: state.bias,
          allowLongEntry: state.allowLongEntry,
          allowShortEntry: state.allowShortEntry,
          strategyId: state.strategyId,
          supertrendDir: state.snapshot.supertrendDir,
          supertrendValue: state.snapshot.supertrendValue,
          sma200Value: state.snapshot.sma200,
          ema1000Value: state.snapshot.ema1000,
          closeAboveSma200: state.snapshot.closeAboveSma200,
          closeBelowSma200: state.snapshot.closeBelowSma200,
          closeAboveEma1000: state.snapshot.closeAboveEma1000,
          closeBelowEma1000: state.snapshot.closeBelowEma1000,
          structureBias: state.snapshot.structureBias,
          protectedSwingLow: state.keyLevels.protectedSwingLow,
          protectedSwingHigh: state.keyLevels.protectedSwingHigh,
          lastSwingLow: state.keyLevels.lastSwingLow,
          lastSwingHigh: state.keyLevels.lastSwingHigh,
          closePrice: state.snapshot.price,
        },
      });
    } catch (error) {
      logger.error({ error, symbol: state.symbol }, 'Failed to save strategy state');
    }
  }

  /**
   * Get current state for a symbol
   */
  getState(symbol: string): StrategyState | null {
    return this.states.get(symbol) ?? null;
  }

  /**
   * Get all current states
   */
  getAllStates(): StrategyState[] {
    return Array.from(this.states.values());
  }

  /**
   * Force recompute state for a symbol
   */
  async recomputeState(symbol: string): Promise<StrategyState | null> {
    const config = this.configs.get(symbol);
    if (!config) {
      logger.warn({ symbol }, 'Cannot recompute - symbol not registered');
      return null;
    }

    const state = await this.computeState(symbol, config);
    if (state) {
      this.states.set(symbol, state);
      await this.saveState(state);
      this.emit('stateUpdate', state);
    }

    return state;
  }

  /**
   * Check if entry is allowed
   */
  isEntryAllowed(symbol: string, side: 'LONG' | 'SHORT'): { allowed: boolean; reason?: string } {
    const state = this.states.get(symbol);
    
    if (!state) {
      return { allowed: false, reason: 'No strategy state available' };
    }

    if (side === 'LONG') {
      if (!state.allowLongEntry) {
        return { 
          allowed: false, 
          reason: `LONG blocked: Supertrend is ${state.snapshot.supertrendDir}, structure is ${state.snapshot.structureBias}` 
        };
      }
    } else {
      if (!state.allowShortEntry) {
        return { 
          allowed: false, 
          reason: `SHORT blocked: Supertrend is ${state.snapshot.supertrendDir}, structure is ${state.snapshot.structureBias}` 
        };
      }
    }

    return { allowed: true };
  }

  /**
   * Get risk warning for strategy
   */
  getRiskWarning(symbol: string): { isRisky: boolean; message?: string } {
    const state = this.states.get(symbol);
    
    if (!state) {
      return { isRisky: true, message: 'No strategy state' };
    }

    if (state.strategyId === 'S103') {
      return {
        isRisky: true,
        message: 'RISKY: ST-only entry (103). Consider reduced position size.',
      };
    }

    return { isRisky: false };
  }
}

// Singleton
let engineInstance: StrategyEngine | null = null;

export function getStrategyEngine(): StrategyEngine {
  if (!engineInstance) {
    engineInstance = new StrategyEngine();
  }
  return engineInstance;
}

// Singleton reference for easy import
export const strategyEngine = getStrategyEngine();

