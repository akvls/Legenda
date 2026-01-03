import { WebSocketServer, WebSocket } from 'ws';
import type { Server } from 'http';
import { logger } from '../utils/logger.js';
import { getPositionTracker } from '../execution/position-tracker.js';
import { getStrategyEngine } from '../strategy/engine.js';
import { getMarketWebSocket } from '../bybit/market-ws.js';
import { getSLManager } from '../execution/sl-manager.js';
import { getTradeExecutor } from '../execution/trade-executor.js';
import { smartOrchestrator } from '../agent/smart-orchestrator.js';
import { getHourlyCheckin, getPositionCloseFeedback, type HourlyCheckinData, type PositionCloseData } from '../agent/llm-service.js';
import { getWalletBalance } from '../bybit/rest-client.js';

/**
 * WebSocket server for frontend real-time updates
 * Broadcasts position updates, strategy state changes, and prices
 */

interface WSMessage {
  type: 'position' | 'strategy' | 'price' | 'ticker' | 'circuitBreaker' | 'watch' | 'trade' | 'trailUpdate' | 'legendaAdvice' | 'ping';
  data: any;
  timestamp: number;
}

// Track subscribed tickers to avoid duplicates
const subscribedTickers = new Set<string>();

// Track symbols with positions for auto-cleanup (symbol -> lastActivityTime)
const positionSymbols = new Map<string, number>();

// Cleanup interval: 24 hours
const SYMBOL_CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000;

// Hourly check-in interval: 1 hour
const HOURLY_CHECKIN_INTERVAL_MS = 60 * 60 * 1000;

// Track wallet balance for 24hr performance
let walletBalance24hAgo: number | null = null;
let walletBalanceHistory: { time: number; balance: number }[] = [];

let wss: WebSocketServer | null = null;
const clients = new Set<WebSocket>();
let cleanupInterval: ReturnType<typeof setInterval> | null = null;
let hourlyCheckinInterval: ReturnType<typeof setInterval> | null = null;

/**
 * Initialize WebSocket server on existing HTTP server
 */
export function initFrontendWebSocket(server: Server): void {
  wss = new WebSocketServer({ server, path: '/ws' });

  wss.on('connection', (ws) => {
    clients.add(ws);
    logger.info({ clientCount: clients.size }, 'Frontend WebSocket client connected');

    // Send initial state on connect
    sendInitialState(ws);

    ws.on('message', (message) => {
      try {
        const msg = JSON.parse(message.toString());
        if (msg.type === 'ping') {
          ws.send(JSON.stringify({ type: 'pong', timestamp: Date.now() }));
        }
      } catch (e) {
        // Ignore invalid messages
      }
    });

    ws.on('close', () => {
      clients.delete(ws);
      logger.debug({ clientCount: clients.size }, 'Frontend WebSocket client disconnected');
    });

    ws.on('error', (error) => {
      logger.error({ error }, 'Frontend WebSocket error');
      clients.delete(ws);
    });
  });

  // Set up event listeners for real-time broadcasts
  setupEventListeners();
  
  // Auto-register symbols for existing positions on startup
  const positionTracker = getPositionTracker();
  const existingPositions = positionTracker.getAllPositions();
  existingPositions.forEach(pos => {
    autoRegisterSymbol(pos.symbol);
  });
  
  if (existingPositions.length > 0) {
    logger.info({ symbols: existingPositions.map(p => p.symbol) }, 'Auto-registering symbols for existing positions');
  }

  // Set up cleanup interval (check every hour, remove after 24h of no activity)
  cleanupInterval = setInterval(() => {
    const now = Date.now();
    const positionTracker = getPositionTracker();
    
    positionSymbols.forEach((lastActivity, symbol) => {
      // Only cleanup if no open position AND 24h since last activity
      if (!positionTracker.getPosition(symbol) && now - lastActivity > SYMBOL_CLEANUP_INTERVAL_MS) {
        positionSymbols.delete(symbol);
        logger.info({ symbol, hoursInactive: Math.round((now - lastActivity) / (60 * 60 * 1000)) }, 'Symbol cleaned up after inactivity');
        // Note: We don't unsubscribe from strategy engine - it keeps running
        // This just tracks which symbols were auto-registered for positions
      }
    });
  }, 60 * 60 * 1000); // Check every hour

  // Start Legenda's hourly check-in for open positions
  startHourlyCheckin();

  logger.info('Frontend WebSocket server initialized on /ws');
}

/**
 * Auto-register a symbol with the strategy engine if not already registered
 * This ensures positions always have market data available
 */
async function autoRegisterSymbol(symbol: string): Promise<void> {
  const strategyEngine = getStrategyEngine();
  const marketWs = getMarketWebSocket();
  
  // Check if already registered
  if (strategyEngine.getState(symbol)) {
    // Already registered, just update activity timestamp
    positionSymbols.set(symbol, Date.now());
    return;
  }
  
  try {
    // Register with strategy engine (this also subscribes to candles)
    await strategyEngine.registerSymbol(symbol);
    positionSymbols.set(symbol, Date.now());
    logger.info({ symbol }, 'Auto-registered symbol for position tracking');
  } catch (error) {
    logger.error({ error, symbol }, 'Failed to auto-register symbol');
  }
  
  // Also subscribe to ticker if not already
  if (!subscribedTickers.has(symbol)) {
    subscribedTickers.add(symbol);
    marketWs.subscribeTicker(symbol);
  }
}

/**
 * Send initial state to newly connected client
 */
function sendInitialState(ws: WebSocket): void {
  const marketWs = getMarketWebSocket();
  
  // Send all positions and subscribe to tickers for position symbols
  const positionTracker = getPositionTracker();
  const positions = positionTracker.getAllPositions();
  send(ws, {
    type: 'position',
    data: { all: positions },
    timestamp: Date.now(),
  });

  // Subscribe to tickers AND auto-register for open positions
  positions.forEach(pos => {
    // Auto-register with strategy engine (async, don't wait)
    autoRegisterSymbol(pos.symbol);
    
    if (!subscribedTickers.has(pos.symbol)) {
      subscribedTickers.add(pos.symbol);
      marketWs.subscribeTicker(pos.symbol);
      logger.info({ symbol: pos.symbol }, 'Subscribed to ticker for open position');
    }
  });

  // Send all strategy states and subscribe to tickers
  const strategyEngine = getStrategyEngine();
  const states = strategyEngine.getAllStates();
  states.forEach(state => {
    send(ws, {
      type: 'strategy',
      data: state,
      timestamp: Date.now(),
    });
    
    // Ensure ticker is subscribed for this symbol
    if (!subscribedTickers.has(state.symbol)) {
      subscribedTickers.add(state.symbol);
      marketWs.subscribeTicker(state.symbol);
      logger.info({ symbol: state.symbol }, 'Subscribed to ticker on client connect');
    }
  });

  // Send circuit breaker status
  const cbStatus = smartOrchestrator.getCircuitBreakerStatus();
  send(ws, {
    type: 'circuitBreaker',
    data: cbStatus,
    timestamp: Date.now(),
  });
}

/**
 * Set up event listeners to broadcast updates
 */
function setupEventListeners(): void {
  const positionTracker = getPositionTracker();
  const strategyEngine = getStrategyEngine();
  const marketWs = getMarketWebSocket();

  // Position updates
  positionTracker.on('positionOpened', (position) => {
    broadcast({
      type: 'position',
      data: { opened: position },
      timestamp: Date.now(),
    });
    
    // Auto-register symbol with strategy engine for market data
    autoRegisterSymbol(position.symbol);
    
    // Subscribe to ticker for real-time P&L updates
    if (!subscribedTickers.has(position.symbol)) {
      subscribedTickers.add(position.symbol);
      marketWs.subscribeTicker(position.symbol);
      logger.info({ symbol: position.symbol }, 'Subscribed to ticker for new position');
    }
  });

  positionTracker.on('positionUpdated', (position) => {
    broadcast({
      type: 'position',
      data: { updated: position },
      timestamp: Date.now(),
    });
    
    // Update activity timestamp
    positionSymbols.set(position.symbol, Date.now());
  });

  positionTracker.on('positionClosed', async (symbol, side, realizedPnl) => {
    broadcast({
      type: 'position',
      data: { closed: { symbol, side, realizedPnl } },
      timestamp: Date.now(),
    });
    
    // Keep tracking for cleanup - will be removed after 24h of no activity
    positionSymbols.set(symbol, Date.now());
    
    // Get Legenda's feedback on the closed trade
    try {
      const executor = getTradeExecutor();
      const trade = executor.getLastClosedTrade?.(symbol);
      const wallet24hChange = await getWallet24hChange();
      
      const closeData: PositionCloseData = {
        symbol,
        side: side as 'LONG' | 'SHORT',
        entryPrice: trade?.entryPrice || 0,
        exitPrice: trade?.exitPrice || 0,
        realizedPnl: realizedPnl || 0,
        pnlPercent: trade?.entryPrice ? ((realizedPnl || 0) / (trade.entryPrice * (trade?.size || 1))) * 100 : 0,
        exitReason: (trade?.exitReason as any) || 'UNKNOWN',
        durationMinutes: trade?.createdAt ? (Date.now() - new Date(trade.createdAt).getTime()) / 60000 : 0,
        strategyWasValid: true, // Assume valid for now
        wallet24hChange,
      };
      
      const feedback = await getPositionCloseFeedback(closeData);
      
      broadcast({
        type: 'legendaAdvice',
        data: {
          adviceType: 'POSITION_CLOSED',
          symbol,
          message: feedback,
          pnl: realizedPnl,
          isWin: realizedPnl >= 0,
        },
        timestamp: Date.now(),
      });
      
      logger.info({ symbol, pnl: realizedPnl }, 'Sent Legenda position close feedback');
    } catch (error) {
      logger.error({ error, symbol }, 'Failed to get position close feedback');
    }
  });

  positionTracker.on('pnlUpdate', (symbol, pnl, pnlPercent) => {
    broadcast({
      type: 'position',
      data: { pnlUpdate: { symbol, pnl, pnlPercent } },
      timestamp: Date.now(),
    });
  });

  // Strategy state updates
  strategyEngine.on('stateUpdate', (state) => {
    broadcast({
      type: 'strategy',
      data: state,
      timestamp: Date.now(),
    });
    
    // Auto-subscribe to ticker for this symbol
    if (!subscribedTickers.has(state.symbol)) {
      subscribedTickers.add(state.symbol);
      marketWs.subscribeTicker(state.symbol);
      logger.info({ symbol: state.symbol }, 'Auto-subscribed to ticker for real-time price');
    }
  });

  // Real-time ticker/price updates (every ~100ms from Bybit)
  marketWs.on('ticker', (ticker) => {
    broadcast({
      type: 'ticker',
      data: {
        symbol: ticker.symbol,
        price: parseFloat(ticker.lastPrice),
        markPrice: parseFloat(ticker.markPrice),
        bid: parseFloat(ticker.bid1Price),
        ask: parseFloat(ticker.ask1Price),
        high24h: parseFloat(ticker.highPrice24h),
        low24h: parseFloat(ticker.lowPrice24h),
        volume24h: parseFloat(ticker.volume24h),
      },
      timestamp: Date.now(),
    });
  });

  // Trailing SL updates (triggered on candle close)
  const slManager = getSLManager();
  slManager.on('slLevelsUpdated', (symbol, levels) => {
    const positionTracker = getPositionTracker();
    const position = positionTracker.getPosition(symbol);
    const executor = getTradeExecutor();
    const trade = executor.getActiveTrade(symbol);
    const strategyEngine = getStrategyEngine();
    const strategyState = strategyEngine.getState(symbol);
    
    let nextTrailLevel: number | null = null;
    if (trade && trade.trail.active && strategyState) {
      if (trade.trail.mode === 'SUPERTREND') {
        nextTrailLevel = strategyState.snapshot.supertrendValue;
      } else if (trade.trail.mode === 'STRUCTURE') {
        nextTrailLevel = position?.side === 'LONG' 
          ? strategyState.keyLevels.protectedSwingLow 
          : strategyState.keyLevels.protectedSwingHigh;
      }
    }

    broadcast({
      type: 'trailUpdate',
      data: {
        symbol,
        strategicSL: levels.strategicSL,
        emergencySL: levels.emergencySL,
        trailMode: trade?.trail.mode || 'NONE',
        trailActive: trade?.trail.active || false,
        nextTrailLevel,
      },
      timestamp: Date.now(),
    });
    
    logger.info({ symbol, strategicSL: levels.strategicSL.toFixed(2) }, 'Trailing SL update broadcast');
  });
}

/**
 * Send message to a specific client
 */
function send(ws: WebSocket, message: WSMessage): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(message));
  }
}

/**
 * Broadcast message to all connected clients
 */
export function broadcast(message: WSMessage): void {
  const data = JSON.stringify(message);
  clients.forEach(ws => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(data);
    }
  });
}

/**
 * Get number of connected clients
 */
export function getClientCount(): number {
  return clients.size;
}

/**
 * Track wallet balance for 24hr performance
 */
async function trackWalletBalance(): Promise<void> {
  try {
    const wallet = await getWalletBalance();
    const balance = wallet.totalEquity;
    const now = Date.now();
    
    walletBalanceHistory.push({ time: now, balance });
    
    // Keep only last 25 hours of data
    const cutoff = now - (25 * 60 * 60 * 1000);
    walletBalanceHistory = walletBalanceHistory.filter(h => h.time > cutoff);
    
    // Set 24h ago balance
    const target24hAgo = now - (24 * 60 * 60 * 1000);
    const closest = walletBalanceHistory.reduce((prev, curr) => {
      return Math.abs(curr.time - target24hAgo) < Math.abs(prev.time - target24hAgo) ? curr : prev;
    });
    walletBalance24hAgo = closest.balance;
    
  } catch (error) {
    logger.error({ error }, 'Failed to track wallet balance');
  }
}

/**
 * Get wallet 24hr change percentage
 */
async function getWallet24hChange(): Promise<number> {
  try {
    const wallet = await getWalletBalance();
    const currentBalance = wallet.totalEquity;
    if (!walletBalance24hAgo || walletBalance24hAgo === 0) {
      return 0;
    }
    return ((currentBalance - walletBalance24hAgo) / walletBalance24hAgo) * 100;
  } catch (error) {
    return 0;
  }
}

/**
 * Hourly position check-in by Legenda
 */
async function doHourlyCheckin(): Promise<void> {
  const positionTracker = getPositionTracker();
  const positions = positionTracker.getAllPositions();
  
  if (positions.length === 0) {
    return; // No positions to check
  }
  
  const strategyEngine = getStrategyEngine();
  const wallet24hChange = await getWallet24hChange();
  let currentBalance = 0;
  try {
    const wallet = await getWalletBalance();
    currentBalance = wallet.totalEquity;
  } catch (e) { /* ignore */ }
  
  const wallet24hPnl = walletBalance24hAgo ? currentBalance - walletBalance24hAgo : 0;
  
  for (const position of positions) {
    try {
      const strategyState = strategyEngine.getState(position.symbol);
      if (!strategyState) continue;
      
      const snap = strategyState.snapshot;
      const entryTime = position.updatedAt || Date.now();
      const hoursInTrade = (Date.now() - entryTime) / (60 * 60 * 1000);
      
      // Calculate PnL percent
      const pnlPercent = position.avgPrice > 0 
        ? ((position.markPrice - position.avgPrice) / position.avgPrice) * 100 * (position.side === 'LONG' ? 1 : -1)
        : 0;
      
      // Check if strategy still aligns with position
      const strategyStillValid = (position.side === 'LONG' && snap.supertrendDir === 'LONG') ||
                                  (position.side === 'SHORT' && snap.supertrendDir === 'SHORT');
      
      const checkinData: HourlyCheckinData = {
        symbol: position.symbol,
        side: position.side,
        entryPrice: position.avgPrice,
        currentPrice: position.markPrice || snap.price,
        unrealizedPnl: position.unrealizedPnl,
        pnlPercent,
        stopLoss: position.stopLoss,
        takeProfit: position.takeProfit,
        hoursInTrade,
        strategyStillValid,
        supertrendDir: snap.supertrendDir,
        structureBias: snap.structureBias,
        wallet24hChange,
        wallet24hPnl,
      };
      
      const advice = await getHourlyCheckin(checkinData);
      
      broadcast({
        type: 'legendaAdvice',
        data: {
          adviceType: 'HOURLY_CHECKIN',
          symbol: position.symbol,
          message: advice,
          position: {
            side: position.side,
            pnl: position.unrealizedPnl,
            pnlPercent,
          },
          wallet24hChange,
        },
        timestamp: Date.now(),
      });
      
      logger.info({ symbol: position.symbol, pnl: position.unrealizedPnl.toFixed(2) }, 'Sent Legenda hourly check-in');
      
    } catch (error) {
      logger.error({ error, symbol: position.symbol }, 'Failed to do hourly checkin');
    }
  }
}

/**
 * Start hourly check-in interval
 */
function startHourlyCheckin(): void {
  // Track wallet balance every hour
  setInterval(trackWalletBalance, 60 * 60 * 1000);
  trackWalletBalance(); // Initial track
  
  // Hourly check-in for open positions
  hourlyCheckinInterval = setInterval(doHourlyCheckin, HOURLY_CHECKIN_INTERVAL_MS);
  
  logger.info('Legenda hourly check-in started');
}

/**
 * Close WebSocket server
 */
export function closeFrontendWebSocket(): void {
  if (hourlyCheckinInterval) {
    clearInterval(hourlyCheckinInterval);
    hourlyCheckinInterval = null;
  }
  
  if (cleanupInterval) {
    clearInterval(cleanupInterval);
    cleanupInterval = null;
  }
  
  if (wss) {
    clients.forEach(ws => ws.close());
    clients.clear();
    wss.close();
    wss = null;
    logger.info('Frontend WebSocket server closed');
  }
}

