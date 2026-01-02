import { useState, useEffect } from 'react'
import { TrendingUp, TrendingDown, Shield, Target, X } from 'lucide-react'
import { execution, type Position } from '../api/client'

export default function PositionCard() {
  const [positions, setPositions] = useState<Position[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const fetchPositions = async () => {
      try {
        const res = await execution.positions()
        const posData = res.data || []
        setPositions(posData.filter((p: Position) => parseFloat(p.size) > 0))
      } catch (error) {
        console.error('Failed to fetch positions:', error)
      }
      setLoading(false)
    }

    fetchPositions()
    const interval = setInterval(fetchPositions, 5000)
    return () => clearInterval(interval)
  }, [])

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
        const pnl = parseFloat(position.unrealisedPnl)
        const isProfit = pnl >= 0
        const side = position.side === 'Buy' ? 'LONG' : 'SHORT'
        const entryPrice = parseFloat(position.entryPrice)
        const markPrice = parseFloat(position.markPrice)
        const pnlPercent = ((markPrice - entryPrice) / entryPrice) * 100 * (side === 'LONG' ? 1 : -1)

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
                {isProfit ? '+' : ''}{pnl.toFixed(2)} USDT
              </div>
              <div className={`text-sm ${isProfit ? 'text-accent-green/70' : 'text-accent-red/70'}`}>
                {isProfit ? '+' : ''}{pnlPercent.toFixed(2)}%
              </div>
            </div>

            {/* Details */}
            <div className="grid grid-cols-2 gap-3 text-sm">
              <div>
                <span className="text-zinc-500 text-xs">Entry</span>
                <div className="text-zinc-300 mono">${entryPrice.toFixed(2)}</div>
              </div>
              <div>
                <span className="text-zinc-500 text-xs">Mark</span>
                <div className="text-zinc-300 mono">${markPrice.toFixed(2)}</div>
              </div>
              <div>
                <span className="text-zinc-500 text-xs">Size</span>
                <div className="text-zinc-300 mono">{position.size}</div>
              </div>
              <div>
                <span className="text-zinc-500 text-xs">Value</span>
                <div className="text-zinc-300 mono">
                  ${(parseFloat(position.size) * markPrice).toFixed(2)}
                </div>
              </div>
            </div>

            {/* Actions */}
            <div className="flex gap-2 mt-4">
              <button className="flex-1 py-2 rounded-lg bg-dark-600 hover:bg-dark-500 text-zinc-300 text-sm flex items-center justify-center gap-1">
                <Shield size={14} />
                Move SL
              </button>
              <button className="flex-1 py-2 rounded-lg bg-accent-red/20 hover:bg-accent-red/30 text-accent-red text-sm flex items-center justify-center gap-1">
                <X size={14} />
                Close
              </button>
            </div>
          </div>
        )
      })}
    </div>
  )
}

