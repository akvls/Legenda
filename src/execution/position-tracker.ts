import { EventEmitter } from 'eventemitter3';
import { prisma } from '../db/index.js';
import { getPrivateWebSocket, PositionUpdate } from '../bybit/private-ws.js';
import { getPosition, getAllPositions } from '../bybit/rest-client.js';
import { createLogger } from '../utils/logger.js';
import type { TradeSide, BybitPosition } from '../types/index.js';

const logger = createLogger('position-tracker');

/**
 * Position Tracker
 * Tracks open positions and syncs with Bybit
 */

export interface TrackedPosition {
  symbol: string;
  side: TradeSide;
  size: number;
  avgPrice: number;
  leverage: number;
  unrealizedPnl: number;
  markPrice: number;
  liqPrice: number | null;
  stopLoss: number | null;
  takeProfit: number | null;
  updatedAt: number;
}

export interface PositionTrackerEvents {
  positionOpened: (position: TrackedPosition) => void;
  positionUpdated: (position: TrackedPosition) => void;
  positionClosed: (symbol: string, side: TradeSide, realizedPnl: number) => void;
  pnlUpdate: (symbol: string, pnl: number, pnlPercent: number) => void;
  error: (error: Error) => void;
}

export class PositionTracker extends EventEmitter<PositionTrackerEvents> {
  private positions: Map<string, TrackedPosition> = new Map();
  private privateWs = getPrivateWebSocket();

  constructor() {
    super();
    this.setupWebSocketHandlers();
  }

  private setupWebSocketHandlers(): void {
    this.privateWs.on('position', (update) => {
      this.handlePositionUpdate(update);
    });
  }

  private handlePositionUpdate(update: PositionUpdate): void {
    const symbol = update.symbol;
    const size = parseFloat(update.size);
    
    if (size === 0) {
      // Position closed
      const existing = this.positions.get(symbol);
      if (existing) {
        // Get realized P&L from the update (cumRealisedPnl from Bybit)
        const realizedPnl = parseFloat(update.cumRealisedPnl || '0');
        this.positions.delete(symbol);
        this.emit('positionClosed', symbol, existing.side, realizedPnl);
        logger.info({ symbol, side: existing.side, realizedPnl }, 'Position closed');
      }
      return;
    }

    const side: TradeSide = update.side === 'Buy' ? 'LONG' : 'SHORT';
    const existing = this.positions.get(symbol);
    
    // Parse values, keeping existing if new value is invalid or zero
    const parsedAvgPrice = parseFloat(update.avgPrice);
    const parsedLeverage = parseFloat(update.leverage);
    const parsedUnrealizedPnl = parseFloat(update.unrealisedPnl);
    const parsedMarkPrice = parseFloat(update.markPrice);
    const parsedLiqPrice = parseFloat(update.liqPrice);
    
    // For markPrice: only use new value if it's valid AND non-zero
    // (Bybit sometimes sends 0 in updates which is incorrect)
    const validMarkPrice = !isNaN(parsedMarkPrice) && parsedMarkPrice > 0 
      ? parsedMarkPrice 
      : (existing?.markPrice ?? 0);
    
    const position: TrackedPosition = {
      symbol,
      side,
      size,
      // Keep existing avgPrice if new one is NaN (WebSocket might not always send it)
      avgPrice: !isNaN(parsedAvgPrice) && parsedAvgPrice > 0 ? parsedAvgPrice : (existing?.avgPrice ?? 0),
      leverage: !isNaN(parsedLeverage) && parsedLeverage > 0 ? parsedLeverage : (existing?.leverage ?? 1),
      unrealizedPnl: !isNaN(parsedUnrealizedPnl) ? parsedUnrealizedPnl : (existing?.unrealizedPnl ?? 0),
      markPrice: validMarkPrice,
      liqPrice: !isNaN(parsedLiqPrice) && parsedLiqPrice > 0 ? parsedLiqPrice : (existing?.liqPrice ?? null),
      stopLoss: update.stopLoss ? parseFloat(update.stopLoss) : (existing?.stopLoss ?? null),
      takeProfit: update.takeProfit ? parseFloat(update.takeProfit) : (existing?.takeProfit ?? null),
      updatedAt: Date.now(),
    };
    
    if (!existing) {
      // New position
      this.positions.set(symbol, position);
      this.emit('positionOpened', position);
      logger.info({ symbol, side, size, avgPrice: position.avgPrice }, 'Position opened');
    } else {
      // Updated position
      this.positions.set(symbol, position);
      this.emit('positionUpdated', position);
      
      // Calculate PnL percent (avoid division by zero)
      const positionValue = position.avgPrice * position.size;
      const pnlPercent = positionValue > 0 ? (position.unrealizedPnl / positionValue) * 100 : 0;
      this.emit('pnlUpdate', symbol, position.unrealizedPnl, pnlPercent);
    }
  }

  /**
   * Initialize by fetching current positions from REST API
   */
  async initialize(): Promise<void> {
    try {
      const positions = await getAllPositions();
      
      for (const pos of positions) {
        const size = parseFloat(pos.size);
        if (size === 0) continue;

        const side: TradeSide = pos.side === 'Buy' ? 'LONG' : 'SHORT';
        const position: TrackedPosition = {
          symbol: pos.symbol,
          side,
          size,
          avgPrice: parseFloat(pos.avgPrice),
          leverage: parseFloat(pos.leverage),
          unrealizedPnl: parseFloat(pos.unrealisedPnl),
          markPrice: parseFloat(pos.markPrice),
          liqPrice: parseFloat(pos.liqPrice),
          stopLoss: pos.stopLoss ? parseFloat(pos.stopLoss) : null,
          takeProfit: pos.takeProfit ? parseFloat(pos.takeProfit) : null,
          updatedAt: Date.now(),
        };

        this.positions.set(pos.symbol, position);
      }

      logger.info({ count: this.positions.size }, 'Position tracker initialized');
    } catch (error) {
      logger.error({ error }, 'Failed to initialize position tracker');
      this.emit('error', error as Error);
    }
  }

  /**
   * Get position for a symbol
   */
  getPosition(symbol: string): TrackedPosition | null {
    return this.positions.get(symbol) ?? null;
  }

  /**
   * Get all positions
   */
  getAllPositions(): TrackedPosition[] {
    return Array.from(this.positions.values());
  }

  /**
   * Check if we have a position in a symbol
   */
  hasPosition(symbol: string): boolean {
    return this.positions.has(symbol);
  }

  /**
   * Get position side for a symbol
   */
  getPositionSide(symbol: string): TradeSide | null {
    const pos = this.positions.get(symbol);
    return pos?.side ?? null;
  }

  /**
   * Refresh position from REST API
   */
  async refreshPosition(symbol: string): Promise<TrackedPosition | null> {
    try {
      const pos = await getPosition(symbol);
      
      if (!pos || parseFloat(pos.size) === 0) {
        this.positions.delete(symbol);
        return null;
      }

      const side: TradeSide = pos.side === 'Buy' ? 'LONG' : 'SHORT';
      const position: TrackedPosition = {
        symbol: pos.symbol,
        side,
        size: parseFloat(pos.size),
        avgPrice: parseFloat(pos.avgPrice),
        leverage: parseFloat(pos.leverage),
        unrealizedPnl: parseFloat(pos.unrealisedPnl),
        markPrice: parseFloat(pos.markPrice),
        liqPrice: parseFloat(pos.liqPrice),
        stopLoss: pos.stopLoss ? parseFloat(pos.stopLoss) : null,
        takeProfit: pos.takeProfit ? parseFloat(pos.takeProfit) : null,
        updatedAt: Date.now(),
      };

      this.positions.set(symbol, position);
      return position;
    } catch (error) {
      logger.error({ error, symbol }, 'Failed to refresh position');
      return null;
    }
  }

  /**
   * Calculate R-multiple for a position given initial risk
   */
  calculateRMultiple(symbol: string, initialRiskUsdt: number): number | null {
    const position = this.positions.get(symbol);
    if (!position || initialRiskUsdt === 0) return null;

    return position.unrealizedPnl / initialRiskUsdt;
  }
}

// Singleton
let trackerInstance: PositionTracker | null = null;

export function getPositionTracker(): PositionTracker {
  if (!trackerInstance) {
    trackerInstance = new PositionTracker();
  }
  return trackerInstance;
}

