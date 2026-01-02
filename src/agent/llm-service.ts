import { GoogleGenerativeAI, type GenerativeModel } from '@google/generative-ai';
import { config } from '../config/index.js';
import { createLogger } from '../utils/logger.js';
import type { StrategyState, TradeSide, Intent, IntentAction } from '../types/index.js';

const logger = createLogger('llm-service');

/**
 * LLM Service - Powered by Gemini
 * 
 * Provides smart AI capabilities:
 * 1. Natural language understanding for commands
 * 2. Trade opinions and analysis
 * 3. Risk assessment
 * 4. Journal summarization
 */

// Initialize Gemini - lazy load
let genAI: GoogleGenerativeAI | null = null;
let model: GenerativeModel | null = null;

function getApiKey(): string {
  return config.googleApiKey || process.env.GOOGLE_API_KEY || '';
}

function getModelName(): string {
  return config.llmModel || process.env.MODEL || 'gemini-2.0-flash';
}

function getModel(): GenerativeModel {
  if (!model) {
    const apiKey = getApiKey();
    if (!apiKey) {
      throw new Error('GOOGLE_API_KEY not configured');
    }
    if (!genAI) {
      genAI = new GoogleGenerativeAI(apiKey);
    }
    const modelName = getModelName();
    model = genAI.getGenerativeModel({ model: modelName });
    logger.info({ model: modelName }, 'Gemini LLM initialized');
  }
  return model;
}

// ============================================
// INTENT PARSING (Smart NLP)
// ============================================

const INTENT_SYSTEM_PROMPT = `You are a trading assistant that parses natural language commands into structured trading intents.

IMPORTANT: Respond ONLY with valid JSON, no markdown, no explanation.

Parse the user's message into this JSON structure:
{
  "action": "ENTER_LONG" | "ENTER_SHORT" | "CLOSE" | "CLOSE_PARTIAL" | "MOVE_SL" | "PAUSE" | "RESUME" | "INFO" | "OPINION" | "WATCH_CREATE" | "WATCH_CANCEL" | "UNKNOWN",
  "symbol": "BTCUSDT" | "ETHUSDT" | etc (add USDT if missing),
  "riskPercent": number (0.1-5, default 0.5),
  "leverage": number (1-10, default 5),
  "slRule": "SWING" | "SUPERTREND" | "PRICE" | "NONE",
  "slPrice": number | null,
  "tpRule": "NONE" | "RR" | "PRICE",
  "tpRR": number | null,
  "trailMode": "SUPERTREND" | "STRUCTURE" | "NONE",
  "closePercent": number (for partial close),
  "newSlPrice": number | null (for MOVE_SL, 0 = breakeven),
  "watchTarget": "sma200" | "ema1000" | "supertrend" | null (for WATCH_CREATE),
  "threshold": number (distance % for watch trigger, default 0.5),
  "expiryMinutes": number (watch expiry, default 120),
  "autoEnter": boolean (auto-enter when watch triggers),
  "side": "LONG" | "SHORT" (intended trade side for watch),
  "confidence": number (0-1, how confident you are in parsing),
  "clarification": string | null (if you need more info)
}

Examples:
- "long btc" → action: ENTER_LONG, symbol: BTCUSDT
- "go short on ethereum with 1% risk" → action: ENTER_SHORT, symbol: ETHUSDT, riskPercent: 1
- "close half my position" → action: CLOSE_PARTIAL, closePercent: 50
- "move stop to breakeven" → action: MOVE_SL, newSlPrice: 0
- "what do you think about btc?" → action: OPINION, symbol: BTCUSDT
- "pause trading" → action: PAUSE
- "how's my position?" → action: INFO
- "watch btc near sma200" → action: WATCH_CREATE, symbol: BTCUSDT, watchTarget: "sma200", side: "LONG"
- "scan eth closer to ema1000 for short" → action: WATCH_CREATE, symbol: ETHUSDT, watchTarget: "ema1000", side: "SHORT"
- "alert me when btc gets to supertrend" → action: WATCH_CREATE, symbol: BTCUSDT, watchTarget: "supertrend"
- "watch sol near ma 0.3%" → action: WATCH_CREATE, symbol: SOLUSDT, watchTarget: "sma200", threshold: 0.3
- "watch btc 4 hours auto enter" → action: WATCH_CREATE, symbol: BTCUSDT, expiryMinutes: 240, autoEnter: true
- "cancel watch btc" → action: WATCH_CANCEL, symbol: BTCUSDT
- "cancel all watches" → action: WATCH_CANCEL

Symbol aliases: BTC=BTCUSDT, ETH=ETHUSDT, SOL=SOLUSDT, etc.`;

export interface ParsedIntent {
  action: IntentAction | 'INFO' | 'OPINION' | 'UNKNOWN';
  symbol?: string;
  riskPercent?: number;
  leverage?: number;
  slRule?: string;
  slPrice?: number;
  tpRule?: string;
  tpRR?: number;
  trailMode?: string;
  closePercent?: number;
  newSlPrice?: number;
  // Watch/Scanner fields
  watchTarget?: 'sma200' | 'ema1000' | 'supertrend';
  threshold?: number;
  expiryMinutes?: number;
  autoEnter?: boolean;
  side?: 'LONG' | 'SHORT';
  watchId?: string;
  // Meta
  confidence: number;
  clarification?: string;
}

export async function parseIntentWithLLM(userMessage: string): Promise<ParsedIntent> {
  try {
    const model = getModel();
    
    const result = await model.generateContent([
      { text: INTENT_SYSTEM_PROMPT },
      { text: `Parse this command: "${userMessage}"` },
    ]);

    const response = result.response.text();
    
    // Extract JSON from response (handle markdown code blocks)
    let jsonStr = response;
    const jsonMatch = response.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (jsonMatch) {
      jsonStr = jsonMatch[1];
    }
    
    const parsed = JSON.parse(jsonStr.trim()) as ParsedIntent;
    
    logger.info({ userMessage, parsed }, 'LLM parsed intent');
    return parsed;
    
  } catch (error) {
    logger.error({ error, userMessage }, 'LLM parsing failed');
    return {
      action: 'UNKNOWN',
      confidence: 0,
      clarification: 'Could not understand the command. Try: "long BTC", "close position", or "what do you think?"',
    };
  }
}

// ============================================
// TRADE OPINION & ANALYSIS
// ============================================

const OPINION_SYSTEM_PROMPT = `You are **Legenda** - a legendary trader with 30+ years of experience giving your honest opinion.

You've seen everything - the crashes, the moons, the liquidations. You lost it all twice before making billions.
You're talking to a fellow experienced trader as an equal, not a student.

**Your Style:**
- NEVER say "kid" or talk down - this is a fellow pro
- Speak trader-to-trader: "Here's my read...", "The way I see this...", "Between us..."
- Share a quick war story if it's relevant
- Be genuinely honest - if it's risky, say it straight
- If the setup is clean, get excited about it
- Keep it conversational, 2-3 sentences for the opinion

**Strategy Rules You Follow:**
1. LONG only when: Price above Supertrend (UP) + above SMA200 + above EMA1000
2. SHORT only when: Price below Supertrend (DOWN) + below SMA200 + below EMA1000
3. BOS (Break of Structure) = continuation signal
4. CHoCH (Change of Character) = reversal warning
5. Protected swing = your stop loss area (if broken, trade invalid)
6. Best entries: Near Supertrend edge OR near MA support/resistance

**When to Recommend WAIT + WATCH:**
- Price too far from key levels (>2% from Supertrend, SMA, or EMA)
- Structure just broke (wait for retest)
- Near protected swing (risky entry)
→ Suggest: "Set a WATCH for when price gets closer to [SMA200/EMA1000/Supertrend]"

**CONFIDENCE = RISK SIZE:**
Your confidence score (1-10) directly determines position size:
- Confidence 1 = 5% of budget (low conviction, small bet)
- Confidence 5 = 25% of budget (medium conviction)
- Confidence 10 = 50% of budget (maximum conviction, best setup ever)

BE HONEST with confidence - it determines real money on the line!
- 1-3: Weak setup, structure unclear, far from levels
- 4-6: Decent setup but some concerns
- 7-8: Clean setup, aligned indicators, good entry
- 9-10: PERFECT setup, everything aligned, near key level, strong structure

**Analyze:**
- Look at Supertrend direction, MA positions, structure (BOS/CHoCH)
- Check distances to key levels - best entries are NEAR support/resistance
- Consider the risk/reward honestly
- Would YOU take this trade with your own money? How much?

Format your response as JSON (but make the "opinion" field sound like a pro talking to another pro):
{
  "opinion": "Your conversational opinion as one trader to another",
  "recommendation": "ENTER" | "WAIT" | "SKIP" | "EXIT",
  "confidence": 1-10 (THIS DETERMINES POSITION SIZE!),
  "keyPoints": ["brief point1", "brief point2", "brief point3"],
  "riskLevel": "LOW" | "MEDIUM" | "HIGH",
  "watchSuggestion": "watch btc near sma200" or null (suggest if WAIT)
}`;

export interface TradeOpinion {
  opinion: string;
  recommendation: 'ENTER' | 'WAIT' | 'SKIP' | 'EXIT';
  confidence: number;           // 1-10
  suggestedRiskPercent: number; // 5-50% (calculated from confidence)
  keyPoints: string[];
  riskLevel: 'LOW' | 'MEDIUM' | 'HIGH';
  watchSuggestion?: string | null;
}

/**
 * Calculate risk % based on confidence score
 * Confidence 1 = 5%
 * Confidence 10 = 50%
 * Linear scale: risk = 5 + (confidence - 1) * 5
 */
function confidenceToRisk(confidence: number): number {
  const clampedConfidence = Math.max(1, Math.min(10, confidence));
  // Linear: 1->5%, 10->50%
  const risk = 5 + (clampedConfidence - 1) * 5;
  return Math.round(risk);
}

export async function getTradeOpinion(
  symbol: string,
  side: TradeSide | null,
  strategyState: StrategyState,
  currentPrice: number,
  additionalContext?: string
): Promise<TradeOpinion> {
  try {
    const model = getModel();
    
    // Format BOS/CHoCH info
    const lastBOS = strategyState.snapshot.lastBOS;
    const lastCHoCH = strategyState.snapshot.lastCHoCH;
    const bosInfo = lastBOS 
      ? `Last BOS: ${lastBOS.direction} at ${lastBOS.level?.toFixed(2) || 'N/A'}` 
      : 'No recent BOS';
    const chochInfo = lastCHoCH 
      ? `Last CHoCH: ${lastCHoCH.direction} at ${lastCHoCH.level?.toFixed(2) || 'N/A'} ⚠️ REVERSAL SIGNAL` 
      : 'No recent CHoCH';

    const marketContext = `
Symbol: ${symbol}
Current Price: ${currentPrice}
Intended Side: ${side || 'Not specified - asking for general opinion'}

=== STRATEGY GATE ===
- Current Bias: ${strategyState.bias}
- Strategy Active: ${strategyState.strategyId || 'None'}
- LONG Allowed: ${strategyState.allowLongEntry ? '✅ YES' : '❌ NO'}
- SHORT Allowed: ${strategyState.allowShortEntry ? '✅ YES' : '❌ NO'}

=== INDICATORS ===
Supertrend:
- Direction: ${strategyState.snapshot.supertrendDir}
- Value: ${strategyState.snapshot.supertrendValue.toFixed(2)}
- Distance from price: ${strategyState.snapshot.distanceToSupertrend?.toFixed(2) || 'N/A'}%
- Price is ${currentPrice > strategyState.snapshot.supertrendValue ? 'ABOVE ✅' : 'BELOW ⬇️'} Supertrend

SMA 200:
- Value: ${strategyState.snapshot.sma200.toFixed(2)}
- Distance from price: ${strategyState.snapshot.distanceToSma200?.toFixed(2) || 'N/A'}%
- Price is ${strategyState.snapshot.closeAboveSma200 ? 'ABOVE ✅' : 'BELOW ⬇️'} SMA200

EMA 1000:
- Value: ${strategyState.snapshot.ema1000.toFixed(2)}
- Distance from price: ${strategyState.snapshot.distanceToEma1000?.toFixed(2) || 'N/A'}%
- Price is ${strategyState.snapshot.closeAboveEma1000 ? 'ABOVE ✅' : 'BELOW ⬇️'} EMA1000

=== MARKET STRUCTURE ===
- Structure Bias: ${strategyState.snapshot.structureBias}
- Current Trend: ${strategyState.snapshot.currentTrend || 'N/A'}
- ${bosInfo}
- ${chochInfo}

=== KEY SWING LEVELS ===
- Protected Swing High: ${strategyState.keyLevels.protectedSwingHigh?.toFixed(2) || 'N/A'}
- Protected Swing Low: ${strategyState.keyLevels.protectedSwingLow?.toFixed(2) || 'N/A'}
- Last Swing High: ${strategyState.keyLevels.lastSwingHigh?.toFixed(2) || 'N/A'}
- Last Swing Low: ${strategyState.keyLevels.lastSwingLow?.toFixed(2) || 'N/A'}
- Distance to Swing High: ${strategyState.snapshot.distanceToSwingHigh?.toFixed(2) || 'N/A'}%
- Distance to Swing Low: ${strategyState.snapshot.distanceToSwingLow?.toFixed(2) || 'N/A'}%
${strategyState.snapshot.protectedLevel ? `- Protected Level (SL area): ${strategyState.snapshot.protectedLevel.toFixed(2)} (${strategyState.snapshot.distanceToProtectedLevel?.toFixed(2)}% away)` : ''}

=== ENTRY QUALITY CHECK ===
${Math.abs(strategyState.snapshot.distanceToSupertrend || 0) < 1 ? '✅ Near Supertrend edge - GOOD entry zone' : '⚠️ Far from Supertrend - consider waiting'}
${Math.abs(strategyState.snapshot.distanceToSma200 || 0) < 1 ? '✅ Near SMA200 - strong level' : ''}
${Math.abs(strategyState.snapshot.distanceToEma1000 || 0) < 1 ? '✅ Near EMA1000 - strong level' : ''}
${lastCHoCH ? '⚠️ Recent CHoCH detected - potential reversal, be cautious' : ''}

${additionalContext ? `Additional Context: ${additionalContext}` : ''}
`;

    const result = await model.generateContent([
      { text: OPINION_SYSTEM_PROMPT },
      { text: marketContext },
    ]);

    const response = result.response.text();
    
    // Extract JSON
    let jsonStr = response;
    const jsonMatch = response.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (jsonMatch) {
      jsonStr = jsonMatch[1];
    }
    
    const rawOpinion = JSON.parse(jsonStr.trim());
    
    // Calculate risk from confidence (1-10 → 5%-50%)
    const confidence = rawOpinion.confidence || 5;
    const suggestedRiskPercent = confidenceToRisk(confidence);
    
    const opinion: TradeOpinion = {
      opinion: rawOpinion.opinion,
      recommendation: rawOpinion.recommendation,
      confidence,
      suggestedRiskPercent,
      keyPoints: rawOpinion.keyPoints || [],
      riskLevel: rawOpinion.riskLevel || 'MEDIUM',
      watchSuggestion: rawOpinion.watchSuggestion,
    };
    
    logger.info({ 
      symbol, 
      side, 
      recommendation: opinion.recommendation,
      confidence,
      riskPercent: suggestedRiskPercent,
    }, 'Trade opinion generated');
    
    return opinion;
    
  } catch (error) {
    logger.error({ error, symbol }, 'Failed to get trade opinion');
    return {
      opinion: 'Unable to analyze at this time. Check your indicators manually.',
      recommendation: 'WAIT',
      confidence: 1,
      suggestedRiskPercent: 5, // Minimum risk when error
      keyPoints: ['LLM analysis unavailable'],
      riskLevel: 'HIGH',
    };
  }
}

// ============================================
// TRADE JOURNAL ANALYSIS
// ============================================

const JOURNAL_SYSTEM_PROMPT = `You are a trading coach analyzing a trader's journal/history. 

Provide constructive feedback:
- Identify patterns (good and bad)
- Note emotional trading signs
- Suggest improvements
- Be encouraging but honest
- Focus on actionable advice

Format response as JSON:
{
  "summary": "Brief summary of performance",
  "winRate": "X%",
  "strengths": ["strength1", "strength2"],
  "weaknesses": ["weakness1", "weakness2"],
  "patterns": ["pattern1", "pattern2"],
  "advice": "Main actionable advice",
  "emotionalScore": 1-10 (10 = disciplined, 1 = emotional),
  "overallGrade": "A" | "B" | "C" | "D" | "F"
}`;

export interface JournalAnalysis {
  summary: string;
  winRate: string;
  strengths: string[];
  weaknesses: string[];
  patterns: string[];
  advice: string;
  emotionalScore: number;
  overallGrade: 'A' | 'B' | 'C' | 'D' | 'F';
}

export async function analyzeJournal(trades: TradeRecord[]): Promise<JournalAnalysis> {
  try {
    const model = getModel();
    
    const tradesContext = trades.map((t, i) => `
Trade ${i + 1}:
- Symbol: ${t.symbol}, Side: ${t.side}
- Entry: ${t.entryPrice}, Exit: ${t.exitPrice || 'Open'}
- PnL: ${t.pnl || 'N/A'}
- Duration: ${t.duration || 'N/A'}
- Exit Reason: ${t.exitReason || 'N/A'}
- Notes: ${t.notes || 'None'}
`).join('\n');

    const result = await model.generateContent([
      { text: JOURNAL_SYSTEM_PROMPT },
      { text: `Analyze these ${trades.length} trades:\n${tradesContext}` },
    ]);

    const response = result.response.text();
    
    let jsonStr = response;
    const jsonMatch = response.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (jsonMatch) {
      jsonStr = jsonMatch[1];
    }
    
    return JSON.parse(jsonStr.trim()) as JournalAnalysis;
    
  } catch (error) {
    logger.error({ error }, 'Failed to analyze journal');
    return {
      summary: 'Unable to analyze trades at this time.',
      winRate: 'N/A',
      strengths: [],
      weaknesses: [],
      patterns: [],
      advice: 'Keep a detailed journal for better analysis.',
      emotionalScore: 5,
      overallGrade: 'C',
    };
  }
}

// Trade record for journal
export interface TradeRecord {
  symbol: string;
  side: TradeSide;
  entryPrice: number;
  exitPrice?: number;
  pnl?: string;
  duration?: string;
  exitReason?: string;
  notes?: string;
}

// ============================================
// CONVERSATIONAL RESPONSES
// ============================================

const CHAT_SYSTEM_PROMPT = `You are **Legenda** - the most legendary day trader who ever lived.

**Your Story:**
- 30+ years of trading experience, started with nothing
- Lost everything twice before making billions
- Rose from the bottom to become the most respected daily trader in history
- Now you trade alongside other experienced traders as equals

**Your Personality:**
- You're talking to fellow experienced traders, NOT beginners - treat them as equals
- Calm and zen-like, never panicked - you've seen every market condition
- Speaks from experience with wisdom, not textbook knowledge
- Uses colorful trader stories and analogies from your career
- Knows EXACTLY when to take risks and when to sit on hands
- Friendly colleague vibe - like two pros having coffee and discussing setups
- Occasionally shares battle scars from your past to connect

**Strategy Knowledge You Have:**
1. LONG entries: Supertrend UP + Price > SMA200 + Price > EMA1000
2. SHORT entries: Supertrend DOWN + Price < SMA200 + Price < EMA1000
3. BOS (Break of Structure) = trend continuation, good signal
4. CHoCH (Change of Character) = potential reversal, be careful!
5. Best entries are NEAR key levels (Supertrend edge, SMA200, EMA1000)
6. If price too far from levels, WAIT and set a WATCH
7. Protected swing = stop loss zone. If broken = exit trade

**Commands You Can Suggest:**
- "watch BTC near sma200" - Set alert when price approaches level
- "watch ETH near supertrend 0.5%" - Alert at specific distance
- "watch SOL near ema1000 4 hours" - Watch with expiry
- "long BTC risk 0.5" - Enter long position
- "close BTC" - Exit position
- "pause" / "resume" - Stop/start trading

**When to Suggest a Watch:**
- Price far from key levels (>1-2%)
- Waiting for better entry
- Structure needs confirmation
- Say: "Set a watch, let price come to us"

**How You Talk:**
- NEVER say "kid" or talk down - they're experienced traders too
- Use: "Here's how I see it...", "My read on this...", "Between us..."
- Share quick stories: "I remember in '08..." or "Reminds me of when I..."
- Give genuine opinions like you're talking to a trading buddy
- If something looks risky, warn them trader-to-trader
- Celebrate wins, commiserate losses - you've been there
- Keep it conversational, 2-4 sentences usually
- Use trading wisdom naturally: "The market will always be here tomorrow"
- SUGGEST WATCHES when appropriate: "Let's set a watch for when price gets closer"

Remember: You're not a mentor to beginners. You're Legenda talking to a fellow experienced trader as an equal.`;

export async function chat(
  userMessage: string,
  context?: {
    positions?: string;
    recentTrades?: string;
    marketState?: string;
  }
): Promise<string> {
  try {
    const model = getModel();
    
    let contextStr = '';
    if (context) {
      if (context.positions) contextStr += `\nCurrent Positions:\n${context.positions}`;
      if (context.recentTrades) contextStr += `\nRecent Trades:\n${context.recentTrades}`;
      if (context.marketState) contextStr += `\nMarket State:\n${context.marketState}`;
    }

    const result = await model.generateContent([
      { text: CHAT_SYSTEM_PROMPT },
      { text: contextStr ? `Context:${contextStr}\n\nUser: ${userMessage}` : `User: ${userMessage}` },
    ]);

    return result.response.text();
    
  } catch (error) {
    logger.error({ error }, 'Chat failed');
    return "I'm having trouble responding right now. Try again in a moment.";
  }
}

// ============================================
// RISK ASSESSMENT
// ============================================

export async function assessRisk(
  symbol: string,
  side: TradeSide,
  riskPercent: number,
  leverage: number,
  strategyState: StrategyState
): Promise<{ safe: boolean; warning?: string; suggestion?: string }> {
  // Quick rule-based checks first
  if (riskPercent > 2) {
    return {
      safe: false,
      warning: `Risk of ${riskPercent}% is aggressive. Consider reducing.`,
      suggestion: 'Lower risk to 1% or less for better capital preservation.',
    };
  }

  if (leverage > 5 && riskPercent > 1) {
    return {
      safe: false,
      warning: 'High leverage + high risk is dangerous.',
      suggestion: 'Either reduce leverage to 3x or risk to 0.5%.',
    };
  }

  // Check alignment
  if (side === 'LONG' && !strategyState.allowLongEntry) {
    return {
      safe: false,
      warning: 'Strategy does not allow LONG entry right now.',
      suggestion: 'Wait for proper alignment or take a SHORT instead.',
    };
  }

  if (side === 'SHORT' && !strategyState.allowShortEntry) {
    return {
      safe: false,
      warning: 'Strategy does not allow SHORT entry right now.',
      suggestion: 'Wait for proper alignment or take a LONG instead.',
    };
  }

  return { safe: true };
}

// Export check for API key
export function isLLMAvailable(): boolean {
  return !!getApiKey();
}

// ============================================
// TEXT SUMMARIZATION (for memory system)
// ============================================

export async function summarizeText(text: string): Promise<string> {
  try {
    const model = getModel();
    
    const result = await model.generateContent([
      { text: 'Summarize the following text concisely, focusing on key trading patterns, decisions, and lessons. Keep under 200 words.' },
      { text: text },
    ]);

    return result.response.text();
  } catch (error) {
    logger.error({ error }, 'Summarization failed');
    return 'Summary generation failed.';
  }
}

// ============================================
// CHAT WITH MEMORY CONTEXT
// ============================================

export async function chatWithMemory(
  userMessage: string,
  memoryContext: string,
  additionalContext?: {
    positions?: string;
    recentTrades?: string;
    marketState?: string;
  }
): Promise<string> {
  try {
    const model = getModel();
    
    let fullContext = '';
    
    // Add memory context first
    if (memoryContext) {
      fullContext += `[Your Memory - Use this to personalize responses]\n${memoryContext}\n\n`;
    }
    
    // Add current context
    if (additionalContext) {
      if (additionalContext.positions) fullContext += `Current Positions:\n${additionalContext.positions}\n`;
      if (additionalContext.recentTrades) fullContext += `Recent Trades:\n${additionalContext.recentTrades}\n`;
      if (additionalContext.marketState) fullContext += `Market State:\n${additionalContext.marketState}\n`;
    }

    const result = await model.generateContent([
      { text: CHAT_SYSTEM_PROMPT + '\n\nYou have access to memory of past conversations. Use it to provide personalized, contextual responses.' },
      { text: fullContext ? `Context:\n${fullContext}\n\nUser: ${userMessage}` : `User: ${userMessage}` },
    ]);

    return result.response.text();
    
  } catch (error) {
    logger.error({ error }, 'Chat with memory failed');
    return "I'm having trouble responding right now. Try again in a moment.";
  }
}

