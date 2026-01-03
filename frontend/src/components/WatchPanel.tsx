import { useState, useEffect } from 'react';
import { Eye, X, Clock, Target, TrendingUp, TrendingDown, Zap, Bell } from 'lucide-react';
import { api, type WatchRule } from '../api/client';

export function WatchPanel() {
  const [watches, setWatches] = useState<WatchRule[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchWatches = async () => {
    try {
      const data = await api.getWatches();
      setWatches(data.watches || []);
      setError(null);
    } catch (err) {
      setError('Failed to load watches');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchWatches();
    const interval = setInterval(fetchWatches, 5000); // Refresh every 5s
    return () => clearInterval(interval);
  }, []);

  const cancelWatch = async (id: string) => {
    try {
      await api.cancelWatch(id);
      fetchWatches();
    } catch (err) {
      console.error('Failed to cancel watch:', err);
    }
  };

  const formatTimeLeft = (expiryTime: number) => {
    const now = Date.now();
    const diff = expiryTime - now;
    if (diff <= 0) return 'Expired';
    
    const hours = Math.floor(diff / (1000 * 60 * 60));
    const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
    
    if (hours > 0) return `${hours}h ${minutes}m`;
    return `${minutes}m`;
  };

  const getTriggerLabel = (type: string) => {
    switch (type) {
      case 'CLOSER_TO_SMA200': return 'SMA 200';
      case 'CLOSER_TO_EMA1000': return 'EMA 1000';
      case 'CLOSER_TO_SUPERTREND': return 'Supertrend';
      case 'PRICE_ABOVE': return 'Price Above';
      case 'PRICE_BELOW': return 'Price Below';
      default: return type;
    }
  };

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'ACTIVE': return 'text-emerald-400';
      case 'TRIGGERED': return 'text-amber-400';
      case 'EXPIRED': return 'text-zinc-500';
      case 'CANCELLED': return 'text-zinc-600';
      default: return 'text-zinc-400';
    }
  };

  if (loading) {
    return (
      <div className="bg-zinc-900/50 backdrop-blur border border-zinc-800 rounded-xl p-4">
        <div className="flex items-center gap-2 mb-3">
          <Eye className="w-4 h-4 text-violet-400" />
          <span className="text-sm font-medium text-zinc-300">Watch List</span>
        </div>
        <div className="text-zinc-500 text-sm animate-pulse">Loading...</div>
      </div>
    );
  }

  return (
    <div className="bg-zinc-900/50 backdrop-blur border border-zinc-800 rounded-xl p-4">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <Eye className="w-4 h-4 text-violet-400" />
          <span className="text-sm font-medium text-zinc-300">Watch List</span>
          {watches.length > 0 && (
            <span className="text-xs bg-violet-500/20 text-violet-400 px-2 py-0.5 rounded-full">
              {watches.length}
            </span>
          )}
        </div>
      </div>

      {error && (
        <div className="text-red-400 text-xs mb-2">{error}</div>
      )}

      {watches.length === 0 ? (
        <div className="text-zinc-500 text-sm py-4 text-center">
          No active watches
          <div className="text-xs mt-1 text-zinc-600">
            Say "watch BTC near SMA200" to create one
          </div>
        </div>
      ) : (
        <div className="space-y-2">
          {watches.map((watch) => (
            <WatchCard
              key={watch.id}
              watch={watch}
              onCancel={() => cancelWatch(watch.id)}
              formatTimeLeft={formatTimeLeft}
              getTriggerLabel={getTriggerLabel}
              getStatusColor={getStatusColor}
            />
          ))}
        </div>
      )}
    </div>
  );
}

interface WatchCardProps {
  watch: WatchRule;
  onCancel: () => void;
  formatTimeLeft: (expiryTime: number) => string;
  getTriggerLabel: (type: string) => string;
  getStatusColor: (status: string) => string;
}

function WatchCard({ watch, onCancel, formatTimeLeft, getTriggerLabel, getStatusColor }: WatchCardProps) {
  const isLong = watch.intendedSide === 'LONG';
  const isAutoEnter = watch.mode === 'AUTO_ENTER';
  
  return (
    <div className="bg-zinc-800/50 rounded-lg p-3 border border-zinc-700/50 hover:border-zinc-600/50 transition-colors">
      <div className="flex items-start justify-between">
        <div className="flex-1">
          {/* Symbol + Side */}
          <div className="flex items-center gap-2 mb-1">
            <span className="font-mono font-semibold text-zinc-200">
              {watch.symbol.replace('USDT', '')}
            </span>
            <span className={`text-xs px-1.5 py-0.5 rounded ${
              isLong 
                ? 'bg-emerald-500/20 text-emerald-400' 
                : 'bg-red-500/20 text-red-400'
            }`}>
              {isLong ? (
                <span className="flex items-center gap-1">
                  <TrendingUp className="w-3 h-3" /> LONG
                </span>
              ) : (
                <span className="flex items-center gap-1">
                  <TrendingDown className="w-3 h-3" /> SHORT
                </span>
              )}
            </span>
            {isAutoEnter && (
              <span className="text-xs px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-400 flex items-center gap-1">
                <Zap className="w-3 h-3" /> Auto
              </span>
            )}
          </div>
          
          {/* Trigger Info */}
          <div className="flex items-center gap-3 text-xs text-zinc-400">
            <span className="flex items-center gap-1">
              <Target className="w-3 h-3" />
              {getTriggerLabel(watch.triggerType)}
            </span>
            <span className="text-zinc-500">
              ≤ {watch.thresholdPercent}%
            </span>
          </div>
          
          {/* Status + Time */}
          <div className="flex items-center gap-3 mt-1.5 text-xs">
            <span className={getStatusColor(watch.status)}>
              {watch.status === 'ACTIVE' && <Bell className="w-3 h-3 inline mr-1" />}
              {watch.status}
            </span>
            <span className="flex items-center gap-1 text-zinc-500">
              <Clock className="w-3 h-3" />
              {formatTimeLeft(watch.expiryTime)}
            </span>
          </div>
        </div>
        
        {/* Cancel Button */}
        {watch.status === 'ACTIVE' && (
          <button
            onClick={onCancel}
            className="p-1.5 hover:bg-zinc-700 rounded-lg transition-colors text-zinc-500 hover:text-red-400"
            title="Cancel watch"
          >
            <X className="w-4 h-4" />
          </button>
        )}
      </div>
    </div>
  );
}


