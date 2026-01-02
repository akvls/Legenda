const API_BASE = 'http://localhost:3001/api'

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
  opinion: (symbol: string) => fetchApi<OpinionResponse>(`/agent/opinion/${symbol}`, {
    method: 'POST',
  }),
  journal: () => fetchApi<JournalResponse>('/agent/journal'),
  circuitBreaker: () => fetchApi<CircuitBreakerStatus>('/agent/circuit-breaker'),
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
  wallet: () => fetchApi<WalletResponse>('/market/wallet'),
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
  response: {
    success: boolean
    message: string
    type: string
    data?: any
    opinion?: any
    timestamp: number
  }
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
  }
}

export interface PositionsResponse {
  success: boolean
  positions: Position[]
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
  wallet: {
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

