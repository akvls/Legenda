import { useState, useEffect } from 'react'
import { Wallet, AlertTriangle } from 'lucide-react'
import { market, agent, type WalletResponse, type CircuitBreakerStatus } from '../api/client'

export default function WalletCard() {
  const [wallet, setWallet] = useState<WalletResponse['data'] | null>(null)
  const [circuitBreaker, setCircuitBreaker] = useState<CircuitBreakerStatus | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const fetchData = async () => {
      try {
        const [walletRes, cbRes] = await Promise.all([
          market.wallet(),
          agent.circuitBreaker(),
        ])
        setWallet(walletRes.data)
        setCircuitBreaker(cbRes)
      } catch (error) {
        console.error('Failed to fetch wallet:', error)
      }
      setLoading(false)
    }

    fetchData()
    const interval = setInterval(fetchData, 10000)
    return () => clearInterval(interval)
  }, [])

  if (loading) {
    return (
      <div className="bg-dark-800 rounded-xl border border-dark-600 p-4">
        <div className="animate-pulse space-y-2">
          <div className="h-4 bg-dark-600 rounded w-1/3"></div>
          <div className="h-6 bg-dark-600 rounded w-2/3"></div>
        </div>
      </div>
    )
  }

  if (!wallet) {
    return (
      <div className="bg-dark-800 rounded-xl border border-dark-600 p-4 text-center">
        <p className="text-zinc-500 text-sm">Failed to load wallet</p>
      </div>
    )
  }

  const lossPercent = circuitBreaker?.lossPercent || 0
  const isWarning = lossPercent > 30
  const isTripped = circuitBreaker?.isTripped

  return (
    <div className={`
      bg-dark-800 rounded-xl border p-4
      ${isTripped ? 'border-accent-red' : 'border-dark-600'}
    `}>
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2 text-zinc-400">
          <Wallet size={16} />
          <span className="text-sm">Account Balance</span>
        </div>
        {isTripped && (
          <span className="text-xs px-2 py-0.5 rounded bg-accent-red/20 text-accent-red flex items-center gap-1">
            <AlertTriangle size={12} />
            LOCKED
          </span>
        )}
      </div>

      <div className="text-2xl font-semibold text-zinc-100 mono mb-1">
        ${wallet.totalEquity.toFixed(2)}
      </div>

      <div className="flex gap-4 text-sm">
        <div>
          <span className="text-zinc-500">Available: </span>
          <span className="text-zinc-300 mono">${wallet.availableBalance.toFixed(2)}</span>
        </div>
        <div>
          <span className="text-zinc-500">Margin: </span>
          <span className="text-zinc-300 mono">${wallet.usedMargin.toFixed(2)}</span>
        </div>
      </div>

      {/* Circuit Breaker Status */}
      {circuitBreaker && (
        <div className="mt-3 pt-3 border-t border-dark-600">
          <div className="flex items-center justify-between text-xs">
            <span className="text-zinc-500">Daily Loss</span>
            <span className={isWarning ? 'text-accent-amber' : 'text-zinc-400'}>
              {lossPercent.toFixed(1)}% / {circuitBreaker.threshold}%
            </span>
          </div>
          <div className="mt-1 h-1.5 bg-dark-600 rounded-full overflow-hidden">
            <div 
              className={`h-full rounded-full transition-all ${
                isTripped ? 'bg-accent-red' : isWarning ? 'bg-accent-amber' : 'bg-accent-green'
              }`}
              style={{ width: `${Math.min(lossPercent / circuitBreaker.threshold * 100, 100)}%` }}
            />
          </div>
        </div>
      )}
    </div>
  )
}

