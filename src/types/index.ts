/**
 * Core Types for AI Trading Assistant
 * These types mirror the spec and are used throughout the application
 */

// ============================================
// ENUMS
// ============================================

export type TradeSide = 'LONG' | 'SHORT';
export type Bias = 'LONG' | 'SHORT' | 'NEUTRAL';
export type StructureBias = 'BULLISH' | 'BEARISH' | 'NEUTRAL';

export type TradeState = 
  | 'FLAT' 
  | 'IN_LONG' 
  | 'IN_SHORT' 
  | 'EXITING' 
  | 'LOCK_LONG' 
  | 'LOCK_SHORT' 
  | 'PAUSED';

export type OrderType = 'MARKET' | 'LIMIT';
export type SLRule = 'SWING' | 'SUPERTREND' | 'PRICE' | 'NONE';
export type TPRule = 'NONE' | 'RR' | 'PRICE' | 'STRUCTURE';
export type TrailMode = 'SUPERTREND' | 'STRUCTURE' | 'NONE';

export type ExitReason = 
  | 'STOP_LOSS'
  | 'TAKE_PROFIT'
  | 'TRAIL_STOP'
  | 'INVALIDATION_BIAS_FLIP'
  | 'INVALIDATION_STRUCTURE_BREAK'
  | 'INVALIDATION_SUPERTREND_FLIP'
  | 'MANUAL_CLOSE'
  | 'EMERGENCY_FLATTEN';

export type WatchTriggerType = 
  | 'CLOSER_TO_SMA200'
  | 'CLOSER_TO_EMA1000'
  | 'CLOSER_TO_SUPERTREND'
  | 'PRICE_ABOVE'
  | 'PRICE_BELOW';
export type WatchMode = 'NOTIFY_ONLY' | 'AUTO_ENTER';

export type StrategyId = 'S101' | 'S102' | 'S103';

export type IntentAction = 
  | 'ENTER_LONG'
  | 'ENTER_SHORT'
  | 'CLOSE'
  | 'CLOSE_PARTIAL'
  | 'CANCEL_ORDER'  // Cancel pending limit orders
  | 'MOVE_SL'
  | 'SET_TP'        // Add/modify TP on existing position
  | 'SET_TRAIL'     // Enable/disable trailing on existing position
  | 'PAUSE'
  | 'RESUME'
  | 'WATCH_CREATE'
  | 'WATCH_CANCEL'
  | 'WATCH_SNOOZE'
  | 'INFO'
  | 'OPINION'
  | 'UNKNOWN';

export type EventType =
  | 'ENTRY_REQUESTED'
  | 'ENTRY_BLOCKED_NOT_ALIGNED'
  | 'ENTRY_BLOCKED_LOCKED'
  | 'ENTRY_PLACED'
  | 'ENTRY_FILLED'
  | 'SL_SET'
  | 'SL_MODIFIED'
  | 'TP_SET'
  | 'TP_MODIFIED'
  | 'TRAIL_ACTIVATED'
  | 'TRAIL_UPDATED'
  | 'STRATEGY_BIAS_FLIP'
  | 'INVALIDATION_DETECTED'
  | 'INVALIDATION_EXIT'
  | 'EXIT_PLACED'
  | 'EXIT_FILLED'
  | 'LEVERAGE_CLAMPED'
  | 'LEVERAGE_SET'
  | 'WATCH_CREATED'
  | 'WATCH_TRIGGERED'
  | 'WATCH_EXPIRED'
  | 'WATCH_CANCELLED'
  | 'USER_MANUAL_CLOSE'
  | 'USER_PARTIAL_CLOSE'
  | 'STATE_TRANSITION'
  | 'ERROR';

// ============================================
// STRATEGY STATE (Single Source of Truth)
// ============================================

export interface KeyLevels {
  protectedSwingLow: number | null;
  protectedSwingHigh: number | null;
  lastSwingLow: number | null;
  lastSwingHigh: number | null;
}

export interface StructureEvent {
  type: 'BOS' | 'CHOCH';
  direction: 'BULLISH' | 'BEARISH';
  level: number;
  candleIndex: number;
  openTime: number;
}

export interface StrategySnapshot {
  supertrendDir: Bias;
  supertrendValue: number;
  sma200: number;
  ema1000: number;
  closeAboveSma200: boolean;
  closeBelowSma200: boolean;
  closeAboveEma1000: boolean;
  closeBelowEma1000: boolean;
  structureBias: StructureBias;
  price: number;
  
  // Distance from price to key levels (in %)
  distanceToSupertrend: number;  // + = above, - = below
  distanceToSma200: number;
  distanceToEma1000: number;
  distanceToSwingHigh: number | null;
  distanceToSwingLow: number | null;
  
  // Market Structure for journaling/LLM analysis
  currentTrend: 'UPTREND' | 'DOWNTREND' | 'RANGING';
  lastBOS: StructureEvent | null;
  lastCHoCH: StructureEvent | null;
  protectedLevel: number | null;
  distanceToProtectedLevel: number | null;
}

export interface StrategyState {
  symbol: string;
  timeframe: string;
  timestamp: number;
  candleCloseTime: number;
  bias: Bias;
  allowLongEntry: boolean;
  allowShortEntry: boolean;
  strategyId: StrategyId | null;
  keyLevels: KeyLevels;
  snapshot: StrategySnapshot;
}

// ============================================
// INTENT (Parsed User Command)
// ============================================

export interface Intent {
  source: 'chat' | 'voice' | 'api';
  rawText: string;
  action: IntentAction;
  symbol?: string;
  side?: TradeSide;  // for watch commands
  riskPercent?: number;
  requestedLeverage?: number;
  slRule?: SLRule;
  slPrice?: number;
  tpRule?: TPRule;
  tpPrice?: number;
  tpRR?: number;
  trailMode?: TrailMode;
  closePercent?: number; // for partial close
  newSlPrice?: number;   // for move SL
  watchTrigger?: {
    type: WatchTriggerType;
    thresholdPct: number;
  };
}

// ============================================
// TRADE CONTRACT
// ============================================

export interface InvalidationRules {
  biasFlipAgainstTrade: boolean;
  structureBreak: boolean;
  supertrendFlip: boolean;
}

export interface ReentryPolicy {
  lockSameDirection: boolean;
  onlyOppositeAllowed: boolean;
}

export interface TradeContract {
  tradeId: string;
  symbol: string;
  side: TradeSide;
  timeframe: string;
  strategyId: StrategyId;
  
  entry: {
    type: OrderType;
    limitPrice?: number;  // Limit order price (only if type is 'LIMIT')
    riskPercent: number;
    riskAmountUsdt: number;
    requestedLeverage: number;
    appliedLeverage: number;
  };
  
  sl: {
    rule: SLRule;
    price: number | null;
  };
  
  tp: {
    rule: TPRule;
    price?: number;
    rrTarget?: number;
  };
  
  trail: {
    mode: TrailMode;
    active: boolean;
  };
  
  invalidation: InvalidationRules;
  reentryPolicy: ReentryPolicy;
  
  reasons: {
    userTags: string[];
    userNote?: string;
    strategySnapshotAtEntry: StrategySnapshot;
  };
  
  aiScore?: number;
  userScore?: number;
}

// ============================================
// WATCH RULE
// ============================================

export interface WatchRule {
  watchId: string;
  symbol: string;
  intendedSide: TradeSide;
  trigger: {
    type: WatchTriggerType;
    thresholdPct: number;
  };
  expiryTs: number;
  mode: WatchMode;
  requiresHardGate: boolean;
  preset: {
    riskPercent?: number;
    slRule?: SLRule;
    trailMode?: TrailMode;
    leverage?: number;
  };
}

// ============================================
// VALIDATION RESULTS
// ============================================

export type QualityGrade = 'A' | 'B' | 'C';

export interface HardGateResult {
  allowed: boolean;
  blockedReason?: string;
  suggestion?: string;
  strategyState: StrategyState;
}

export interface SoftCoachResult {
  qualityGrade: QualityGrade;
  advice: 'ENTER_NOW' | 'WAIT' | 'SKIP';
  waitTrigger?: {
    type: WatchTriggerType;
    thresholdPct: number;
    message: string;
  };
  riskReminder: string;
  rrEstimate?: number;
}

export interface ValidationResult {
  hardGate: HardGateResult;
  softCoach?: SoftCoachResult;
}

// ============================================
// CANDLE DATA
// ============================================

export interface Candle {
  symbol: string;
  timeframe: string;
  openTime: number;
  closeTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

// ============================================
// BYBIT TYPES
// ============================================

export interface BybitPosition {
  symbol: string;
  side: 'Buy' | 'Sell' | 'None';
  size: string;
  avgPrice: string;
  leverage: string;
  unrealisedPnl: string;
  positionValue: string;
  liqPrice: string;
  markPrice: string;
  takeProfit: string;
  stopLoss: string;
}

export interface BybitOrder {
  orderId: string;
  orderLinkId: string;
  symbol: string;
  side: 'Buy' | 'Sell';
  orderType: 'Market' | 'Limit';
  price: string;
  qty: string;
  orderStatus: string;
  reduceOnly: boolean;
  createdTime: string;
  updatedTime: string;
}

export interface BybitTicker {
  symbol: string;
  lastPrice: string;
  highPrice24h: string;
  lowPrice24h: string;
  prevPrice24h: string;
  volume24h: string;
  bid1Price: string;
  ask1Price: string;
  markPrice: string;
  indexPrice: string;
}

export interface BybitKline {
  symbol: string;
  interval: string;
  openTime: number;
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string;
  turnover: string;
}

// ============================================
// APP EVENTS (Internal)
// ============================================

export interface AppEvent {
  type: EventType;
  symbol?: string;
  tradeId?: string;
  timestamp: number;
  payload?: Record<string, unknown>;
  message?: string;
}

// ============================================
// CONFIG
// ============================================

export interface SymbolConfig {
  symbol: string;
  timeframe: string;
  supertrendPeriod: number;
  supertrendMultiplier: number;
  sma200Period: number;
  ema1000Period: number;
  swingLookback: number;
  enabled: boolean;
}

export interface AppSettings {
  maxLeverage: number;
  defaultLeverage: number;
  defaultRiskPercent: number;
  defaultSlRule: SLRule;
  defaultTpRule: TPRule;
  defaultTrailMode: TrailMode;
  watchDefaultThresholdPct: number;
  watchDefaultExpiryMinutes: number;
  coachStrictness: 1 | 2 | 3;
  autoExitOnInvalidation: boolean;
}

// ============================================
// API RESPONSES
// ============================================

export interface ApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
  message?: string;
}

