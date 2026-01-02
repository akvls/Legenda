import { Router } from 'express';
import { prisma } from '../../db/index.js';
import { getMarketWebSocket } from '../../bybit/market-ws.js';
import { getPrivateWebSocket } from '../../bybit/private-ws.js';

const router = Router();

/**
 * Health check endpoint
 */
router.get('/health', async (_req, res) => {
  const marketWs = getMarketWebSocket();
  const privateWs = getPrivateWebSocket();

  // Check database
  let dbOk = false;
  try {
    await prisma.$queryRaw`SELECT 1`;
    dbOk = true;
  } catch {
    dbOk = false;
  }

  const status = {
    status: 'ok',
    timestamp: new Date().toISOString(),
    services: {
      database: dbOk ? 'connected' : 'disconnected',
      marketWebSocket: marketWs.getConnectionStatus() ? 'connected' : 'disconnected',
      privateWebSocket: privateWs.getConnectionStatus().connected ? 'connected' : 'disconnected',
    },
  };

  const httpStatus = dbOk ? 200 : 503;
  res.status(httpStatus).json(status);
});

/**
 * Detailed status endpoint
 */
router.get('/status', async (_req, res) => {
  const marketWs = getMarketWebSocket();
  const privateWs = getPrivateWebSocket();

  res.json({
    uptime: process.uptime(),
    memory: process.memoryUsage(),
    marketWs: {
      connected: marketWs.getConnectionStatus(),
      subscriptions: marketWs.getSubscriptions(),
    },
    privateWs: privateWs.getConnectionStatus(),
  });
});

export default router;

