// Use relative path - works whether served from same origin or different
const API_BASE = '/api'

export async function fetchApi<T>(endpoint: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${endpoint}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...options?.headers,
    },
  })
  
  if (!res.ok) {
    throw new Error(`API Error: ${res.status}`)
  }
  
  return res.json()
}

// Agent endpoints
export const agent = {
  status: () => fetchApi<AgentStatus>('/agent/status'),
  chat: (message: string) => fetchApi<ChatResponse>('/agent/chat', {
    method: 'POST',
    body: JSON.stringify({ message }),
  }),
  chatHistory: () => fetchApi<ChatHistoryResponse>('/agent/memory/messages'),
  clearChat: () => fetchApi<{ success: boolean }>('/agent/memory/clear', { method: 'POST' }),
  opinion: (symbol: string) => fetchApi<OpinionResponse>(`/agent/opinion/${symbol}`, {
    method: 'POST',
  }),
  journal: () => fetchApi<JournalResponse>('/agent/journal'),
  circuitBreaker: () => fetchApi<CircuitBreakerStatus>('/agent/circuit-breaker'),
  overrideCircuitBreaker: () => fetchApi<{ success: boolean; message: string }>('/agent/circuit-breaker/override', {
    method: 'POST',
  }),
  resetCircuitBreaker: () => fetchApi<{ success: boolean; message: string }>('/agent/circuit-breaker/reset', {
    method: 'POST',
  }),
}

export interface ChatHistoryResponse {
  success: boolean
  count: number
  messages: Array<{
    role: 'user' | 'assistant'
    content: string
    timestamp: number
  }>
}

// Strategy endpoints
export const strategy = {
  register: (symbol: string) => fetchApi<StrategyResponse>(`/strategy/register/${symbol}`),
  state: (symbol: string) => fetchApi<StrategyResponse>(`/strategy/state/${symbol}`),
}

// Execution endpoints
export const execution = {
  positions: () => fetchApi<PositionsResponse>('/execution/positions'),
  orders: () => fetchApi<OrdersResponse>('/execution/orders'),
}

// Market endpoints
export const market = {
  wallet: () => fetchApi<WalletResponse>('/market/balance'),
  price: (symbol: string) => fetchApi<PriceResponse>(`/market/price/${symbol}`),
}

// Types
export interface AgentStatus {
  success: boolean
  status: string
  isPaused: boolean
  llmEnabled: boolean
  symbols: string[]
  memory: {
    shortTerm: { id: string; messageCount: number; hoursRemaining: number }
    longTerm: { conversationCount: number; summaries: any[] }
  }
  circuitBreaker: {
    isTripped: boolean
    lossPercent: number
    threshold: number
    message: string
  }
}

export interface ChatResponse {
  success: boolean
  message: string
  type: string
  data?: any
  opinion?: any
}

export interface OpinionResponse {
  success: boolean
  symbol: string
  opinion: {
    recommendation: string
    confidence: number
    opinion: string
    keyPoints: string[]
    risks: string[]
    suggestedEntry?: number
    suggestedSL?: number
  }
}

export interface JournalResponse {
  success: boolean
  response: {
    success: boolean
    message: string
    type: string
    analysis?: any
  }
}

export interface CircuitBreakerStatus {
  success: boolean
  isTripped: boolean
  lossPercent: number
  threshold: number
  message: string
}

export interface StrategyResponse {
  success: boolean
  message?: string
  data?: StrategyState
}

export interface StrategyState {
  symbol: string
  timeframe: string
  timestamp: number
  bias: 'LONG' | 'SHORT' | 'NEUTRAL'
  allowLongEntry: boolean
  allowShortEntry: boolean
  strategyId: string | null
  keyLevels: {
    protectedSwingLow: number | null
    protectedSwingHigh: number | null
    lastSwingLow: number | null
    lastSwingHigh: number | null
  }
  snapshot: {
    supertrendDir: string
    supertrendValue: number
    sma200: number
    ema1000: number
    price: number
    distanceToSupertrend: number
    distanceToSma200: number
    distanceToEma1000: number
    distanceToSwingHigh: number | null
    distanceToSwingLow: number | null
    currentTrend: string
    structureBias: string
    // Structure events (advisory)
    lastBOS: {
      type: string
      direction: 'BULLISH' | 'BEARISH'
      level: number
      candleIndex: number
      openTime: number
    } | null
    lastCHoCH: {
      type: string
      direction: 'BULLISH' | 'BEARISH'
      level: number
      candleIndex: number
      openTime: number
    } | null
    protectedLevel: number | null
    distanceToProtectedLevel: number | null
  }
}

export interface PositionsResponse {
  success: boolean
  data: Position[]
}

export interface Position {
  symbol: string
  side: 'LONG' | 'SHORT'
  size: number
  avgPrice: number
  markPrice: number
  unrealizedPnl: number
  leverage: number
  liqPrice: number
  stopLoss: number | null
  takeProfit: number | null
  // Trailing info
  trailMode?: 'SUPERTREND' | 'STRUCTURE' | 'NONE'
  trailActive?: boolean
  strategicSL?: number | null
  emergencySL?: number | null
  nextTrailLevel?: number | null
}

export interface OrdersResponse {
  success: boolean
  orders: Order[]
}

export interface Order {
  symbol: string
  side: string
  orderType: string
  qty: string
  price: string
  orderStatus: string
}

export interface WalletResponse {
  success: boolean
  data: {
    totalEquity: number
    availableBalance: number
    usedMargin: number
  }
}

export interface PriceResponse {
  success: boolean
  symbol: string
  price: number
}

// Watch types
export interface WatchRule {
  id: string
  symbol: string
  intendedSide: 'LONG' | 'SHORT'
  triggerType: 'CLOSER_TO_SMA200' | 'CLOSER_TO_EMA1000' | 'CLOSER_TO_SUPERTREND' | 'PRICE_ABOVE' | 'PRICE_BELOW'
  thresholdPercent: number
  targetPrice?: number
  mode: 'NOTIFY_ONLY' | 'AUTO_ENTER'
  expiryTime: number
  createdAt: number
  preset: {
    riskPercent: number
    slRule: string
    trailMode: string
  }
  status: 'ACTIVE' | 'TRIGGERED' | 'EXPIRED' | 'CANCELLED'
  triggeredAt?: number
  triggeredPrice?: number
}

export interface WatchesResponse {
  success: boolean
  count: number
  watches: WatchRule[]
}

export interface DistanceResponse {
  success: boolean
  symbol: string
  type: string
  currentPrice: number
  targetPrice: number
  distancePercent: number
}

// Journal types
export interface JournalTradesResponse {
  success: boolean
  total: number
  limit: number
  offset: number
  trades: Trade[]
}

export interface Trade {
  id: string
  symbol: string
  side: 'LONG' | 'SHORT'
  timeframe: string
  strategyId: string
  entryType: string
  riskPercent: number
  riskAmountUsdt: number
  requestedLeverage: number
  appliedLeverage: number
  slRule: string
  slPrice: number | null
  tpRule: string
  tpPrice: number | null
  trailMode: string
  entryPrice: number | null
  entryFilledAt: string | null
  entrySize: number | null
  entrySizeUsdt: number | null
  exitPrice: number | null
  exitFilledAt: string | null
  exitReason: string | null
  realizedPnl: number | null
  realizedPnlPercent: number | null
  rMultiple: number | null
  fees: number | null
  mfePrice: number | null
  mfePercent: number | null
  maePrice: number | null
  maePercent: number | null
  aiScore: number | null
  userScore: number | null
  aiRecommendation: string | null
  aiOpinion: string | null
  aiKeyPoints: string[]
  aiRiskLevel: string | null
  aiSuggestedRisk: number | null
  userRawCommand: string | null
  userNote: string | null
  userTags: string[]
  userReview: string | null
  durationSeconds: number | null
  strategySnapshotAtEntry: any
  strategySnapshotAtExit: any
  createdAt: string
  closedAt: string | null
  orders: any[]
  fills: any[]
  events: any[]
}

export interface JournalStatsResponse {
  success: boolean
  stats: {
    overview: {
      totalTrades: number
      winningTrades: number
      losingTrades: number
      breakEvenTrades: number
      winRate: number
      profitFactor: number
    }
    pnl: {
      totalPnl: number
      avgPnl: number
      totalR: number
      avgR: number
      totalFees: number
      grossProfit: number
      grossLoss: number
    }
    bestWorst: {
      bestTrade: { id: string; symbol: string; pnl: number; rMultiple: number } | null
      worstTrade: { id: string; symbol: string; pnl: number; rMultiple: number } | null
    }
    streaks: {
      maxConsecutiveWins: number
      maxConsecutiveLosses: number
    }
    timing: {
      avgDurationSeconds: number
      avgDurationFormatted: string
    }
    bySide: {
      longs: { count: number; wins: number; winRate: number; pnl: number }
      shorts: { count: number; wins: number; winRate: number; pnl: number }
    }
    bySymbol: Record<string, { trades: number; pnl: number; winRate: number }>
    byStrategy: Record<string, { trades: number; pnl: number; winRate: number }>
    byExitReason: Record<string, number>
  }
}

export interface EventsResponse {
  success: boolean
  total: number
  events: Array<{
    id: string
    symbol: string | null
    tradeId: string | null
    eventType: string
    payload: any
    message: string | null
    timestamp: string
  }>
}

// Journal endpoints
export const journal = {
  getTrades: (filters?: { symbol?: string; side?: string; strategyId?: string; limit?: number }) =>
    fetchApi<JournalTradesResponse>(`/journal/trades?${new URLSearchParams(
      Object.entries(filters || {}).filter(([, v]) => v).map(([k, v]) => [k, String(v)])
    ).toString()}`),
  
  getTrade: (id: string) => fetchApi<{ success: boolean; trade: Trade }>(`/journal/trades/${id}`),
  
  updateTrade: (id: string, data: { userScore?: number; userNote?: string; userReview?: string; userTags?: string[] }) =>
    fetchApi<{ success: boolean; trade: Trade }>(`/journal/trades/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    }),
  
  getStats: (filters?: { startDate?: string; endDate?: string; symbol?: string }) =>
    fetchApi<JournalStatsResponse>(`/journal/stats?${new URLSearchParams(
      Object.entries(filters || {}).filter(([, v]) => v).map(([k, v]) => [k, String(v)])
    ).toString()}`),
  
  getDailyStats: (days?: number) =>
    fetchApi<{ success: boolean; dailyStats: any[] }>(`/journal/stats/daily?days=${days || 30}`),
  
  getEvents: (filters?: { symbol?: string; tradeId?: string; eventType?: string; limit?: number }) =>
    fetchApi<EventsResponse>(`/journal/events?${new URLSearchParams(
      Object.entries(filters || {}).filter(([, v]) => v).map(([k, v]) => [k, String(v)])
    ).toString()}`),
  
  getEventTypes: () => fetchApi<{ success: boolean; types: Array<{ type: string; count: number }> }>('/journal/events/types'),
}

// Settings types and endpoints
export interface SettingsData {
  id: string
  maxLeverage: number
  defaultLeverage: number
  defaultRiskPercent: number
  defaultSlRule: string
  defaultTpRule: string
  defaultTrailMode: string
  watchDefaultThreshold: number
  watchDefaultExpiryMin: number
  coachStrictness: number
  autoExitOnInvalidation: boolean
}

export interface SymbolConfig {
  id: string
  symbol: string
  timeframe: string
  supertrendPeriod: number
  supertrendMult: number
  sma200Period: number
  ema1000Period: number
  swingLookback: number
  enabled: boolean
}

export const settings = {
  get: () => fetchApi<{ success: boolean; data: SettingsData }>('/settings'),
  update: (data: Partial<SettingsData>) => fetchApi<{ success: boolean; data: SettingsData }>('/settings', {
    method: 'PATCH',
    body: JSON.stringify(data),
  }),
  getSymbols: () => fetchApi<{ success: boolean; data: SymbolConfig[] }>('/settings/symbols'),
  updateSymbol: (symbol: string, data: Partial<SymbolConfig>) => 
    fetchApi<{ success: boolean; data: SymbolConfig }>(`/settings/symbols/${symbol}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    }),
  deleteSymbol: (symbol: string) => 
    fetchApi<{ success: boolean }>(`/settings/symbols/${symbol}`, {
      method: 'DELETE',
    }),
}

// Combined API object for easy access
export const api = {
  // Agent
  getStatus: () => agent.status(),
  chat: (message: string) => agent.chat(message),
  getOpinion: (symbol: string) => agent.opinion(symbol),
  getJournal: () => agent.journal(),
  getCircuitBreaker: () => agent.circuitBreaker(),
  
  // Strategy
  registerSymbol: (symbol: string) => strategy.register(symbol),
  getStrategyState: (symbol: string) => strategy.state(symbol),
  
  // Execution
  getPositions: () => execution.positions(),
  getOrders: () => execution.orders(),
  
  // Market
  getWallet: () => market.wallet(),
  getPrice: (symbol: string) => market.price(symbol),
  
  // Watches
  getWatches: () => fetchApi<WatchesResponse>('/agent/watches'),
  getWatchesForSymbol: (symbol: string) => fetchApi<WatchesResponse>(`/agent/watches/${symbol}`),
  createWatch: (params: {
    symbol: string
    side: 'LONG' | 'SHORT'
    triggerType: string
    threshold?: number
    targetPrice?: number
    mode?: 'NOTIFY_ONLY' | 'AUTO_ENTER'
    expiryMinutes?: number
  }) => fetchApi<{ success: boolean; watch: WatchRule }>('/agent/watch', {
    method: 'POST',
    body: JSON.stringify(params),
  }),
  cancelWatch: (id: string) => fetchApi<{ success: boolean }>(`/agent/watch/${id}`, {
    method: 'DELETE',
  }),
  getDistance: (symbol: string, type: 'sma200' | 'ema1000' | 'supertrend') => 
    fetchApi<DistanceResponse>(`/agent/distance/${symbol}/${type}`),

  // Journal
  journal: journal,
}

