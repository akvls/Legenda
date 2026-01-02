import { existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { createLogger } from '../utils/logger.js';
import { config } from '../config/index.js';

const logger = createLogger('memory');

/**
 * AI Memory System
 * 
 * Hierarchical memory with:
 * 1. Short-term: Current session (resets every 24 hours)
 * 2. Long-term: Saved conversations (every 7 days)
 * 3. Summaries: Compressed history (30 days, 4 months, 1 year)
 * 
 * This allows the AI to:
 * - Remember recent context
 * - Access trading patterns over time
 * - Stay within context window limits
 */

// Memory storage directory
const MEMORY_DIR = join(process.cwd(), 'data', 'memory');
const CONVERSATIONS_DIR = join(MEMORY_DIR, 'conversations');
const SUMMARIES_DIR = join(MEMORY_DIR, 'summaries');

// Ensure directories exist
function ensureDirectories(): void {
  [MEMORY_DIR, CONVERSATIONS_DIR, SUMMARIES_DIR].forEach(dir => {
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
      logger.info({ dir }, 'Created memory directory');
    }
  });
}

// ============================================
// TYPES
// ============================================

export interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: number;
}

export interface ChatSession {
  id: string;
  startedAt: number;
  lastMessageAt: number;
  messages: ChatMessage[];
}

export interface ConversationFile {
  sessionId: string;
  date: string;
  messages: ChatMessage[];
  tradeCount: number;
  symbols: string[];
}

export interface MemorySummary {
  period: '30d' | '4mo' | '1yr' | 'all';
  generatedAt: number;
  fromDate: string;
  toDate: string;
  summary: string;
  keyPatterns: string[];
  tradingStats: {
    totalTrades: number;
    winRate?: number;
    mostTradedSymbols: string[];
    commonMistakes?: string[];
  };
}

// ============================================
// SHORT-TERM MEMORY (24-hour sessions)
// ============================================

class ShortTermMemory {
  private currentSession: ChatSession | null = null;
  private readonly MAX_MESSAGES = 100; // Keep last 100 messages in session
  private readonly SESSION_DURATION_MS = 24 * 60 * 60 * 1000; // 24 hours

  constructor() {
    this.loadOrCreateSession();
  }

  private generateSessionId(): string {
    const date = new Date().toISOString().split('T')[0];
    return `session-${date}-${Date.now()}`;
  }

  private loadOrCreateSession(): void {
    const sessionFile = join(MEMORY_DIR, 'current-session.json');
    
    if (existsSync(sessionFile)) {
      try {
        const data = JSON.parse(readFileSync(sessionFile, 'utf-8')) as ChatSession;
        const now = Date.now();
        
        // Check if session is still valid (within 24 hours)
        if (now - data.startedAt < this.SESSION_DURATION_MS) {
          this.currentSession = data;
          logger.info({ sessionId: data.id, messageCount: data.messages.length }, 'Loaded existing session');
          return;
        } else {
          // Session expired - save it before creating new one
          this.archiveSession(data);
        }
      } catch (error) {
        logger.warn({ error }, 'Failed to load session, creating new one');
      }
    }

    // Create new session
    this.currentSession = {
      id: this.generateSessionId(),
      startedAt: Date.now(),
      lastMessageAt: Date.now(),
      messages: [],
    };
    logger.info({ sessionId: this.currentSession.id }, 'Created new session');
  }

  private archiveSession(session: ChatSession): void {
    if (session.messages.length === 0) return;

    const date = new Date(session.startedAt).toISOString().split('T')[0];
    const filename = `conv-${date}-${session.id}.json`;
    const filepath = join(CONVERSATIONS_DIR, filename);

    const conversationFile: ConversationFile = {
      sessionId: session.id,
      date,
      messages: session.messages,
      tradeCount: session.messages.filter(m => 
        m.content.includes('✅') && (m.content.includes('LONG') || m.content.includes('SHORT'))
      ).length,
      symbols: this.extractSymbols(session.messages),
    };

    writeFileSync(filepath, JSON.stringify(conversationFile, null, 2));
    logger.info({ filepath, messageCount: session.messages.length }, 'Archived session');
  }

  private extractSymbols(messages: ChatMessage[]): string[] {
    const symbols = new Set<string>();
    const symbolRegex = /\b([A-Z]{2,10}USDT?)\b/g;
    
    messages.forEach(m => {
      const matches = m.content.match(symbolRegex);
      if (matches) {
        matches.forEach(s => symbols.add(s));
      }
    });
    
    return Array.from(symbols);
  }

  addMessage(role: 'user' | 'assistant', content: string): void {
    if (!this.currentSession) {
      this.loadOrCreateSession();
    }

    const message: ChatMessage = {
      role,
      content,
      timestamp: Date.now(),
    };

    this.currentSession!.messages.push(message);
    this.currentSession!.lastMessageAt = Date.now();

    // Trim if too many messages
    if (this.currentSession!.messages.length > this.MAX_MESSAGES) {
      this.currentSession!.messages = this.currentSession!.messages.slice(-this.MAX_MESSAGES);
    }

    this.saveSession();
  }

  private saveSession(): void {
    if (!this.currentSession) return;
    
    const sessionFile = join(MEMORY_DIR, 'current-session.json');
    writeFileSync(sessionFile, JSON.stringify(this.currentSession, null, 2));
  }

  getRecentMessages(count: number = 20): ChatMessage[] {
    if (!this.currentSession) return [];
    return this.currentSession.messages.slice(-count);
  }

  getAllMessages(): ChatMessage[] {
    if (!this.currentSession) return [];
    return this.currentSession.messages;
  }

  getSessionContext(): string {
    const recent = this.getRecentMessages(10);
    if (recent.length === 0) return '';

    return recent.map(m => `${m.role}: ${m.content}`).join('\n');
  }

  clearSession(): void {
    if (this.currentSession) {
      this.archiveSession(this.currentSession);
    }
    this.currentSession = {
      id: this.generateSessionId(),
      startedAt: Date.now(),
      lastMessageAt: Date.now(),
      messages: [],
    };
    this.saveSession();
    logger.info('Session cleared and archived');
  }

  getSessionInfo(): { id: string; messageCount: number; startedAt: Date; hoursRemaining: number } {
    if (!this.currentSession) {
      return { id: 'none', messageCount: 0, startedAt: new Date(), hoursRemaining: 24 };
    }
    
    const elapsed = Date.now() - this.currentSession.startedAt;
    const remaining = Math.max(0, (this.SESSION_DURATION_MS - elapsed) / (60 * 60 * 1000));
    
    return {
      id: this.currentSession.id,
      messageCount: this.currentSession.messages.length,
      startedAt: new Date(this.currentSession.startedAt),
      hoursRemaining: Math.round(remaining * 10) / 10,
    };
  }
}

// ============================================
// LONG-TERM MEMORY (7-day saves + summaries)
// ============================================

class LongTermMemory {
  private summaries: Map<string, MemorySummary> = new Map();

  constructor() {
    this.loadSummaries();
  }

  private loadSummaries(): void {
    if (!existsSync(SUMMARIES_DIR)) return;

    const files = readdirSync(SUMMARIES_DIR).filter(f => f.endsWith('.json'));
    
    files.forEach(file => {
      try {
        const data = JSON.parse(readFileSync(join(SUMMARIES_DIR, file), 'utf-8')) as MemorySummary;
        this.summaries.set(data.period, data);
      } catch (error) {
        logger.warn({ file, error }, 'Failed to load summary');
      }
    });

    logger.info({ summaryCount: this.summaries.size }, 'Loaded long-term summaries');
  }

  getRecentConversations(days: number = 7): ConversationFile[] {
    if (!existsSync(CONVERSATIONS_DIR)) return [];

    const cutoff = Date.now() - (days * 24 * 60 * 60 * 1000);
    const files = readdirSync(CONVERSATIONS_DIR).filter(f => f.endsWith('.json'));
    const conversations: ConversationFile[] = [];

    files.forEach(file => {
      try {
        const data = JSON.parse(readFileSync(join(CONVERSATIONS_DIR, file), 'utf-8')) as ConversationFile;
        const fileDate = new Date(data.date).getTime();
        if (fileDate >= cutoff) {
          conversations.push(data);
        }
      } catch (error) {
        logger.warn({ file, error }, 'Failed to load conversation');
      }
    });

    return conversations.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
  }

  getSummary(period: '30d' | '4mo' | '1yr' | 'all'): MemorySummary | null {
    return this.summaries.get(period) || null;
  }

  async generateSummary(period: '30d' | '4mo' | '1yr', llmSummarize: (text: string) => Promise<string>): Promise<MemorySummary> {
    const daysMap = { '30d': 30, '4mo': 120, '1yr': 365 };
    const days = daysMap[period];
    
    const conversations = this.getRecentConversations(days);
    
    if (conversations.length === 0) {
      return {
        period,
        generatedAt: Date.now(),
        fromDate: new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
        toDate: new Date().toISOString().split('T')[0],
        summary: 'No conversations in this period.',
        keyPatterns: [],
        tradingStats: {
          totalTrades: 0,
          mostTradedSymbols: [],
        },
      };
    }

    // Compile all messages
    const allMessages = conversations.flatMap(c => c.messages);
    const totalTrades = conversations.reduce((sum, c) => sum + c.tradeCount, 0);
    const allSymbols = conversations.flatMap(c => c.symbols);
    const symbolCounts = allSymbols.reduce((acc, s) => {
      acc[s] = (acc[s] || 0) + 1;
      return acc;
    }, {} as Record<string, number>);
    const topSymbols = Object.entries(symbolCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([s]) => s);

    // Create text for LLM to summarize
    const conversationText = allMessages
      .slice(-500) // Last 500 messages to avoid token limits
      .map(m => `${m.role}: ${m.content}`)
      .join('\n');

    const prompt = `Summarize this trading conversation history. Focus on:
1. Trading patterns and preferences
2. Common strategies used
3. Emotional patterns (FOMO, revenge trading, discipline)
4. Key lessons learned
5. Areas for improvement

Keep summary concise (under 300 words).

Conversations:
${conversationText}`;

    let summary: string;
    try {
      summary = await llmSummarize(prompt);
    } catch (error) {
      summary = `${conversations.length} conversations over ${period}. ${totalTrades} trades executed. Top symbols: ${topSymbols.join(', ')}.`;
    }

    const memorySummary: MemorySummary = {
      period,
      generatedAt: Date.now(),
      fromDate: conversations[conversations.length - 1]?.date || '',
      toDate: conversations[0]?.date || '',
      summary,
      keyPatterns: topSymbols.map(s => `Frequently traded: ${s}`),
      tradingStats: {
        totalTrades,
        mostTradedSymbols: topSymbols,
      },
    };

    // Save summary
    const filename = `summary-${period}.json`;
    writeFileSync(join(SUMMARIES_DIR, filename), JSON.stringify(memorySummary, null, 2));
    this.summaries.set(period, memorySummary);

    logger.info({ period, totalTrades, conversations: conversations.length }, 'Generated summary');
    return memorySummary;
  }

  getMemoryContext(): string {
    const contexts: string[] = [];

    // Add most recent summary
    const summary30d = this.summaries.get('30d');
    if (summary30d) {
      contexts.push(`[30-Day Summary]: ${summary30d.summary}`);
    }

    const summary4mo = this.summaries.get('4mo');
    if (summary4mo) {
      contexts.push(`[4-Month Patterns]: ${summary4mo.keyPatterns.join(', ')}`);
    }

    return contexts.join('\n\n');
  }

  getStats(): { conversationCount: number; summaryPeriods: string[]; oldestDate?: string } {
    const conversations = this.getRecentConversations(365);
    
    return {
      conversationCount: conversations.length,
      summaryPeriods: Array.from(this.summaries.keys()),
      oldestDate: conversations[conversations.length - 1]?.date,
    };
  }
}

// ============================================
// MEMORY MANAGER (combines short + long term)
// ============================================

export class MemoryManager {
  private shortTerm: ShortTermMemory;
  private longTerm: LongTermMemory;
  private lastSummaryCheck: number = 0;

  constructor() {
    ensureDirectories();
    this.shortTerm = new ShortTermMemory();
    this.longTerm = new LongTermMemory();
  }

  /**
   * Add a message to short-term memory
   */
  addMessage(role: 'user' | 'assistant', content: string): void {
    this.shortTerm.addMessage(role, content);
  }

  /**
   * Get context for AI prompt (combines short + long term)
   */
  getContext(): string {
    const shortTermContext = this.shortTerm.getSessionContext();
    const longTermContext = this.longTerm.getMemoryContext();

    let context = '';
    
    if (longTermContext) {
      context += `=== LONG-TERM MEMORY ===\n${longTermContext}\n\n`;
    }
    
    if (shortTermContext) {
      context += `=== RECENT CONVERSATION ===\n${shortTermContext}`;
    }

    return context;
  }

  /**
   * Get recent messages for context window
   */
  getRecentMessages(count: number = 20): ChatMessage[] {
    return this.shortTerm.getRecentMessages(count);
  }

  /**
   * Get all messages from current session
   */
  getAllMessages(): ChatMessage[] {
    return this.shortTerm.getAllMessages();
  }

  /**
   * Check if summaries need regeneration
   */
  async checkAndGenerateSummaries(
    llmSummarize: (text: string) => Promise<string>
  ): Promise<void> {
    const now = Date.now();
    const ONE_DAY = 24 * 60 * 60 * 1000;

    // Only check once per day
    if (now - this.lastSummaryCheck < ONE_DAY) return;
    this.lastSummaryCheck = now;

    const stats = this.longTerm.getStats();
    
    // Generate 30-day summary if we have enough data
    if (stats.conversationCount >= 5) {
      const existing = this.longTerm.getSummary('30d');
      if (!existing || now - existing.generatedAt > 7 * ONE_DAY) {
        logger.info('Generating 30-day summary');
        await this.longTerm.generateSummary('30d', llmSummarize);
      }
    }

    // Generate 4-month summary if we have enough data
    if (stats.conversationCount >= 20) {
      const existing = this.longTerm.getSummary('4mo');
      if (!existing || now - existing.generatedAt > 30 * ONE_DAY) {
        logger.info('Generating 4-month summary');
        await this.longTerm.generateSummary('4mo', llmSummarize);
      }
    }

    // Generate 1-year summary if we have enough data
    if (stats.conversationCount >= 50) {
      const existing = this.longTerm.getSummary('1yr');
      if (!existing || now - existing.generatedAt > 90 * ONE_DAY) {
        logger.info('Generating 1-year summary');
        await this.longTerm.generateSummary('1yr', llmSummarize);
      }
    }
  }

  /**
   * Get memory status
   */
  getStatus(): {
    shortTerm: { id: string; messageCount: number; hoursRemaining: number };
    longTerm: { conversationCount: number; summaries: string[] };
  } {
    const sessionInfo = this.shortTerm.getSessionInfo();
    const stats = this.longTerm.getStats();

    return {
      shortTerm: {
        id: sessionInfo.id,
        messageCount: sessionInfo.messageCount,
        hoursRemaining: sessionInfo.hoursRemaining,
      },
      longTerm: {
        conversationCount: stats.conversationCount,
        summaries: stats.summaryPeriods,
      },
    };
  }

  /**
   * Clear current session (archives it first)
   */
  clearSession(): void {
    this.shortTerm.clearSession();
  }

  /**
   * Get a specific summary
   */
  getSummary(period: '30d' | '4mo' | '1yr'): MemorySummary | null {
    return this.longTerm.getSummary(period);
  }

  /**
   * Force generate a summary
   */
  async generateSummary(
    period: '30d' | '4mo' | '1yr',
    llmSummarize: (text: string) => Promise<string>
  ): Promise<MemorySummary> {
    return this.longTerm.generateSummary(period, llmSummarize);
  }
}

// Singleton
let memoryInstance: MemoryManager | null = null;

export function getMemoryManager(): MemoryManager {
  if (!memoryInstance) {
    memoryInstance = new MemoryManager();
  }
  return memoryInstance;
}

export const memoryManager = getMemoryManager();

