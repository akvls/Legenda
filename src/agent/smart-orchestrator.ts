import { createLogger } from '../utils/logger.js';
import { parseIntent as parseIntentBasic, formatIntent } from './intent-parser.js';
import { stateMachine } from './state-machine.js';
import { createTradeContract, formatContract, type TradeContract } from './trade-contract.js';
import { getTradeExecutor, type TradeExecutor } from '../execution/trade-executor.js';
import { getTrailingManager, type TrailingManager } from '../execution/trailing-manager.js';
import { getStrategyEngine, type StrategyEngine } from '../strategy/engine.js';
import { getPositionTracker } from '../execution/position-tracker.js';
import { getOrderManager } from '../execution/order-manager.js';
import { getSLManager } from '../execution/sl-manager.js';
import { prisma } from '../db/index.js';
import eventLogger from '../services/event-logger.js';
import {
  parseIntentWithLLM,
  getTradeOpinion,
  getBlockedTradeWisdom,
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
    let response: SmartResponse;
    
    switch (parsedIntent.action) {
      case 'ENTER_LONG':
      case 'ENTER_SHORT':
        response = await this.handleEntry(parsedIntent, rawText);
        break;

      case 'CLOSE':
      case 'CLOSE_PARTIAL':
        response = await this.handleClose(parsedIntent);
        break;

      case 'CANCEL_ORDER':
        response = await this.handleCancelOrder(parsedIntent);
        break;

      case 'MOVE_SL':
        response = await this.handleMoveSl(parsedIntent);
        break;

      case 'SET_TP':
        response = await this.handleSetTp(parsedIntent);
        break;

      case 'SET_TRAIL':
        response = await this.handleSetTrail(parsedIntent);
        break;

      case 'PAUSE':
        response = this.handlePause();
        break;

      case 'RESUME':
        response = this.handleResume();
        break;

      case 'OPINION':
        response = await this.handleOpinion(parsedIntent.symbol);
        break;

      case 'INFO':
        response = this.handleInfo(parsedIntent.symbol);
        break;

      case 'WATCH_CREATE':
        response = await this.handleWatchCreate(parsedIntent);
        break;

      case 'WATCH_CANCEL':
        response = await this.handleWatchCancel(parsedIntent);
        break;

      default:
        response = await this.handleConversation(rawText);
        break;
    }

    // Save response to memory (conversation handler saves itself via LLM)
    memoryManager.addMessage('assistant', response.message);

    return response;
  }

  /**
   * Handle watch/scanner creation via chat
   */
  private async handleWatchCreate(parsed: any): Promise<SmartResponse> {
    const symbol = parsed.symbol || 'BTCUSDT';
    const side: TradeSide = parsed.side || 'LONG';
    
    // Auto-register symbol if not available (needed for watch to work)
    if (!this.strategyEngine.getState(symbol)) {
      try {
        logger.info({ symbol }, 'Auto-registering symbol for watch');
        await this.strategyEngine.registerSymbol(symbol);
      } catch (error) {
        logger.error({ error, symbol }, 'Failed to auto-register for watch');
        return {
          success: false,
          message: `❌ Failed to get data for ${symbol}. Try again.`,
          type: 'error',
        };
      }
    }
    
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
    const isLimitOrder = !!parsed.entryPrice;

    // Log entry request
    await eventLogger.logEntryRequested(symbol, side, {
      riskPercent: parsed.riskPercent || 0.5,
      leverage: parsed.leverage || 5,
    });

    // Check if paused
    if (stateMachine.isPaused()) {
      await eventLogger.logEntryBlocked(symbol, side, 'PAUSED', 'Trading is paused');
      return {
        success: false,
        message: '⏸️ Trading is paused. Say "resume" to continue.',
        type: 'error',
      };
    }

    // Check circuit breaker (50% daily loss = 24hr lockout)
    const circuitCheck = circuitBreaker.canTrade();
    if (!circuitCheck.allowed) {
      await eventLogger.logEntryBlocked(symbol, side, 'CIRCUIT_BREAKER', circuitCheck.reason);
      return {
        success: false,
        message: `${circuitCheck.reason}\n⏰ Unlocks in: ${circuitCheck.unlockIn}\n\n💡 This protects you from revenge trading. Take a break.`,
        type: 'error',
      };
    }

    // Check state machine
    const canEnter = stateMachine.canEnter(symbol, side);
    if (!canEnter.allowed) {
      await eventLogger.logEntryBlocked(symbol, side, 'LOCKED', canEnter.reason);
      
      // Build detailed message for state-based blocks
      let stateMsg = `🚫 **${side} ${symbol} Not Allowed**\n\n`;
      stateMsg += `**Reason:** ${canEnter.reason}\n\n`;
      
      const symbolState = stateMachine.getState(symbol);
      if (symbolState.state === 'IN_LONG' || symbolState.state === 'IN_SHORT') {
        stateMsg += `📍 You already have an open ${symbolState.side} position.\n`;
        stateMsg += `💡 Close it first: \`close ${symbol}\` or \`close all\``;
      } else if (symbolState.state === 'LOCK_LONG' || symbolState.state === 'LOCK_SHORT') {
        const lockedSide = symbolState.state === 'LOCK_LONG' ? 'LONG' : 'SHORT';
        const allowedSide = lockedSide === 'LONG' ? 'SHORT' : 'LONG';
        stateMsg += `🔒 ${lockedSide} is temporarily locked after a stop loss to prevent revenge trading.\n\n`;
        stateMsg += `💡 **Options:**\n`;
        stateMsg += `• Wait for the market to give a ${allowedSide} signal\n`;
        stateMsg += `• ${allowedSide} entries are still allowed\n`;
        stateMsg += `• The lock clears when you take an opposite trade or conditions reset\n\n`;
        
        // Add Legenda's wisdom for revenge trading prevention
        const revengeWisdoms = [
          `🧙 **Legenda says:** "I've blown more accounts revenge trading than I care to admit. The market just took your money - don't let it take your discipline too. Walk away, come back fresh."`,
          `🧙 **Legenda says:** "You know what separates the 10% who make it from the 90% who don't? The ability to take a loss and NOT immediately try to make it back. That's you right now. Be proud."`,
          `🧙 **Legenda says:** "The lock exists because I coded my own pain into this system. Every revenge trade I ever took ended worse than the original loss. Trust the process."`,
          `🧙 **Legenda says:** "Your edge isn't in this one trade - it's in the next 1000. Don't blow your statistical advantage trying to be a hero today."`,
        ];
        stateMsg += revengeWisdoms[Math.floor(Math.random() * revengeWisdoms.length)];
      } else if (symbolState.state === 'EXITING') {
        stateMsg += `⏳ Position is currently being closed. Wait a moment and try again.`;
      }
      
      return {
        success: false,
        message: stateMsg,
        type: 'error',
      };
    }

    // Get strategy state - auto-register if not available
    let strategyState = this.strategyEngine.getState(symbol);
    if (!strategyState) {
      // Auto-register the symbol
      try {
        logger.info({ symbol }, 'Auto-registering symbol for trade');
        await this.strategyEngine.registerSymbol(symbol);
        strategyState = this.strategyEngine.getState(symbol);
      } catch (error) {
        logger.error({ error, symbol }, 'Failed to auto-register symbol');
      }
      
      // If still no state after registration, fail
      if (!strategyState) {
        return {
          success: false,
          message: `📊 Failed to get market data for ${symbol}. Please try again in a few seconds.`,
          type: 'error',
        };
      }
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
      slPrice: parsed.slPrice,  // Pass SL price from parsed intent
      tpRule: (parsed.tpRule as any) || 'NONE',
      tpPrice: parsed.tpPrice,  // Pass TP price from parsed intent
      tpRR: parsed.tpRR,
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
        entryPrice: parsed.entryPrice, // Limit order price (if specified)
        riskPercent: contract.riskPercent,
        positionSizeUsdt: parsed.positionSizeUsdt, // Dollar amount if provided
        requestedLeverage: contract.leverage,
        slRule: contract.slRule,
        slPrice: contract.slPrice,  // Pass the SL price
        tpRule: contract.tpRule,
        tpPrice: contract.tpPrice,  // Pass the TP price
        tpRR: contract.tpRR,
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

        // Log entry placed
        await eventLogger.logEntryPlaced(symbol, contract.id, side, {
          price: contract.entryPrice,
          size: contract.positionSize,
          leverage: contract.leverage,
          slPrice: contract.actualSlPrice,
        });

        // Log AI opinion if available
        if (opinion) {
          await eventLogger.logAiOpinion(symbol, opinion.recommendation, opinion.confidence, contract.id);
        }

        // Record trade with full snapshot
        await this.recordTrade(symbol, side, contract.entryPrice!, contract.positionSize!, contract, rawCommand);

        // Calculate actual risk from the result
        const actualRiskPercent = result.contract?.entry?.riskPercent ?? contract.riskPercent;
        const riskDisplay = parsed.positionSizeUsdt 
          ? `$${parsed.positionSizeUsdt} (${actualRiskPercent.toFixed(1)}% of wallet)`
          : `${actualRiskPercent.toFixed(1)}%`;

        // Determine order type label
        const orderTypeLabel = isLimitOrder ? '📋 LIMIT ORDER' : '✅ MARKET ORDER';
        const entryDisplay = isLimitOrder 
          ? `Target: $${parsed.entryPrice} (waiting for fill)`
          : `$${contract.entryPrice?.toFixed(2)}`;

        let responseMsg = `${orderTypeLabel} **${side} ${symbol}**\n`;
        responseMsg += `📍 Entry: ${entryDisplay}\n`;
        responseMsg += `📦 Size: ${contract.positionSize}\n`;
        responseMsg += `🛡️ SL: ${contract.actualSlPrice ? '$' + contract.actualSlPrice.toFixed(2) : 'Set'}\n`;
        responseMsg += `⚙️ Leverage: ${contract.leverage}x | Risk: ${riskDisplay}`;
        
        // Add AI opinion with full details
        if (opinion) {
          responseMsg += `\n\n---\n🤖 **AI Analysis**`;
          responseMsg += `\n📝 ${opinion.opinion}`;
          responseMsg += `\n\n📊 **Recommendation**: ${opinion.recommendation} (Confidence: ${opinion.confidence}/10)`;
          responseMsg += `\n⚠️ **Risk Level**: ${opinion.riskLevel}`;
          if (opinion.keyPoints && opinion.keyPoints.length > 0) {
            responseMsg += `\n\n**Key Points:**`;
            opinion.keyPoints.forEach(point => {
              responseMsg += `\n• ${point}`;
            });
          }
          if (opinion.watchSuggestion) {
            responseMsg += `\n\n💡 **Suggestion**: \`${opinion.watchSuggestion}\``;
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
        
        // Build detailed explanation for blocked trades
        let detailedMsg = `🚫 **${side} ${symbol} Blocked**\n\n`;
        
        // Add current market status
        if (strategyState) {
          const snap = strategyState.snapshot;
          const bias = strategyState.bias;
          
          detailedMsg += `📊 **Current Market Status:**\n`;
          detailedMsg += `• Price: $${snap.price.toFixed(2)}\n`;
          detailedMsg += `• Supertrend: **${snap.supertrendDir}** @ $${snap.supertrendValue.toFixed(2)}\n`;
          detailedMsg += `• Structure: **${snap.structureBias}**\n`;
          detailedMsg += `• Strategy Bias: **${bias}**\n\n`;
          
          // Explain why blocked
          detailedMsg += `❌ **Why Blocked:**\n`;
          detailedMsg += `${result.error || result.blockReason}\n\n`;
          
          // Give context about the hard gate
          if (side === 'LONG' && snap.supertrendDir !== 'LONG') {
            detailedMsg += `📝 The Supertrend indicator is bearish (pointing down). `;
            detailedMsg += `Going LONG against the Supertrend violates the hard gate rules.\n\n`;
          } else if (side === 'SHORT' && snap.supertrendDir !== 'SHORT') {
            detailedMsg += `📝 The Supertrend indicator is bullish (pointing up). `;
            detailedMsg += `Going SHORT against the Supertrend violates the hard gate rules.\n\n`;
          }
          
          if (side === 'LONG' && snap.structureBias === 'BEARISH') {
            detailedMsg += `📝 Market structure is making lower lows and lower highs (bearish). `;
            detailedMsg += `LONG entries require at least neutral structure.\n\n`;
          } else if (side === 'SHORT' && snap.structureBias === 'BULLISH') {
            detailedMsg += `📝 Market structure is making higher highs and higher lows (bullish). `;
            detailedMsg += `SHORT entries require at least neutral structure.\n\n`;
          }
          
          // Suggestion
          detailedMsg += `💡 **Suggestions:**\n`;
          if (strategyState.allowLongEntry) {
            detailedMsg += `• LONG entries are currently allowed\n`;
          }
          if (strategyState.allowShortEntry) {
            detailedMsg += `• SHORT entries are currently allowed\n`;
          }
          if (!strategyState.allowLongEntry && !strategyState.allowShortEntry) {
            detailedMsg += `• Wait for clearer market conditions\n`;
            detailedMsg += `• Set a watch: \`watch ${symbol} near supertrend\`\n`;
          }
          
          // Distance info
          detailedMsg += `\n📏 **Key Levels:**\n`;
          detailedMsg += `• Distance to Supertrend: ${snap.distanceToSupertrend.toFixed(2)}%\n`;
          detailedMsg += `• Distance to SMA200: ${snap.distanceToSma200.toFixed(2)}%\n`;
          
          // Get Legenda's wisdom to calm them down
          try {
            const wisdom = await getBlockedTradeWisdom(
              symbol,
              side,
              result.error || result.blockReason || 'Trade blocked by rules',
              {
                price: snap.price,
                supertrendDir: snap.supertrendDir,
                structureBias: snap.structureBias,
                bias: bias,
                distanceToSupertrend: snap.distanceToSupertrend,
              }
            );
            detailedMsg += `\n---\n🧙 **Legenda says:**\n${wisdom.message}`;
          } catch (e) {
            // Fallback if wisdom fails
            detailedMsg += `\n---\n🧙 *The best trade is sometimes no trade. Wait for YOUR setup.*`;
          }
        } else {
          detailedMsg += `${result.error || result.blockReason}`;
        }
        
        return {
          success: false,
          message: detailedMsg,
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

  /**
   * Handle cancel order (pending limit orders)
   */
  private async handleCancelOrder(parsed: any): Promise<SmartResponse> {
    const symbol = parsed.symbol?.toUpperCase();
    
    try {
      const orderManager = getOrderManager();
      
      if (symbol) {
        // Cancel all pending orders for specific symbol
        const openOrders = orderManager.getOpenOrdersForSymbol(symbol);
        if (openOrders.length === 0) {
          return {
            success: false,
            message: `📭 No pending orders for ${symbol}`,
            type: 'info',
          };
        }
        
        await orderManager.cancelAll(symbol);
        
        // Clean up active trades for cancelled orders
        for (const order of openOrders) {
          if (order.tradeId) {
            this.tradeExecutor.clearTrade(order.tradeId);
          }
        }
        
        return {
          success: true,
          message: `✅ Cancelled ${openOrders.length} pending order(s) for ${symbol}`,
          type: 'trade',
        };
      } else {
        // No symbol specified - list pending orders from order manager
        const orderManager = getOrderManager();
        const allPendingOrders: any[] = [];
        
        // Get pending orders from contracts
        for (const [tradeId, contract] of this.contracts) {
          if (contract.status === 'PENDING') {
            allPendingOrders.push({
              symbol: contract.symbol,
              side: contract.side,
              price: contract.slPrice || 'Market',
            });
          }
        }
        
        if (allPendingOrders.length === 0) {
          return {
            success: true,
            message: '📭 No pending limit orders to cancel',
            type: 'info',
          };
        }
        
        const orderList = allPendingOrders.map(o => 
          `• ${o.side} ${o.symbol} @ $${o.price}`
        ).join('\n');
        
        return {
          success: true,
          message: `📋 **Pending Limit Orders:**\n${orderList}\n\n💡 Say \`cancel order BTC\` to cancel specific symbol`,
          type: 'info',
        };
      }
    } catch (error) {
      return {
        success: false,
        message: `❌ Failed to cancel order: ${(error as Error).message}`,
        type: 'error',
      };
    }
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
        
        // Log exit event
        const contractId = this.activeContractsBySymbol.get(symbol);
        await eventLogger.logExit(symbol, contractId || '', reason, {
          side: state.side!,
          reason,
        });
        
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
   * Handle set TP (add/modify take profit on existing position)
   */
  private async handleSetTp(parsed: any): Promise<SmartResponse> {
    const symbol = parsed.symbol;
    const tpPrice = parsed.tpPrice;

    if (!symbol) {
      // Try to find any open position
      const positions = getPositionTracker().getAllPositions();
      if (positions.length === 0) {
        return {
          success: false,
          message: '📭 No open positions to set TP on.',
          type: 'error',
        };
      }
      if (positions.length === 1) {
        return this.setTpForPosition(positions[0].symbol, tpPrice);
      }
      return {
        success: false,
        message: `❓ Multiple positions open. Specify symbol: "set tp BTC 95000"`,
        type: 'error',
      };
    }

    if (!tpPrice) {
      return {
        success: false,
        message: '❓ What price? Try "set tp BTC 95000"',
        type: 'error',
      };
    }

    return this.setTpForPosition(symbol, tpPrice);
  }

  private async setTpForPosition(symbol: string, tpPrice: number): Promise<SmartResponse> {
    const position = getPositionTracker().getPosition(symbol);
    if (!position) {
      return {
        success: false,
        message: `📭 No position in ${symbol} to set TP on.`,
        type: 'error',
      };
    }

    try {
      const { setTakeProfit } = await import('../bybit/rest-client.js');
      await setTakeProfit(symbol, position.side, tpPrice);

      return {
        success: true,
        message: `✅ Take Profit set for ${symbol} at $${tpPrice.toFixed(2)}\n\n📍 Entry: $${position.avgPrice.toFixed(2)}\n🎯 TP: $${tpPrice.toFixed(2)}\n📈 Potential: ${((tpPrice - position.avgPrice) / position.avgPrice * 100 * (position.side === 'LONG' ? 1 : -1)).toFixed(2)}%`,
        type: 'trade',
      };
    } catch (error) {
      return {
        success: false,
        message: `❌ Failed to set TP: ${(error as Error).message}`,
        type: 'error',
      };
    }
  }

  /**
   * Handle set trail (enable/disable trailing on existing position)
   */
  private async handleSetTrail(parsed: any): Promise<SmartResponse> {
    const positionTracker = getPositionTracker();
    const slManager = getSLManager();
    let symbol = parsed.symbol;
    const trailMode = parsed.trailMode || 'SUPERTREND';

    // If no symbol, try to find any open position
    if (!symbol) {
      const positions = positionTracker.getAllPositions();
      if (positions.length === 0) {
        return {
          success: false,
          message: '📭 No open positions to set trailing on.',
          type: 'error',
        };
      }
      if (positions.length === 1) {
        symbol = positions[0].symbol;
      } else {
        return {
          success: false,
          message: `❓ Multiple positions open. Specify symbol: "enable trail BTC supertrend"`,
          type: 'error',
        };
      }
    }

    const position = positionTracker.getPosition(symbol);
    if (!position) {
      return {
        success: false,
        message: `📭 No position in ${symbol} to set trailing on.`,
        type: 'error',
      };
    }

    // Get or create active trade
    let trade = this.tradeExecutor.getActiveTrade(symbol);
    
    if (!trade) {
      // No active trade in memory - create minimal one for trailing
      return {
        success: false,
        message: `❌ No active trade record for ${symbol}. Position may have been opened externally or before app restart.`,
        type: 'error',
      };
    }

    // Disable trailing
    if (trailMode === 'NONE') {
      this.trailingManager.deactivateTrailing(symbol);
      trade.trail.active = false;
      trade.trail.mode = 'NONE';
      
      return {
        success: true,
        message: `🔴 Trailing **DISABLED** for ${symbol}\n\nSL will remain static at current level.`,
        type: 'info',
      };
    }

    // Enable trailing - auto-register if needed
    let strategyState = this.strategyEngine.getState(symbol);
    if (!strategyState) {
      try {
        await this.strategyEngine.registerSymbol(symbol);
        strategyState = this.strategyEngine.getState(symbol);
      } catch (error) {
        logger.error({ error, symbol }, 'Failed to auto-register for trailing');
      }
      if (!strategyState) {
        return {
          success: false,
          message: `❌ Failed to get strategy state for ${symbol}. Try again.`,
          type: 'error',
        };
      }
    }

    // Set up strategic SL based on trail mode
    let newSlPrice: number;
    if (trailMode === 'SUPERTREND') {
      newSlPrice = strategyState.snapshot.supertrendValue;
    } else { // STRUCTURE
      newSlPrice = position.side === 'LONG'
        ? strategyState.keyLevels.protectedSwingLow || strategyState.snapshot.supertrendValue
        : strategyState.keyLevels.protectedSwingHigh || strategyState.snapshot.supertrendValue;
    }

    // Register the SL with SL manager
    const buffer = slManager.getBufferPercent();
    let emergencySlPrice: number;
    if (position.side === 'LONG') {
      emergencySlPrice = newSlPrice * (1 - buffer / 100);
    } else {
      emergencySlPrice = newSlPrice * (1 + buffer / 100);
    }

    // Update SL on Bybit
    try {
      const { setStopLoss } = await import('../bybit/rest-client.js');
      await setStopLoss(symbol, position.side, emergencySlPrice);
      
      // Register with SL manager
      slManager.registerStrategicSL(symbol, position.side, newSlPrice, emergencySlPrice);
      
      // Activate trailing
      trade.trail.active = true;
      trade.trail.mode = trailMode;
      this.trailingManager.activateTrailing(symbol);

      return {
        success: true,
        message: `✅ Trailing **ENABLED** for ${symbol}\n\n📈 Trail Mode: ${trailMode}\n🛡️ Strategic SL: $${newSlPrice.toFixed(2)}\n🚨 Emergency SL: $${emergencySlPrice.toFixed(2)}\n\nSL will trail on each candle close.`,
        type: 'trade',
      };
    } catch (error) {
      return {
        success: false,
        message: `❌ Failed to set trailing SL: ${(error as Error).message}`,
        type: 'error',
      };
    }
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
    
    // Auto-register symbol if not available
    let strategyState = this.strategyEngine.getState(sym);
    if (!strategyState) {
      try {
        logger.info({ symbol: sym }, 'Auto-registering symbol for opinion');
        await this.strategyEngine.registerSymbol(sym);
        strategyState = this.strategyEngine.getState(sym);
      } catch (error) {
        logger.error({ error, symbol: sym }, 'Failed to auto-register for opinion');
      }
      
      if (!strategyState) {
        return {
          success: false,
          message: `📊 Failed to get data for ${sym}. Try again in a moment.`,
          type: 'error',
        };
      }
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
        // Get trade details including trailing info
        const trade = this.tradeExecutor.getActiveTrade(pos.symbol);
        const slManager = getSLManager();
        const slLevels = slManager.getSLLevels(pos.symbol);
        
        msg += `\n**${pos.side} ${pos.symbol}**\n`;
        msg += `• Size: ${pos.size} @ $${pos.avgPrice.toFixed(2)}\n`;
        msg += `• PnL: ${pos.unrealizedPnl >= 0 ? '+' : ''}$${pos.unrealizedPnl.toFixed(2)}\n`;
        msg += `• Mark: $${pos.markPrice.toFixed(2)}\n`;
        
        if (slLevels) {
          msg += `• 🛡️ Strategic SL: $${slLevels.strategicSL.toFixed(2)}\n`;
          msg += `• 🚨 Emergency SL: $${slLevels.emergencySL.toFixed(2)}\n`;
        }
        
        if (trade) {
          const trailStatus = trade.trail.active ? '✅ ACTIVE' : '❌ Inactive';
          const trailMode = trade.trail.mode;
          msg += `• 📈 Trail Mode: ${trailMode} (${trailStatus})\n`;
          
          if (trade.trail.active && trailMode !== 'NONE') {
            // Show next trail level
            const strategyState = this.strategyEngine.getState(pos.symbol);
            if (strategyState) {
              let nextTrailLevel: number | null = null;
              if (trailMode === 'SUPERTREND') {
                nextTrailLevel = strategyState.snapshot.supertrendValue;
              } else if (trailMode === 'STRUCTURE') {
                nextTrailLevel = pos.side === 'LONG' 
                  ? strategyState.keyLevels.protectedSwingLow 
                  : strategyState.keyLevels.protectedSwingHigh;
              }
              if (nextTrailLevel) {
                msg += `• 🎯 Next Trail Level: $${nextTrailLevel.toFixed(2)}\n`;
              }
            }
          }
        }
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

