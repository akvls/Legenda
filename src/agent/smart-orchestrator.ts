import { createLogger } from '../utils/logger.js';
import { parseIntent as parseIntentBasic, formatIntent } from './intent-parser.js';
import { stateMachine } from './state-machine.js';
import { createTradeContract, formatContract, type TradeContract } from './trade-contract.js';
import { getTradeExecutor, type TradeExecutor } from '../execution/trade-executor.js';
import { getTrailingManager, type TrailingManager } from '../execution/trailing-manager.js';
import { getStrategyEngine, type StrategyEngine } from '../strategy/engine.js';
import { getPositionTracker } from '../execution/position-tracker.js';
import { prisma } from '../db/index.js';
import {
  parseIntentWithLLM,
  getTradeOpinion,
  analyzeJournal,
  chat as llmChat,
  chatWithMemory,
  assessRisk,
  isLLMAvailable,
  summarizeText,
  type TradeOpinion,
  type JournalAnalysis,
  type TradeRecord,
} from './llm-service.js';
import { memoryManager, type MemorySummary } from './memory.js';
import { circuitBreaker } from './circuit-breaker.js';
import { getWatchManager, type WatchRule } from './watch-manager.js';
import type { Intent, TradeSide, IntentAction, WatchTriggerType, WatchMode } from '../types/index.js';

const logger = createLogger('smart-orchestrator');

/**
 * Smart Orchestrator - LLM-Enhanced Trading Agent
 * 
 * Features:
 * 1. Natural language understanding via Gemini
 * 2. Trade opinions and analysis
 * 3. Risk assessment
 * 4. Journal/history analysis
 * 5. Conversational chat
 */

export interface SmartResponse {
  success: boolean;
  message: string;
  type: 'trade' | 'opinion' | 'info' | 'chat' | 'error';
  contract?: TradeContract;
  opinion?: TradeOpinion;
  journal?: JournalAnalysis;
  data?: unknown;
}

export class SmartOrchestrator {
  private contracts: Map<string, TradeContract> = new Map();
  private activeContractsBySymbol: Map<string, string> = new Map();
  private conversationHistory: Array<{ role: 'user' | 'assistant'; content: string }> = [];
  
  // Lazy-loaded dependencies
  private _tradeExecutor: TradeExecutor | null = null;
  private _trailingManager: TrailingManager | null = null;
  private _strategyEngine: StrategyEngine | null = null;

  constructor() {}

  private get tradeExecutor(): TradeExecutor {
    if (!this._tradeExecutor) this._tradeExecutor = getTradeExecutor();
    return this._tradeExecutor;
  }

  private get trailingManager(): TrailingManager {
    if (!this._trailingManager) this._trailingManager = getTrailingManager();
    return this._trailingManager;
  }

  private get strategyEngine(): StrategyEngine {
    if (!this._strategyEngine) this._strategyEngine = getStrategyEngine();
    return this._strategyEngine;
  }

  /**
   * Main chat handler - smart natural language processing
   */
  async handleChat(rawText: string): Promise<SmartResponse> {
    logger.info({ rawText }, 'Processing smart chat');

    // Store in memory
    memoryManager.addMessage('user', rawText);

    // Check if we need to generate summaries (runs in background)
    if (isLLMAvailable()) {
      memoryManager.checkAndGenerateSummaries(summarizeText).catch(err => 
        logger.warn({ err }, 'Background summary generation failed')
      );
    }

    // Try LLM parsing if available
    let parsedIntent;
    if (isLLMAvailable()) {
      try {
        parsedIntent = await parseIntentWithLLM(rawText);
        logger.info({ parsedIntent }, 'LLM parsed intent');
      } catch (error) {
        logger.warn({ error }, 'LLM parsing failed, falling back to basic');
      }
    }

    // Fallback to basic parser if LLM failed
    if (!parsedIntent || parsedIntent.action === 'UNKNOWN') {
      const basicIntent = parseIntentBasic(rawText);
      if (basicIntent) {
        parsedIntent = {
          action: basicIntent.action,
          symbol: basicIntent.symbol,
          riskPercent: basicIntent.riskPercent,
          leverage: basicIntent.requestedLeverage,
          slRule: basicIntent.slRule,
          tpRule: basicIntent.tpRule,
          trailMode: basicIntent.trailMode,
          closePercent: basicIntent.closePercent,
          newSlPrice: basicIntent.newSlPrice,
          confidence: 0.8,
        };
      }
    }

    // Route based on action
    if (!parsedIntent || parsedIntent.action === 'UNKNOWN') {
      // Conversational fallback
      return this.handleConversation(rawText);
    }

    // Handle different actions
    switch (parsedIntent.action) {
      case 'ENTER_LONG':
      case 'ENTER_SHORT':
        return this.handleEntry(parsedIntent, rawText);

      case 'CLOSE':
      case 'CLOSE_PARTIAL':
        return this.handleClose(parsedIntent);

      case 'MOVE_SL':
        return this.handleMoveSl(parsedIntent);

      case 'PAUSE':
        return this.handlePause();

      case 'RESUME':
        return this.handleResume();

      case 'OPINION':
        return this.handleOpinion(parsedIntent.symbol);

      case 'INFO':
        return this.handleInfo(parsedIntent.symbol);

      case 'WATCH_CREATE':
        return this.handleWatchCreate(parsedIntent);

      case 'WATCH_CANCEL':
        return this.handleWatchCancel(parsedIntent);

      default:
        return this.handleConversation(rawText);
    }
  }

  /**
   * Handle watch/scanner creation via chat
   */
  private async handleWatchCreate(parsed: any): Promise<SmartResponse> {
    const symbol = parsed.symbol || 'BTCUSDT';
    const side: TradeSide = parsed.side || 'LONG';
    
    // Determine trigger type from parsed intent
    let triggerType: WatchTriggerType = 'CLOSER_TO_SMA200';
    const target = (parsed.watchTarget || '').toLowerCase();
    
    if (target.includes('ema') || target.includes('1000')) {
      triggerType = 'CLOSER_TO_EMA1000';
    } else if (target.includes('super') || target.includes('trend')) {
      triggerType = 'CLOSER_TO_SUPERTREND';
    } else if (target.includes('sma') || target.includes('200')) {
      triggerType = 'CLOSER_TO_SMA200';
    }
    
    const threshold = parsed.threshold || 0.5;
    const mode: WatchMode = parsed.autoEnter ? 'AUTO_ENTER' : 'NOTIFY_ONLY';
    const expiryMinutes = parsed.expiryMinutes || 120;
    
    const watchManager = getWatchManager();
    const watch = watchManager.createWatch({
      symbol,
      intendedSide: side,
      triggerType,
      thresholdPercent: threshold,
      mode,
      expiryMinutes,
      preset: {
        riskPercent: parsed.riskPercent || 0.5,
        slRule: parsed.slRule || 'SWING',
        trailMode: parsed.trailMode || 'SUPERTREND',
      },
    });

    // Get current distance
    const distance = await watchManager.getCurrentDistance(symbol, triggerType);
    const distanceInfo = distance 
      ? `Current distance: ${distance.distance.toFixed(2)}% (threshold: ${threshold}%)`
      : '';

    const targetLabel = {
      'CLOSER_TO_SMA200': 'SMA200',
      'CLOSER_TO_EMA1000': 'EMA1000',
      'CLOSER_TO_SUPERTREND': 'Supertrend',
      'PRICE_ABOVE': 'Price Above',
      'PRICE_BELOW': 'Price Below',
    }[triggerType];

    const expiryHours = Math.round(expiryMinutes / 60 * 10) / 10;
    const modeLabel = mode === 'AUTO_ENTER' ? '🚀 Auto-enter when triggered' : '🔔 Notify only';

    const response = `👁️ **Watch Created!**

📊 **${symbol}** - ${side} near ${targetLabel}
🎯 Threshold: ${threshold}%
${distanceInfo}
⏰ Expires in: ${expiryHours} hours
${modeLabel}

I'll alert you when price gets within ${threshold}% of ${targetLabel}. ${mode === 'AUTO_ENTER' ? `Then I'll automatically enter ${side} with ${parsed.riskPercent || 0.5}% risk.` : 'You decide when to enter.'}`;

    memoryManager.addMessage('assistant', response);

    return {
      success: true,
      message: response,
      type: 'info',
      data: { watch },
    };
  }

  /**
   * Handle watch cancellation via chat
   */
  private async handleWatchCancel(parsed: any): Promise<SmartResponse> {
    const watchManager = getWatchManager();
    
    // If specific watch ID provided
    if (parsed.watchId) {
      const success = watchManager.cancelWatch(parsed.watchId);
      if (success) {
        return {
          success: true,
          message: '✅ Watch cancelled.',
          type: 'info',
        };
      }
      return {
        success: false,
        message: '❌ Watch not found or already inactive.',
        type: 'error',
      };
    }
    
    // Cancel all watches for symbol
    const symbol = parsed.symbol?.toUpperCase();
    if (symbol) {
      const watches = watchManager.getWatchesForSymbol(symbol);
      let cancelled = 0;
      for (const watch of watches) {
        if (watchManager.cancelWatch(watch.id)) cancelled++;
      }
      return {
        success: true,
        message: `✅ Cancelled ${cancelled} watch(es) for ${symbol}`,
        type: 'info',
      };
    }
    
    // Cancel all watches
    const allWatches = watchManager.getActiveWatches();
    let cancelled = 0;
    for (const watch of allWatches) {
      if (watchManager.cancelWatch(watch.id)) cancelled++;
    }
    return {
      success: true,
      message: `✅ Cancelled all ${cancelled} active watch(es)`,
      type: 'info',
    };
  }

  /**
   * Handle trade entry with LLM opinion
   */
  private async handleEntry(parsed: any, rawCommand?: string): Promise<SmartResponse> {
    const symbol = parsed.symbol || 'BTCUSDT';
    const side: TradeSide = parsed.action === 'ENTER_LONG' ? 'LONG' : 'SHORT';

    // Check if paused
    if (stateMachine.isPaused()) {
      return {
        success: false,
        message: '⏸️ Trading is paused. Say "resume" to continue.',
        type: 'error',
      };
    }

    // Check circuit breaker (70% daily loss = 24hr lockout)
    const circuitCheck = circuitBreaker.canTrade();
    if (!circuitCheck.allowed) {
      return {
        success: false,
        message: `${circuitCheck.reason}\n⏰ Unlocks in: ${circuitCheck.unlockIn}\n\n💡 This protects you from revenge trading. Take a break.`,
        type: 'error',
      };
    }

    // Check state machine
    const canEnter = stateMachine.canEnter(symbol, side);
    if (!canEnter.allowed) {
      return {
        success: false,
        message: `🚫 ${canEnter.reason}`,
        type: 'error',
      };
    }

    // Get strategy state
    const strategyState = this.strategyEngine.getState(symbol);
    if (!strategyState) {
      return {
        success: false,
        message: `📊 No market data for ${symbol}. Register it first with /api/strategy/register/${symbol}`,
        type: 'error',
      };
    }

    // Get LLM opinion if available
    let opinion: TradeOpinion | undefined;
    if (isLLMAvailable()) {
      try {
        opinion = await getTradeOpinion(
          symbol,
          side,
          strategyState,
          strategyState.snapshot.price
        );
      } catch (error) {
        logger.warn({ error }, 'Could not get trade opinion');
      }
    }

    // Risk assessment
    const riskPercent = parsed.riskPercent || 0.5;
    const leverage = Math.min(parsed.leverage || 5, 10);
    
    const riskCheck = await assessRisk(symbol, side, riskPercent, leverage, strategyState);
    
    // Build warning message if needed (AI advises only, does NOT block)
    let warningMsg = '';
    if (!riskCheck.safe) {
      warningMsg = `\n⚠️ ${riskCheck.warning}`;
      if (riskCheck.suggestion) warningMsg += `\n💡 ${riskCheck.suggestion}`;
    }

    // AI opinion is advisory only - trade will proceed
    // Only strategy rules (Hard Gate) can block trades

    // Create intent for trade contract
    const intent: Intent = {
      source: 'chat',
      rawText: `${side.toLowerCase()} ${symbol}`,
      action: side === 'LONG' ? 'ENTER_LONG' : 'ENTER_SHORT',
      symbol,
      riskPercent,
      requestedLeverage: leverage,
      slRule: (parsed.slRule as any) || 'SWING',
      tpRule: (parsed.tpRule as any) || 'NONE',
      trailMode: (parsed.trailMode as any) || 'SUPERTREND',
    };

    // Create contract
    const contract = createTradeContract(intent);
    if (!contract || contract.status === 'REJECTED') {
      return {
        success: false,
        message: `❌ Contract rejected: ${contract?.rejectReason || 'Unknown error'}`,
        type: 'error',
      };
    }

    // Store contract
    this.contracts.set(contract.id, contract);
    this.activeContractsBySymbol.set(symbol, contract.id);

    try {
      // Execute trade
      const result = await this.tradeExecutor.executeEntry({
        symbol,
        side,
        riskPercent: contract.riskPercent,
        requestedLeverage: contract.leverage,
        slRule: contract.slRule,
        tpRule: contract.tpRule,
        trailMode: contract.trailMode,
      });

      if (result.success) {
        contract.status = 'EXECUTED';
        contract.orderId = result.order?.id;
        contract.entryPrice = result.order?.avgFillPrice ?? undefined;
        contract.positionSize = result.order?.size;
        
        stateMachine.enterPosition(symbol, side);
        
        if (contract.trailMode !== 'NONE') {
          this.trailingManager.activateTrailing(symbol);
        }

        // Record trade with full snapshot
        await this.recordTrade(symbol, side, contract.entryPrice!, contract.positionSize!, contract, rawCommand);

        let responseMsg = `✅ **${side} ${symbol}**\n`;
        responseMsg += `📍 Entry: $${contract.entryPrice?.toFixed(2)}\n`;
        responseMsg += `📦 Size: ${contract.positionSize}\n`;
        responseMsg += `🛡️ SL: ${contract.actualSlPrice ? '$' + contract.actualSlPrice.toFixed(2) : 'Set'}\n`;
        responseMsg += `⚙️ Leverage: ${contract.leverage}x | Risk: ${contract.riskPercent}%`;
        
        // Add AI opinion as advice (not blocking)
        if (opinion) {
          responseMsg += `\n\n🤖 **AI Advice**: ${opinion.keyPoints[0] || opinion.opinion}`;
          if (opinion.recommendation === 'WAIT' || opinion.recommendation === 'SKIP') {
            responseMsg += `\n⚠️ AI suggested ${opinion.recommendation} (Confidence: ${opinion.confidence}/10)`;
          }
        }
        if (warningMsg) {
          responseMsg += warningMsg;
        }

        return {
          success: true,
          message: responseMsg,
          type: 'trade',
          contract,
          opinion,
        };
      } else {
        contract.status = 'REJECTED';
        contract.rejectReason = result.error || result.blockReason;
        return {
          success: false,
          message: `❌ Trade failed: ${result.error || result.blockReason}`,
          type: 'error',
          contract,
        };
      }
    } catch (error) {
      contract.status = 'REJECTED';
      return {
        success: false,
        message: `❌ Error: ${(error as Error).message}`,
        type: 'error',
      };
    }
  }

  /**
   * Handle close position
   */
  private async handleClose(parsed: any): Promise<SmartResponse> {
    const symbol = parsed.symbol;
    if (!symbol) {
      // Find any open position
      const positions = getPositionTracker().getAllPositions();
      if (positions.length === 0) {
        return {
          success: false,
          message: '📭 No open positions to close.',
          type: 'info',
        };
      }
      // Close first position
      return this.closePosition(positions[0].symbol, parsed.closePercent || 100);
    }

    return this.closePosition(symbol, parsed.closePercent || 100);
  }

  private async closePosition(symbol: string, percent: number): Promise<SmartResponse> {
    const state = stateMachine.getState(symbol);
    if (state.state !== 'IN_LONG' && state.state !== 'IN_SHORT') {
      return {
        success: false,
        message: `📭 No position in ${symbol} to close.`,
        type: 'info',
      };
    }

    try {
      stateMachine.startExiting(symbol);
      const reason = percent === 100 ? 'USER_CLOSE' : 'PARTIAL_CLOSE';
      const success = await this.tradeExecutor.executeExit(symbol, reason, percent);

      if (success) {
        this.trailingManager.deactivateTrailing(symbol);
        
        if (percent === 100) {
          stateMachine.exitClean(symbol);
          this.activeContractsBySymbol.delete(symbol);
        } else {
          stateMachine.enterPosition(symbol, state.side!);
        }

        return {
          success: true,
          message: `✅ Closed ${percent}% of ${symbol}`,
          type: 'trade',
        };
      } else {
        stateMachine.enterPosition(symbol, state.side!);
        return {
          success: false,
          message: `❌ Failed to close ${symbol}`,
          type: 'error',
        };
      }
    } catch (error) {
      stateMachine.enterPosition(symbol, state.side!);
      return {
        success: false,
        message: `❌ Error: ${(error as Error).message}`,
        type: 'error',
      };
    }
  }

  /**
   * Handle move SL
   */
  private async handleMoveSl(parsed: any): Promise<SmartResponse> {
    const symbol = parsed.symbol;
    if (!symbol) {
      return {
        success: false,
        message: '❓ Which symbol? Try "move BTC sl to breakeven"',
        type: 'error',
      };
    }

    if (parsed.newSlPrice === 0) {
      const success = await this.tradeExecutor.moveSlToBreakeven(symbol);
      return {
        success,
        message: success ? `✅ SL moved to breakeven for ${symbol}` : `❌ Failed to move SL`,
        type: success ? 'trade' : 'error',
      };
    }

    return {
      success: false,
      message: '💡 Currently only "breakeven" is supported. Try "move sl to be"',
      type: 'info',
    };
  }

  /**
   * Handle pause
   */
  private handlePause(): SmartResponse {
    stateMachine.pause();
    return {
      success: true,
      message: '⏸️ Trading **PAUSED**. All entries blocked until you say "resume".',
      type: 'info',
    };
  }

  /**
   * Handle resume
   */
  private handleResume(): SmartResponse {
    stateMachine.resume();
    return {
      success: true,
      message: '▶️ Trading **RESUMED**. Ready for action!',
      type: 'info',
    };
  }

  /**
   * Get AI opinion on a symbol
   */
  async handleOpinion(symbol?: string): Promise<SmartResponse> {
    const sym = symbol || 'BTCUSDT';
    
    const strategyState = this.strategyEngine.getState(sym);
    if (!strategyState) {
      return {
        success: false,
        message: `📊 No data for ${sym}. Register it first.`,
        type: 'error',
      };
    }

    if (!isLLMAvailable()) {
      // Provide basic opinion from strategy
      const bias = strategyState.bias;
      const allowLong = strategyState.allowLongEntry;
      const allowShort = strategyState.allowShortEntry;
      
      return {
        success: true,
        message: `📊 **${sym} Analysis**\n\nBias: **${bias}**\nLong Entry: ${allowLong ? '✅' : '❌'}\nShort Entry: ${allowShort ? '✅' : '❌'}\nSupertrend: ${strategyState.snapshot.supertrendDir}\nPrice: $${strategyState.snapshot.price.toFixed(2)}\n\n_Enable Gemini for AI opinions._`,
        type: 'info',
      };
    }

    try {
      const opinion = await getTradeOpinion(
        sym,
        null, // No specific side
        strategyState,
        strategyState.snapshot.price
      );

      const watchLine = opinion.watchSuggestion ? `\n\n💡 **Suggested Watch:** \`${opinion.watchSuggestion}\`` : '';
      
      return {
        success: true,
        message: `🤖 **AI Opinion on ${sym}**\n\n${opinion.opinion}\n\n📊 Recommendation: **${opinion.recommendation}**\n🎯 Confidence: ${opinion.confidence}/10 → 💰 Risk: **${opinion.suggestedRiskPercent}% of budget**\n⚠️ Risk Level: ${opinion.riskLevel}\n\n**Key Points:**\n${opinion.keyPoints.map(p => `• ${p}`).join('\n')}${watchLine}`,
        type: 'opinion',
        opinion,
      };
    } catch (error) {
      return {
        success: false,
        message: `❌ Could not get opinion: ${(error as Error).message}`,
        type: 'error',
      };
    }
  }

  /**
   * Get info about positions/status
   */
  private handleInfo(symbol?: string): SmartResponse {
    const positions = getPositionTracker().getAllPositions();
    const status = stateMachine.isPaused() ? 'PAUSED ⏸️' : 'RUNNING ▶️';

    let msg = `📊 **Trading Status: ${status}**\n\n`;

    if (positions.length === 0) {
      msg += '📭 No open positions.\n';
    } else {
      msg += '**Open Positions:**\n';
      for (const pos of positions) {
        msg += `• ${pos.side} ${pos.symbol}: ${pos.size} @ $${pos.avgPrice.toFixed(2)} (PnL: ${pos.unrealizedPnl >= 0 ? '+' : ''}$${pos.unrealizedPnl.toFixed(2)})\n`;
      }
    }

    // Get registered symbols
    const states = this.strategyEngine.getAllStates();
    if (states.length > 0) {
      msg += '\n**Watching:**\n';
      for (const state of states) {
        const stateInfo = stateMachine.getState(state.symbol);
        msg += `• ${state.symbol}: ${state.bias} bias, State: ${stateInfo.state}\n`;
      }
    }

    return {
      success: true,
      message: msg,
      type: 'info',
    };
  }

  /**
   * Conversational fallback - uses memory for context
   */
  private async handleConversation(message: string): Promise<SmartResponse> {
    if (!isLLMAvailable()) {
      const response = `❓ I didn't understand that. Try:\n• "long BTC"\n• "close position"\n• "what do you think about ETH?"\n• "pause trading"`;
      memoryManager.addMessage('assistant', response);
      return {
        success: false,
        message: response,
        type: 'error',
      };
    }

    try {
      // Build context from memory + current state
      const positions = getPositionTracker().getAllPositions();
      const positionContext = positions.length > 0
        ? positions.map(p => `${p.side} ${p.symbol}: ${p.size} @ ${p.avgPrice}`).join('\n')
        : 'No open positions';

      // Get memory context (short-term + long-term summaries)
      const memoryContext = memoryManager.getContext();

      const response = await chatWithMemory(message, memoryContext, {
        positions: positionContext,
        marketState: 'Active trading session',
      });

      // Store response in memory
      memoryManager.addMessage('assistant', response);

      return {
        success: true,
        message: response,
        type: 'chat',
      };
    } catch (error) {
      const errorMsg = `❌ ${(error as Error).message}`;
      memoryManager.addMessage('assistant', errorMsg);
      return {
        success: false,
        message: errorMsg,
        type: 'error',
      };
    }
  }

  /**
   * Record trade to database with full snapshot for LLM analysis
   */
  private async recordTrade(
    symbol: string,
    side: TradeSide,
    entryPrice: number,
    size: number,
    contract: TradeContract,
    rawCommand?: string
  ): Promise<void> {
    try {
      // Get current strategy state for snapshot
      const strategyState = await this.strategyEngine.getState(symbol);
      const snapshotJson = strategyState ? JSON.stringify(strategyState.snapshot) : null;

      // Get strategy ID from state if available
      const strategyId = strategyState?.strategyId || 'S101';

      await prisma.trade.create({
        data: {
          symbol,
          side,
          strategyId,
          timeframe: '5m',
          entryType: 'MARKET',
          riskPercent: contract.riskPercent,
          riskAmountUsdt: 0,
          requestedLeverage: contract.leverage,
          appliedLeverage: contract.leverage,
          slRule: contract.slRule,
          slPrice: contract.actualSlPrice || 0,
          tpRule: contract.tpRule,
          trailMode: contract.trailMode,
          invalidationRules: JSON.stringify({ biasFlip: true, structureBreak: true, supertrendFlip: true }),
          entryPrice,
          entrySize: size,
          entrySizeUsdt: size * entryPrice,
          entryFilledAt: new Date(),
          // Journal fields
          userRawCommand: rawCommand,
          strategySnapshotAtEntry: snapshotJson,
        },
      });
      logger.info({ symbol, side, entryPrice, size, hasSnapshot: !!snapshotJson }, 'Trade recorded to journal');
    } catch (error) {
      logger.error({ error }, 'Failed to record trade');
    }
  }

  /**
   * Analyze trading journal
   */
  async analyzeMyTrades(): Promise<SmartResponse> {
    try {
      const trades = await prisma.trade.findMany({
        orderBy: { createdAt: 'desc' },
        take: 50,
      });

      if (trades.length === 0) {
        return {
          success: true,
          message: '📔 No trades in journal yet. Start trading to build history!',
          type: 'info',
        };
      }

      const tradeRecords: TradeRecord[] = trades.map(t => ({
        symbol: t.symbol,
        side: t.side as TradeSide,
        entryPrice: t.entryPrice || 0,
        exitPrice: t.exitPrice || undefined,
        pnl: t.realizedPnl?.toString(),
        exitReason: t.exitReason || undefined,
      }));

      if (!isLLMAvailable()) {
        const wins = trades.filter(t => t.realizedPnl && t.realizedPnl > 0).length;
        const losses = trades.filter(t => t.realizedPnl && t.realizedPnl < 0).length;
        
        return {
          success: true,
          message: `📔 **Trade Journal**\n\nTotal Trades: ${trades.length}\nWins: ${wins} | Losses: ${losses}\nWin Rate: ${trades.length > 0 ? ((wins / trades.length) * 100).toFixed(1) : 0}%\n\n_Enable Gemini for AI analysis._`,
          type: 'info',
        };
      }

      const analysis = await analyzeJournal(tradeRecords);

      return {
        success: true,
        message: `📔 **Trade Journal Analysis**\n\n${analysis.summary}\n\n📈 Win Rate: ${analysis.winRate}\n🎯 Grade: **${analysis.overallGrade}**\n😌 Emotional Score: ${analysis.emotionalScore}/10\n\n**Strengths:**\n${analysis.strengths.map(s => `✅ ${s}`).join('\n')}\n\n**Areas to Improve:**\n${analysis.weaknesses.map(w => `⚠️ ${w}`).join('\n')}\n\n**Patterns Noticed:**\n${analysis.patterns.map(p => `📊 ${p}`).join('\n')}\n\n💡 **Advice:** ${analysis.advice}`,
        type: 'info',
        journal: analysis,
      };
    } catch (error) {
      return {
        success: false,
        message: `❌ Error analyzing trades: ${(error as Error).message}`,
        type: 'error',
      };
    }
  }

  /**
   * Handle position closed by exchange
   */
  handlePositionClosed(symbol: string, reason: 'STOP_LOSS' | 'TAKE_PROFIT' | 'LIQUIDATION' | 'UNKNOWN'): void {
    logger.info({ symbol, reason }, 'Position closed by exchange');
    this.trailingManager.deactivateTrailing(symbol);

    if (reason === 'STOP_LOSS') {
      stateMachine.exitStopped(symbol);
    } else {
      stateMachine.exitClean(symbol);
    }

    this.activeContractsBySymbol.delete(symbol);
  }

  /**
   * Get status
   */
  getStatus(): { global: string; symbols: string[]; memory?: any; circuitBreaker?: any } {
    const symbolStatuses: string[] = [];
    for (const [symbol] of stateMachine.getAllStates()) {
      symbolStatuses.push(stateMachine.formatState(symbol));
    }
    return {
      global: stateMachine.isPaused() ? 'PAUSED' : 'RUNNING',
      symbols: symbolStatuses,
      memory: memoryManager.getStatus(),
      circuitBreaker: circuitBreaker.getStatus(),
    };
  }

  /**
   * Get circuit breaker status
   */
  getCircuitBreakerStatus() {
    return circuitBreaker.getStatus();
  }

  /**
   * Override circuit breaker (emergency)
   */
  overrideCircuitBreaker(): void {
    circuitBreaker.override();
  }

  /**
   * Reset circuit breaker
   */
  resetCircuitBreaker(): void {
    circuitBreaker.reset();
  }

  /**
   * Record P&L for circuit breaker tracking
   */
  async recordPnL(pnl: number): Promise<void> {
    await circuitBreaker.recordPnL(pnl);
  }

  /**
   * Get memory status
   */
  getMemoryStatus() {
    return memoryManager.getStatus();
  }

  /**
   * Get all chat messages from current session
   */
  getChatHistory() {
    return memoryManager.getAllMessages();
  }

  /**
   * Clear current chat session (archives to long-term)
   */
  clearChatSession(): void {
    memoryManager.clearSession();
  }

  /**
   * Get memory summary
   */
  getMemorySummary(period: '30d' | '4mo' | '1yr'): MemorySummary | null {
    return memoryManager.getSummary(period);
  }

  /**
   * Force generate a memory summary
   */
  async generateMemorySummary(period: '30d' | '4mo' | '1yr'): Promise<MemorySummary> {
    return memoryManager.generateSummary(period, summarizeText);
  }

  forceUnlock(symbol: string): void {
    stateMachine.forceUnlock(symbol);
  }
}

// Singleton
export const smartOrchestrator = new SmartOrchestrator();

