import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import path from 'path';
import { apiLogger as logger } from '../utils/logger.js';

// Routes
import healthRoutes from './routes/health.js';
import marketRoutes from './routes/market.js';
import settingsRoutes from './routes/settings.js';
import strategyRoutes from './routes/strategy.js';
import executionRoutes from './routes/execution.js';
import agentRoutes from './routes/agent.js';
import journalRoutes from './routes/journal.js';

/**
 * Create Express Application
 */
export function createApp() {
  const app = express();

  // Middleware
  app.use(cors());
  app.use(express.json());
  
  // Request logging and cache control (only for API routes)
  app.use('/api', (req: Request, res: Response, next: NextFunction) => {
    // Prevent browser caching of API responses
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');
    
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
    app.use('/api/journal', journalRoutes);

  // Serve frontend static files (production build)
  const frontendPath = path.join(process.cwd(), 'frontend/dist');
  app.use(express.static(frontendPath));

  // SPA fallback - serve index.html for all non-API routes
  app.get('*', (req: Request, res: Response, next: NextFunction) => {
    // Skip if it's an API route
    if (req.path.startsWith('/api')) {
      return next();
    }
    res.sendFile(path.join(frontendPath, 'index.html'));
  });

  // 404 handler for API routes
  app.use('/api/*', (_req: Request, res: Response) => {
    res.status(404).json({ success: false, error: 'API endpoint not found' });
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

