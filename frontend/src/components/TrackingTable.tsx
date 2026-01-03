import { useState, useEffect } from 'react'
import { RefreshCw, Trash2, TrendingUp, TrendingDown, Minus, Eye } from 'lucide-react'
import { strategy } from '../api/client'
import { useAllTickers } from '../hooks/useWebSocket'

interface StrategyState {
  symbol: string
  timeframe: string
  bias: 'LONG' | 'SHORT' | 'NEUTRAL'
  strategyId: string
  allowLongEntry: boolean
  allowShortEntry: boolean
  snapshot: {
    price: number
    supertrendDir: 'LONG' | 'SHORT'
    supertrendValue: number
    structureBias: string
    distanceToSupertrend: number
    distanceToSma200: number
  }
  timestamp: number
}

interface TrackingTableProps {
  onSymbolClick?: (symbol: string) => void
}

export default function TrackingTable({ onSymbolClick }: TrackingTableProps) {
  const [states, setStates] = useState<StrategyState[]>([])
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const { tickers } = useAllTickers()

  const fetchStates = async () => {
    try {
      const res = await strategy.allStates()
      if (res.success && res.data) {
        setStates(res.data)
      }
    } catch (error) {
      console.error('Failed to fetch strategy states:', error)
    }
    setLoading(false)
    setRefreshing(false)
  }

  useEffect(() => {
    fetchStates()
    // Refresh every 30 seconds
    const interval = setInterval(fetchStates, 30000)
    return () => clearInterval(interval)
  }, [])

  const handleRefresh = () => {
    setRefreshing(true)
    fetchStates()
  }

  const getBiasIcon = (bias: string) => {
    if (bias === 'LONG') return <TrendingUp size={14} className="text-accent-green" />
    if (bias === 'SHORT') return <TrendingDown size={14} className="text-accent-red" />
    return <Minus size={14} className="text-zinc-500" />
  }

  const getBiasColor = (bias: string) => {
    if (bias === 'LONG') return 'text-accent-green'
    if (bias === 'SHORT') return 'text-accent-red'
    return 'text-zinc-400'
  }

  if (loading) {
    return (
      <div className="bg-dark-800 rounded-xl border border-dark-600 p-4">
        <div className="animate-pulse space-y-3">
          <div className="h-4 bg-dark-600 rounded w-1/3"></div>
          <div className="h-20 bg-dark-600 rounded"></div>
        </div>
      </div>
    )
  }

  if (states.length === 0) {
    return (
      <div className="bg-dark-800 rounded-xl border border-dark-600 p-6 text-center">
        <Eye size={24} className="text-zinc-500 mx-auto mb-2" />
        <p className="text-zinc-400 text-sm">No coins being tracked</p>
        <p className="text-zinc-500 text-xs mt-1">Ask about a coin to start tracking</p>
      </div>
    )
  }

  return (
    <div className="bg-dark-800 rounded-xl border border-dark-600 overflow-hidden">
      {/* Header */}
      <div className="px-4 py-3 border-b border-dark-600 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Eye size={16} className="text-accent-blue" />
          <span className="font-medium text-zinc-200">Active Tracking</span>
          <span className="text-xs text-zinc-500">({states.length} coins)</span>
        </div>
        <button
          onClick={handleRefresh}
          disabled={refreshing}
          className="p-1.5 hover:bg-dark-600 rounded-lg text-zinc-400 hover:text-zinc-200 transition-colors"
        >
          <RefreshCw size={14} className={refreshing ? 'animate-spin' : ''} />
        </button>
      </div>

      {/* Table */}
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-zinc-500 text-xs border-b border-dark-600">
              <th className="text-left px-4 py-2 font-medium">Symbol</th>
              <th className="text-right px-4 py-2 font-medium">Price</th>
              <th className="text-center px-4 py-2 font-medium">Trend</th>
              <th className="text-center px-4 py-2 font-medium">Bias</th>
              <th className="text-center px-4 py-2 font-medium">Long</th>
              <th className="text-center px-4 py-2 font-medium">Short</th>
              <th className="text-right px-4 py-2 font-medium">ST Dist</th>
            </tr>
          </thead>
          <tbody>
            {states.map((state) => {
              const ticker = tickers.get(state.symbol)
              const livePrice = ticker?.price || state.snapshot.price
              
              return (
                <tr
                  key={state.symbol}
                  onClick={() => onSymbolClick?.(state.symbol)}
                  className="border-b border-dark-700 hover:bg-dark-700/50 cursor-pointer transition-colors"
                >
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      {getBiasIcon(state.snapshot.supertrendDir)}
                      <span className="font-medium text-zinc-200">{state.symbol}</span>
                    </div>
                  </td>
                  <td className="px-4 py-3 text-right">
                    <span className="mono text-zinc-300">
                      ${livePrice < 1 ? livePrice.toFixed(6) : livePrice.toFixed(2)}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-center">
                    <span className={`text-xs px-2 py-0.5 rounded ${
                      state.snapshot.supertrendDir === 'LONG' 
                        ? 'bg-accent-green/20 text-accent-green' 
                        : 'bg-accent-red/20 text-accent-red'
                    }`}>
                      {state.snapshot.supertrendDir}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-center">
                    <span className={getBiasColor(state.bias)}>
                      {state.bias}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-center">
                    {state.allowLongEntry 
                      ? <span className="text-accent-green">✅</span>
                      : <span className="text-zinc-600">❌</span>
                    }
                  </td>
                  <td className="px-4 py-3 text-center">
                    {state.allowShortEntry 
                      ? <span className="text-accent-red">✅</span>
                      : <span className="text-zinc-600">❌</span>
                    }
                  </td>
                  <td className="px-4 py-3 text-right">
                    <span className={`mono text-xs ${
                      state.snapshot.distanceToSupertrend > 0 
                        ? 'text-accent-green' 
                        : 'text-accent-red'
                    }`}>
                      {state.snapshot.distanceToSupertrend > 0 ? '+' : ''}
                      {state.snapshot.distanceToSupertrend?.toFixed(1)}%
                    </span>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      {/* Footer */}
      <div className="px-4 py-2 border-t border-dark-600 text-xs text-zinc-500">
        Click any row to see full analysis • Auto-refreshes every 30s
      </div>
    </div>
  )
}

