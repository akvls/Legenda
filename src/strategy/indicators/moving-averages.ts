import type { Candle } from '../../types/index.js';

/**
 * Moving Average Indicators
 * - SMA (Simple Moving Average)
 * - EMA (Exponential Moving Average)
 */

export interface MAResult {
  value: number;
  priceAbove: boolean;
  priceBelow: boolean;
  distance: number;      // Distance from price to MA (absolute)
  distancePercent: number; // Distance as percentage
}

/**
 * Calculate Simple Moving Average (SMA)
 * Uses closing prices
 */
export function calcSMA(candles: Candle[], period: number): number[] {
  if (candles.length < period) {
    return [];
  }

  const smaValues: number[] = [];
  
  for (let i = period - 1; i < candles.length; i++) {
    let sum = 0;
    for (let j = 0; j < period; j++) {
      sum += candles[i - j].close;
    }
    smaValues.push(sum / period);
  }

  return smaValues;
}

/**
 * Calculate Exponential Moving Average (EMA)
 * Uses SMA-seeded initialization (common for longer periods)
 * First EMA = SMA of first `period` candles, then EMA formula continues
 */
export function calcEMA(candles: Candle[], period: number): number[] {
  if (candles.length < period) {
    return [];
  }

  const emaValues: number[] = [];
  const multiplier = 2 / (period + 1);

  // Seed EMA with SMA of first `period` candles
  let sum = 0;
  for (let i = 0; i < period; i++) {
    sum += candles[i].close;
  }
  let ema = sum / period;
  emaValues.push(ema);

  // Apply EMA formula from candle `period` onwards
  for (let i = period; i < candles.length; i++) {
    ema = candles[i].close * multiplier + ema * (1 - multiplier);
    emaValues.push(ema);
  }

  return emaValues;
}

/**
 * Get the latest SMA value with price relationship
 */
export function getLatestSMA(
  candles: Candle[],
  period: number
): MAResult | null {
  const smaValues = calcSMA(candles, period);
  
  if (smaValues.length === 0 || candles.length === 0) {
    return null;
  }

  const sma = smaValues[smaValues.length - 1];
  const price = candles[candles.length - 1].close;
  const distance = Math.abs(price - sma);
  const distancePercent = (distance / sma) * 100;

  return {
    value: sma,
    priceAbove: price > sma,
    priceBelow: price < sma,
    distance,
    distancePercent,
  };
}

/**
 * Get the latest EMA value with price relationship
 */
export function getLatestEMA(
  candles: Candle[],
  period: number
): MAResult | null {
  const emaValues = calcEMA(candles, period);
  
  if (emaValues.length === 0 || candles.length === 0) {
    return null;
  }

  const ema = emaValues[emaValues.length - 1];
  const price = candles[candles.length - 1].close;
  const distance = Math.abs(price - ema);
  const distancePercent = (distance / ema) * 100;

  return {
    value: ema,
    priceAbove: price > ema,
    priceBelow: price < ema,
    distance,
    distancePercent,
  };
}

/**
 * Calculate SMA200 and EMA1000 together (common strategy combo)
 */
export function calcStrategyMAs(
  candles: Candle[],
  sma200Period: number = 200,
  ema1000Period: number = 1000
): { sma200: MAResult | null; ema1000: MAResult | null } {
  return {
    sma200: getLatestSMA(candles, sma200Period),
    ema1000: getLatestEMA(candles, ema1000Period),
  };
}

/**
 * Check if price is "close to" a moving average
 * Used for Watch triggers like "wait until closer to MA"
 */
export function isPriceCloseToMA(
  candles: Candle[],
  maPeriod: number,
  thresholdPercent: number,
  maType: 'SMA' | 'EMA' = 'SMA'
): { isClose: boolean; distancePercent: number; maValue: number } {
  const maResult = maType === 'SMA'
    ? getLatestSMA(candles, maPeriod)
    : getLatestEMA(candles, maPeriod);

  if (!maResult) {
    return { isClose: false, distancePercent: Infinity, maValue: 0 };
  }

  return {
    isClose: maResult.distancePercent <= thresholdPercent,
    distancePercent: maResult.distancePercent,
    maValue: maResult.value,
  };
}

/**
 * Detect MA cross events
 */
export function detectMACross(
  candles: Candle[],
  fastPeriod: number,
  slowPeriod: number,
  maType: 'SMA' | 'EMA' = 'SMA'
): { crossed: boolean; direction: 'BULLISH' | 'BEARISH' | null } {
  const calcFn = maType === 'SMA' ? calcSMA : calcEMA;
  
  const fastMA = calcFn(candles, fastPeriod);
  const slowMA = calcFn(candles, slowPeriod);

  // Need at least 2 values to detect cross
  if (fastMA.length < 2 || slowMA.length < 2) {
    return { crossed: false, direction: null };
  }

  // Align arrays (slow MA has fewer values)
  const offset = fastMA.length - slowMA.length;
  
  const prevFast = fastMA[fastMA.length - 2];
  const currFast = fastMA[fastMA.length - 1];
  const prevSlow = slowMA[slowMA.length - 2];
  const currSlow = slowMA[slowMA.length - 1];

  // Bullish cross: fast crosses above slow
  if (prevFast <= prevSlow && currFast > currSlow) {
    return { crossed: true, direction: 'BULLISH' };
  }

  // Bearish cross: fast crosses below slow
  if (prevFast >= prevSlow && currFast < currSlow) {
    return { crossed: true, direction: 'BEARISH' };
  }

  return { crossed: false, direction: null };
}

