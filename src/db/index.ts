import { PrismaClient } from '@prisma/client';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('database');

/**
 * Prisma Client Singleton
 * Ensures only one instance is created
 */

declare global {
  // eslint-disable-next-line no-var
  var prisma: PrismaClient | undefined;
}

export const prisma = globalThis.prisma || new PrismaClient({
  log: process.env.NODE_ENV === 'development' 
    ? ['query', 'error', 'warn'] 
    : ['error'],
});

if (process.env.NODE_ENV !== 'production') {
  globalThis.prisma = prisma;
}

/**
 * Connect to database
 */
export async function connectDatabase(): Promise<void> {
  try {
    await prisma.$connect();
    logger.info('Database connected successfully');
  } catch (error) {
    logger.error({ error }, 'Failed to connect to database');
    throw error;
  }
}

/**
 * Disconnect from database
 */
export async function disconnectDatabase(): Promise<void> {
  await prisma.$disconnect();
  logger.info('Database disconnected');
}

/**
 * Initialize default settings if not exist
 */
export async function initializeDefaultSettings(): Promise<void> {
  const existing = await prisma.settings.findUnique({
    where: { id: 'default' },
  });
  
  if (!existing) {
    await prisma.settings.create({
      data: {
        id: 'default',
        maxLeverage: 10,
        defaultLeverage: 5,
        defaultRiskPercent: 0.5,
        defaultSlRule: 'SWING',        // String, not enum
        defaultTpRule: 'NONE',         // String, not enum
        defaultTrailMode: 'SUPERTREND', // String, not enum
        watchDefaultThreshold: 0.2,
        watchDefaultExpiryMin: 120,
        coachStrictness: 1,
        autoExitOnInvalidation: true,
      },
    });
    logger.info('Default settings initialized');
  }
}

export { PrismaClient };

