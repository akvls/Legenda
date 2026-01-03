import { useEffect, useRef, useState, useCallback } from 'react'

interface WSMessage {
  type: 'position' | 'strategy' | 'price' | 'ticker' | 'circuitBreaker' | 'watch' | 'trade' | 'trailUpdate' | 'pong'
  data: any
  timestamp: number
}

export interface TrailUpdateData {
  symbol: string
  strategicSL: number
  emergencySL: number
  trailMode: 'SUPERTREND' | 'STRUCTURE' | 'NONE'
  trailActive: boolean
  nextTrailLevel: number | null
}

export interface TickerData {
  symbol: string
  price: number
  markPrice: number
  bid: number
  ask: number
  high24h: number
  low24h: number
  volume24h: number
}

type MessageHandler = (message: WSMessage) => void

interface UseWebSocketResult {
  isConnected: boolean
  lastMessage: WSMessage | null
  subscribe: (type: WSMessage['type'], handler: MessageHandler) => () => void
}

const WS_URL = `ws://${window.location.hostname}:3001/ws`

// Singleton WebSocket connection
let ws: WebSocket | null = null
let reconnectTimeout: ReturnType<typeof setTimeout> | null = null
const handlers = new Map<WSMessage['type'], Set<MessageHandler>>()
const connectionListeners = new Set<(connected: boolean) => void>()

function connect() {
  if (ws?.readyState === WebSocket.OPEN || ws?.readyState === WebSocket.CONNECTING) {
    return
  }

  ws = new WebSocket(WS_URL)

  ws.onopen = () => {
    console.log('[WS] Connected')
    connectionListeners.forEach(fn => fn(true))
    
    // Start ping/pong for keepalive
    const pingInterval = setInterval(() => {
      if (ws?.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'ping' }))
      } else {
        clearInterval(pingInterval)
      }
    }, 30000)
  }

  ws.onmessage = (event) => {
    try {
      const message: WSMessage = JSON.parse(event.data)
      const typeHandlers = handlers.get(message.type)
      if (typeHandlers) {
        typeHandlers.forEach(handler => handler(message))
      }
    } catch (e) {
      console.error('[WS] Failed to parse message:', e)
    }
  }

  ws.onclose = () => {
    console.log('[WS] Disconnected, reconnecting in 3s...')
    connectionListeners.forEach(fn => fn(false))
    ws = null
    
    // Auto-reconnect
    if (reconnectTimeout) clearTimeout(reconnectTimeout)
    reconnectTimeout = setTimeout(connect, 3000)
  }

  ws.onerror = (error) => {
    console.error('[WS] Error:', error)
  }
}

// Start connection immediately
if (typeof window !== 'undefined') {
  connect()
}

export function useWebSocket(): UseWebSocketResult {
  const [isConnected, setIsConnected] = useState(ws?.readyState === WebSocket.OPEN)
  const [lastMessage, setLastMessage] = useState<WSMessage | null>(null)

  useEffect(() => {
    const handleConnectionChange = (connected: boolean) => {
      setIsConnected(connected)
    }
    connectionListeners.add(handleConnectionChange)
    
    // Ensure connection
    connect()

    return () => {
      connectionListeners.delete(handleConnectionChange)
    }
  }, [])

  const subscribe = useCallback((type: WSMessage['type'], handler: MessageHandler) => {
    if (!handlers.has(type)) {
      handlers.set(type, new Set())
    }
    handlers.get(type)!.add(handler)

    // Return unsubscribe function
    return () => {
      handlers.get(type)?.delete(handler)
    }
  }, [])

  return { isConnected, lastMessage, subscribe }
}

// Convenience hooks for specific data types
// Store latest ticker data separately to preserve real-time prices
const tickerCache = new Map<string, { markPrice: number; timestamp: number }>()

export function usePositions() {
  const [positions, setPositions] = useState<any[]>([])
  const { subscribe, isConnected } = useWebSocket()

  useEffect(() => {
    const unsubPosition = subscribe('position', (msg) => {
      if (msg.data.all) {
        // When receiving all positions, merge with cached ticker data to preserve real-time markPrice
        const positionsWithTickerData = msg.data.all.map((p: any) => {
          const cached = tickerCache.get(p.symbol)
          if (cached && cached.markPrice > 0) {
            const markPrice = cached.markPrice
            const unrealizedPnl = p.avgPrice 
              ? (markPrice - p.avgPrice) * p.size * (p.side === 'LONG' ? 1 : -1)
              : p.unrealizedPnl
            return { ...p, markPrice, unrealizedPnl }
          }
          return p
        })
        setPositions(positionsWithTickerData)
      } else if (msg.data.opened) {
        setPositions(prev => [...prev, msg.data.opened])
      } else if (msg.data.updated) {
        // Preserve markPrice from ticker cache when updating position
        setPositions(prev => prev.map(p => {
          if (p.symbol === msg.data.updated.symbol) {
            const cached = tickerCache.get(p.symbol)
            const updatedPos = msg.data.updated
            if (cached && cached.markPrice > 0 && (!updatedPos.markPrice || updatedPos.markPrice === 0)) {
              const markPrice = cached.markPrice
              const unrealizedPnl = updatedPos.avgPrice 
                ? (markPrice - updatedPos.avgPrice) * updatedPos.size * (updatedPos.side === 'LONG' ? 1 : -1)
                : updatedPos.unrealizedPnl
              return { ...updatedPos, markPrice, unrealizedPnl }
            }
            return updatedPos
          }
          return p
        }))
      } else if (msg.data.closed) {
        setPositions(prev => prev.filter(p => p.symbol !== msg.data.closed.symbol))
      } else if (msg.data.pnlUpdate) {
        setPositions(prev => prev.map(p => 
          p.symbol === msg.data.pnlUpdate.symbol 
            ? { ...p, unrealizedPnl: msg.data.pnlUpdate.pnl }
            : p
        ))
      }
    })

    // Also subscribe to ticker updates to update markPrice in real-time
    const unsubTicker = subscribe('ticker', (msg) => {
      // Cache ticker data for when position updates come in
      tickerCache.set(msg.data.symbol, {
        markPrice: msg.data.markPrice,
        timestamp: Date.now()
      })
      
      setPositions(prev => prev.map(p => 
        p.symbol === msg.data.symbol 
          ? { 
              ...p, 
              markPrice: msg.data.markPrice,
              // Recalculate unrealizedPnl based on new mark price
              unrealizedPnl: p.avgPrice 
                ? (msg.data.markPrice - p.avgPrice) * p.size * (p.side === 'LONG' ? 1 : -1)
                : p.unrealizedPnl
            }
          : p
      ))
    })

    return () => {
      unsubPosition()
      unsubTicker()
    }
  }, [subscribe])

  return { positions, isConnected }
}

export function useStrategyState(symbol: string) {
  const [state, setState] = useState<any>(null)
  const { subscribe, isConnected } = useWebSocket()

  useEffect(() => {
    return subscribe('strategy', (msg) => {
      if (msg.data.symbol === symbol) {
        setState(msg.data)
      }
    })
  }, [subscribe, symbol])

  return { state, isConnected }
}

export function useCircuitBreaker() {
  const [status, setStatus] = useState<any>(null)
  const { subscribe, isConnected } = useWebSocket()

  useEffect(() => {
    return subscribe('circuitBreaker', (msg) => {
      setStatus(msg.data)
    })
  }, [subscribe])

  return { status, isConnected }
}

// Real-time ticker/price updates
export function useTicker(symbol: string) {
  const [ticker, setTicker] = useState<TickerData | null>(null)
  const { subscribe, isConnected } = useWebSocket()

  useEffect(() => {
    return subscribe('ticker', (msg) => {
      if (msg.data.symbol === symbol) {
        setTicker(msg.data)
      }
    })
  }, [subscribe, symbol])

  return { ticker, isConnected }
}

// Get all tickers (for multiple symbols)
export function useAllTickers() {
  const [tickers, setTickers] = useState<Map<string, TickerData>>(new Map())
  const { subscribe, isConnected } = useWebSocket()

  useEffect(() => {
    return subscribe('ticker', (msg) => {
      setTickers(prev => {
        const next = new Map(prev)
        next.set(msg.data.symbol, msg.data)
        return next
      })
    })
  }, [subscribe])

  return { tickers, isConnected }
}

// Real-time trailing SL updates (triggered on candle close)
export function useTrailUpdates() {
  const [trailData, setTrailData] = useState<Map<string, TrailUpdateData>>(new Map())
  const { subscribe, isConnected } = useWebSocket()

  useEffect(() => {
    return subscribe('trailUpdate', (msg) => {
      setTrailData(prev => {
        const next = new Map(prev)
        next.set(msg.data.symbol, msg.data as TrailUpdateData)
        return next
      })
    })
  }, [subscribe])

  return { trailData, isConnected }
}

