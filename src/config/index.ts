import 'dotenv/config';

/**
 * Application Configuration
 * Loads from environment variables with validation
 */

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function optionalEnv(name: string, defaultValue: string): string {
  return process.env[name] || defaultValue;
}

function boolEnv(name: string, defaultValue: boolean): boolean {
  const value = process.env[name];
  if (!value) return defaultValue;
  return value.toLowerCase() === 'true';
}

function intEnv(name: string, defaultValue: number): number {
  const value = process.env[name];
  if (!value) return defaultValue;
  const parsed = parseInt(value, 10);
  return isNaN(parsed) ? defaultValue : parsed;
}

export const config = {
  // Environment
  nodeEnv: optionalEnv('NODE_ENV', 'development'),
  isDev: optionalEnv('NODE_ENV', 'development') === 'development',
  isProd: process.env.NODE_ENV === 'production',
  
  // Server
  port: intEnv('PORT', 3001),
  
  // Database
  databaseUrl: requireEnv('DATABASE_URL'),
  
  // Redis
  redisUrl: optionalEnv('REDIS_URL', 'redis://localhost:6379'),
  
  // Bybit
  bybit: {
    apiKey: requireEnv('BYBIT_API_KEY'),
    apiSecret: requireEnv('BYBIT_API_SECRET'),
    testnet: boolEnv('BYBIT_TESTNET', true),
    
    // Endpoints
    get restBaseUrl() {
      return this.testnet 
        ? 'https://api-testnet.bybit.com' 
        : 'https://api.bybit.com';
    },
    get wsPublicUrl() {
      return this.testnet
        ? 'wss://stream-testnet.bybit.com/v5/public/linear'
        : 'wss://stream.bybit.com/v5/public/linear';
    },
    get wsPrivateUrl() {
      return this.testnet
        ? 'wss://stream-testnet.bybit.com/v5/private'
        : 'wss://stream.bybit.com/v5/private';
    },
  },
  
  // Trading defaults (will be overridden by DB settings)
  trading: {
    maxLeverage: 10,
    defaultLeverage: 5,
    defaultRiskPercent: 0.5,
    defaultTimeframe: '5m',
  },
  
  // Security
  apiSecret: optionalEnv('API_SECRET', 'dev-secret-change-me'),
  
  // Google AI (Gemini)
  googleApiKey: process.env.GOOGLE_API_KEY || '',
  llmModel: process.env.MODEL || 'gemini-2.0-flash',
} as const;

export type Config = typeof config;

