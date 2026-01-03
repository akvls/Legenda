import { useState, useEffect, useRef } from 'react'
import { TrendingUp, TrendingDown, Shield, Target, X, Loader2, Crosshair } from 'lucide-react'
import { execution, api, type Position } from '../api/client'
import { usePositions, useTrailUpdates, useAllTickers } from '../hooks/useWebSocket'

export default function PositionCard() {
  const { positions: wsPositions, isConnected } = usePositions()
  const { trailData } = useTrailUpdates()
  const { tickers } = useAllTickers()
  const [initialPositions, setInitialPositions] = useState<Position[]>([])
  const [initialLoaded, setInitialLoaded] = useState(false)
  const [actionLoading, setActionLoading] = useState<string | null>(null)
  
  // Cache ticker data in a ref to prevent flickering during state updates
  const tickerCacheRef = useRef<Map<string, { markPrice: number; price: number }>>(new Map())

  // Fetch initial positions only once on mount
  const fetchPositions = async () => {
    try {
      const res = await execution.positions()
      const posData = res.data || []
      setInitialPositions(posData.filter((p: Position) => p.size > 0))
    } catch (error) {
      console.error('Failed to fetch positions:', error)
    }
    setInitialLoaded(true)
  }

  useEffect(() => {
    fetchPositions()
  }, [])

  // Fallback polling only when WebSocket is disconnected
  useEffect(() => {
    if (!isConnected) {
      const interval = setInterval(fetchPositions, 3000)
      return () => clearInterval(interval)
    }
  }, [isConnected])

  // Update ticker cache whenever tickers map changes
  useEffect(() => {
    tickers.forEach((ticker, symbol) => {
      if (ticker.markPrice > 0) {
        tickerCacheRef.current.set(symbol, {
          markPrice: ticker.markPrice,
          price: ticker.price
        })
      }
    })
  }, [tickers])

  // Use WebSocket positions when available, fallback to initial fetch data
  const rawPositions = (wsPositions.length > 0 ? wsPositions : initialPositions)
    .filter((p: Position) => p.size > 0)
  
  // Enrich positions with cached ticker data to prevent flickering
  const positions = rawPositions.map(p => {
    const cached = tickerCacheRef.current.get(p.symbol)
    if (cached && cached.markPrice > 0 && (!p.markPrice || p.markPrice === 0)) {
      const markPrice = cached.markPrice
      const unrealizedPnl = p.avgPrice 
        ? (markPrice - p.avgPrice) * p.size * (p.side === 'LONG' ? 1 : -1)
        : p.unrealizedPnl
      return { ...p, markPrice, unrealizedPnl }
    }
    return p
  })
  
  const loading = !initialLoaded && wsPositions.length === 0

  const handleClose = async (symbol: string) => {
    if (actionLoading) return
    setActionLoading(`close-${symbol}`)
    try {
      await api.chat(`close ${symbol}`)
      // WebSocket will update positions automatically, fallback fetch for safety
      if (!isConnected) {
        setTimeout(fetchPositions, 1000)
      }
    } catch (error) {
      console.error('Failed to close position:', error)
    }
    setActionLoading(null)
  }

  const handleMoveSL = async (symbol: string) => {
    if (actionLoading) return
    setActionLoading(`sl-${symbol}`)
    try {
      await api.chat(`move sl ${symbol} to be`)
      // WebSocket will update positions automatically, fallback fetch for safety
      if (!isConnected) {
        setTimeout(fetchPositions, 1000)
      }
    } catch (error) {
      console.error('Failed to move SL:', error)
    }
    setActionLoading(null)
  }

  if (loading) {
    return (
      <div className="bg-dark-800 rounded-xl border border-dark-600 p-4">
        <div className="animate-pulse space-y-3">
          <div className="h-4 bg-dark-600 rounded w-1/3"></div>
          <div className="h-8 bg-dark-600 rounded"></div>
        </div>
      </div>
    )
  }

  if (positions.length === 0) {
    return (
      <div className="bg-dark-800 rounded-xl border border-dark-600 p-6 text-center">
        <div className="w-12 h-12 rounded-full bg-dark-700 flex items-center justify-center mx-auto mb-3">
          <Target size={20} className="text-zinc-500" />
        </div>
        <p className="text-zinc-400 text-sm">No open positions</p>
        <p className="text-zinc-500 text-xs mt-1">Use chat to enter a trade</p>
      </div>
    )
  }

  return (
    <div className="space-y-3">
      {positions.map(position => {
        const side = position.side
        const entryPrice = position.avgPrice ?? 0
        
        // Get markPrice: position data (enriched) -> tickers map -> cached ref
        const tickerData = tickers.get(position.symbol)
        const cachedTicker = tickerCacheRef.current.get(position.symbol)
        const rawMarkPrice = position.markPrice ?? 0
        const markPrice = rawMarkPrice > 0 
          ? rawMarkPrice 
          : (tickerData?.markPrice ?? cachedTicker?.markPrice ?? 0)
        
        // Calculate PnL from markPrice for real-time accuracy
        const pnl = markPrice > 0 && entryPrice > 0
          ? (markPrice - entryPrice) * (position.size ?? 0) * (side === 'LONG' ? 1 : -1)
          : (position.unrealizedPnl ?? 0)
        const isProfit = pnl >= 0
        
        // Calculate position value
        const positionValue = (position.size ?? 0) * markPrice
        
        // Calculate PnL percent
        const pnlPercent = markPrice > 0 && entryPrice > 0 
          ? ((markPrice - entryPrice) / entryPrice) * 100 * (side === 'LONG' ? 1 : -1)
          : (entryPrice > 0 && position.size > 0 
              ? (pnl / (entryPrice * position.size)) * 100
              : 0)

        return (
          <div 
            key={position.symbol}
            className={`
              bg-dark-800 rounded-xl border p-4
              ${isProfit ? 'border-accent-green/30 glow-green' : 'border-accent-red/30 glow-red'}
            `}
          >
            {/* Header */}
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                <div className={`
                  w-8 h-8 rounded-lg flex items-center justify-center
                  ${side === 'LONG' ? 'bg-accent-green/20' : 'bg-accent-red/20'}
                `}>
                  {side === 'LONG' 
                    ? <TrendingUp size={16} className="text-accent-green" />
                    : <TrendingDown size={16} className="text-accent-red" />
                  }
                </div>
                <div>
                  <span className="font-medium text-zinc-200">{position.symbol}</span>
                  <span className={`
                    ml-2 text-xs px-1.5 py-0.5 rounded
                    ${side === 'LONG' ? 'bg-accent-green/20 text-accent-green' : 'bg-accent-red/20 text-accent-red'}
                  `}>
                    {side}
                  </span>
                </div>
              </div>
              
              <span className="text-xs text-zinc-500">{position.leverage}x</span>
            </div>

            {/* P&L */}
            <div className="mb-4">
              <div className={`text-2xl font-semibold mono ${isProfit ? 'text-accent-green' : 'text-accent-red'}`}>
                {isProfit ? '+' : ''}{pnl?.toFixed(2) ?? '0.00'} USDT
              </div>
              <div className={`text-sm ${isProfit ? 'text-accent-green/70' : 'text-accent-red/70'}`}>
                {isProfit ? '+' : ''}{pnlPercent?.toFixed(2) ?? '0.00'}%
              </div>
            </div>

            {/* Details */}
            <div className="grid grid-cols-2 gap-3 text-sm">
              <div>
                <span className="text-zinc-500 text-xs">Entry</span>
                <div className="text-zinc-300 mono">${entryPrice?.toFixed(2) ?? 'N/A'}</div>
              </div>
              <div>
                <span className="text-zinc-500 text-xs">Mark</span>
                <div className="text-zinc-300 mono">
                  {markPrice > 0 ? `$${markPrice.toFixed(2)}` : <span className="text-zinc-500">Loading...</span>}
                </div>
              </div>
              <div>
                <span className="text-zinc-500 text-xs">Size</span>
                <div className="text-zinc-300 mono">{position.size?.toFixed(4) ?? '0'}</div>
              </div>
              <div>
                <span className="text-zinc-500 text-xs">Value</span>
                <div className="text-zinc-300 mono">
                  {markPrice > 0 ? `$${positionValue.toFixed(2)}` : <span className="text-zinc-500">Loading...</span>}
                </div>
              </div>
            </div>

            {/* SL/TP Info */}
            {(position.stopLoss || position.takeProfit) && (
              <div className="grid grid-cols-2 gap-3 text-sm mt-2 pt-2 border-t border-dark-600">
                <div>
                  <span className="text-zinc-500 text-xs">Stop Loss</span>
                  <div className="text-accent-red mono">{position.stopLoss ? `$${Number(position.stopLoss).toFixed(2)}` : '-'}</div>
                </div>
                <div>
                  <span className="text-zinc-500 text-xs">Take Profit</span>
                  <div className="text-accent-green mono">{position.takeProfit ? `$${Number(position.takeProfit).toFixed(2)}` : '-'}</div>
                </div>
              </div>
            )}

            {/* Trailing SL Info */}
            {(() => {
              // Get trailing info from WebSocket updates or from position data
              const trail = trailData.get(position.symbol)
              const trailMode = trail?.trailMode || position.trailMode || 'NONE'
              const trailActive = trail?.trailActive ?? position.trailActive ?? false
              const strategicSL = trail?.strategicSL || position.strategicSL
              const emergencySL = trail?.emergencySL || position.emergencySL
              const nextTrailLevel = trail?.nextTrailLevel || position.nextTrailLevel

              if (trailMode === 'NONE' && !strategicSL) return null

              return (
                <div className="mt-3 pt-3 border-t border-dark-600">
                  <div className="flex items-center gap-2 mb-2">
                    <Crosshair size={14} className="text-accent-blue" />
                    <span className="text-xs text-zinc-400">Trailing Stop</span>
                    <span className={`
                      text-xs px-1.5 py-0.5 rounded
                      ${trailActive ? 'bg-accent-green/20 text-accent-green' : 'bg-dark-600 text-zinc-500'}
                    `}>
                      {trailMode} {trailActive ? '✓' : '○'}
                    </span>
                  </div>
                  
                  <div className="grid grid-cols-3 gap-2 text-xs">
                    <div>
                      <span className="text-zinc-500">Strategic SL</span>
                      <div className="text-accent-yellow mono font-medium">
                        {strategicSL ? `$${Number(strategicSL).toFixed(2)}` : '-'}
                      </div>
                    </div>
                    <div>
                      <span className="text-zinc-500">Emergency SL</span>
                      <div className="text-accent-red mono">
                        {emergencySL ? `$${Number(emergencySL).toFixed(2)}` : '-'}
                      </div>
                    </div>
                    <div>
                      <span className="text-zinc-500">Next Trail</span>
                      <div className="text-accent-blue mono">
                        {nextTrailLevel ? `$${Number(nextTrailLevel).toFixed(2)}` : '-'}
                      </div>
                    </div>
                  </div>

                  {trailActive && nextTrailLevel && strategicSL && (
                    <div className="mt-2 text-xs text-zinc-500">
                      {side === 'LONG' 
                        ? Number(nextTrailLevel) > Number(strategicSL) 
                          ? `↑ SL will trail up to $${Number(nextTrailLevel).toFixed(2)} on candle close`
                          : `SL at best level, waiting for higher trail`
                        : Number(nextTrailLevel) < Number(strategicSL)
                          ? `↓ SL will trail down to $${Number(nextTrailLevel).toFixed(2)} on candle close`
                          : `SL at best level, waiting for lower trail`
                      }
                    </div>
                  )}
                </div>
              )
            })()}

            {/* Actions */}
            <div className="flex gap-2 mt-4">
              <button 
                onClick={() => handleMoveSL(position.symbol)}
                disabled={!!actionLoading}
                className="flex-1 py-2 rounded-lg bg-dark-600 hover:bg-dark-500 text-zinc-300 text-sm flex items-center justify-center gap-1 disabled:opacity-50"
              >
                {actionLoading === `sl-${position.symbol}` ? (
                  <Loader2 size={14} className="animate-spin" />
                ) : (
                  <Shield size={14} />
                )}
                Move to BE
              </button>
              <button 
                onClick={() => handleClose(position.symbol)}
                disabled={!!actionLoading}
                className="flex-1 py-2 rounded-lg bg-accent-red/20 hover:bg-accent-red/30 text-accent-red text-sm flex items-center justify-center gap-1 disabled:opacity-50"
              >
                {actionLoading === `close-${position.symbol}` ? (
                  <Loader2 size={14} className="animate-spin" />
                ) : (
                  <X size={14} />
                )}
                Close
              </button>
            </div>
          </div>
        )
      })}
    </div>
  )
}


