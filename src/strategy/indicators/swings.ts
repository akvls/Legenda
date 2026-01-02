import type { Candle } from '../../types/index.js';

/**
 * Swing High/Low Detection
 * 
 * Swing High: A candle high that is higher than N candles before AND after
 * Swing Low: A candle low that is lower than N candles before AND after
 */

export interface SwingPoint {
  type: 'HIGH' | 'LOW';
  price: number;
  candleIndex: number;
  openTime: number;
  confirmed: boolean; // Has enough candles after to confirm
}

export interface SwingAnalysis {
  swings: SwingPoint[];
  lastSwingHigh: SwingPoint | null;
  lastSwingLow: SwingPoint | null;
  // For structure analysis
  higherHighs: boolean;
  higherLows: boolean;
  lowerHighs: boolean;
  lowerLows: boolean;
}

/**
 * Detect swing highs in candle data
 * lookback: number of candles to look before/after
 */
export function detectSwingHighs(
  candles: Candle[],
  lookback: number = 5
): SwingPoint[] {
  const swingHighs: SwingPoint[] = [];

  // Need at least lookback candles on each side
  for (let i = lookback; i < candles.length - lookback; i++) {
    const currentHigh = candles[i].high;
    let isSwingHigh = true;

    // Check left side (before)
    for (let j = 1; j <= lookback; j++) {
      if (candles[i - j].high >= currentHigh) {
        isSwingHigh = false;
        break;
      }
    }

    // Check right side (after)
    if (isSwingHigh) {
      for (let j = 1; j <= lookback; j++) {
        if (candles[i + j].high >= currentHigh) {
          isSwingHigh = false;
          break;
        }
      }
    }

    if (isSwingHigh) {
      swingHighs.push({
        type: 'HIGH',
        price: currentHigh,
        candleIndex: i,
        openTime: candles[i].openTime,
        confirmed: true,
      });
    }
  }

  // Check potential swing high at the edge (not fully confirmed)
  if (candles.length > lookback) {
    const lastIdx = candles.length - 1;
    for (let i = lastIdx; i >= lastIdx - lookback && i >= lookback; i--) {
      const currentHigh = candles[i].high;
      let isPotentialSwingHigh = true;

      // Check left side only (can't confirm right side yet)
      for (let j = 1; j <= lookback; j++) {
        if (i - j >= 0 && candles[i - j].high >= currentHigh) {
          isPotentialSwingHigh = false;
          break;
        }
      }

      // Check available right side
      if (isPotentialSwingHigh) {
        for (let j = 1; j <= lookback && i + j < candles.length; j++) {
          if (candles[i + j].high >= currentHigh) {
            isPotentialSwingHigh = false;
            break;
          }
        }
      }

      if (isPotentialSwingHigh && !swingHighs.some(s => s.candleIndex === i)) {
        swingHighs.push({
          type: 'HIGH',
          price: currentHigh,
          candleIndex: i,
          openTime: candles[i].openTime,
          confirmed: i <= candles.length - lookback - 1,
        });
        break; // Only add one potential swing at edge
      }
    }
  }

  return swingHighs.sort((a, b) => a.candleIndex - b.candleIndex);
}

/**
 * Detect swing lows in candle data
 */
export function detectSwingLows(
  candles: Candle[],
  lookback: number = 5
): SwingPoint[] {
  const swingLows: SwingPoint[] = [];

  // Need at least lookback candles on each side
  for (let i = lookback; i < candles.length - lookback; i++) {
    const currentLow = candles[i].low;
    let isSwingLow = true;

    // Check left side (before)
    for (let j = 1; j <= lookback; j++) {
      if (candles[i - j].low <= currentLow) {
        isSwingLow = false;
        break;
      }
    }

    // Check right side (after)
    if (isSwingLow) {
      for (let j = 1; j <= lookback; j++) {
        if (candles[i + j].low <= currentLow) {
          isSwingLow = false;
          break;
        }
      }
    }

    if (isSwingLow) {
      swingLows.push({
        type: 'LOW',
        price: currentLow,
        candleIndex: i,
        openTime: candles[i].openTime,
        confirmed: true,
      });
    }
  }

  // Check potential swing low at the edge
  if (candles.length > lookback) {
    const lastIdx = candles.length - 1;
    for (let i = lastIdx; i >= lastIdx - lookback && i >= lookback; i--) {
      const currentLow = candles[i].low;
      let isPotentialSwingLow = true;

      for (let j = 1; j <= lookback; j++) {
        if (i - j >= 0 && candles[i - j].low <= currentLow) {
          isPotentialSwingLow = false;
          break;
        }
      }

      if (isPotentialSwingLow) {
        for (let j = 1; j <= lookback && i + j < candles.length; j++) {
          if (candles[i + j].low <= currentLow) {
            isPotentialSwingLow = false;
            break;
          }
        }
      }

      if (isPotentialSwingLow && !swingLows.some(s => s.candleIndex === i)) {
        swingLows.push({
          type: 'LOW',
          price: currentLow,
          candleIndex: i,
          openTime: candles[i].openTime,
          confirmed: i <= candles.length - lookback - 1,
        });
        break;
      }
    }
  }

  return swingLows.sort((a, b) => a.candleIndex - b.candleIndex);
}

/**
 * Get all swings (highs and lows) sorted by time
 */
export function detectAllSwings(
  candles: Candle[],
  lookback: number = 5
): SwingPoint[] {
  const highs = detectSwingHighs(candles, lookback);
  const lows = detectSwingLows(candles, lookback);
  
  return [...highs, ...lows].sort((a, b) => a.candleIndex - b.candleIndex);
}

/**
 * Analyze swing structure
 */
export function analyzeSwings(
  candles: Candle[],
  lookback: number = 5
): SwingAnalysis {
  const highs = detectSwingHighs(candles, lookback);
  const lows = detectSwingLows(candles, lookback);
  const allSwings = [...highs, ...lows].sort((a, b) => a.candleIndex - b.candleIndex);

  const lastSwingHigh = highs.length > 0 ? highs[highs.length - 1] : null;
  const lastSwingLow = lows.length > 0 ? lows[lows.length - 1] : null;

  // Analyze structure pattern (need at least 2 of each)
  let higherHighs = false;
  let higherLows = false;
  let lowerHighs = false;
  let lowerLows = false;

  if (highs.length >= 2) {
    const prevHigh = highs[highs.length - 2];
    const currHigh = highs[highs.length - 1];
    higherHighs = currHigh.price > prevHigh.price;
    lowerHighs = currHigh.price < prevHigh.price;
  }

  if (lows.length >= 2) {
    const prevLow = lows[lows.length - 2];
    const currLow = lows[lows.length - 1];
    higherLows = currLow.price > prevLow.price;
    lowerLows = currLow.price < prevLow.price;
  }

  return {
    swings: allSwings,
    lastSwingHigh,
    lastSwingLow,
    higherHighs,
    higherLows,
    lowerHighs,
    lowerLows,
  };
}

/**
 * Get protected swing levels for a trade
 * - For LONG: protected swing low (the HL that shouldn't break)
 * - For SHORT: protected swing high (the LH that shouldn't break)
 */
export function getProtectedSwingLevels(
  candles: Candle[],
  lookback: number = 5
): { protectedSwingLow: number | null; protectedSwingHigh: number | null } {
  const analysis = analyzeSwings(candles, lookback);

  return {
    protectedSwingLow: analysis.lastSwingLow?.price ?? null,
    protectedSwingHigh: analysis.lastSwingHigh?.price ?? null,
  };
}

