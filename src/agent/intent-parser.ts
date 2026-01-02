import { createLogger } from '../utils/logger.js';
import type { 
  Intent, 
  IntentAction, 
  TradeSide, 
  SLRule, 
  TPRule, 
  TrailMode,
  WatchTriggerType,
} from '../types/index.js';

const logger = createLogger('intent-parser');

/**
 * Intent Parser
 * Parses natural language chat commands into structured Intent objects
 * 
 * Examples:
 * - "Long BTCUSDT risk 0.5 SL swing trail supertrend"
 * - "Short ETH risk 0.8 lev 10"
 * - "Close BTCUSDT"
 * - "Close half"
 * - "Move SL to breakeven"
 * - "Wait BTCUSDT long until closer to MA"
 */

// Default values for quick scalping
const DEFAULTS = {
  riskPercent: 0.5,
  leverage: 5,
  slRule: 'SWING' as SLRule,
  tpRule: 'NONE' as TPRule,
  trailMode: 'SUPERTREND' as TrailMode,
  watchThresholdPct: 0.5,
};

// Symbol aliases
const SYMBOL_ALIASES: Record<string, string> = {
  'BTC': 'BTCUSDT',
  'ETH': 'ETHUSDT',
  'SOL': 'SOLUSDT',
  'DOGE': 'DOGEUSDT',
  'XRP': 'XRPUSDT',
  'ADA': 'ADAUSDT',
  'MATIC': 'MATICUSDT',
  'LINK': 'LINKUSDT',
  'AVAX': 'AVAXUSDT',
  'DOT': 'DOTUSDT',
};

/**
 * Parse a chat command into structured Intent
 */
export function parseIntent(rawText: string): Intent | null {
  const text = rawText.trim().toLowerCase();
  const words = text.split(/\s+/);
  
  if (words.length === 0) return null;

  // Determine action
  const action = detectAction(words);
  if (!action) {
    logger.debug({ rawText }, 'Could not detect action');
    return null;
  }

  const intent: Intent = {
    source: 'chat',
    rawText,
    action,
  };

  // Parse based on action type
  switch (action) {
    case 'ENTER_LONG':
    case 'ENTER_SHORT':
      parseEntryIntent(words, intent);
      break;
    case 'CLOSE':
    case 'CLOSE_PARTIAL':
      parseCloseIntent(words, intent);
      break;
    case 'MOVE_SL':
      parseMoveSlIntent(words, intent);
      break;
    case 'WATCH_CREATE':
      parseWatchIntent(words, intent);
      break;
    case 'PAUSE':
    case 'RESUME':
    case 'WATCH_CANCEL':
    case 'WATCH_SNOOZE':
      parseSimpleIntent(words, intent);
      break;
  }

  logger.info({ intent }, 'Intent parsed');
  return intent;
}

/**
 * Detect the action from command words
 */
function detectAction(words: string[]): IntentAction | null {
  const text = words.join(' ');

  // Watch/Scanner actions - check first (takes priority)
  if (
    words.includes('watch') || 
    words.includes('scan') || 
    words.includes('scanner') ||
    words.includes('alert') ||
    (text.includes('wait') && (text.includes('closer') || text.includes('near')))
  ) {
    if (words.includes('cancel') || words.includes('stop') || words.includes('remove')) {
      return 'WATCH_CANCEL';
    }
    if (words.includes('snooze')) {
      return 'WATCH_SNOOZE';
    }
    return 'WATCH_CREATE';
  }

  // Entry actions
  if (words.includes('long') || words.includes('buy')) {
    if (text.includes('wait') || text.includes('until')) {
      return 'WATCH_CREATE';
    }
    return 'ENTER_LONG';
  }
  if (words.includes('short') || words.includes('sell')) {
    if (text.includes('wait') || text.includes('until')) {
      return 'WATCH_CREATE';
    }
    return 'ENTER_SHORT';
  }

  // Close actions
  if (words.includes('close') || words.includes('exit')) {
    if (words.includes('half') || words.includes('partial') || words.includes('50')) {
      return 'CLOSE_PARTIAL';
    }
    return 'CLOSE';
  }

  // SL actions
  if (text.includes('move sl') || text.includes('sl to be') || text.includes('breakeven')) {
    return 'MOVE_SL';
  }

  // Pause/Resume
  if (words.includes('pause')) {
    return 'PAUSE';
  }
  if (words.includes('resume') || words.includes('start')) {
    return 'RESUME';
  }

  return null;
}

/**
 * Parse entry intent (LONG/SHORT)
 */
function parseEntryIntent(words: string[], intent: Intent): void {
  // Extract symbol
  intent.symbol = extractSymbol(words);

  // Extract risk percent
  intent.riskPercent = extractNumber(words, ['risk', 'r']) ?? DEFAULTS.riskPercent;

  // Extract leverage
  intent.requestedLeverage = extractNumber(words, ['lev', 'leverage', 'x']) ?? DEFAULTS.leverage;
  
  // Clamp leverage to max 10
  if (intent.requestedLeverage > 10) {
    intent.requestedLeverage = 10;
  }

  // Extract SL rule
  intent.slRule = extractSlRule(words);

  // Extract SL price if specified
  intent.slPrice = extractNumber(words, ['sl', 'stop']);

  // Extract TP rule
  intent.tpRule = extractTpRule(words);

  // Extract TP price or RR
  intent.tpPrice = extractNumber(words, ['tp', 'target', 'take']);
  intent.tpRR = extractNumber(words, ['rr', 'r:r']);
  
  // If just a number after "tp", check if it looks like RR (small number)
  if (intent.tpPrice && intent.tpPrice < 10) {
    intent.tpRR = intent.tpPrice;
    intent.tpPrice = undefined;
  }

  // Extract trail mode
  intent.trailMode = extractTrailMode(words);
}

/**
 * Parse close intent
 */
function parseCloseIntent(words: string[], intent: Intent): void {
  intent.symbol = extractSymbol(words);
  
  // Extract close percent for partial close
  if (intent.action === 'CLOSE_PARTIAL') {
    intent.closePercent = extractNumber(words, ['close', 'exit', '%']) ?? 50;
  } else {
    intent.closePercent = 100;
  }
}

/**
 * Parse move SL intent
 */
function parseMoveSlIntent(words: string[], intent: Intent): void {
  intent.symbol = extractSymbol(words);
  
  // Check if moving to breakeven
  const text = words.join(' ');
  if (text.includes('be') || text.includes('breakeven') || text.includes('break even')) {
    intent.newSlPrice = 0; // Signal for breakeven (will use entry price)
  } else {
    // Extract new SL price
    intent.newSlPrice = extractNumber(words, ['sl', 'to', 'at']);
  }
}

/**
 * Parse watch/wait intent
 */
function parseWatchIntent(words: string[], intent: Intent): void {
  intent.symbol = extractSymbol(words);
  
  const text = words.join(' ');
  
  // Determine intended side
  intent.side = words.includes('short') || words.includes('sell') ? 'SHORT' : 'LONG';

  // Determine watch target
  let watchTarget: WatchTriggerType = 'CLOSER_TO_SMA200';
  if (text.includes('ema') || text.includes('1000')) {
    watchTarget = 'CLOSER_TO_EMA1000';
  } else if (text.includes('supertrend') || text.includes('super') || text.includes('st')) {
    watchTarget = 'CLOSER_TO_SUPERTREND';
  } else if (text.includes('sma') || text.includes('200') || text.includes('ma')) {
    watchTarget = 'CLOSER_TO_SMA200';
  }

  // Extract threshold
  const threshold = extractNumber(words, ['%', 'pct', 'percent', 'threshold']) ?? DEFAULTS.watchThresholdPct;

  // Extract expiry in minutes
  let expiryMinutes = 120; // default 2 hours
  if (text.includes('1h') || text.includes('1 hour')) expiryMinutes = 60;
  if (text.includes('4h') || text.includes('4 hour')) expiryMinutes = 240;
  if (text.includes('8h') || text.includes('8 hour')) expiryMinutes = 480;
  if (text.includes('12h') || text.includes('12 hour')) expiryMinutes = 720;
  if (text.includes('24h') || text.includes('1 day')) expiryMinutes = 1440;
  const customMinutes = extractNumber(words, ['min', 'minute']);
  if (customMinutes) expiryMinutes = customMinutes;
  const customHours = extractNumber(words, ['hour', 'hr']);
  if (customHours) expiryMinutes = customHours * 60;

  // Check for auto-enter
  const autoEnter = text.includes('auto') || text.includes('enter') || text.includes('execute');

  intent.watchTrigger = {
    type: watchTarget,
    thresholdPct: threshold,
  };

  // Store additional watch params in intent for the orchestrator
  (intent as any).watchTarget = watchTarget;
  (intent as any).threshold = threshold;
  (intent as any).expiryMinutes = expiryMinutes;
  (intent as any).autoEnter = autoEnter;

  // Copy entry params (for auto-enter)
  intent.riskPercent = extractNumber(words, ['risk', 'r']) ?? DEFAULTS.riskPercent;
  intent.slRule = extractSlRule(words);
  intent.trailMode = extractTrailMode(words);
}

/**
 * Parse simple intents (pause, resume, etc.)
 */
function parseSimpleIntent(words: string[], intent: Intent): void {
  intent.symbol = extractSymbol(words);
}

/**
 * Extract symbol from words
 */
function extractSymbol(words: string[]): string | undefined {
  for (const word of words) {
    const upper = word.toUpperCase();
    
    // Check aliases
    if (SYMBOL_ALIASES[upper]) {
      return SYMBOL_ALIASES[upper];
    }
    
    // Check if it looks like a symbol (ends with USDT or is uppercase letters)
    if (upper.endsWith('USDT')) {
      return upper;
    }
    
    // Check if it's a known coin that needs USDT appended
    if (/^[A-Z]{2,5}$/.test(upper) && !['LONG', 'SHORT', 'BUY', 'SELL', 'RISK', 'SL', 'TP'].includes(upper)) {
      return upper + 'USDT';
    }
  }
  return undefined;
}

/**
 * Extract a number following certain keywords
 */
function extractNumber(words: string[], keywords: string[]): number | undefined {
  for (let i = 0; i < words.length; i++) {
    const word = words[i].toLowerCase();
    
    // Check if current word is a keyword
    if (keywords.some(k => word.includes(k))) {
      // Look for number in next word or same word
      const nextWord = words[i + 1];
      if (nextWord) {
        const num = parseFloat(nextWord.replace(/[^0-9.]/g, ''));
        if (!isNaN(num)) return num;
      }
      // Check if number is in same word (e.g., "risk0.5")
      const numInWord = parseFloat(word.replace(/[^0-9.]/g, ''));
      if (!isNaN(numInWord)) return numInWord;
    }
    
    // Check if word itself is a number after removing non-numeric
    const num = parseFloat(word.replace(/[^0-9.]/g, ''));
    if (!isNaN(num) && num > 0 && word.match(/\d/)) {
      // Check if previous word is a keyword
      const prevWord = words[i - 1]?.toLowerCase();
      if (prevWord && keywords.some(k => prevWord.includes(k))) {
        return num;
      }
    }
  }
  return undefined;
}

/**
 * Extract SL rule
 */
function extractSlRule(words: string[]): SLRule {
  const text = words.join(' ');
  
  if (text.includes('swing')) return 'SWING';
  if (text.includes('supertrend') || text.includes('st')) return 'SUPERTREND';
  if (text.includes('none') || text.includes('no sl')) return 'NONE';
  
  // Check if a price was given (implies PRICE rule)
  for (const word of words) {
    if (word.includes('sl') && /\d/.test(word)) {
      return 'PRICE';
    }
  }
  
  return DEFAULTS.slRule;
}

/**
 * Extract TP rule
 */
function extractTpRule(words: string[]): TPRule {
  const text = words.join(' ');
  
  if (text.includes('none') || text.includes('no tp') || text.includes('runner')) return 'NONE';
  if (text.includes('rr') || text.includes('r:r')) return 'RR';
  if (text.includes('structure')) return 'STRUCTURE';
  
  // Check if a price was given
  for (const word of words) {
    if (word.includes('tp') && /\d/.test(word)) {
      return 'PRICE';
    }
  }
  
  return DEFAULTS.tpRule;
}

/**
 * Extract trail mode
 */
function extractTrailMode(words: string[]): TrailMode {
  const text = words.join(' ');
  
  if (text.includes('no trail') || text.includes('none')) return 'NONE';
  if (text.includes('trail structure') || text.includes('trail swing')) return 'STRUCTURE';
  if (text.includes('trail') || text.includes('trailing')) return 'SUPERTREND';
  
  return DEFAULTS.trailMode;
}

/**
 * Format intent for display
 */
export function formatIntent(intent: Intent): string {
  const parts: string[] = [];
  
  parts.push(`Action: ${intent.action}`);
  if (intent.symbol) parts.push(`Symbol: ${intent.symbol}`);
  if (intent.riskPercent) parts.push(`Risk: ${intent.riskPercent}%`);
  if (intent.requestedLeverage) parts.push(`Leverage: ${intent.requestedLeverage}x`);
  if (intent.slRule) parts.push(`SL: ${intent.slRule}`);
  if (intent.slPrice) parts.push(`SL Price: ${intent.slPrice}`);
  if (intent.tpRule && intent.tpRule !== 'NONE') parts.push(`TP: ${intent.tpRule}`);
  if (intent.tpRR) parts.push(`TP RR: ${intent.tpRR}R`);
  if (intent.trailMode && intent.trailMode !== 'NONE') parts.push(`Trail: ${intent.trailMode}`);
  
  return parts.join(' | ');
}

