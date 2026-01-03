import { useState, useEffect } from 'react'
import { Clock, X, TrendingUp, TrendingDown, Loader2, RefreshCw } from 'lucide-react'
import { api } from '../api/client'

interface PendingOrder {
  id: string
  symbol: string
  side: 'LONG' | 'SHORT'
  price: number
  size: number
  status: string
  createdAt: string
  stopLoss?: number
  takeProfit?: number
}

export default function PendingOrdersCard() {
  const [orders, setOrders] = useState<PendingOrder[]>([])
  const [loading, setLoading] = useState(true)
  const [actionLoading, setActionLoading] = useState<string | null>(null)

  const fetchOrders = async () => {
    try {
      const res = await fetch('http://localhost:3001/api/execution/orders')
      const data = await res.json()
      if (data.success && data.data) {
        // Filter only pending/open orders (not filled, not cancelled)
        const pendingOrders = data.data.filter((o: any) => 
          o.status === 'OPEN' || o.status === 'PENDING' || o.status === 'PARTIALLY_FILLED'
        )
        setOrders(pendingOrders.map((o: any) => ({
          id: o.id,
          symbol: o.symbol,
          side: o.side,
          price: o.price,
          size: o.size,
          status: o.status,
          createdAt: o.createdAt,
          stopLoss: o.stopLoss,
          takeProfit: o.takeProfit,
        })))
      }
    } catch (error) {
      console.error('Failed to fetch pending orders:', error)
    }
    setLoading(false)
  }

  useEffect(() => {
    fetchOrders()
    const interval = setInterval(fetchOrders, 5000) // Refresh every 5s
    return () => clearInterval(interval)
  }, [])

  const handleCancel = async (symbol: string) => {
    if (actionLoading) return
    setActionLoading(symbol)
    try {
      await api.chat(`cancel order ${symbol}`)
      // Refresh after cancel
      setTimeout(fetchOrders, 1000)
    } catch (error) {
      console.error('Failed to cancel order:', error)
    }
    setActionLoading(null)
  }

  const formatTime = (dateStr: string) => {
    const date = new Date(dateStr)
    const now = new Date()
    const diffMs = now.getTime() - date.getTime()
    const diffMins = Math.floor(diffMs / 60000)
    
    if (diffMins < 1) return 'Just now'
    if (diffMins < 60) return `${diffMins}m ago`
    const diffHours = Math.floor(diffMins / 60)
    if (diffHours < 24) return `${diffHours}h ago`
    return `${Math.floor(diffHours / 24)}d ago`
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

  if (orders.length === 0) {
    return (
      <div className="bg-dark-800 rounded-xl border border-dark-600 p-4">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2 text-zinc-400">
            <Clock size={16} />
            <span className="text-sm font-medium">Pending Orders</span>
          </div>
          <button 
            onClick={fetchOrders}
            className="p-1 rounded hover:bg-dark-600 text-zinc-500"
          >
            <RefreshCw size={14} />
          </button>
        </div>
        <p className="text-zinc-500 text-sm text-center py-2">No pending limit orders</p>
      </div>
    )
  }

  return (
    <div className="bg-dark-800 rounded-xl border border-amber-500/30 p-4">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2 text-amber-400">
          <Clock size={16} />
          <span className="text-sm font-medium">Pending Orders</span>
          <span className="text-xs bg-amber-500/20 text-amber-400 px-2 py-0.5 rounded-full">
            {orders.length}
          </span>
        </div>
        <button 
          onClick={fetchOrders}
          className="p-1 rounded hover:bg-dark-600 text-zinc-500"
        >
          <RefreshCw size={14} />
        </button>
      </div>

      <div className="space-y-2">
        {orders.map(order => (
          <div 
            key={order.id}
            className="bg-dark-700 rounded-lg p-3 border border-dark-500"
          >
            {/* Header */}
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center gap-2">
                <div className={`
                  w-6 h-6 rounded flex items-center justify-center
                  ${order.side === 'LONG' ? 'bg-accent-green/20' : 'bg-accent-red/20'}
                `}>
                  {order.side === 'LONG' 
                    ? <TrendingUp size={14} className="text-accent-green" />
                    : <TrendingDown size={14} className="text-accent-red" />
                  }
                </div>
                <span className="font-medium text-zinc-200">{order.symbol}</span>
                <span className={`
                  text-xs px-1.5 py-0.5 rounded
                  ${order.side === 'LONG' ? 'bg-accent-green/20 text-accent-green' : 'bg-accent-red/20 text-accent-red'}
                `}>
                  {order.side}
                </span>
              </div>
              
              <span className="text-xs text-zinc-500">{formatTime(order.createdAt)}</span>
            </div>

            {/* Details */}
            <div className="grid grid-cols-3 gap-2 text-sm mb-2">
              <div>
                <span className="text-zinc-500 text-xs">Limit Price</span>
                <div className="text-amber-400 mono font-medium">${order.price?.toFixed(2)}</div>
              </div>
              <div>
                <span className="text-zinc-500 text-xs">Size</span>
                <div className="text-zinc-300 mono">{order.size?.toFixed(4)}</div>
              </div>
              <div>
                <span className="text-zinc-500 text-xs">Status</span>
                <div className="text-amber-400 text-xs">{order.status}</div>
              </div>
            </div>

            {/* SL/TP if set */}
            {(order.stopLoss || order.takeProfit) && (
              <div className="grid grid-cols-2 gap-2 text-xs mb-2 pt-2 border-t border-dark-500">
                <div>
                  <span className="text-zinc-500">SL:</span>
                  <span className="text-accent-red ml-1 mono">
                    {order.stopLoss ? `$${order.stopLoss.toFixed(2)}` : '-'}
                  </span>
                </div>
                <div>
                  <span className="text-zinc-500">TP:</span>
                  <span className="text-accent-green ml-1 mono">
                    {order.takeProfit ? `$${order.takeProfit.toFixed(2)}` : '-'}
                  </span>
                </div>
              </div>
            )}

            {/* Cancel Button */}
            <button
              onClick={() => handleCancel(order.symbol)}
              disabled={!!actionLoading}
              className="w-full mt-2 py-1.5 rounded-lg bg-accent-red/20 hover:bg-accent-red/30 text-accent-red text-sm flex items-center justify-center gap-1 disabled:opacity-50 transition-colors"
            >
              {actionLoading === order.symbol ? (
                <Loader2 size={14} className="animate-spin" />
              ) : (
                <X size={14} />
              )}
              Cancel Order
            </button>
          </div>
        ))}
      </div>
    </div>
  )
}



