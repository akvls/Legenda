import { EventEmitter } from 'eventemitter3';
import { prisma } from '../db/index.js';
import { getKlines } from '../bybit/rest-client.js';
import { getMarketWebSocket, MarketWebSocket } from '../bybit/market-ws.js';
import { createLogger } from '../utils/logger.js';
import type { Candle } from '../types/index.js';

const logger = createLogger('candles');

/**
 * Candle Manager
 * Manages candle data with backfilling, real-time updates, and storage
 */

export interface CandleManagerEvents {
  candleClose: (candle: Candle) => void;
  candleUpdate: (candle: Candle) => void;
  backfillComplete: (symbol: string, timeframe: string, count: number) => void;
  error: (error: Error) => void;
}

interface CandleBuffer {
  candles: Map<number, Candle>; // openTime -> Candle
  lastConfirmed: number | null;
}

export class CandleManager extends EventEmitter<CandleManagerEvents> {
  private buffers: Map<string, CandleBuffer> = new Map(); // "SYMBOL:TIMEFRAME" -> buffer
  private marketWs: MarketWebSocket;
  private subscriptions: Set<string> = new Set();
  private saveInterval: NodeJS.Timeout | null = null;
  private pendingSaves: Candle[] = [];

  constructor() {
    super();
    this.marketWs = getMarketWebSocket();
    this.setupWebSocketHandlers();
    this.startSaveInterval();
  }

  private getKey(symbol: string, timeframe: string): string {
    return `${symbol}:${timeframe}`;
  }

  private setupWebSocketHandlers(): void {
    this.marketWs.on('kline', (candle) => {
      this.handleCandleUpdate(candle);
    });

    this.marketWs.on('connected', () => {
      logger.info('Market WS connected, checking for backfill needs');
      this.checkBackfillNeeds();
    });

    this.marketWs.on('disconnected', () => {
      logger.warn('Market WS disconnected');
    });

    this.marketWs.on('reconnecting', () => {
      logger.info('Market WS reconnecting...');
    });
  }

  private handleCandleUpdate(candle: Candle): void {
    const key = this.getKey(candle.symbol, candle.timeframe);
    const buffer = this.buffers.get(key);
    
    if (!buffer) return;

    // Check if this is a confirmed (closed) candle
    const now = Date.now();
    const isClosed = candle.closeTime < now;
    
    if (isClosed && buffer.lastConfirmed !== candle.openTime) {
      // This is a newly closed candle
      buffer.lastConfirmed = candle.openTime;
      buffer.candles.set(candle.openTime, candle);
      
      // Queue for database save
      this.pendingSaves.push(candle);
      
      // Emit closed candle event
      this.emit('candleClose', candle);
      
      logger.debug(
        { symbol: candle.symbol, timeframe: candle.timeframe, close: candle.close },
        'Candle closed'
      );
    } else {
      // Real-time update to current candle
      buffer.candles.set(candle.openTime, candle);
      this.emit('candleUpdate', candle);
    }
  }

  /**
   * Subscribe to a symbol/timeframe pair
   */
  async subscribe(symbol: string, timeframe: string): Promise<void> {
    const key = this.getKey(symbol, timeframe);
    
    if (this.subscriptions.has(key)) {
      logger.debug({ symbol, timeframe }, 'Already subscribed');
      return;
    }

    // Initialize buffer
    this.buffers.set(key, {
      candles: new Map(),
      lastConfirmed: null,
    });

    this.subscriptions.add(key);

    // Backfill first
    await this.backfill(symbol, timeframe);

    // Then subscribe to real-time updates
    this.marketWs.subscribeKline(symbol, timeframe);
    
    logger.info({ symbol, timeframe }, 'Subscribed to candles');
  }

  /**
   * Unsubscribe from a symbol/timeframe pair
   */
  unsubscribe(symbol: string, timeframe: string): void {
    const key = this.getKey(symbol, timeframe);
    
    if (!this.subscriptions.has(key)) return;

    this.subscriptions.delete(key);
    this.buffers.delete(key);
    this.marketWs.unsubscribeKline(symbol, timeframe);
    
    logger.info({ symbol, timeframe }, 'Unsubscribed from candles');
  }

  /**
   * Backfill candles from REST API
   * Makes multiple requests to get enough data (Bybit limit is 200 per request)
   */
  async backfill(
    symbol: string, 
    timeframe: string, 
    limit: number = 1200
  ): Promise<number> {
    const key = this.getKey(symbol, timeframe);
    const buffer = this.buffers.get(key);
    
    if (!buffer) {
      throw new Error(`Not subscribed to ${key}`);
    }

    try {
      logger.info({ symbol, timeframe, limit }, 'Starting backfill');

      const allCandles: Candle[] = [];
      const batchSize = 200; // Bybit max per request
      let endTime: number | undefined = undefined;
      let fetched = 0;

      // Fetch in batches, going backwards in time
      while (fetched < limit) {
        const remaining = limit - fetched;
        const fetchCount = Math.min(batchSize, remaining);
        
        const candles = await getKlines(symbol, timeframe, fetchCount, undefined, endTime);
        
        if (candles.length === 0) {
          break; // No more data
        }

        allCandles.unshift(...candles); // Add to front (older candles)
        fetched += candles.length;
        
        // Set endTime to oldest candle for next batch
        endTime = candles[0].openTime - 1;
        
        logger.debug({ symbol, fetched, total: limit }, 'Backfill progress');

        // Small delay to avoid rate limiting
        if (fetched < limit && candles.length === fetchCount) {
          await new Promise(r => setTimeout(r, 100));
        } else {
          break; // Got less than requested, no more data
        }
      }

      // Store in buffer
      for (const candle of allCandles) {
        buffer.candles.set(candle.openTime, candle);
      }

      // Batch upsert to database
      if (allCandles.length > 0) {
        await this.saveCandles(allCandles);
      }

      // Set last confirmed
      const confirmedCandles = allCandles.filter(c => c.closeTime < Date.now());
      if (confirmedCandles.length > 0) {
        buffer.lastConfirmed = confirmedCandles[confirmedCandles.length - 1].openTime;
      }

      logger.info(
        { symbol, timeframe, count: allCandles.length },
        'Backfill complete'
      );

      this.emit('backfillComplete', symbol, timeframe, allCandles.length);
      return allCandles.length;
    } catch (error) {
      logger.error({ error, symbol, timeframe }, 'Backfill failed');
      this.emit('error', error as Error);
      throw error;
    }
  }

  /**
   * Check if any subscriptions need backfilling (after reconnect)
   */
  private async checkBackfillNeeds(): Promise<void> {
    for (const key of this.subscriptions) {
      const [symbol, timeframe] = key.split(':');
      const buffer = this.buffers.get(key);
      
      if (!buffer) continue;

      // Check if we're missing recent candles
      const now = Date.now();
      const intervalMs = this.getIntervalMs(timeframe);
      const expectedLastOpen = Math.floor(now / intervalMs) * intervalMs;
      
      if (!buffer.lastConfirmed || buffer.lastConfirmed < expectedLastOpen - intervalMs * 5) {
        // We're missing more than 5 candles, backfill
        logger.info({ symbol, timeframe }, 'Gap detected, backfilling');
        await this.backfill(symbol, timeframe, 200);
      }
    }
  }

  /**
   * Get candles from buffer
   */
  getCandles(
    symbol: string, 
    timeframe: string, 
    limit?: number
  ): Candle[] {
    const key = this.getKey(symbol, timeframe);
    const buffer = this.buffers.get(key);
    
    if (!buffer) return [];

    const candles = Array.from(buffer.candles.values())
      .sort((a, b) => a.openTime - b.openTime);

    if (limit) {
      return candles.slice(-limit);
    }
    return candles;
  }

  /**
   * Get the latest closed candle
   */
  getLatestClosedCandle(symbol: string, timeframe: string): Candle | null {
    const key = this.getKey(symbol, timeframe);
    const buffer = this.buffers.get(key);
    
    if (!buffer || !buffer.lastConfirmed) return null;

    return buffer.candles.get(buffer.lastConfirmed) || null;
  }

  /**
   * Get candles from database
   */
  async getCandlesFromDb(
    symbol: string,
    timeframe: string,
    limit: number = 1000
  ): Promise<Candle[]> {
    const dbCandles = await prisma.candle.findMany({
      where: { symbol, timeframe },
      orderBy: { openTime: 'desc' },
      take: limit,
    });

    return dbCandles.reverse().map((c) => ({
      symbol: c.symbol,
      timeframe: c.timeframe,
      openTime: new Date(c.openTime).getTime(),
      closeTime: new Date(c.closeTime).getTime(),
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
      volume: c.volume,
    }));
  }

  /**
   * Save candles to database (batch upsert)
   */
  private async saveCandles(candles: Candle[]): Promise<void> {
    if (candles.length === 0) return;

    try {
      // Use Prisma transaction for batch upsert
      await prisma.$transaction(
        candles.map((candle) =>
          prisma.candle.upsert({
            where: {
              symbol_timeframe_openTime: {
                symbol: candle.symbol,
                timeframe: candle.timeframe,
                openTime: new Date(candle.openTime),
              },
            },
            update: {
              high: candle.high,
              low: candle.low,
              close: candle.close,
              volume: candle.volume,
            },
            create: {
              symbol: candle.symbol,
              timeframe: candle.timeframe,
              openTime: new Date(candle.openTime),
              closeTime: new Date(candle.closeTime),
              open: candle.open,
              high: candle.high,
              low: candle.low,
              close: candle.close,
              volume: candle.volume,
            },
          })
        )
      );
    } catch (error) {
      logger.error({ error, count: candles.length }, 'Failed to save candles');
    }
  }

  /**
   * Start interval to batch-save pending candles
   */
  private startSaveInterval(): void {
    // Save pending candles every 5 seconds
    this.saveInterval = setInterval(async () => {
      if (this.pendingSaves.length === 0) return;

      const toSave = [...this.pendingSaves];
      this.pendingSaves = [];

      await this.saveCandles(toSave);
    }, 5000);
  }

  /**
   * Convert interval string to milliseconds
   */
  private getIntervalMs(interval: string): number {
    const map: Record<string, number> = {
      '1': 60 * 1000,
      '3': 3 * 60 * 1000,
      '5': 5 * 60 * 1000,
      '15': 15 * 60 * 1000,
      '30': 30 * 60 * 1000,
      '60': 60 * 60 * 1000,
      '120': 2 * 60 * 60 * 1000,
      '240': 4 * 60 * 60 * 1000,
      '360': 6 * 60 * 60 * 1000,
      '720': 12 * 60 * 60 * 1000,
      'D': 24 * 60 * 60 * 1000,
      'W': 7 * 24 * 60 * 60 * 1000,
    };
    return map[interval] || 5 * 60 * 1000;
  }

  /**
   * Clean up
   */
  destroy(): void {
    if (this.saveInterval) {
      clearInterval(this.saveInterval);
    }
    
    // Save any pending candles
    if (this.pendingSaves.length > 0) {
      this.saveCandles(this.pendingSaves);
    }

    this.buffers.clear();
    this.subscriptions.clear();
    
    logger.info('Candle manager destroyed');
  }
}

// Singleton instance
let candleManagerInstance: CandleManager | null = null;

export function getCandleManager(): CandleManager {
  if (!candleManagerInstance) {
    candleManagerInstance = new CandleManager();
  }
  return candleManagerInstance;
}

export function destroyCandleManager(): void {
  if (candleManagerInstance) {
    candleManagerInstance.destroy();
    candleManagerInstance = null;
  }
}

