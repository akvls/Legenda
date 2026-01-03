/**
 * Event Logger Service
 * Records all trading events to database for audit trail
 */

import { prisma } from '../db/index.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('event-logger');

// Event types
export type EventType =
  // Entry events
  | 'ENTRY_REQUESTED'
  | 'ENTRY_BLOCKED_DIRECTION'
  | 'ENTRY_BLOCKED_LEVERAGE'
  | 'ENTRY_BLOCKED_CIRCUIT_BREAKER'
  | 'ENTRY_BLOCKED_PAUSED'
  | 'ENTRY_BLOCKED_LOCKED'
  | 'ENTRY_PLACED'
  | 'ENTRY_FILLED'
  // Exit events
  | 'EXIT_REQUESTED'
  | 'EXIT_STOP_LOSS'
  | 'EXIT_TAKE_PROFIT'
  | 'EXIT_TRAIL_STOP'
  | 'EXIT_SWING_BREAK'
  | 'EXIT_BIAS_FLIP'
  | 'EXIT_MANUAL'
  | 'EXIT_EMERGENCY'
  | 'EXIT_FILLED'
  // Order events
  | 'ORDER_PLACED'
  | 'ORDER_FILLED'
  | 'ORDER_CANCELLED'
  | 'ORDER_ERROR'
  // SL/TP events
  | 'SL_SET'
  | 'SL_MOVED'
  | 'SL_MOVED_BREAKEVEN'
  | 'TP_SET'
  | 'TRAIL_ACTIVATED'
  | 'TRAIL_UPDATED'
  // Watch events
  | 'WATCH_CREATED'
  | 'WATCH_TRIGGERED'
  | 'WATCH_EXPIRED'
  | 'WATCH_CANCELLED'
  // Strategy events
  | 'STRATEGY_BIAS_FLIP'
  | 'STRATEGY_DIRECTION_CHANGE'
  | 'STRUCTURE_BOS'
  | 'STRUCTURE_CHOCH'
  // System events
  | 'LEVERAGE_SET'
  | 'LEVERAGE_CLAMPED'
  | 'CIRCUIT_BREAKER_TRIPPED'
  | 'CIRCUIT_BREAKER_RESET'
  | 'SYSTEM_PAUSED'
  | 'SYSTEM_RESUMED'
  | 'AI_OPINION_GENERATED'
  | 'POSITION_SYNC';

export interface EventPayload {
  // Common
  price?: number;
  size?: number;
  side?: 'LONG' | 'SHORT';
  leverage?: number;
  
  // Entry/Exit
  entryPrice?: number;
  exitPrice?: number;
  pnl?: number;
  rMultiple?: number;
  reason?: string;
  
  // SL/TP
  slPrice?: number;
  tpPrice?: number;
  slRule?: string;
  
  // Strategy
  bias?: string;
  previousBias?: string;
  supertrendDir?: string;
  structureBias?: string;
  
  // Watch
  watchId?: string;
  triggerType?: string;
  threshold?: number;
  
  // AI
  aiRecommendation?: string;
  aiConfidence?: number;
  
  // Error
  errorCode?: string;
  errorMessage?: string;
  
  // Any additional data
  [key: string]: any;
}

/**
 * Log an event to the database
 */
export async function logEvent(
  eventType: EventType,
  options: {
    symbol?: string;
    tradeId?: string;
    payload?: EventPayload;
    message?: string;
  } = {}
): Promise<void> {
  try {
    await prisma.event.create({
      data: {
        symbol: options.symbol,
        tradeId: options.tradeId,
        eventType,
        payload: options.payload ? JSON.stringify(options.payload) : null,
        message: options.message,
      },
    });

    logger.debug({ eventType, symbol: options.symbol, message: options.message }, 'Event logged');
  } catch (error) {
    logger.error({ error, eventType }, 'Failed to log event');
  }
}

/**
 * Log entry request
 */
export async function logEntryRequested(
  symbol: string,
  side: 'LONG' | 'SHORT',
  payload: EventPayload
): Promise<void> {
  await logEvent('ENTRY_REQUESTED', {
    symbol,
    payload: { ...payload, side },
    message: `Entry ${side} requested for ${symbol}`,
  });
}

/**
 * Log entry blocked
 */
export async function logEntryBlocked(
  symbol: string,
  side: 'LONG' | 'SHORT',
  reason: 'DIRECTION' | 'LEVERAGE' | 'CIRCUIT_BREAKER' | 'PAUSED' | 'LOCKED',
  details?: string
): Promise<void> {
  const eventType: EventType = `ENTRY_BLOCKED_${reason}` as EventType;
  await logEvent(eventType, {
    symbol,
    payload: { side, reason: details },
    message: `${side} entry blocked: ${details || reason}`,
  });
}

/**
 * Log entry placed/filled
 */
export async function logEntryPlaced(
  symbol: string,
  tradeId: string,
  side: 'LONG' | 'SHORT',
  payload: EventPayload
): Promise<void> {
  await logEvent('ENTRY_PLACED', {
    symbol,
    tradeId,
    payload: { ...payload, side },
    message: `${side} entry placed at $${payload.price?.toFixed(2)}`,
  });
}

/**
 * Log exit
 */
export async function logExit(
  symbol: string,
  tradeId: string,
  reason: string,
  payload: EventPayload
): Promise<void> {
  let eventType: EventType = 'EXIT_MANUAL';
  
  if (reason.includes('STOP_LOSS')) eventType = 'EXIT_STOP_LOSS';
  else if (reason.includes('TAKE_PROFIT')) eventType = 'EXIT_TAKE_PROFIT';
  else if (reason.includes('TRAIL')) eventType = 'EXIT_TRAIL_STOP';
  else if (reason.includes('SWING_BREAK')) eventType = 'EXIT_SWING_BREAK';
  else if (reason.includes('BIAS_FLIP') || reason.includes('INVALIDATION')) eventType = 'EXIT_BIAS_FLIP';
  else if (reason.includes('EMERGENCY')) eventType = 'EXIT_EMERGENCY';
  
  await logEvent(eventType, {
    symbol,
    tradeId,
    payload: { ...payload, reason },
    message: `Exit via ${reason}: PnL $${payload.pnl?.toFixed(2) || '?'}`,
  });
}

/**
 * Log SL set/moved
 */
export async function logSlEvent(
  symbol: string,
  tradeId: string,
  type: 'SET' | 'MOVED' | 'BREAKEVEN',
  slPrice: number,
  slRule?: string
): Promise<void> {
  const eventType: EventType = type === 'SET' ? 'SL_SET' : type === 'BREAKEVEN' ? 'SL_MOVED_BREAKEVEN' : 'SL_MOVED';
  await logEvent(eventType, {
    symbol,
    tradeId,
    payload: { slPrice, slRule },
    message: `SL ${type.toLowerCase()} at $${slPrice.toFixed(2)}`,
  });
}

/**
 * Log watch events
 */
export async function logWatchEvent(
  type: 'CREATED' | 'TRIGGERED' | 'EXPIRED' | 'CANCELLED',
  symbol: string,
  watchId: string,
  payload?: EventPayload
): Promise<void> {
  const eventType: EventType = `WATCH_${type}` as EventType;
  await logEvent(eventType, {
    symbol,
    payload: { ...payload, watchId },
    message: `Watch ${type.toLowerCase()} for ${symbol}`,
  });
}

/**
 * Log strategy bias flip
 */
export async function logBiasFlip(
  symbol: string,
  previousBias: string,
  newBias: string,
  payload?: EventPayload
): Promise<void> {
  await logEvent('STRATEGY_BIAS_FLIP', {
    symbol,
    payload: { ...payload, previousBias, bias: newBias },
    message: `Bias flipped: ${previousBias} → ${newBias}`,
  });
}

/**
 * Log leverage clamped
 */
export async function logLeverageClamped(
  symbol: string,
  requested: number,
  applied: number
): Promise<void> {
  await logEvent('LEVERAGE_CLAMPED', {
    symbol,
    payload: { requested, applied },
    message: `Leverage clamped: ${requested}x → ${applied}x`,
  });
}

/**
 * Log circuit breaker
 */
export async function logCircuitBreaker(
  tripped: boolean,
  lossPercent: number
): Promise<void> {
  await logEvent(tripped ? 'CIRCUIT_BREAKER_TRIPPED' : 'CIRCUIT_BREAKER_RESET', {
    payload: { tripped, lossPercent },
    message: tripped ? `Circuit breaker TRIPPED at ${lossPercent.toFixed(1)}% loss` : 'Circuit breaker reset',
  });
}

/**
 * Log AI opinion
 */
export async function logAiOpinion(
  symbol: string,
  recommendation: string,
  confidence: number,
  tradeId?: string
): Promise<void> {
  await logEvent('AI_OPINION_GENERATED', {
    symbol,
    tradeId,
    payload: { aiRecommendation: recommendation, aiConfidence: confidence },
    message: `AI: ${recommendation} (${confidence}/10 confidence)`,
  });
}

export default {
  logEvent,
  logEntryRequested,
  logEntryBlocked,
  logEntryPlaced,
  logExit,
  logSlEvent,
  logWatchEvent,
  logBiasFlip,
  logLeverageClamped,
  logCircuitBreaker,
  logAiOpinion,
};



