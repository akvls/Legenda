import { Router } from 'express';
import type { Request, Response } from 'express';
import { smartOrchestrator, stateMachine, isLLMAvailable } from '../../agent/index.js';
import { createLogger } from '../../utils/logger.js';

const logger = createLogger('api:agent');
const router = Router();

/**
 * POST /api/agent/chat
 * Process a natural language command with AI
 */
router.post('/chat', async (req: Request, res: Response) => {
  try {
    const { message } = req.body;
    
    if (!message || typeof message !== 'string') {
      return res.status(400).json({
        success: false,
        error: 'Message is required',
      });
    }

    logger.info({ message, llmEnabled: isLLMAvailable() }, 'Processing smart chat');

    const result = await smartOrchestrator.handleChat(message);

    return res.json({
      success: result.success,
      type: result.type,
      message: result.message,
      opinion: result.opinion,
      journal: result.journal,
      data: result.data,
    });
  } catch (error) {
    logger.error({ error }, 'Chat processing error');
    return res.status(500).json({
      success: false,
      error: (error as Error).message,
    });
  }
});

/**
 * POST /api/agent/opinion/:symbol
 * Get AI opinion on a symbol
 */
router.post('/opinion/:symbol', async (req: Request, res: Response) => {
  try {
    const { symbol } = req.params;
    const result = await smartOrchestrator.handleOpinion(symbol.toUpperCase());

    return res.json({
      success: result.success,
      message: result.message,
      opinion: result.opinion,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: (error as Error).message,
    });
  }
});

/**
 * GET /api/agent/journal
 * Analyze trading journal with AI
 */
router.get('/journal', async (_req: Request, res: Response) => {
  try {
    const result = await smartOrchestrator.analyzeMyTrades();

    return res.json({
      success: result.success,
      message: result.message,
      journal: result.journal,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: (error as Error).message,
    });
  }
});

/**
 * GET /api/agent/status
 * Get overall agent status (includes memory + circuit breaker)
 */
router.get('/status', (_req: Request, res: Response) => {
  try {
    const status = smartOrchestrator.getStatus();
    
    return res.json({
      success: true,
      status: status.global,
      isPaused: stateMachine.isPaused(),
      llmEnabled: isLLMAvailable(),
      symbols: status.symbols,
      memory: status.memory,
      circuitBreaker: status.circuitBreaker,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: (error as Error).message,
    });
  }
});

/**
 * GET /api/agent/memory
 * Get memory status
 */
router.get('/memory', (_req: Request, res: Response) => {
  try {
    const memory = smartOrchestrator.getMemoryStatus();
    
    return res.json({
      success: true,
      memory,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: (error as Error).message,
    });
  }
});

/**
 * POST /api/agent/memory/clear
 * Clear current session (archives it first)
 */
router.post('/memory/clear', (_req: Request, res: Response) => {
  try {
    smartOrchestrator.clearChatSession();
    
    return res.json({
      success: true,
      message: '🧹 Chat session cleared and archived',
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: (error as Error).message,
    });
  }
});

/**
 * GET /api/agent/memory/summary/:period
 * Get a memory summary (30d, 4mo, 1yr)
 */
router.get('/memory/summary/:period', (req: Request, res: Response) => {
  try {
    const { period } = req.params;
    if (!['30d', '4mo', '1yr'].includes(period)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid period. Use: 30d, 4mo, or 1yr',
      });
    }
    
    const summary = smartOrchestrator.getMemorySummary(period as '30d' | '4mo' | '1yr');
    
    if (!summary) {
      return res.json({
        success: true,
        message: `No ${period} summary yet. Keep chatting to build history!`,
        summary: null,
      });
    }
    
    return res.json({
      success: true,
      summary,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: (error as Error).message,
    });
  }
});

/**
 * POST /api/agent/memory/summary/:period
 * Force generate a memory summary
 */
router.post('/memory/summary/:period', async (req: Request, res: Response) => {
  try {
    const { period } = req.params;
    if (!['30d', '4mo', '1yr'].includes(period)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid period. Use: 30d, 4mo, or 1yr',
      });
    }
    
    if (!isLLMAvailable()) {
      return res.status(400).json({
        success: false,
        error: 'LLM not available. Set GOOGLE_API_KEY in .env',
      });
    }
    
    const summary = await smartOrchestrator.generateMemorySummary(period as '30d' | '4mo' | '1yr');
    
    return res.json({
      success: true,
      message: `📝 Generated ${period} summary`,
      summary,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: (error as Error).message,
    });
  }
});

/**
 * GET /api/agent/circuit-breaker
 * Get circuit breaker status
 */
router.get('/circuit-breaker', (_req: Request, res: Response) => {
  try {
    const status = smartOrchestrator.getCircuitBreakerStatus();
    
    return res.json({
      success: true,
      ...status,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: (error as Error).message,
    });
  }
});

/**
 * POST /api/agent/circuit-breaker/override
 * Emergency override of circuit breaker (USE WITH CAUTION)
 */
router.post('/circuit-breaker/override', (_req: Request, res: Response) => {
  try {
    smartOrchestrator.overrideCircuitBreaker();
    
    return res.json({
      success: true,
      message: '⚠️ Circuit breaker OVERRIDDEN. Trading allowed but be careful!',
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: (error as Error).message,
    });
  }
});

/**
 * POST /api/agent/circuit-breaker/reset
 * Reset circuit breaker
 */
router.post('/circuit-breaker/reset', (_req: Request, res: Response) => {
  try {
    smartOrchestrator.resetCircuitBreaker();
    
    return res.json({
      success: true,
      message: '✅ Circuit breaker reset',
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: (error as Error).message,
    });
  }
});

/**
 * GET /api/agent/state/:symbol
 * Get state for a specific symbol
 */
router.get('/state/:symbol', (req: Request, res: Response) => {
  try {
    const { symbol } = req.params;
    const state = stateMachine.getState(symbol.toUpperCase());

    return res.json({
      success: true,
      symbol: symbol.toUpperCase(),
      state: state.state,
      side: state.side,
      entryTime: state.entryTime,
      lastStopSide: state.lastStopSide,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: (error as Error).message,
    });
  }
});

/**
 * POST /api/agent/pause
 * Pause all trading
 */
router.post('/pause', (_req: Request, res: Response) => {
  try {
    stateMachine.pause();
    return res.json({
      success: true,
      message: '⏸️ Trading PAUSED',
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: (error as Error).message,
    });
  }
});

/**
 * POST /api/agent/resume
 * Resume trading
 */
router.post('/resume', (_req: Request, res: Response) => {
  try {
    stateMachine.resume();
    return res.json({
      success: true,
      message: '▶️ Trading RESUMED',
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: (error as Error).message,
    });
  }
});

/**
 * POST /api/agent/unlock/:symbol
 * Force unlock a symbol (admin override)
 */
router.post('/unlock/:symbol', (req: Request, res: Response) => {
  try {
    const { symbol } = req.params;
    smartOrchestrator.forceUnlock(symbol.toUpperCase());
    
    return res.json({
      success: true,
      message: `🔓 ${symbol.toUpperCase()} unlocked`,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: (error as Error).message,
    });
  }
});

/**
 * Quick action shortcuts
 */

// POST /api/agent/long/:symbol
router.post('/long/:symbol', async (req: Request, res: Response) => {
  try {
    const { symbol } = req.params;
    const { risk = 0.5, leverage = 5, sl = 'swing' } = req.body;
    
    const message = `long ${symbol} risk ${risk} lev ${leverage} sl ${sl}`;
    const result = await smartOrchestrator.handleChat(message);
    
    return res.json({
      success: result.success,
      type: result.type,
      message: result.message,
      opinion: result.opinion,
      data: result.data,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: (error as Error).message,
    });
  }
});

// POST /api/agent/short/:symbol
router.post('/short/:symbol', async (req: Request, res: Response) => {
  try {
    const { symbol } = req.params;
    const { risk = 0.5, leverage = 5, sl = 'swing' } = req.body;
    
    const message = `short ${symbol} risk ${risk} lev ${leverage} sl ${sl}`;
    const result = await smartOrchestrator.handleChat(message);
    
    return res.json({
      success: result.success,
      type: result.type,
      message: result.message,
      opinion: result.opinion,
      data: result.data,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: (error as Error).message,
    });
  }
});

// POST /api/agent/close/:symbol
router.post('/close/:symbol', async (req: Request, res: Response) => {
  try {
    const { symbol } = req.params;
    const { percent = 100 } = req.body;
    
    const message = percent === 100 
      ? `close ${symbol}` 
      : `close ${percent}% ${symbol}`;
    const result = await smartOrchestrator.handleChat(message);
    
    return res.json({
      success: result.success,
      message: result.message,
      data: result.data,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: (error as Error).message,
    });
  }
});

// POST /api/agent/be/:symbol (move to breakeven)
router.post('/be/:symbol', async (req: Request, res: Response) => {
  try {
    const { symbol } = req.params;
    const result = await smartOrchestrator.handleChat(`move sl ${symbol} to be`);
    
    return res.json({
      success: result.success,
      message: result.message,
      data: result.data,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: (error as Error).message,
    });
  }
});

export default router;
