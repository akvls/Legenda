import { useState, useEffect } from 'react'
import { Calendar, TrendingUp, TrendingDown, Filter } from 'lucide-react'

interface Trade {
  id: string
  symbol: string
  side: 'LONG' | 'SHORT'
  strategyId: string
  entryPrice: number
  exitPrice?: number
  entrySize: number
  pnl?: number
  pnlPercent?: number
  createdAt: string
  exitedAt?: string
  status: 'OPEN' | 'CLOSED'
}

export default function Journal() {
  const [trades, setTrades] = useState<Trade[]>([])
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState<'all' | 'winning' | 'losing'>('all')

  useEffect(() => {
    const fetchTrades = async () => {
      try {
        const res = await fetch('http://localhost:3001/api/execution/trades')
        const data = await res.json()
        if (data.success) {
          setTrades(data.trades || [])
        }
      } catch (error) {
        console.error('Failed to fetch trades:', error)
      }
      setLoading(false)
    }

    fetchTrades()
  }, [])

  const stats = {
    total: trades.length,
    winning: trades.filter(t => (t.pnl || 0) > 0).length,
    losing: trades.filter(t => (t.pnl || 0) < 0).length,
    totalPnl: trades.reduce((sum, t) => sum + (t.pnl || 0), 0),
    winRate: trades.length > 0 
      ? (trades.filter(t => (t.pnl || 0) > 0).length / trades.filter(t => t.pnl !== undefined).length * 100) 
      : 0,
  }

  const filteredTrades = trades.filter(t => {
    if (filter === 'winning') return (t.pnl || 0) > 0
    if (filter === 'losing') return (t.pnl || 0) < 0
    return true
  })

  return (
    <div className="h-full flex flex-col p-6">
      {/* Header */}
      <div className="mb-6">
        <h1 className="text-xl font-semibold text-zinc-100">Trade Journal</h1>
        <p className="text-sm text-zinc-500">Review your trading history and performance</p>
      </div>

      {/* Stats Cards */}
      <div className="grid grid-cols-4 gap-4 mb-6">
        <StatCard label="Total Trades" value={stats.total.toString()} />
        <StatCard 
          label="Win Rate" 
          value={`${stats.winRate.toFixed(1)}%`} 
          color={stats.winRate >= 50 ? 'green' : 'red'}
        />
        <StatCard 
          label="Total P&L" 
          value={`${stats.totalPnl >= 0 ? '+' : ''}$${stats.totalPnl.toFixed(2)}`}
          color={stats.totalPnl >= 0 ? 'green' : 'red'}
        />
        <StatCard 
          label="W / L" 
          value={`${stats.winning} / ${stats.losing}`}
        />
      </div>

      {/* Filter */}
      <div className="flex items-center gap-2 mb-4">
        <Filter size={14} className="text-zinc-500" />
        <div className="flex gap-1">
          {(['all', 'winning', 'losing'] as const).map(f => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={`
                px-3 py-1 rounded-lg text-xs capitalize
                ${filter === f 
                  ? 'bg-dark-600 text-zinc-200' 
                  : 'text-zinc-500 hover:text-zinc-300'
                }
              `}
            >
              {f}
            </button>
          ))}
        </div>
      </div>

      {/* Trades Table */}
      <div className="flex-1 overflow-hidden bg-dark-800 rounded-xl border border-dark-600">
        {loading ? (
          <div className="p-8 text-center text-zinc-500">Loading trades...</div>
        ) : filteredTrades.length === 0 ? (
          <div className="p-8 text-center">
            <Calendar size={32} className="mx-auto mb-2 text-zinc-600" />
            <p className="text-zinc-500">No trades yet</p>
            <p className="text-xs text-zinc-600 mt-1">Your trading history will appear here</p>
          </div>
        ) : (
          <div className="overflow-y-auto h-full">
            <table className="w-full text-sm">
              <thead className="bg-dark-700 sticky top-0">
                <tr className="text-left text-zinc-500 text-xs uppercase">
                  <th className="px-4 py-3">Symbol</th>
                  <th className="px-4 py-3">Side</th>
                  <th className="px-4 py-3">Strategy</th>
                  <th className="px-4 py-3">Entry</th>
                  <th className="px-4 py-3">Exit</th>
                  <th className="px-4 py-3">P&L</th>
                  <th className="px-4 py-3">Date</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-dark-600">
                {filteredTrades.map(trade => (
                  <tr key={trade.id} className="hover:bg-dark-700/50">
                    <td className="px-4 py-3 font-medium text-zinc-200">{trade.symbol}</td>
                    <td className="px-4 py-3">
                      <span className={`
                        flex items-center gap-1
                        ${trade.side === 'LONG' ? 'text-accent-green' : 'text-accent-red'}
                      `}>
                        {trade.side === 'LONG' 
                          ? <TrendingUp size={14} /> 
                          : <TrendingDown size={14} />
                        }
                        {trade.side}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-zinc-400">{trade.strategyId}</td>
                    <td className="px-4 py-3 mono text-zinc-300">
                      ${trade.entryPrice?.toFixed(2) || '-'}
                    </td>
                    <td className="px-4 py-3 mono text-zinc-300">
                      {trade.exitPrice ? `$${trade.exitPrice.toFixed(2)}` : '-'}
                    </td>
                    <td className={`px-4 py-3 mono font-medium ${
                      (trade.pnl || 0) >= 0 ? 'text-accent-green' : 'text-accent-red'
                    }`}>
                      {trade.pnl !== undefined 
                        ? `${trade.pnl >= 0 ? '+' : ''}$${trade.pnl.toFixed(2)}`
                        : '-'
                      }
                    </td>
                    <td className="px-4 py-3 text-zinc-500">
                      {new Date(trade.createdAt).toLocaleDateString()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}

function StatCard({ label, value, color }: { label: string; value: string; color?: 'green' | 'red' }) {
  return (
    <div className="bg-dark-800 rounded-xl border border-dark-600 p-4">
      <div className="text-xs text-zinc-500 mb-1">{label}</div>
      <div className={`text-xl font-semibold mono ${
        color === 'green' ? 'text-accent-green' : 
        color === 'red' ? 'text-accent-red' : 
        'text-zinc-200'
      }`}>
        {value}
      </div>
    </div>
  )
}

