import { EventEmitter } from 'eventemitter3';
import { v4 as uuid } from 'uuid';
import { prisma } from '../db/index.js';
import { getPrivateWebSocket, OrderUpdate, ExecutionUpdate } from '../bybit/private-ws.js';
import {
  placeMarketOrder,
  placeLimitOrder,
  cancelOrder,
  cancelAllOrders,
  getOpenOrders,
} from '../bybit/rest-client.js';
import { createLogger } from '../utils/logger.js';
import type { TradeSide, OrderType } from '../types/index.js';

const logger = createLogger('order-manager');

/**
 * Order Manager
 * Handles order placement, tracking, and cancellation
 */

export interface ManagedOrder {
  id: string;
  symbol: string;
  bybitOrderId: string | null;
  side: TradeSide;
  orderType: OrderType;
  price: number | null;
  size: number;
  filledSize: number;
  avgFillPrice: number | null;
  status: 'PENDING' | 'OPEN' | 'PARTIALLY_FILLED' | 'FILLED' | 'CANCELLED' | 'REJECTED';
  reduceOnly: boolean;
  isEntry: boolean;
  isExit: boolean;
  isStopLoss: boolean;
  isTakeProfit: boolean;
  tradeId: string | null;
  createdAt: number;
  updatedAt: number;
  errorMessage: string | null;
}

export interface OrderFill {
  orderId: string;
  execId: string;
  price: number;
  size: number;
  fee: number;
  filledAt: number;
}

export interface OrderManagerEvents {
  orderPlaced: (order: ManagedOrder) => void;
  orderFilled: (order: ManagedOrder, fill: OrderFill) => void;
  orderPartiallyFilled: (order: ManagedOrder, fill: OrderFill) => void;
  orderCancelled: (order: ManagedOrder) => void;
  orderRejected: (order: ManagedOrder, reason: string) => void;
  error: (error: Error) => void;
}

export class OrderManager extends EventEmitter<OrderManagerEvents> {
  private orders: Map<string, ManagedOrder> = new Map(); // our ID -> order
  private bybitIdMap: Map<string, string> = new Map(); // bybit ID -> our ID
  private privateWs = getPrivateWebSocket();

  constructor() {
    super();
    this.setupWebSocketHandlers();
  }

  private setupWebSocketHandlers(): void {
    this.privateWs.on('order', (update) => {
      this.handleOrderUpdate(update);
    });

    this.privateWs.on('execution', (update) => {
      this.handleExecutionUpdate(update);
    });
  }

  private handleOrderUpdate(update: OrderUpdate): void {
    const ourId = this.bybitIdMap.get(update.orderId);
    if (!ourId) return; // Not our order

    const order = this.orders.get(ourId);
    if (!order) return;

    // Update order status
    const prevStatus = order.status;
    order.status = this.mapOrderStatus(update.orderStatus);
    order.filledSize = parseFloat(update.cumExecQty);
    order.avgFillPrice = parseFloat(update.cumExecValue) / parseFloat(update.cumExecQty) || null;
    order.updatedAt = Date.now();

    this.orders.set(ourId, order);

    // Emit events based on status change
    if (order.status === 'CANCELLED' && prevStatus !== 'CANCELLED') {
      this.emit('orderCancelled', order);
      logger.info({ orderId: ourId, symbol: order.symbol }, 'Order cancelled');
    } else if (order.status === 'REJECTED') {
      order.errorMessage = update.orderStatus;
      this.emit('orderRejected', order, update.orderStatus);
      logger.warn({ orderId: ourId, symbol: order.symbol, reason: update.orderStatus }, 'Order rejected');
    }
  }

  private handleExecutionUpdate(update: ExecutionUpdate): void {
    const ourId = this.bybitIdMap.get(update.orderId);
    if (!ourId) return;

    const order = this.orders.get(ourId);
    if (!order) return;

    const fill: OrderFill = {
      orderId: ourId,
      execId: update.execId,
      price: parseFloat(update.execPrice),
      size: parseFloat(update.execQty),
      fee: parseFloat(update.execFee),
      filledAt: parseInt(update.execTime),
    };

    order.filledSize += fill.size;
    order.avgFillPrice = parseFloat(update.execPrice); // Simplified
    order.updatedAt = Date.now();

    // Check if fully filled
    if (order.filledSize >= order.size * 0.999) { // 99.9% tolerance
      order.status = 'FILLED';
      this.emit('orderFilled', order, fill);
      logger.info(
        { orderId: ourId, symbol: order.symbol, price: fill.price, size: fill.size },
        'Order filled'
      );
    } else {
      order.status = 'PARTIALLY_FILLED';
      this.emit('orderPartiallyFilled', order, fill);
      logger.info(
        { orderId: ourId, symbol: order.symbol, filled: order.filledSize, total: order.size },
        'Order partially filled'
      );
    }

    this.orders.set(ourId, order);

    // Save fill to database
    this.saveFill(order, fill);
  }

  private mapOrderStatus(status: string): ManagedOrder['status'] {
    const map: Record<string, ManagedOrder['status']> = {
      'New': 'OPEN',
      'PartiallyFilled': 'PARTIALLY_FILLED',
      'Filled': 'FILLED',
      'Cancelled': 'CANCELLED',
      'Rejected': 'REJECTED',
      'PendingCancel': 'OPEN',
    };
    return map[status] || 'PENDING';
  }

  /**
   * Place a market order with optional SL/TP attached atomically
   */
  async placeMarket(params: {
    symbol: string;
    side: TradeSide;
    size: number;
    reduceOnly?: boolean;
    tradeId?: string;
    isEntry?: boolean;
    isExit?: boolean;
    stopLoss?: number;
    takeProfit?: number;
  }): Promise<ManagedOrder> {
    const orderId = uuid();
    
    const order: ManagedOrder = {
      id: orderId,
      symbol: params.symbol,
      bybitOrderId: null,
      side: params.side,
      orderType: 'MARKET',
      price: null,
      size: params.size,
      filledSize: 0,
      avgFillPrice: null,
      status: 'PENDING',
      reduceOnly: params.reduceOnly ?? false,
      isEntry: params.isEntry ?? false,
      isExit: params.isExit ?? false,
      isStopLoss: false,
      isTakeProfit: false,
      tradeId: params.tradeId ?? null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      errorMessage: null,
    };

    this.orders.set(orderId, order);

    try {
      const result = await placeMarketOrder({
        symbol: params.symbol,
        side: params.side,
        qty: params.size,
        reduceOnly: params.reduceOnly,
        orderLinkId: orderId,
        stopLoss: params.stopLoss,
        takeProfit: params.takeProfit,
      });

      order.bybitOrderId = result.orderId;
      order.status = 'OPEN';
      this.bybitIdMap.set(result.orderId, orderId);
      this.orders.set(orderId, order);

      this.emit('orderPlaced', order);
      logger.info(
        { orderId, symbol: params.symbol, side: params.side, size: params.size },
        'Market order placed'
      );

      // Save to database
      await this.saveOrder(order);

      return order;
    } catch (error) {
      order.status = 'REJECTED';
      order.errorMessage = (error as Error).message;
      this.orders.set(orderId, order);
      
      this.emit('orderRejected', order, order.errorMessage);
      logger.error({ error, orderId }, 'Failed to place market order');
      
      throw error;
    }
  }

  /**
   * Place a limit order (sent to Bybit immediately, waits for fill)
   */
  async placeLimit(params: {
    symbol: string;
    side: TradeSide;
    size: number;
    price: number;
    reduceOnly?: boolean;
    tradeId?: string;
    isEntry?: boolean;
    isExit?: boolean;
    isStopLoss?: boolean;
    isTakeProfit?: boolean;
    stopLoss?: number;
    takeProfit?: number;
  }): Promise<ManagedOrder> {
    const orderId = uuid();
    
    const order: ManagedOrder = {
      id: orderId,
      symbol: params.symbol,
      bybitOrderId: null,
      side: params.side,
      orderType: 'LIMIT',
      price: params.price,
      size: params.size,
      filledSize: 0,
      avgFillPrice: null,
      status: 'PENDING',
      reduceOnly: params.reduceOnly ?? false,
      isEntry: params.isEntry ?? false,
      isExit: params.isExit ?? false,
      isStopLoss: params.isStopLoss ?? false,
      isTakeProfit: params.isTakeProfit ?? false,
      tradeId: params.tradeId ?? null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      errorMessage: null,
    };

    this.orders.set(orderId, order);

    try {
      const result = await placeLimitOrder({
        symbol: params.symbol,
        side: params.side,
        qty: params.size,
        price: params.price,
        reduceOnly: params.reduceOnly,
        orderLinkId: orderId,
        stopLoss: params.stopLoss,
        takeProfit: params.takeProfit,
      });

      order.bybitOrderId = result.orderId;
      order.status = 'OPEN';
      this.bybitIdMap.set(result.orderId, orderId);
      this.orders.set(orderId, order);

      this.emit('orderPlaced', order);
      logger.info(
        { orderId, symbol: params.symbol, side: params.side, size: params.size, price: params.price },
        'Limit order placed'
      );

      await this.saveOrder(order);

      return order;
    } catch (error) {
      order.status = 'REJECTED';
      order.errorMessage = (error as Error).message;
      this.orders.set(orderId, order);
      
      this.emit('orderRejected', order, order.errorMessage);
      logger.error({ error, orderId }, 'Failed to place limit order');
      
      throw error;
    }
  }

  /**
   * Cancel an order
   */
  async cancel(orderId: string): Promise<void> {
    const order = this.orders.get(orderId);
    if (!order || !order.bybitOrderId) {
      throw new Error(`Order not found: ${orderId}`);
    }

    try {
      await cancelOrder(order.symbol, order.bybitOrderId);
      order.status = 'CANCELLED';
      order.updatedAt = Date.now();
      this.orders.set(orderId, order);
      
      this.emit('orderCancelled', order);
    } catch (error) {
      logger.error({ error, orderId }, 'Failed to cancel order');
      throw error;
    }
  }

  /**
   * Cancel all orders for a symbol
   */
  async cancelAll(symbol: string): Promise<void> {
    try {
      await cancelAllOrders(symbol);
      
      // Update local state
      for (const [id, order] of this.orders) {
        if (order.symbol === symbol && order.status === 'OPEN') {
          order.status = 'CANCELLED';
          order.updatedAt = Date.now();
          this.orders.set(id, order);
        }
      }
      
      logger.info({ symbol }, 'All orders cancelled');
    } catch (error) {
      logger.error({ error, symbol }, 'Failed to cancel all orders');
      throw error;
    }
  }

  /**
   * Get order by ID
   */
  getOrder(orderId: string): ManagedOrder | null {
    return this.orders.get(orderId) ?? null;
  }

  /**
   * Get all orders for a symbol
   */
  getOrdersForSymbol(symbol: string): ManagedOrder[] {
    return Array.from(this.orders.values()).filter(o => o.symbol === symbol);
  }

  /**
   * Get open orders for a symbol
   */
  getOpenOrdersForSymbol(symbol: string): ManagedOrder[] {
    return Array.from(this.orders.values()).filter(
      o => o.symbol === symbol && (o.status === 'OPEN' || o.status === 'PARTIALLY_FILLED')
    );
  }

  /**
   * Save order to database
   */
  private async saveOrder(order: ManagedOrder): Promise<void> {
    try {
      await prisma.order.create({
        data: {
          id: order.id,
          symbol: order.symbol,
          bybitOrderId: order.bybitOrderId,
          side: order.side,
          orderType: order.orderType,
          price: order.price,
          size: order.size,
          reduceOnly: order.reduceOnly,
          status: order.status,
          isEntry: order.isEntry,
          isExit: order.isExit,
          isStopLoss: order.isStopLoss,
          isTakeProfit: order.isTakeProfit,
          tradeId: order.tradeId,
        },
      });
    } catch (error) {
      logger.error({ error, orderId: order.id }, 'Failed to save order');
    }
  }

  /**
   * Save fill to database
   */
  private async saveFill(order: ManagedOrder, fill: OrderFill): Promise<void> {
    try {
      await prisma.fill.create({
        data: {
          orderId: order.id,
          tradeId: order.tradeId,
          bybitExecId: fill.execId,
          price: fill.price,
          size: fill.size,
          fee: fill.fee,
          filledAt: new Date(fill.filledAt),
        },
      });

      // Update order in database
      await prisma.order.update({
        where: { id: order.id },
        data: {
          status: order.status,
          filledSize: order.filledSize,
          avgFillPrice: order.avgFillPrice,
          filledAt: order.status === 'FILLED' ? new Date() : undefined,
        },
      });
    } catch (error) {
      logger.error({ error, orderId: order.id }, 'Failed to save fill');
    }
  }
}

// Singleton
let managerInstance: OrderManager | null = null;

export function getOrderManager(): OrderManager {
  if (!managerInstance) {
    managerInstance = new OrderManager();
  }
  return managerInstance;
}

