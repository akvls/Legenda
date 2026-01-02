import Decimal from 'decimal.js';
import type { Candle, Bias } from '../../types/index.js';

/**
 * Supertrend Indicator
 * 
 * Supertrend = ATR-based trend following indicator
 * - When price > Supertrend line → LONG bias
 * - When price < Supertrend line → SHORT bias
 */

export interface SupertrendResult {
  value: number;        // The supertrend line value
  direction: Bias;      // LONG or SHORT
  upperBand: number;
  lowerBand: number;
}

export interface SupertrendState {
  prevUpperBand: number;
  prevLowerBand: number;
  prevSupertrend: number;
  prevDirection: Bias;
}

/**
 * Calculate True Range for a candle
 */
function calcTrueRange(candle: Candle, prevClose: number): number {
  const highLow = candle.high - candle.low;
  const highPrevClose = Math.abs(candle.high - prevClose);
  const lowPrevClose = Math.abs(candle.low - prevClose);
  return Math.max(highLow, highPrevClose, lowPrevClose);
}

/**
 * Calculate ATR (Average True Range)
 */
export function calcATR(candles: Candle[], period: number): number[] {
  if (candles.length < period + 1) {
    return [];
  }

  const atrValues: number[] = [];
  
  // Calculate True Range for each candle
  const trValues: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    trValues.push(calcTrueRange(candles[i], candles[i - 1].close));
  }

  // First ATR is simple average
  let atr = trValues.slice(0, period).reduce((a, b) => a + b, 0) / period;
  atrValues.push(atr);

  // Subsequent ATRs use smoothing (Wilder's method)
  for (let i = period; i < trValues.length; i++) {
    atr = ((atr * (period - 1)) + trValues[i]) / period;
    atrValues.push(atr);
  }

  return atrValues;
}

/**
 * Calculate Supertrend for a series of candles
 * Returns array of SupertrendResult for each valid candle
 */
export function calcSupertrend(
  candles: Candle[],
  period: number = 10,
  multiplier: number = 3.0
): SupertrendResult[] {
  if (candles.length < period + 1) {
    return [];
  }

  const atrValues = calcATR(candles, period);
  const results: SupertrendResult[] = [];

  // We need ATR values starting from index `period` in original candles
  // ATR array starts at candle index `period` (0-indexed: candles[period])
  
  let prevUpperBand = 0;
  let prevLowerBand = 0;
  let prevSupertrend = 0;
  let prevDirection: Bias = 'LONG';
  let prevClose = 0;

  for (let i = 0; i < atrValues.length; i++) {
    const candleIdx = i + period; // Map ATR index to candle index
    const candle = candles[candleIdx];
    const atr = atrValues[i];
    
    // Calculate basic bands
    const hl2 = (candle.high + candle.low) / 2;
    const basicUpperBand = hl2 + (multiplier * atr);
    const basicLowerBand = hl2 - (multiplier * atr);

    // Calculate final bands
    let upperBand: number;
    let lowerBand: number;

    if (i === 0) {
      upperBand = basicUpperBand;
      lowerBand = basicLowerBand;
    } else {
      // Upper band: use previous if current is lower or prev close was above prev upper
      upperBand = (basicUpperBand < prevUpperBand || prevClose > prevUpperBand)
        ? basicUpperBand
        : prevUpperBand;

      // Lower band: use previous if current is higher or prev close was below prev lower
      lowerBand = (basicLowerBand > prevLowerBand || prevClose < prevLowerBand)
        ? basicLowerBand
        : prevLowerBand;
    }

    // Determine supertrend value and direction
    let supertrend: number;
    let direction: Bias;

    if (i === 0) {
      // Initial direction based on close vs bands
      if (candle.close <= upperBand) {
        supertrend = upperBand;
        direction = 'SHORT';
      } else {
        supertrend = lowerBand;
        direction = 'LONG';
      }
    } else {
      if (prevSupertrend === prevUpperBand) {
        // Was in downtrend
        if (candle.close > upperBand) {
          supertrend = lowerBand;
          direction = 'LONG';
        } else {
          supertrend = upperBand;
          direction = 'SHORT';
        }
      } else {
        // Was in uptrend
        if (candle.close < lowerBand) {
          supertrend = upperBand;
          direction = 'SHORT';
        } else {
          supertrend = lowerBand;
          direction = 'LONG';
        }
      }
    }

    results.push({
      value: supertrend,
      direction,
      upperBand,
      lowerBand,
    });

    // Store for next iteration
    prevUpperBand = upperBand;
    prevLowerBand = lowerBand;
    prevSupertrend = supertrend;
    prevDirection = direction;
    prevClose = candle.close;
  }

  return results;
}

/**
 * Get the latest Supertrend value
 */
export function getLatestSupertrend(
  candles: Candle[],
  period: number = 10,
  multiplier: number = 3.0
): SupertrendResult | null {
  const results = calcSupertrend(candles, period, multiplier);
  return results.length > 0 ? results[results.length - 1] : null;
}

/**
 * Detect Supertrend direction flip
 */
export function detectSupertrendFlip(
  candles: Candle[],
  period: number = 10,
  multiplier: number = 3.0
): { flipped: boolean; from: Bias | null; to: Bias | null } {
  const results = calcSupertrend(candles, period, multiplier);
  
  if (results.length < 2) {
    return { flipped: false, from: null, to: null };
  }

  const prev = results[results.length - 2];
  const curr = results[results.length - 1];

  if (prev.direction !== curr.direction) {
    return {
      flipped: true,
      from: prev.direction,
      to: curr.direction,
    };
  }

  return { flipped: false, from: null, to: null };
}

