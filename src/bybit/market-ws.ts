import { WebsocketClient, WSClientConfigurableOptions } from 'bybit-api';
import { EventEmitter } from 'eventemitter3';
import { config } from '../config/index.js';
import { wsLogger as logger } from '../utils/logger.js';
import type { Candle, BybitTicker } from '../types/index.js';

/**
 * Bybit Market WebSocket Client
 * Handles public market data streams (klines, tickers)
 */

export interface MarketWSEvents {
  kline: (candle: Candle) => void;
  ticker: (ticker: BybitTicker) => void;
  connected: () => void;
  disconnected: () => void;
  error: (error: Error) => void;
  reconnecting: () => void;
}

export class MarketWebSocket extends EventEmitter<MarketWSEvents> {
  private ws: WebsocketClient;
  private subscriptions: Set<string> = new Set();
  private isConnected: boolean = false;

  constructor() {
    super();

    const wsConfig: WSClientConfigurableOptions = {
      market: 'v5',
      testnet: config.bybit.testnet,
    };

    this.ws = new WebsocketClient(wsConfig);
    this.setupEventHandlers();
  }

  private setupEventHandlers(): void {
    // Connection opened
    this.ws.on('open', ({ wsKey }) => {
      logger.info({ wsKey }, 'Market WebSocket connected');
      this.isConnected = true;
      this.emit('connected');
      
      // Resubscribe if we had previous subscriptions
      this.resubscribe();
    });

    // Connection closed
    this.ws.on('close', () => {
      logger.warn('Market WebSocket disconnected');
      this.isConnected = false;
      this.emit('disconnected');
    });

    // Reconnecting
    this.ws.on('reconnect', ({ wsKey }) => {
      logger.info({ wsKey }, 'Market WebSocket reconnecting...');
      this.emit('reconnecting');
    });

    // Reconnected
    this.ws.on('reconnected', ({ wsKey }) => {
      logger.info({ wsKey }, 'Market WebSocket reconnected');
      this.isConnected = true;
      this.emit('connected');
    });

    // Response to subscription requests
    this.ws.on('response', (response) => {
      if (response.success) {
        logger.debug({ response }, 'Subscription confirmed');
      } else {
        logger.error({ response }, 'Subscription failed');
      }
    });

    // Handle incoming data
    this.ws.on('update', (data) => {
      this.handleUpdate(data);
    });

    // Error
    this.ws.on('error', (error) => {
      logger.error({ error }, 'Market WebSocket error');
      this.emit('error', error as Error);
    });
  }

  private handleUpdate(data: Record<string, unknown>): void {
    const topic = data.topic as string;
    
    if (!topic) return;

    // Handle kline updates
    if (topic.startsWith('kline.')) {
      this.handleKlineUpdate(data);
    }
    // Handle ticker updates
    else if (topic.startsWith('tickers.')) {
      this.handleTickerUpdate(data);
    }
  }

  private handleKlineUpdate(data: Record<string, unknown>): void {
    const topic = data.topic as string;
    const parts = topic.split('.');
    const interval = parts[1];
    const symbol = parts[2];
    
    const klineData = data.data as Array<{
      start: number;
      end: number;
      interval: string;
      open: string;
      high: string;
      low: string;
      close: string;
      volume: string;
      turnover: string;
      confirm: boolean;
      timestamp: number;
    }>;

    for (const k of klineData) {
      const candle: Candle = {
        symbol,
        timeframe: interval,
        openTime: k.start,
        closeTime: k.end,
        open: parseFloat(k.open),
        high: parseFloat(k.high),
        low: parseFloat(k.low),
        close: parseFloat(k.close),
        volume: parseFloat(k.volume),
      };

      // Only emit confirmed candles (closed) or real-time updates
      this.emit('kline', candle);
      
      if (k.confirm) {
        logger.debug({ symbol, interval, close: candle.close }, 'Candle closed');
      }
    }
  }

  private handleTickerUpdate(data: Record<string, unknown>): void {
    const tickerData = data.data as {
      symbol: string;
      lastPrice: string;
      highPrice24h: string;
      lowPrice24h: string;
      prevPrice24h: string;
      volume24h: string;
      bid1Price: string;
      ask1Price: string;
      markPrice: string;
      indexPrice: string;
    };

    const ticker: BybitTicker = {
      symbol: tickerData.symbol,
      lastPrice: tickerData.lastPrice,
      highPrice24h: tickerData.highPrice24h,
      lowPrice24h: tickerData.lowPrice24h,
      prevPrice24h: tickerData.prevPrice24h,
      volume24h: tickerData.volume24h,
      bid1Price: tickerData.bid1Price,
      ask1Price: tickerData.ask1Price,
      markPrice: tickerData.markPrice,
      indexPrice: tickerData.indexPrice,
    };

    this.emit('ticker', ticker);
  }

  /**
   * Subscribe to kline/candlestick updates
   */
  subscribeKline(symbol: string, interval: string): void {
    const topic = `kline.${interval}.${symbol}`;
    
    if (this.subscriptions.has(topic)) {
      logger.debug({ topic }, 'Already subscribed');
      return;
    }

    this.subscriptions.add(topic);
    this.ws.subscribeV5(topic, 'linear');
    logger.info({ symbol, interval }, 'Subscribed to klines');
  }

  /**
   * Subscribe to ticker updates
   */
  subscribeTicker(symbol: string): void {
    const topic = `tickers.${symbol}`;
    
    if (this.subscriptions.has(topic)) {
      logger.debug({ topic }, 'Already subscribed');
      return;
    }

    this.subscriptions.add(topic);
    this.ws.subscribeV5(topic, 'linear');
    logger.info({ symbol }, 'Subscribed to ticker');
  }

  /**
   * Unsubscribe from kline updates
   */
  unsubscribeKline(symbol: string, interval: string): void {
    const topic = `kline.${interval}.${symbol}`;
    this.subscriptions.delete(topic);
    this.ws.unsubscribeV5(topic, 'linear');
    logger.info({ symbol, interval }, 'Unsubscribed from klines');
  }

  /**
   * Unsubscribe from ticker updates
   */
  unsubscribeTicker(symbol: string): void {
    const topic = `tickers.${symbol}`;
    this.subscriptions.delete(topic);
    this.ws.unsubscribeV5(topic, 'linear');
    logger.info({ symbol }, 'Unsubscribed from ticker');
  }

  /**
   * Resubscribe to all previous subscriptions (after reconnect)
   */
  private resubscribe(): void {
    if (this.subscriptions.size === 0) return;

    logger.info({ count: this.subscriptions.size }, 'Resubscribing to topics');
    
    for (const topic of this.subscriptions) {
      this.ws.subscribeV5(topic, 'linear');
    }
  }

  /**
   * Check if connected
   */
  getConnectionStatus(): boolean {
    return this.isConnected;
  }

  /**
   * Get list of current subscriptions
   */
  getSubscriptions(): string[] {
    return Array.from(this.subscriptions);
  }

  /**
   * Close the WebSocket connection
   */
  close(): void {
    this.ws.closeAll();
    this.subscriptions.clear();
    this.isConnected = false;
    logger.info('Market WebSocket closed');
  }
}

// Singleton instance
let marketWsInstance: MarketWebSocket | null = null;

export function getMarketWebSocket(): MarketWebSocket {
  if (!marketWsInstance) {
    marketWsInstance = new MarketWebSocket();
  }
  return marketWsInstance;
}

export function closeMarketWebSocket(): void {
  if (marketWsInstance) {
    marketWsInstance.close();
    marketWsInstance = null;
  }
}

