import { createLogger } from '../utils/logger.js';
import { parseIntent, formatIntent } from './intent-parser.js';
import { stateMachine } from './state-machine.js';
import { createTradeContract, formatContract, type TradeContract } from './trade-contract.js';
import { getTradeExecutor, type TradeExecutor } from '../execution/trade-executor.js';
import { getTrailingManager, type TrailingManager } from '../execution/trailing-manager.js';
import { getStrategyEngine, type StrategyEngine } from '../strategy/engine.js';
import type { Intent, TradeSide } from '../types/index.js';

const logger = createLogger('orchestrator');

/**
 * Agent Orchestrator
 * 
 * The central brain that:
 * 1. Receives commands (from chat, API, or strategy signals)
 * 2. Parses intents
 * 3. Validates against state machine
 * 4. Creates trade contracts
 * 5. Executes trades
 * 6. Manages position lifecycle
 */

interface OrchestrationResult {
  success: boolean;
  message: string;
  contract?: TradeContract;
  data?: unknown;
}

export class Orchestrator {
  private contracts: Map<string, TradeContract> = new Map();
  private activeContractsBySymbol: Map<string, string> = new Map(); // symbol -> contractId
  
  // Lazy-loaded dependencies
  private _tradeExecutor: TradeExecutor | null = null;
  private _trailingManager: TrailingManager | null = null;
  private _strategyEngine: StrategyEngine | null = null;

  constructor() {}

  // Lazy getters to avoid circular dependency issues
  private get tradeExecutor(): TradeExecutor {
    if (!this._tradeExecutor) {
      this._tradeExecutor = getTradeExecutor();
    }
    return this._tradeExecutor;
  }

  private get trailingManager(): TrailingManager {
    if (!this._trailingManager) {
      this._trailingManager = getTrailingManager();
    }
    return this._trailingManager;
  }

  private get strategyEngine(): StrategyEngine {
    if (!this._strategyEngine) {
      this._strategyEngine = getStrategyEngine();
    }
    return this._strategyEngine;
  }

  /**
   * Handle a chat command
   */
  async handleChat(rawText: string): Promise<OrchestrationResult> {
    logger.info({ rawText }, 'Processing chat command');

    // Parse intent
    const intent = parseIntent(rawText);
    if (!intent) {
      return { 
        success: false, 
        message: `Could not understand command: "${rawText}"` 
      };
    }

    logger.info({ intent: formatIntent(intent) }, 'Intent parsed');

    // Route to appropriate handler
    return this.handleIntent(intent);
  }

  /**
   * Handle a parsed intent
   */
  async handleIntent(intent: Intent): Promise<OrchestrationResult> {
    switch (intent.action) {
      case 'ENTER_LONG':
      case 'ENTER_SHORT':
        return this.handleEntry(intent);

      case 'CLOSE':
      case 'CLOSE_PARTIAL':
        return this.handleClose(intent);

      case 'MOVE_SL':
        return this.handleMoveSl(intent);

      case 'PAUSE':
        return this.handlePause();

      case 'RESUME':
        return this.handleResume();

      case 'WATCH_CREATE':
        return this.handleWatchCreate(intent);

      case 'WATCH_CANCEL':
        return this.handleWatchCancel(intent);

      default:
        return { 
          success: false, 
          message: `Unhandled action: ${intent.action}` 
        };
    }
  }

  /**
   * Handle entry commands (LONG/SHORT)
   */
  private async handleEntry(intent: Intent): Promise<OrchestrationResult> {
    const symbol = intent.symbol;
    if (!symbol) {
      return { success: false, message: 'No symbol specified' };
    }

    const side: TradeSide = intent.action === 'ENTER_LONG' ? 'LONG' : 'SHORT';

    // Check state machine
    const canEnter = stateMachine.canEnter(symbol, side);
    if (!canEnter.allowed) {
      return { 
        success: false, 
        message: `Cannot enter ${side}: ${canEnter.reason}` 
      };
    }

    // Create trade contract
    const contract = createTradeContract(intent);
    if (!contract) {
      return { success: false, message: 'Failed to create trade contract' };
    }

    if (contract.status === 'REJECTED') {
      return { 
        success: false, 
        message: `Contract rejected: ${contract.rejectReason}`,
        contract,
      };
    }

    // Store contract
    this.contracts.set(contract.id, contract);
    this.activeContractsBySymbol.set(symbol, contract.id);

    logger.info({ contract: formatContract(contract) }, 'Executing trade contract');

    try {
      // Get strategy state for SL/TP calculation
      const strategyState = this.strategyEngine.getState(symbol);
      if (!strategyState) {
        return { 
          success: false, 
          message: `No strategy state for ${symbol}. Register it first.` 
        };
      }

      // Execute the trade
      const result = await this.tradeExecutor.executeEntry({
        symbol,
        side,
        riskPercent: contract.riskPercent,
        requestedLeverage: contract.leverage,
        slRule: contract.slRule,
        slPrice: contract.slPrice,
        tpRule: contract.tpRule,
        tpPrice: contract.tpPrice,
        tpRR: contract.tpRR,
        trailMode: contract.trailMode,
      });

      if (result.success) {
        // Update contract with execution details
        contract.status = 'EXECUTED';
        contract.orderId = result.order?.id;
        contract.entryPrice = result.order?.avgFillPrice ?? undefined;
        contract.positionSize = result.order?.size;
        contract.actualSlPrice = result.contract?.sl.price ?? undefined;
        contract.actualTpPrice = result.contract?.tp.price;

        // Update state machine
        stateMachine.enterPosition(symbol, side);

        // Activate trailing if configured
        if (contract.trailMode !== 'NONE') {
          this.trailingManager.activateTrailing(symbol);
        }

        return {
          success: true,
          message: `Entered ${side} ${symbol} @ ${result.order?.avgFillPrice} | SL: ${result.contract?.sl.price} | Size: ${result.order?.size}`,
          contract,
          data: result,
        };
      } else {
        contract.status = 'REJECTED';
        contract.rejectReason = result.error || result.blockReason;
        return {
          success: false,
          message: `Trade failed: ${result.error || result.blockReason}`,
          contract,
        };
      }
    } catch (error) {
      contract.status = 'REJECTED';
      contract.rejectReason = (error as Error).message;
      return {
        success: false,
        message: `Trade error: ${(error as Error).message}`,
        contract,
      };
    }
  }

  /**
   * Handle close commands
   */
  private async handleClose(intent: Intent): Promise<OrchestrationResult> {
    const symbol = intent.symbol;
    if (!symbol) {
      return { success: false, message: 'No symbol specified' };
    }

    const state = stateMachine.getState(symbol);
    if (state.state !== 'IN_LONG' && state.state !== 'IN_SHORT') {
      return { 
        success: false, 
        message: `No position in ${symbol} to close` 
      };
    }

    const closePercent = intent.closePercent ?? 100;

    try {
      stateMachine.startExiting(symbol);

      const reason = closePercent === 100 ? 'USER_CLOSE' : 'PARTIAL_CLOSE';
      const success = await this.tradeExecutor.executeExit(symbol, reason, closePercent);

      if (success) {
        // Deactivate trailing
        this.trailingManager.deactivateTrailing(symbol);

        // Update state
        if (closePercent === 100) {
          stateMachine.exitClean(symbol);
          this.activeContractsBySymbol.delete(symbol);
        } else {
          // Partial close - remain in position
          stateMachine.enterPosition(symbol, state.side!);
        }

        return {
          success: true,
          message: `Closed ${closePercent}% of ${symbol}`,
        };
      } else {
        // Restore state on failure
        stateMachine.enterPosition(symbol, state.side!);
        return {
          success: false,
          message: `Close failed`,
        };
      }
    } catch (error) {
      stateMachine.enterPosition(symbol, state.side!);
      return {
        success: false,
        message: `Close error: ${(error as Error).message}`,
      };
    }
  }

  /**
   * Handle move SL command
   */
  private async handleMoveSl(intent: Intent): Promise<OrchestrationResult> {
    const symbol = intent.symbol;
    if (!symbol) {
      return { success: false, message: 'No symbol specified' };
    }

    const state = stateMachine.getState(symbol);
    if (state.state !== 'IN_LONG' && state.state !== 'IN_SHORT') {
      return { 
        success: false, 
        message: `No position in ${symbol}` 
      };
    }

    try {
      // 0 signals breakeven
      const isBreakeven = intent.newSlPrice === 0;

      if (isBreakeven) {
        const success = await this.tradeExecutor.moveSlToBreakeven(symbol);
        if (success) {
          return {
            success: true,
            message: `SL moved to breakeven`,
          };
        } else {
          return {
            success: false,
            message: `Move SL failed`,
          };
        }
      } else if (intent.newSlPrice) {
        // Move to specific price - not implemented yet, use moveSLToBreakeven as fallback
        return { 
          success: false, 
          message: 'Moving SL to specific price not yet implemented. Use "move sl to be" for breakeven.' 
        };
      } else {
        return { success: false, message: 'No SL price specified' };
      }
    } catch (error) {
      return {
        success: false,
        message: `Move SL error: ${(error as Error).message}`,
      };
    }
  }

  /**
   * Handle pause command
   */
  private handlePause(): OrchestrationResult {
    stateMachine.pause();
    return {
      success: true,
      message: 'Trading PAUSED. Use "resume" to continue.',
    };
  }

  /**
   * Handle resume command
   */
  private handleResume(): OrchestrationResult {
    stateMachine.resume();
    return {
      success: true,
      message: 'Trading RESUMED.',
    };
  }

  /**
   * Handle watch/alert creation
   */
  private async handleWatchCreate(intent: Intent): Promise<OrchestrationResult> {
    // TODO: Implement watch/alert system
    return {
      success: false,
      message: 'Watch/alert system not implemented yet',
    };
  }

  /**
   * Handle watch cancellation
   */
  private handleWatchCancel(intent: Intent): OrchestrationResult {
    // TODO: Implement watch/alert system
    return {
      success: false,
      message: 'Watch/alert system not implemented yet',
    };
  }

  /**
   * Handle position close by exchange (SL/TP hit)
   * Called by position tracker when position closes
   */
  handlePositionClosed(symbol: string, reason: 'STOP_LOSS' | 'TAKE_PROFIT' | 'LIQUIDATION' | 'UNKNOWN'): void {
    const state = stateMachine.getState(symbol);

    logger.info({ symbol, reason, previousState: state.state }, 'Position closed by exchange');

    // Deactivate trailing
    this.trailingManager.deactivateTrailing(symbol);

    if (reason === 'STOP_LOSS') {
      // Apply anti-rage lock
      stateMachine.exitStopped(symbol);
    } else {
      // Clean exit
      stateMachine.exitClean(symbol);
    }

    // Clear active contract
    this.activeContractsBySymbol.delete(symbol);
  }

  /**
   * Get status of all symbols
   */
  getStatus(): { global: string; symbols: string[] } {
    const symbolStatuses: string[] = [];
    
    for (const [symbol, _] of stateMachine.getAllStates()) {
      symbolStatuses.push(stateMachine.formatState(symbol));
    }

    return {
      global: stateMachine.isPaused() ? 'PAUSED' : 'RUNNING',
      symbols: symbolStatuses,
    };
  }

  /**
   * Get contract by ID
   */
  getContract(contractId: string): TradeContract | undefined {
    return this.contracts.get(contractId);
  }

  /**
   * Get active contract for symbol
   */
  getActiveContract(symbol: string): TradeContract | undefined {
    const contractId = this.activeContractsBySymbol.get(symbol);
    return contractId ? this.contracts.get(contractId) : undefined;
  }

  /**
   * Force unlock a symbol (admin)
   */
  forceUnlock(symbol: string): void {
    stateMachine.forceUnlock(symbol);
    logger.warn({ symbol }, 'Symbol force unlocked');
  }
}

// Singleton
export const orchestrator = new Orchestrator();
