import { createLogger } from '../utils/logger.js';
import type { 
  Intent, 
  TradeSide, 
  SLRule, 
  TPRule, 
  TrailMode,
} from '../types/index.js';

const logger = createLogger('trade-contract');

/**
 * Trade Contract
 * 
 * A validated, executable trade specification created from an Intent.
 * The contract contains all parameters needed to execute a trade,
 * with defaults filled in and validation completed.
 */

export interface TradeContract {
  // Identity
  id: string;
  createdAt: Date;
  
  // Core params
  symbol: string;
  side: TradeSide;
  riskPercent: number;
  leverage: number;
  
  // SL configuration
  slRule: SLRule;
  slPrice?: number;
  emergencySlPercent: number; // Buffer for emergency SL (default 4%)
  
  // TP configuration  
  tpRule: TPRule;
  tpPrice?: number;
  tpRR?: number;
  
  // Trail configuration
  trailMode: TrailMode;
  
  // Status
  status: 'PENDING' | 'EXECUTED' | 'REJECTED' | 'CANCELLED';
  rejectReason?: string;
  
  // Execution details (filled after execution)
  orderId?: string;
  entryPrice?: number;
  positionSize?: number;
  actualSlPrice?: number;
  actualTpPrice?: number;
}

// Default values
const DEFAULTS = {
  riskPercent: 0.5,
  leverage: 5,
  slRule: 'SWING' as SLRule,
  tpRule: 'NONE' as TPRule,
  trailMode: 'SUPERTREND' as TrailMode,
  emergencySlPercent: 4,
};

/**
 * Create a trade contract from an intent
 */
export function createTradeContract(intent: Intent): TradeContract | null {
  // Must have a symbol
  if (!intent.symbol) {
    logger.error('No symbol in intent');
    return null;
  }

  // Must be an entry action
  if (intent.action !== 'ENTER_LONG' && intent.action !== 'ENTER_SHORT') {
    logger.error({ action: intent.action }, 'Not an entry intent');
    return null;
  }

  const side: TradeSide = intent.action === 'ENTER_LONG' ? 'LONG' : 'SHORT';

  const contract: TradeContract = {
    id: generateContractId(),
    createdAt: new Date(),
    
    symbol: intent.symbol,
    side,
    riskPercent: intent.riskPercent ?? DEFAULTS.riskPercent,
    leverage: Math.min(intent.requestedLeverage ?? DEFAULTS.leverage, 10),
    
    slRule: intent.slRule ?? DEFAULTS.slRule,
    slPrice: intent.slPrice,
    emergencySlPercent: DEFAULTS.emergencySlPercent,
    
    tpRule: intent.tpRule ?? DEFAULTS.tpRule,
    tpPrice: intent.tpPrice,
    tpRR: intent.tpRR,
    
    trailMode: intent.trailMode ?? DEFAULTS.trailMode,
    
    status: 'PENDING',
  };

  // Validate contract
  const validation = validateContract(contract);
  if (!validation.valid) {
    contract.status = 'REJECTED';
    contract.rejectReason = validation.reason;
  }

  logger.info({ contract }, 'Trade contract created');
  return contract;
}

/**
 * Validate a trade contract
 * 
 * Note: Risk % has NO limit - it's your money, trade what you want
 * Only leverage is hard-capped at 10x for safety
 */
function validateContract(contract: TradeContract): { valid: boolean; reason?: string } {
  // Risk % - NO LIMIT (user's choice)
  // Only reject if invalid (zero or negative)
  if (contract.riskPercent <= 0) {
    return { valid: false, reason: `Risk must be greater than 0%` };
  }

  // Leverage - HARD CAP at 10x
  if (contract.leverage < 1 || contract.leverage > 10) {
    return { valid: false, reason: `Leverage ${contract.leverage}x exceeds max 10x` };
  }

  // SL validation
  if (contract.slRule === 'PRICE' && !contract.slPrice) {
    return { valid: false, reason: 'SL rule is PRICE but no slPrice provided' };
  }

  // TP validation
  if (contract.tpRule === 'PRICE' && !contract.tpPrice) {
    return { valid: false, reason: 'TP rule is PRICE but no tpPrice provided' };
  }
  if (contract.tpRule === 'RR' && !contract.tpRR) {
    return { valid: false, reason: 'TP rule is RR but no tpRR provided' };
  }

  return { valid: true };
}

/**
 * Generate unique contract ID
 */
function generateContractId(): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substring(2, 6);
  return `TC-${timestamp}-${random}`.toUpperCase();
}

/**
 * Format contract for display
 */
export function formatContract(contract: TradeContract): string {
  const parts: string[] = [
    `[${contract.id}]`,
    `${contract.side} ${contract.symbol}`,
    `Risk: ${contract.riskPercent}%`,
    `Lev: ${contract.leverage}x`,
    `SL: ${contract.slRule}`,
  ];
  
  if (contract.slPrice) parts.push(`SL@${contract.slPrice}`);
  if (contract.tpRule !== 'NONE') {
    parts.push(`TP: ${contract.tpRule}`);
    if (contract.tpRR) parts.push(`(${contract.tpRR}R)`);
    if (contract.tpPrice) parts.push(`@${contract.tpPrice}`);
  }
  if (contract.trailMode !== 'NONE') {
    parts.push(`Trail: ${contract.trailMode}`);
  }
  
  parts.push(`Status: ${contract.status}`);
  
  return parts.join(' | ');
}

