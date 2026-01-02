import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import { apiLogger as logger } from '../utils/logger.js';

// Routes
import healthRoutes from './routes/health.js';
import marketRoutes from './routes/market.js';
import settingsRoutes from './routes/settings.js';
import strategyRoutes from './routes/strategy.js';
import executionRoutes from './routes/execution.js';
import agentRoutes from './routes/agent.js';

/**
 * Create Express Application
 */
export function createApp() {
  const app = express();

  // Middleware
  app.use(cors());
  app.use(express.json());
  
  // Request logging
  app.use((req: Request, _res: Response, next: NextFunction) => {
    logger.debug({ method: req.method, path: req.path }, 'Request');
    next();
  });

  // API Routes
  app.use('/api', healthRoutes);
  app.use('/api/market', marketRoutes);
  app.use('/api/settings', settingsRoutes);
  app.use('/api/strategy', strategyRoutes);
  app.use('/api/execution', executionRoutes);
  app.use('/api/agent', agentRoutes);

  // Root endpoint
  app.get('/', (_req: Request, res: Response) => {
    res.json({
      name: 'AI Trading Assistant API',
      version: '1.0.0',
      status: 'running',
    });
  });

  // 404 handler
  app.use((_req: Request, res: Response) => {
    res.status(404).json({ success: false, error: 'Not found' });
  });

  // Error handler
  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    logger.error({ error: err }, 'Unhandled error');
    res.status(500).json({ 
      success: false, 
      error: 'Internal server error' 
    });
  });

  return app;
}

