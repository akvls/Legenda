import type { Candle, StructureBias } from '../../types/index.js';
import { analyzeSwings, SwingPoint, SwingAnalysis } from './swings.js';

/**
 * Market Structure Analysis
 * 
 * BOS (Break of Structure): Price breaks previous swing in trend direction
 * - Bullish BOS: Price breaks above previous swing high (continuation)
 * - Bearish BOS: Price breaks below previous swing low (continuation)
 * 
 * CHoCH (Change of Character): Price breaks swing against current trend
 * - Bullish CHoCH: In downtrend, price breaks above a lower high
 * - Bearish CHoCH: In uptrend, price breaks below a higher low
 */

export interface StructureEvent {
  type: 'BOS' | 'CHOCH';
  direction: 'BULLISH' | 'BEARISH';
  level: number;
  candleIndex: number;
  openTime: number;
}

export interface StructureAnalysis {
  bias: StructureBias;
  events: StructureEvent[];
  lastBOS: StructureEvent | null;
  lastCHoCH: StructureEvent | null;
  currentTrend: 'UPTREND' | 'DOWNTREND' | 'RANGING';
  protectedLevel: number | null; // Level that shouldn't break
}

/**
 * Determine market structure bias from swing analysis
 */
export function determineStructureBias(swingAnalysis: SwingAnalysis): StructureBias {
  const { higherHighs, higherLows, lowerHighs, lowerLows } = swingAnalysis;

  // Bullish structure: HH + HL
  if (higherHighs && higherLows) {
    return 'BULLISH';
  }

  // Bearish structure: LH + LL
  if (lowerHighs && lowerLows) {
    return 'BEARISH';
  }

  // Mixed or unclear
  return 'NEUTRAL';
}

/**
 * Detect BOS (Break of Structure) events
 */
export function detectBOS(
  candles: Candle[],
  swingAnalysis: SwingAnalysis
): StructureEvent[] {
  const events: StructureEvent[] = [];
  const { swings } = swingAnalysis;

  if (swings.length < 2) return events;

  // Track which swings have been broken
  for (let i = 0; i < candles.length; i++) {
    const candle = candles[i];

    // Find swings that occurred before this candle
    const priorSwings = swings.filter(s => s.candleIndex < i);
    
    for (const swing of priorSwings) {
      // Check if swing is already broken
      const alreadyBroken = events.some(
        e => e.level === swing.price && e.candleIndex < i
      );
      if (alreadyBroken) continue;

      // Bullish BOS: Close above swing high
      if (swing.type === 'HIGH' && candle.close > swing.price) {
        // Only count as BOS if we were in uptrend (breaking higher)
        const prevHighs = priorSwings.filter(s => s.type === 'HIGH' && s.candleIndex < swing.candleIndex);
        if (prevHighs.length > 0) {
          const lastPrevHigh = prevHighs[prevHighs.length - 1];
          if (swing.price > lastPrevHigh.price) {
            // This was already a higher high, breaking it is continuation
            events.push({
              type: 'BOS',
              direction: 'BULLISH',
              level: swing.price,
              candleIndex: i,
              openTime: candle.openTime,
            });
          }
        }
      }

      // Bearish BOS: Close below swing low
      if (swing.type === 'LOW' && candle.close < swing.price) {
        const prevLows = priorSwings.filter(s => s.type === 'LOW' && s.candleIndex < swing.candleIndex);
        if (prevLows.length > 0) {
          const lastPrevLow = prevLows[prevLows.length - 1];
          if (swing.price < lastPrevLow.price) {
            events.push({
              type: 'BOS',
              direction: 'BEARISH',
              level: swing.price,
              candleIndex: i,
              openTime: candle.openTime,
            });
          }
        }
      }
    }
  }

  return events;
}

/**
 * Detect CHoCH (Change of Character) events
 */
export function detectCHoCH(
  candles: Candle[],
  swingAnalysis: SwingAnalysis
): StructureEvent[] {
  const events: StructureEvent[] = [];
  const { swings, lastSwingHigh, lastSwingLow } = swingAnalysis;

  if (swings.length < 3) return events;

  // Find the most recent structure break against trend
  for (let i = swings.length - 1; i >= 2; i--) {
    const currentSwing = swings[i];
    
    // Look for previous swings of same type
    const sameTypeSwings = swings
      .slice(0, i)
      .filter(s => s.type === currentSwing.type)
      .slice(-2);

    if (sameTypeSwings.length < 2) continue;

    const [older, newer] = sameTypeSwings;

    // Bullish CHoCH: In downtrend (LH, LL pattern), price breaks above a LH
    if (currentSwing.type === 'HIGH') {
      // Were we making lower highs?
      if (newer.price < older.price) {
        // Check if current high broke the newer lower high
        for (let j = newer.candleIndex + 1; j < candles.length; j++) {
          if (candles[j].close > newer.price) {
            // Check not already recorded
            if (!events.some(e => e.level === newer.price && e.type === 'CHOCH')) {
              events.push({
                type: 'CHOCH',
                direction: 'BULLISH',
                level: newer.price,
                candleIndex: j,
                openTime: candles[j].openTime,
              });
            }
            break;
          }
        }
      }
    }

    // Bearish CHoCH: In uptrend (HH, HL pattern), price breaks below a HL
    if (currentSwing.type === 'LOW') {
      // Were we making higher lows?
      if (newer.price > older.price) {
        // Check if price broke the newer higher low
        for (let j = newer.candleIndex + 1; j < candles.length; j++) {
          if (candles[j].close < newer.price) {
            if (!events.some(e => e.level === newer.price && e.type === 'CHOCH')) {
              events.push({
                type: 'CHOCH',
                direction: 'BEARISH',
                level: newer.price,
                candleIndex: j,
                openTime: candles[j].openTime,
              });
            }
            break;
          }
        }
      }
    }
  }

  return events;
}

/**
 * Full structure analysis
 */
export function analyzeStructure(
  candles: Candle[],
  lookback: number = 5
): StructureAnalysis {
  const swingAnalysis = analyzeSwings(candles, lookback);
  const bias = determineStructureBias(swingAnalysis);
  
  const bosEvents = detectBOS(candles, swingAnalysis);
  const chochEvents = detectCHoCH(candles, swingAnalysis);
  
  const allEvents = [...bosEvents, ...chochEvents].sort(
    (a, b) => a.candleIndex - b.candleIndex
  );

  const lastBOS = bosEvents.length > 0 ? bosEvents[bosEvents.length - 1] : null;
  const lastCHoCH = chochEvents.length > 0 ? chochEvents[chochEvents.length - 1] : null;

  // Determine current trend
  let currentTrend: 'UPTREND' | 'DOWNTREND' | 'RANGING' = 'RANGING';
  if (bias === 'BULLISH') {
    currentTrend = 'UPTREND';
  } else if (bias === 'BEARISH') {
    currentTrend = 'DOWNTREND';
  }

  // Protected level depends on trend
  let protectedLevel: number | null = null;
  if (currentTrend === 'UPTREND' && swingAnalysis.lastSwingLow) {
    // In uptrend, protect the last higher low
    protectedLevel = swingAnalysis.lastSwingLow.price;
  } else if (currentTrend === 'DOWNTREND' && swingAnalysis.lastSwingHigh) {
    // In downtrend, protect the last lower high
    protectedLevel = swingAnalysis.lastSwingHigh.price;
  }

  return {
    bias,
    events: allEvents,
    lastBOS,
    lastCHoCH,
    currentTrend,
    protectedLevel,
  };
}

/**
 * Check if a level (stop loss) has been invalidated
 */
export function isLevelInvalidated(
  candles: Candle[],
  level: number,
  direction: 'LONG' | 'SHORT'
): boolean {
  if (candles.length === 0) return false;

  const lastCandle = candles[candles.length - 1];

  if (direction === 'LONG') {
    // For long, invalidated if price closes below level
    return lastCandle.close < level;
  } else {
    // For short, invalidated if price closes above level
    return lastCandle.close > level;
  }
}

/**
 * Get simple structure bias without full event detection
 * (faster for real-time updates)
 */
export function getQuickStructureBias(
  candles: Candle[],
  lookback: number = 5
): StructureBias {
  const swingAnalysis = analyzeSwings(candles, lookback);
  return determineStructureBias(swingAnalysis);
}

