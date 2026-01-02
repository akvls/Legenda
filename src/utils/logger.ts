import pino from 'pino';
import { config } from '../config/index.js';

/**
 * Application Logger
 * Uses pino for high-performance logging
 */

export const logger = pino({
  level: config.isDev ? 'debug' : 'info',
  transport: config.isDev
    ? {
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'SYS:standard',
          ignore: 'pid,hostname',
        },
      }
    : undefined,
  base: {
    env: config.nodeEnv,
  },
});

// Child loggers for different modules
export const createLogger = (module: string) => logger.child({ module });

// Pre-configured loggers
export const bybitLogger = createLogger('bybit');
export const strategyLogger = createLogger('strategy');
export const executionLogger = createLogger('execution');
export const wsLogger = createLogger('websocket');
export const apiLogger = createLogger('api');

