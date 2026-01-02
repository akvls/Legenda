import { useState, useEffect } from 'react'
import { TrendingUp, TrendingDown, Minus, RefreshCw } from 'lucide-react'
import { strategy, type StrategyState } from '../api/client'

interface StrategyPanelProps {
  symbol?: string
}

export default function StrategyPanel({ symbol = 'BTCUSDT' }: StrategyPanelProps) {
  const [state, setState] = useState<StrategyState | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)

  const fetchState = async () => {
    try {
      const res = await strategy.state(symbol)
      if (res.data) {
        setState(res.data)
      }
    } catch (error) {
      // Try registering first
      try {
        const res = await strategy.register(symbol)
        if (res.data) {
          setState(res.data)
        }
      } catch {
        console.error('Failed to get strategy state')
      }
    }
    setLoading(false)
    setRefreshing(false)
  }

  useEffect(() => {
    fetchState()
    const interval = setInterval(fetchState, 10000)
    return () => clearInterval(interval)
  }, [symbol])

  const refresh = () => {
    setRefreshing(true)
    fetchState()
  }

  if (loading) {
    return (
      <div className="bg-dark-800 rounded-xl border border-dark-600 p-4">
        <div className="animate-pulse space-y-3">
          <div className="h-4 bg-dark-600 rounded w-1/2"></div>
          <div className="h-20 bg-dark-600 rounded"></div>
        </div>
      </div>
    )
  }

  if (!state) {
    return (
      <div className="bg-dark-800 rounded-xl border border-dark-600 p-4 text-center">
        <p className="text-zinc-500 text-sm">No data for {symbol}</p>
        <button 
          onClick={refresh}
          className="mt-2 text-xs text-accent-blue hover:underline"
        >
          Register symbol
        </button>
      </div>
    )
  }

  const BiasIcon = state.bias === 'LONG' ? TrendingUp : state.bias === 'SHORT' ? TrendingDown : Minus
  const biasColor = state.bias === 'LONG' ? 'text-accent-green' : state.bias === 'SHORT' ? 'text-accent-red' : 'text-zinc-400'
  const biasBg = state.bias === 'LONG' ? 'bg-accent-green/10' : state.bias === 'SHORT' ? 'bg-accent-red/10' : 'bg-dark-600'

  return (
    <div className="bg-dark-800 rounded-xl border border-dark-600 overflow-hidden">
      {/* Header */}
      <div className="px-4 py-3 border-b border-dark-600 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-zinc-300 font-medium">{symbol}</span>
          <span className="text-xs text-zinc-500">{state.timeframe}m</span>
        </div>
        <button 
          onClick={refresh}
          className="p-1.5 rounded-lg hover:bg-dark-600 text-zinc-400"
          disabled={refreshing}
        >
          <RefreshCw size={14} className={refreshing ? 'animate-spin' : ''} />
        </button>
      </div>

      {/* Bias */}
      <div className={`px-4 py-4 ${biasBg}`}>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <BiasIcon size={24} className={biasColor} />
            <div>
              <div className={`text-lg font-semibold ${biasColor}`}>{state.bias}</div>
              <div className="text-xs text-zinc-500">
                Strategy: {state.strategyId || 'None'}
              </div>
            </div>
          </div>
          
          <div className="text-right">
            <div className="text-xl font-semibold text-zinc-200 mono">
              ${state.snapshot.price.toFixed(2)}
            </div>
            <div className="text-xs text-zinc-500">
              {state.snapshot.currentTrend}
            </div>
          </div>
        </div>

        {/* Entry permissions */}
        <div className="flex gap-2 mt-3">
          <span className={`
            text-xs px-2 py-1 rounded
            ${state.allowLongEntry ? 'bg-accent-green/20 text-accent-green' : 'bg-dark-600 text-zinc-500'}
          `}>
            {state.allowLongEntry ? '✓ Long OK' : '✗ Long blocked'}
          </span>
          <span className={`
            text-xs px-2 py-1 rounded
            ${state.allowShortEntry ? 'bg-accent-red/20 text-accent-red' : 'bg-dark-600 text-zinc-500'}
          `}>
            {state.allowShortEntry ? '✓ Short OK' : '✗ Short blocked'}
          </span>
        </div>
      </div>

      {/* Distances */}
      <div className="px-4 py-3 space-y-2">
        <div className="text-xs text-zinc-500 mb-2">Distance from Price</div>
        
        <DistanceRow 
          label="Supertrend" 
          value={state.snapshot.distanceToSupertrend}
          subValue={`$${state.snapshot.supertrendValue.toFixed(2)}`}
        />
        <DistanceRow 
          label="SMA 200" 
          value={state.snapshot.distanceToSma200}
          subValue={`$${state.snapshot.sma200.toFixed(2)}`}
        />
        <DistanceRow 
          label="EMA 1000" 
          value={state.snapshot.distanceToEma1000}
          subValue={`$${state.snapshot.ema1000.toFixed(2)}`}
        />
        
        {state.snapshot.distanceToSwingHigh !== null && (
          <DistanceRow 
            label="Swing High" 
            value={state.snapshot.distanceToSwingHigh}
            subValue={state.keyLevels.lastSwingHigh ? `$${state.keyLevels.lastSwingHigh.toFixed(2)}` : '-'}
          />
        )}
        {state.snapshot.distanceToSwingLow !== null && (
          <DistanceRow 
            label="Swing Low" 
            value={state.snapshot.distanceToSwingLow}
            subValue={state.keyLevels.lastSwingLow ? `$${state.keyLevels.lastSwingLow.toFixed(2)}` : '-'}
          />
        )}
      </div>
    </div>
  )
}

function DistanceRow({ label, value, subValue }: { label: string; value: number; subValue: string }) {
  const isPositive = value >= 0
  
  return (
    <div className="flex items-center justify-between text-sm">
      <div className="flex items-center gap-2">
        <span className="text-zinc-400">{label}</span>
        <span className="text-xs text-zinc-600">{subValue}</span>
      </div>
      <span className={`mono ${isPositive ? 'text-accent-green' : 'text-accent-red'}`}>
        {isPositive ? '+' : ''}{value.toFixed(2)}%
      </span>
    </div>
  )
}

