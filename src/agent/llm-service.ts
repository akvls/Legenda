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
  "action": "ENTER_LONG" | "ENTER_SHORT" | "CLOSE" | "CLOSE_PARTIAL" | "MOVE_SL" | "PAUSE" | "RESUME" | "INFO" | "OPINION" | "UNKNOWN",
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

const OPINION_SYSTEM_PROMPT = `You are an expert crypto trader assistant. Analyze the current market conditions and give your HONEST opinion.

Be concise but insightful. Use these guidelines:
- Look at the strategy state (Supertrend, MA positions, structure)
- Consider the bias alignment
- Assess risk/reward
- Be direct - say if it's a good or bad trade
- Use trader lingo naturally
- Give a confidence score (1-10)
- Keep response under 150 words

Format your response as JSON:
{
  "opinion": "Your trading opinion here",
  "recommendation": "ENTER" | "WAIT" | "SKIP" | "EXIT",
  "confidence": 1-10,
  "keyPoints": ["point1", "point2", "point3"],
  "riskLevel": "LOW" | "MEDIUM" | "HIGH",
  "suggestedRisk": 0.5 (suggested risk % if entering)
}`;

export interface TradeOpinion {
  opinion: string;
  recommendation: 'ENTER' | 'WAIT' | 'SKIP' | 'EXIT';
  confidence: number;
  keyPoints: string[];
  riskLevel: 'LOW' | 'MEDIUM' | 'HIGH';
  suggestedRisk: number;
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
    
    const marketContext = `
Symbol: ${symbol}
Current Price: ${currentPrice}
Intended Side: ${side || 'Not specified - asking for general opinion'}

Strategy State:
- Bias: ${strategyState.bias}
- Strategy Active: ${strategyState.strategyId || 'None'}
- Allow Long: ${strategyState.allowLongEntry}
- Allow Short: ${strategyState.allowShortEntry}

Indicators:
- Supertrend: ${strategyState.snapshot.supertrendDir} @ ${strategyState.snapshot.supertrendValue.toFixed(2)}
- Price vs Supertrend: ${currentPrice > strategyState.snapshot.supertrendValue ? 'ABOVE' : 'BELOW'}
- SMA200: ${strategyState.snapshot.sma200.toFixed(2)} (${strategyState.snapshot.closeAboveSma200 ? 'Price ABOVE' : 'Price BELOW'})
- EMA1000: ${strategyState.snapshot.ema1000.toFixed(2)} (${strategyState.snapshot.closeAboveEma1000 ? 'Price ABOVE' : 'Price BELOW'})
- Structure Bias: ${strategyState.snapshot.structureBias}

Key Levels:
- Protected Swing High: ${strategyState.keyLevels.protectedSwingHigh}
- Protected Swing Low: ${strategyState.keyLevels.protectedSwingLow}
- Last Swing High: ${strategyState.keyLevels.lastSwingHigh}
- Last Swing Low: ${strategyState.keyLevels.lastSwingLow}

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
    
    const opinion = JSON.parse(jsonStr.trim()) as TradeOpinion;
    
    logger.info({ symbol, side, opinion: opinion.recommendation }, 'Trade opinion generated');
    return opinion;
    
  } catch (error) {
    logger.error({ error, symbol }, 'Failed to get trade opinion');
    return {
      opinion: 'Unable to analyze at this time. Check your indicators manually.',
      recommendation: 'WAIT',
      confidence: 0,
      keyPoints: ['LLM analysis unavailable'],
      riskLevel: 'HIGH',
      suggestedRisk: 0.25,
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

const CHAT_SYSTEM_PROMPT = `You are a helpful trading assistant. You're friendly, knowledgeable about crypto trading, and direct.

Keep responses concise (under 100 words usually).
Use trader lingo naturally.
If asked about positions or trades, reference the context provided.
Be encouraging but realistic about risks.`;

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

