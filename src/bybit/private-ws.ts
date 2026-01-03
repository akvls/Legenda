import { WebsocketClient, WSClientConfigurableOptions } from 'bybit-api';
import { EventEmitter } from 'eventemitter3';
import { config } from '../config/index.js';
import { wsLogger as logger } from '../utils/logger.js';

/**
 * Bybit Private WebSocket Client
 * Handles private account streams (orders, fills, positions)
 */

// Types for private WS updates
export interface OrderUpdate {
  orderId: string;
  orderLinkId: string;
  symbol: string;
  side: 'Buy' | 'Sell';
  orderType: 'Market' | 'Limit';
  price: string;
  qty: string;
  leavesQty: string;
  cumExecQty: string;
  cumExecValue: string;
  cumExecFee: string;
  orderStatus: string;
  reduceOnly: boolean;
  stopOrderType: string;
  triggerPrice: string;
  createdTime: string;
  updatedTime: string;
}

export interface ExecutionUpdate {
  execId: string;
  orderId: string;
  orderLinkId: string;
  symbol: string;
  side: 'Buy' | 'Sell';
  orderType: 'Market' | 'Limit';
  execPrice: string;
  execQty: string;
  execValue: string;
  execFee: string;
  feeRate: string;
  execType: string;
  execTime: string;
}

export interface PositionUpdate {
  symbol: string;
  side: 'Buy' | 'Sell' | 'None';
  size: string;
  avgPrice: string;
  positionValue: string;
  leverage: string;
  markPrice: string;
  positionIM: string;
  positionMM: string;
  unrealisedPnl: string;
  cumRealisedPnl: string;
  takeProfit: string;
  stopLoss: string;
  liqPrice: string;
  positionStatus: string;
  updatedTime: string;
}

export interface WalletUpdate {
  accountType: string;
  coin: Array<{
    coin: string;
    equity: string;
    usdValue: string;
    walletBalance: string;
    borrowAmount: string;
    availableToBorrow: string;
    availableToWithdraw: string;
    unrealisedPnl: string;
    cumRealisedPnl: string;
    marginCollateral: boolean;
    isCollateral: boolean;
    collateralSwitch: boolean;
  }>;
}

export interface PrivateWSEvents {
  order: (update: OrderUpdate) => void;
  execution: (update: ExecutionUpdate) => void;
  position: (update: PositionUpdate) => void;
  wallet: (update: WalletUpdate) => void;
  connected: () => void;
  disconnected: () => void;
  authenticated: () => void;
  error: (error: Error) => void;
  reconnecting: () => void;
  stateResyncNeeded: () => void;
}

export class PrivateWebSocket extends EventEmitter<PrivateWSEvents> {
  private ws: WebsocketClient;
  private isConnected: boolean = false;
  private isAuthenticated: boolean = false;

  constructor() {
    super();

    const wsConfig: WSClientConfigurableOptions = {
      key: config.bybit.apiKey,
      secret: config.bybit.apiSecret,
      market: 'v5',
      testnet: config.bybit.testnet,
    };

    this.ws = new WebsocketClient(wsConfig);
    this.setupEventHandlers();
  }

  private setupEventHandlers(): void {
    // Connection opened
    this.ws.on('open', ({ wsKey }) => {
      logger.info({ wsKey }, 'Private WebSocket connected');
      this.isConnected = true;
      this.emit('connected');
    });

    // Connection closed
    this.ws.on('close', () => {
      logger.warn('Private WebSocket disconnected');
      this.isConnected = false;
      this.isAuthenticated = false;
      this.emit('disconnected');
    });

    // Reconnecting
    this.ws.on('reconnect', ({ wsKey }) => {
      logger.info({ wsKey }, 'Private WebSocket reconnecting...');
      this.emit('reconnecting');
    });

    // Reconnected
    this.ws.on('reconnected', ({ wsKey }) => {
      logger.info({ wsKey }, 'Private WebSocket reconnected');
      this.isConnected = true;
      this.emit('connected');
      // Emit reconnected event for state re-sync
      this.emit('stateResyncNeeded');
    });

    // Response to subscription/auth
    this.ws.on('response', (response) => {
      if (response.op === 'auth') {
        if (response.success) {
          logger.info('Private WebSocket authenticated');
          this.isAuthenticated = true;
          this.emit('authenticated');
          this.subscribeToPrivateTopics();
        } else {
          logger.error({ response }, 'Private WebSocket authentication failed');
          this.emit('error', new Error('Authentication failed'));
        }
      } else if (response.success) {
        logger.debug({ response }, 'Private subscription confirmed');
      } else {
        logger.error({ response }, 'Private subscription failed');
      }
    });

    // Handle incoming data
    this.ws.on('update', (data) => {
      this.handleUpdate(data);
    });

    // Error
    this.ws.on('error', (error) => {
      logger.error({ error }, 'Private WebSocket error');
      this.emit('error', error as Error);
    });
  }

  private handleUpdate(data: Record<string, unknown>): void {
    const topic = data.topic as string;
    
    if (!topic) return;

    // Handle order updates
    if (topic === 'order') {
      this.handleOrderUpdate(data);
    }
    // Handle execution (fill) updates
    else if (topic === 'execution') {
      this.handleExecutionUpdate(data);
    }
    // Handle position updates
    else if (topic === 'position') {
      this.handlePositionUpdate(data);
    }
    // Handle wallet updates
    else if (topic === 'wallet') {
      this.handleWalletUpdate(data);
    }
  }

  private handleOrderUpdate(data: Record<string, unknown>): void {
    const orders = data.data as OrderUpdate[];
    
    for (const order of orders) {
      logger.debug(
        { 
          orderId: order.orderId, 
          symbol: order.symbol, 
          status: order.orderStatus 
        }, 
        'Order update received'
      );
      this.emit('order', order);
    }
  }

  private handleExecutionUpdate(data: Record<string, unknown>): void {
    const executions = data.data as ExecutionUpdate[];
    
    for (const execution of executions) {
      logger.debug(
        { 
          execId: execution.execId, 
          orderId: execution.orderId,
          symbol: execution.symbol,
          price: execution.execPrice,
          qty: execution.execQty
        }, 
        'Execution (fill) received'
      );
      this.emit('execution', execution);
    }
  }

  private handlePositionUpdate(data: Record<string, unknown>): void {
    const positions = data.data as PositionUpdate[];
    
    for (const position of positions) {
      logger.debug(
        { 
          symbol: position.symbol, 
          side: position.side,
          size: position.size,
          pnl: position.unrealisedPnl
        }, 
        'Position update received'
      );
      this.emit('position', position);
    }
  }

  private handleWalletUpdate(data: Record<string, unknown>): void {
    const wallets = data.data as WalletUpdate[];
    
    for (const wallet of wallets) {
      logger.debug({ accountType: wallet.accountType }, 'Wallet update received');
      this.emit('wallet', wallet);
    }
  }

  /**
   * Subscribe to private topics after authentication
   */
  private subscribeToPrivateTopics(): void {
    // Subscribe to order updates
    this.ws.subscribeV5('order', 'linear');
    
    // Subscribe to execution (fill) updates
    this.ws.subscribeV5('execution', 'linear');
    
    // Subscribe to position updates
    this.ws.subscribeV5('position', 'linear');
    
    // Subscribe to wallet updates
    this.ws.subscribeV5('wallet', 'linear');
    
    logger.info('Subscribed to private topics');
  }

  /**
   * Start the connection (authentication happens automatically)
   */
  connect(): void {
    // The bybit-api library handles authentication automatically
    // when key/secret are provided. We just need to subscribe.
    // Subscribing to any private topic will trigger the connection.
    this.ws.subscribeV5('order', 'linear');
  }

  /**
   * Check if connected
   */
  getConnectionStatus(): { connected: boolean; authenticated: boolean } {
    return {
      connected: this.isConnected,
      authenticated: this.isAuthenticated,
    };
  }

  /**
   * Close the WebSocket connection
   */
  close(): void {
    this.ws.closeAll();
    this.isConnected = false;
    this.isAuthenticated = false;
    logger.info('Private WebSocket closed');
  }
}

// Singleton instance
let privateWsInstance: PrivateWebSocket | null = null;

export function getPrivateWebSocket(): PrivateWebSocket {
  if (!privateWsInstance) {
    privateWsInstance = new PrivateWebSocket();
  }
  return privateWsInstance;
}

export function closePrivateWebSocket(): void {
  if (privateWsInstance) {
    privateWsInstance.close();
    privateWsInstance = null;
  }
}

