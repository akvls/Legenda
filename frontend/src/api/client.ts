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
  side: 'Buy' | 'Sell'
  size: string
  entryPrice: string
  markPrice: string
  unrealisedPnl: string
  leverage: string
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
}

