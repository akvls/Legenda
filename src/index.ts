import 'dotenv/config';
import { config } from './config/index.js';
import { logger } from './utils/logger.js';
import { connectDatabase, disconnectDatabase, initializeDefaultSettings } from './db/index.js';
import { createApp } from './api/app.js';
import { getMarketWebSocket, closeMarketWebSocket } from './bybit/market-ws.js';
import { getPrivateWebSocket, closePrivateWebSocket } from './bybit/private-ws.js';
import { getCandleManager, destroyCandleManager } from './data/candle-manager.js';
import { getStrategyEngine } from './strategy/engine.js';
import { getPositionTracker } from './execution/position-tracker.js';
import { getTradeExecutor } from './execution/trade-executor.js';
import { getTrailingManager } from './execution/trailing-manager.js';
import { getSLManager } from './execution/sl-manager.js';
import { getInvalidationManager } from './execution/invalidation-manager.js';
import { smartOrchestrator } from './agent/smart-orchestrator.js';
import { initFrontendWebSocket, closeFrontendWebSocket } from './services/frontend-ws.js';

/**
 * AI Trading Assistant - Main Entry Point
 */

async function main() {
  logger.info('Starting AI Trading Assistant...');
  logger.info({ testnet: config.bybit.testnet }, 'Bybit mode');

  try {
    // 1. Connect to database
    await connectDatabase();
    await initializeDefaultSettings();
    
    // 2. Initialize WebSocket connections
    const marketWs = getMarketWebSocket();
    const privateWs = getPrivateWebSocket();
    
    // Connect private WS (handles auth automatically)
    privateWs.connect();
    
    // 3. Initialize candle manager
    const candleManager = getCandleManager();

    // 4. Initialize strategy engine
    const strategyEngine = getStrategyEngine();

    // 5. Initialize execution components
    const positionTracker = getPositionTracker();
    const tradeExecutor = getTradeExecutor();
    const trailingManager = getTrailingManager();
    const slManager = getSLManager();
    const invalidationManager = getInvalidationManager();
    
    // Log swing break events (hard exits)
    invalidationManager.on('swingBreak', (symbol, side, price, swingLevel) => {
      logger.warn({ symbol, side, price, swingLevel }, '🚨 SWING BREAK - Hard exit triggered');
    });
    
    invalidationManager.on('autoExit', (symbol, reason) => {
      logger.info({ symbol, reason }, '✅ Auto-exit completed');
    });
    
    // Initialize position tracker (fetch current positions)
    await positionTracker.initialize();
    
    // Restore active trades from database (after position tracker is ready)
    const restoredTrades = await tradeExecutor.restoreFromDatabase();
    if (restoredTrades > 0) {
      logger.info({ count: restoredTrades }, 'Restored active trades from database');
    }
    
    // Log when ready
    marketWs.on('connected', () => {
      logger.info('Market WebSocket ready');
    });

    strategyEngine.on('stateUpdate', (state) => {
      logger.info(
        { 
          symbol: state.symbol, 
          bias: state.bias, 
          strategy: state.strategyId,
          allowLong: state.allowLongEntry,
          allowShort: state.allowShortEntry,
        },
        'Strategy state updated'
      );
    });

    strategyEngine.on('biasFlip', (symbol, from, to) => {
      logger.warn({ symbol, from, to }, '⚠️ BIAS FLIP DETECTED');
    });

    // Execution events
    tradeExecutor.on('entryExecuted', (tradeId, contract) => {
      logger.info(
        { tradeId, symbol: contract.symbol, side: contract.side, strategy: contract.strategyId },
        '✅ Trade entry executed'
      );
    });

    tradeExecutor.on('entryBlocked', (symbol, side, reason) => {
      logger.warn({ symbol, side, reason }, '🚫 Entry blocked');
    });

    tradeExecutor.on('exitExecuted', (tradeId, reason) => {
      logger.info({ tradeId, reason }, '📤 Trade exited');
    });

    tradeExecutor.on('leverageClamped', (symbol, requested, applied) => {
      logger.warn({ symbol, requested, applied }, '⚠️ Leverage clamped to max 10x');
    });

    positionTracker.on('positionOpened', (position) => {
      logger.info(
        { symbol: position.symbol, side: position.side, size: position.size },
        '📈 Position opened'
      );
    });

    positionTracker.on('positionClosed', async (symbol, side, realizedPnl) => {
      logger.info({ symbol, side, realizedPnl: realizedPnl.toFixed(2) }, '📉 Position closed');
      
      // Record P&L for circuit breaker (anti-rage protection)
      if (realizedPnl !== 0) {
        await smartOrchestrator.recordPnL(realizedPnl);
        logger.info({ pnl: realizedPnl.toFixed(2) }, 'P&L recorded for circuit breaker');
      }
      
      // Notify smart orchestrator for state machine update
      // We don't know the exact reason here, treat as unknown
      smartOrchestrator.handlePositionClosed(symbol, 'UNKNOWN');
    });

    trailingManager.on('slTrailed', (symbol, oldSl, newSl) => {
      logger.info({ symbol, oldSl: oldSl.toFixed(2), newSl: newSl.toFixed(2) }, '🎯 Trailing SL updated');
    });

    // Two-Layer SL events
    slManager.on('strategicSlTriggered', (symbol, closePrice, slLevel) => {
      logger.warn(
        { symbol, closePrice: closePrice.toFixed(2), slLevel: slLevel.toFixed(2) },
        '🛑 Strategic SL triggered (candle close)'
      );
      // Notify smart orchestrator - this was a stop loss
      smartOrchestrator.handlePositionClosed(symbol, 'STOP_LOSS');
    });

    slManager.on('emergencySlSet', (symbol, price) => {
      logger.info({ symbol, emergencySL: price.toFixed(2) }, '🛡️ Emergency SL set on Bybit');
    });
    
    privateWs.on('authenticated', () => {
      logger.info('Private WebSocket authenticated and ready');
    });

    // Re-sync state on WebSocket reconnection
    privateWs.on('stateResyncNeeded', async () => {
      logger.warn('🔄 WebSocket reconnected - re-syncing state with exchange...');
      try {
        await positionTracker.initialize();
        logger.info('✅ Position state re-synced after reconnection');
      } catch (error) {
        logger.error({ error }, '❌ Failed to re-sync state after reconnection');
      }
    });

    candleManager.on('candleClose', (candle) => {
      logger.debug(
        { symbol: candle.symbol, tf: candle.timeframe, close: candle.close },
        'Candle closed'
      );
    });

    // 4. Start API server
    const app = createApp();
    const server = app.listen(config.port, () => {
      logger.info({ port: config.port }, 'API server started');
      logger.info('='.repeat(50));
      logger.info('AI Trading Assistant is ready!');
      logger.info(`API: http://localhost:${config.port}`);
      logger.info(`WebSocket: ws://localhost:${config.port}/ws`);
      logger.info(`Health: http://localhost:${config.port}/api/health`);
      logger.info('='.repeat(50));
    });

    // 4b. Start WebSocket server for frontend real-time updates
    initFrontendWebSocket(server);

    // 5. Set up periodic cleanup (every hour)
    const cleanupInterval = setInterval(() => {
      // Get active symbols from strategy engine
      const activeSymbols = strategyEngine.getAllStates().map(s => s.symbol);
      
      // Clean up stale state machine states
      const { stateMachine } = require('./agent/state-machine.js');
      stateMachine.cleanupStaleStates(activeSymbols);
      
      logger.debug({ 
        activeTradeCount: tradeExecutor.getActiveTradeCount(),
        stateMachineSymbols: stateMachine.getSymbolCount(),
      }, 'Periodic cleanup complete');
    }, 60 * 60 * 1000); // Every hour

    // 6. Graceful shutdown
    const shutdown = async (signal: string) => {
      logger.info({ signal }, 'Shutdown signal received');
      
      // Clear cleanup interval
      clearInterval(cleanupInterval);
      
      // Close HTTP server
      server.close(() => {
        logger.info('HTTP server closed');
      });
      
      // Close WebSockets
      closeFrontendWebSocket();
      closeMarketWebSocket();
      closePrivateWebSocket();
      
      // Destroy candle manager
      destroyCandleManager();
      
      // Close database
      await disconnectDatabase();
      
      logger.info('Shutdown complete');
      process.exit(0);
    };

    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));

  } catch (error) {
    logger.error({ error }, 'Failed to start application');
    process.exit(1);
  }
}

main();

