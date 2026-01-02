import { RestClientV5, type KlineIntervalV3 } from 'bybit-api';
import { config } from '../config/index.js';
import { bybitLogger as logger } from '../utils/logger.js';
import type { 
  Candle, 
  BybitPosition, 
  BybitOrder, 
  BybitTicker,
  TradeSide 
} from '../types/index.js';

/**
 * Bybit REST API Client
 * Handles all REST API calls to Bybit
 */

// Initialize the client
const client = new RestClientV5({
  key: config.bybit.apiKey,
  secret: config.bybit.apiSecret,
  testnet: config.bybit.testnet,
  recv_window: 5000,
});

// ============================================
// MARKET DATA
// ============================================

/**
 * Get historical klines/candles
 */
export async function getKlines(
  symbol: string,
  interval: string,
  limit: number = 200,
  startTime?: number,
  endTime?: number
): Promise<Candle[]> {
  try {
    const response = await client.getKline({
      category: 'linear',
      symbol,
      interval: interval as KlineIntervalV3,
      limit,
      start: startTime,
      end: endTime,
    });

    if (response.retCode !== 0) {
      throw new Error(`Bybit API error: ${response.retMsg}`);
    }

    // Bybit returns newest first, we want oldest first
    const klines = response.result.list.reverse();
    
    return klines.map((k) => ({
      symbol,
      timeframe: interval,
      openTime: parseInt(k[0]),
      closeTime: parseInt(k[0]) + getIntervalMs(interval) - 1,
      open: parseFloat(k[1]),
      high: parseFloat(k[2]),
      low: parseFloat(k[3]),
      close: parseFloat(k[4]),
      volume: parseFloat(k[5]),
    }));
  } catch (error) {
    logger.error({ error, symbol, interval }, 'Failed to fetch klines');
    throw error;
  }
}

/**
 * Get ticker data
 */
export async function getTicker(symbol: string): Promise<BybitTicker> {
  try {
    const response = await client.getTickers({
      category: 'linear',
      symbol,
    });

    if (response.retCode !== 0) {
      throw new Error(`Bybit API error: ${response.retMsg}`);
    }

    const ticker = response.result.list[0];
    return {
      symbol: ticker.symbol,
      lastPrice: ticker.lastPrice,
      highPrice24h: ticker.highPrice24h,
      lowPrice24h: ticker.lowPrice24h,
      prevPrice24h: ticker.prevPrice24h,
      volume24h: ticker.volume24h,
      bid1Price: ticker.bid1Price,
      ask1Price: ticker.ask1Price,
      markPrice: ticker.markPrice,
      indexPrice: ticker.indexPrice,
    };
  } catch (error) {
    logger.error({ error, symbol }, 'Failed to fetch ticker');
    throw error;
  }
}

// ============================================
// ACCOUNT DATA
// ============================================

/**
 * Get wallet balance
 */
export async function getWalletBalance(): Promise<{
  totalEquity: number;
  availableBalance: number;
  usedMargin: number;
}> {
  try {
    const response = await client.getWalletBalance({
      accountType: 'UNIFIED', // or 'CONTRACT' depending on account type
    });

    if (response.retCode !== 0) {
      throw new Error(`Bybit API error: ${response.retMsg}`);
    }

    const account = response.result.list[0];
    const usdtCoin = account.coin.find((c) => c.coin === 'USDT');

    return {
      totalEquity: parseFloat(usdtCoin?.equity || '0'),
      availableBalance: parseFloat(usdtCoin?.availableToWithdraw || '0'),
      usedMargin: parseFloat(usdtCoin?.totalPositionIM || '0'),
    };
  } catch (error) {
    logger.error({ error }, 'Failed to fetch wallet balance');
    throw error;
  }
}

/**
 * Get position for a symbol
 */
export async function getPosition(symbol: string): Promise<BybitPosition | null> {
  try {
    const response = await client.getPositionInfo({
      category: 'linear',
      symbol,
    });

    if (response.retCode !== 0) {
      throw new Error(`Bybit API error: ${response.retMsg}`);
    }

    const position = response.result.list[0];
    if (!position || parseFloat(position.size) === 0) {
      return null;
    }

    return {
      symbol: position.symbol,
      side: position.side as 'Buy' | 'Sell' | 'None',
      size: position.size,
      avgPrice: position.avgPrice,
      leverage: position.leverage || '1',
      unrealisedPnl: position.unrealisedPnl,
      positionValue: position.positionValue,
      liqPrice: position.liqPrice,
      markPrice: position.markPrice,
      takeProfit: position.takeProfit || '0',
      stopLoss: position.stopLoss || '0',
    };
  } catch (error) {
    logger.error({ error, symbol }, 'Failed to fetch position');
    throw error;
  }
}

/**
 * Get all open positions
 */
export async function getAllPositions(): Promise<BybitPosition[]> {
  try {
    const response = await client.getPositionInfo({
      category: 'linear',
      settleCoin: 'USDT',
    });

    if (response.retCode !== 0) {
      throw new Error(`Bybit API error: ${response.retMsg}`);
    }

    return response.result.list
      .filter((p) => parseFloat(p.size) > 0)
      .map((p) => ({
        symbol: p.symbol,
        side: p.side as 'Buy' | 'Sell' | 'None',
        size: p.size,
        avgPrice: p.avgPrice,
        leverage: p.leverage || '1',
        unrealisedPnl: p.unrealisedPnl,
        positionValue: p.positionValue,
        liqPrice: p.liqPrice,
        markPrice: p.markPrice,
        takeProfit: p.takeProfit || '0',
        stopLoss: p.stopLoss || '0',
      }));
  } catch (error) {
    logger.error({ error }, 'Failed to fetch all positions');
    throw error;
  }
}

// ============================================
// LEVERAGE
// ============================================

/**
 * Set leverage for a symbol
 * Returns the actual leverage set
 */
export async function setLeverage(
  symbol: string, 
  leverage: number
): Promise<number> {
  // Enforce max leverage
  const maxLeverage = config.trading.maxLeverage;
  const appliedLeverage = Math.min(leverage, maxLeverage);
  
  if (leverage > maxLeverage) {
    logger.warn(
      { symbol, requested: leverage, applied: appliedLeverage },
      'Leverage clamped to max'
    );
  }

  try {
    const response = await client.setLeverage({
      category: 'linear',
      symbol,
      buyLeverage: appliedLeverage.toString(),
      sellLeverage: appliedLeverage.toString(),
    });

    // retCode 110043 means leverage already set to this value - that's ok
    if (response.retCode !== 0 && response.retCode !== 110043) {
      throw new Error(`Bybit API error: ${response.retMsg}`);
    }

    logger.info({ symbol, leverage: appliedLeverage }, 'Leverage set');
    return appliedLeverage;
  } catch (error) {
    logger.error({ error, symbol, leverage: appliedLeverage }, 'Failed to set leverage');
    throw error;
  }
}

// ============================================
// ORDERS
// ============================================

/**
 * Place a market order
 */
export async function placeMarketOrder(params: {
  symbol: string;
  side: TradeSide;
  qty: number;
  reduceOnly?: boolean;
  orderLinkId?: string;
}): Promise<{ orderId: string; orderLinkId: string }> {
  const bybitSide = params.side === 'LONG' ? 'Buy' : 'Sell';
  
  try {
    const response = await client.submitOrder({
      category: 'linear',
      symbol: params.symbol,
      side: bybitSide,
      orderType: 'Market',
      qty: params.qty.toString(),
      reduceOnly: params.reduceOnly || false,
      orderLinkId: params.orderLinkId,
    });

    if (response.retCode !== 0) {
      throw new Error(`Bybit API error: ${response.retMsg}`);
    }

    logger.info(
      { 
        symbol: params.symbol, 
        side: params.side, 
        qty: params.qty,
        orderId: response.result.orderId 
      }, 
      'Market order placed'
    );

    return {
      orderId: response.result.orderId,
      orderLinkId: response.result.orderLinkId,
    };
  } catch (error) {
    logger.error({ error, params }, 'Failed to place market order');
    throw error;
  }
}

/**
 * Place a limit order
 */
export async function placeLimitOrder(params: {
  symbol: string;
  side: TradeSide;
  qty: number;
  price: number;
  reduceOnly?: boolean;
  orderLinkId?: string;
}): Promise<{ orderId: string; orderLinkId: string }> {
  const bybitSide = params.side === 'LONG' ? 'Buy' : 'Sell';
  
  try {
    const response = await client.submitOrder({
      category: 'linear',
      symbol: params.symbol,
      side: bybitSide,
      orderType: 'Limit',
      qty: params.qty.toString(),
      price: params.price.toString(),
      reduceOnly: params.reduceOnly || false,
      orderLinkId: params.orderLinkId,
      timeInForce: 'GTC',
    });

    if (response.retCode !== 0) {
      throw new Error(`Bybit API error: ${response.retMsg}`);
    }

    logger.info(
      { 
        symbol: params.symbol, 
        side: params.side, 
        qty: params.qty,
        price: params.price,
        orderId: response.result.orderId 
      }, 
      'Limit order placed'
    );

    return {
      orderId: response.result.orderId,
      orderLinkId: response.result.orderLinkId,
    };
  } catch (error) {
    logger.error({ error, params }, 'Failed to place limit order');
    throw error;
  }
}

/**
 * Set stop loss for a position
 */
export async function setStopLoss(
  symbol: string,
  side: TradeSide,
  stopLossPrice: number
): Promise<void> {
  const positionIdx = 0; // One-way mode
  
  try {
    const response = await client.setTradingStop({
      category: 'linear',
      symbol,
      stopLoss: stopLossPrice.toString(),
      positionIdx,
    });

    if (response.retCode !== 0) {
      throw new Error(`Bybit API error: ${response.retMsg}`);
    }

    logger.info({ symbol, side, stopLossPrice }, 'Stop loss set');
  } catch (error) {
    logger.error({ error, symbol, stopLossPrice }, 'Failed to set stop loss');
    throw error;
  }
}

/**
 * Set take profit for a position
 */
export async function setTakeProfit(
  symbol: string,
  side: TradeSide,
  takeProfitPrice: number
): Promise<void> {
  const positionIdx = 0; // One-way mode
  
  try {
    const response = await client.setTradingStop({
      category: 'linear',
      symbol,
      takeProfit: takeProfitPrice.toString(),
      positionIdx,
    });

    if (response.retCode !== 0) {
      throw new Error(`Bybit API error: ${response.retMsg}`);
    }

    logger.info({ symbol, side, takeProfitPrice }, 'Take profit set');
  } catch (error) {
    logger.error({ error, symbol, takeProfitPrice }, 'Failed to set take profit');
    throw error;
  }
}

/**
 * Cancel an order
 */
export async function cancelOrder(
  symbol: string,
  orderId: string
): Promise<void> {
  try {
    const response = await client.cancelOrder({
      category: 'linear',
      symbol,
      orderId,
    });

    if (response.retCode !== 0) {
      throw new Error(`Bybit API error: ${response.retMsg}`);
    }

    logger.info({ symbol, orderId }, 'Order cancelled');
  } catch (error) {
    logger.error({ error, symbol, orderId }, 'Failed to cancel order');
    throw error;
  }
}

/**
 * Cancel all orders for a symbol
 */
export async function cancelAllOrders(symbol: string): Promise<void> {
  try {
    const response = await client.cancelAllOrders({
      category: 'linear',
      symbol,
    });

    if (response.retCode !== 0) {
      throw new Error(`Bybit API error: ${response.retMsg}`);
    }

    logger.info({ symbol }, 'All orders cancelled');
  } catch (error) {
    logger.error({ error, symbol }, 'Failed to cancel all orders');
    throw error;
  }
}

/**
 * Get open orders for a symbol
 */
export async function getOpenOrders(symbol?: string): Promise<BybitOrder[]> {
  try {
    const response = await client.getActiveOrders({
      category: 'linear',
      symbol,
      settleCoin: symbol ? undefined : 'USDT',
    });

    if (response.retCode !== 0) {
      throw new Error(`Bybit API error: ${response.retMsg}`);
    }

    return response.result.list.map((o) => ({
      orderId: o.orderId,
      orderLinkId: o.orderLinkId,
      symbol: o.symbol,
      side: o.side as 'Buy' | 'Sell',
      orderType: o.orderType as 'Market' | 'Limit',
      price: o.price,
      qty: o.qty,
      orderStatus: o.orderStatus,
      reduceOnly: o.reduceOnly,
      createdTime: o.createdTime,
      updatedTime: o.updatedTime,
    }));
  } catch (error) {
    logger.error({ error, symbol }, 'Failed to fetch open orders');
    throw error;
  }
}

// ============================================
// HELPERS
// ============================================

/**
 * Convert interval string to milliseconds
 */
function getIntervalMs(interval: string): number {
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
    'M': 30 * 24 * 60 * 60 * 1000,
  };
  return map[interval] || 5 * 60 * 1000;
}

/**
 * Get instrument info (for precision, lot sizes, etc.)
 */
export async function getInstrumentInfo(symbol: string) {
  try {
    const response = await client.getInstrumentsInfo({
      category: 'linear',
      symbol,
    });

    if (response.retCode !== 0) {
      throw new Error(`Bybit API error: ${response.retMsg}`);
    }

    const info = response.result.list[0];
    return {
      symbol: info.symbol,
      baseCoin: info.baseCoin,
      quoteCoin: info.quoteCoin,
      minOrderQty: parseFloat(info.lotSizeFilter.minOrderQty),
      maxOrderQty: parseFloat(info.lotSizeFilter.maxOrderQty),
      qtyStep: parseFloat(info.lotSizeFilter.qtyStep),
      minPrice: parseFloat(info.priceFilter.minPrice),
      maxPrice: parseFloat(info.priceFilter.maxPrice),
      tickSize: parseFloat(info.priceFilter.tickSize),
      minLeverage: parseFloat(info.leverageFilter.minLeverage),
      maxLeverage: parseFloat(info.leverageFilter.maxLeverage),
      leverageStep: parseFloat(info.leverageFilter.leverageStep),
    };
  } catch (error) {
    logger.error({ error, symbol }, 'Failed to fetch instrument info');
    throw error;
  }
}

export { client as bybitClient };

