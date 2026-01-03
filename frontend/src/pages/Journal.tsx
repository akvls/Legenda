import React, { useState, useEffect } from 'react';
import { 
  TrendingUp, 
  TrendingDown, 
  Clock, 
  Target, 
  AlertTriangle,
  Calendar,
  Filter,
  ChevronDown,
  ChevronUp,
  Star,
  MessageSquare,
  BarChart3,
  RefreshCw,
  X,
} from 'lucide-react';
import { journal } from '../api/client';

interface Trade {
  id: string;
  symbol: string;
  side: 'LONG' | 'SHORT';
  timeframe: string;
  strategyId: string;
  
  // Entry
  entryType: string;
  riskPercent: number;
  riskAmountUsdt: number;
  requestedLeverage: number;
  appliedLeverage: number;
  entryPrice: number | null;
  entryFilledAt: string | null;
  entrySize: number | null;
  entrySizeUsdt: number | null;
  
  // SL/TP
  slRule: string;
  slPrice: number | null;
  tpRule: string;
  tpPrice: number | null;
  trailMode: string;
  
  // Exit
  exitPrice: number | null;
  exitFilledAt: string | null;
  exitReason: string | null;
  
  // P&L
  realizedPnl: number | null;
  realizedPnlPercent: number | null;
  rMultiple: number | null;
  fees: number | null;
  
  // MFE/MAE
  mfePrice: number | null;
  mfePercent: number | null;
  maePrice: number | null;
  maePercent: number | null;
  
  // Scores
  aiScore: number | null;
  userScore: number | null;
  
  // AI Analysis
  aiRecommendation: string | null;
  aiOpinion: string | null;
  aiKeyPoints: string[];
  aiRiskLevel: string | null;
  aiSuggestedRisk: number | null;
  
  // User
  userRawCommand: string | null;
  userNote: string | null;
  userTags: string[];
  userReview: string | null;
  
  // Duration
  durationSeconds: number | null;
  
  // Snapshots
  strategySnapshotAtEntry: any;
  strategySnapshotAtExit: any;
  
  // Timestamps
  createdAt: string;
  closedAt: string | null;
  
  // Relations
  orders: any[];
  fills: any[];
  events: any[];
}

interface Stats {
  overview: {
    totalTrades: number;
    winningTrades: number;
    losingTrades: number;
    breakEvenTrades: number;
    winRate: number;
    profitFactor: number;
  };
  pnl: {
    totalPnl: number;
    avgPnl: number;
    totalR: number;
    avgR: number;
    totalFees: number;
    grossProfit: number;
    grossLoss: number;
  };
  bestWorst: {
    bestTrade: { id: string; symbol: string; pnl: number; rMultiple: number } | null;
    worstTrade: { id: string; symbol: string; pnl: number; rMultiple: number } | null;
  };
  streaks: {
    maxConsecutiveWins: number;
    maxConsecutiveLosses: number;
  };
  timing: {
    avgDurationSeconds: number;
    avgDurationFormatted: string;
  };
  bySide: {
    longs: { count: number; wins: number; winRate: number; pnl: number };
    shorts: { count: number; wins: number; winRate: number; pnl: number };
  };
  bySymbol: Record<string, { trades: number; pnl: number; winRate: number }>;
  byStrategy: Record<string, { trades: number; pnl: number; winRate: number }>;
  byExitReason: Record<string, number>;
}

export default function Journal() {
  const [trades, setTrades] = useState<Trade[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);
  const [loading, setLoading] = useState(true);
  const [expandedTrade, setExpandedTrade] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<'trades' | 'stats'>('trades');
  const [filters, setFilters] = useState({
    symbol: '',
    side: '',
    strategyId: '',
  });
  const [showFilters, setShowFilters] = useState(false);

  useEffect(() => {
    loadData();
  }, [filters]);

  const loadData = async () => {
    setLoading(true);
    try {
      const [tradesRes, statsRes] = await Promise.all([
        journal.getTrades(filters),
        journal.getStats(),
      ]);
      
      if (tradesRes.success) setTrades(tradesRes.trades);
      if (statsRes.success) setStats(statsRes.stats);
    } catch (error) {
      console.error('Failed to load journal:', error);
    }
    setLoading(false);
  };

  const formatDuration = (seconds: number | null): string => {
    if (!seconds) return '-';
    if (seconds < 60) return `${seconds}s`;
    if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
    if (seconds < 86400) return `${(seconds / 3600).toFixed(1)}h`;
    return `${(seconds / 86400).toFixed(1)}d`;
  };

  const formatDate = (dateStr: string): string => {
    const d = new Date(dateStr);
    return d.toLocaleDateString('en-US', { 
      month: 'short', 
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  const getExitReasonLabel = (reason: string | null): { label: string; color: string } => {
    const reasons: Record<string, { label: string; color: string }> = {
      'STOP_LOSS': { label: 'Stop Loss', color: 'text-red-400' },
      'TAKE_PROFIT': { label: 'Take Profit', color: 'text-green-400' },
      'TRAIL_STOP': { label: 'Trailing Stop', color: 'text-amber-400' },
      'INVALIDATION_BIAS_FLIP': { label: 'Bias Flip', color: 'text-orange-400' },
      'INVALIDATION_STRUCTURE_BREAK': { label: 'Structure Break', color: 'text-orange-400' },
      'SWING_BREAK': { label: 'Swing Break', color: 'text-red-400' },
      'MANUAL_CLOSE': { label: 'Manual', color: 'text-blue-400' },
      'EMERGENCY_FLATTEN': { label: 'Emergency', color: 'text-red-500' },
    };
    return reasons[reason || ''] || { label: reason || 'Unknown', color: 'text-gray-400' };
  };

  const getStrategyLabel = (id: string): { label: string; color: string } => {
    const strategies: Record<string, { label: string; color: string }> = {
      'S101': { label: 'Conservative', color: 'bg-green-500/20 text-green-400' },
      'S102': { label: 'Trend Filter', color: 'bg-blue-500/20 text-blue-400' },
      'S103': { label: 'Aggressive', color: 'bg-amber-500/20 text-amber-400' },
    };
    return strategies[id] || { label: id, color: 'bg-gray-500/20 text-gray-400' };
  };

  return (
    <div className="p-6 max-w-7xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-3xl font-bold text-white">📖 Trade Journal</h1>
        <div className="flex items-center gap-3">
          <button
            onClick={() => setShowFilters(!showFilters)}
            className={`flex items-center gap-2 px-4 py-2 rounded-lg transition-colors ${
              showFilters ? 'bg-violet-600 text-white' : 'bg-slate-700 text-gray-300 hover:bg-slate-600'
            }`}
          >
            <Filter size={18} />
            Filters
          </button>
          <button
            onClick={loadData}
            className="flex items-center gap-2 px-4 py-2 bg-slate-700 text-gray-300 rounded-lg hover:bg-slate-600 transition-colors"
          >
            <RefreshCw size={18} />
            Refresh
          </button>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-4 mb-6">
        <button
          onClick={() => setActiveTab('trades')}
          className={`px-6 py-3 rounded-lg font-medium transition-colors ${
            activeTab === 'trades' 
              ? 'bg-violet-600 text-white' 
              : 'bg-slate-800 text-gray-400 hover:text-white'
          }`}
        >
          📋 Trades ({trades.length})
        </button>
        <button
          onClick={() => setActiveTab('stats')}
          className={`px-6 py-3 rounded-lg font-medium transition-colors ${
            activeTab === 'stats' 
              ? 'bg-violet-600 text-white' 
              : 'bg-slate-800 text-gray-400 hover:text-white'
          }`}
        >
          📊 Statistics
        </button>
      </div>

      {/* Filters */}
      {showFilters && (
        <div className="bg-slate-800 rounded-xl p-4 mb-6 flex gap-4 items-center flex-wrap">
          <select
            value={filters.symbol}
            onChange={(e) => setFilters({ ...filters, symbol: e.target.value })}
            className="bg-slate-700 text-white px-4 py-2 rounded-lg border border-slate-600"
          >
            <option value="">All Symbols</option>
            <option value="BTCUSDT">BTCUSDT</option>
            <option value="ETHUSDT">ETHUSDT</option>
          </select>
          <select
            value={filters.side}
            onChange={(e) => setFilters({ ...filters, side: e.target.value })}
            className="bg-slate-700 text-white px-4 py-2 rounded-lg border border-slate-600"
          >
            <option value="">All Sides</option>
            <option value="LONG">Long</option>
            <option value="SHORT">Short</option>
          </select>
          <select
            value={filters.strategyId}
            onChange={(e) => setFilters({ ...filters, strategyId: e.target.value })}
            className="bg-slate-700 text-white px-4 py-2 rounded-lg border border-slate-600"
          >
            <option value="">All Strategies</option>
            <option value="S101">S101 - Conservative</option>
            <option value="S102">S102 - Trend Filter</option>
            <option value="S103">S103 - Aggressive</option>
          </select>
          {(filters.symbol || filters.side || filters.strategyId) && (
            <button
              onClick={() => setFilters({ symbol: '', side: '', strategyId: '' })}
              className="text-gray-400 hover:text-white flex items-center gap-1"
            >
              <X size={16} /> Clear
            </button>
          )}
        </div>
      )}

      {loading ? (
        <div className="text-center text-gray-400 py-12">Loading...</div>
      ) : activeTab === 'trades' ? (
        /* Trade List */
        <div className="space-y-4">
          {trades.length === 0 ? (
            <div className="bg-slate-800 rounded-xl p-12 text-center">
              <p className="text-gray-400 text-lg">No trades recorded yet</p>
              <p className="text-gray-500 mt-2">Complete some trades to see them here</p>
            </div>
          ) : (
            trades.map((trade) => (
              <TradeCard 
                key={trade.id} 
                trade={trade} 
                expanded={expandedTrade === trade.id}
                onToggle={() => setExpandedTrade(expandedTrade === trade.id ? null : trade.id)}
                formatDuration={formatDuration}
                formatDate={formatDate}
                getExitReasonLabel={getExitReasonLabel}
                getStrategyLabel={getStrategyLabel}
              />
            ))
          )}
        </div>
      ) : (
        /* Statistics */
        stats && <StatsPanel stats={stats} />
      )}
    </div>
  );
}

// Trade Card Component
function TradeCard({ 
  trade, 
  expanded, 
  onToggle,
  formatDuration,
  formatDate,
  getExitReasonLabel,
  getStrategyLabel,
}: { 
  trade: Trade; 
  expanded: boolean; 
  onToggle: () => void;
  formatDuration: (s: number | null) => string;
  formatDate: (s: string) => string;
  getExitReasonLabel: (r: string | null) => { label: string; color: string };
  getStrategyLabel: (id: string) => { label: string; color: string };
}) {
  const isWin = (trade.realizedPnl || 0) > 0;
  const isLoss = (trade.realizedPnl || 0) < 0;
  const exitReason = getExitReasonLabel(trade.exitReason);
  const strategy = getStrategyLabel(trade.strategyId);

  return (
    <div className={`bg-slate-800 rounded-xl overflow-hidden border-l-4 ${
      isWin ? 'border-green-500' : isLoss ? 'border-red-500' : 'border-gray-500'
    }`}>
      {/* Header Row */}
      <div 
        className="p-4 cursor-pointer hover:bg-slate-700/50 transition-colors"
        onClick={onToggle}
      >
        <div className="flex items-center justify-between">
          {/* Left: Symbol, Side, Strategy */}
          <div className="flex items-center gap-4">
            <div className={`flex items-center gap-2 px-3 py-1 rounded-lg ${
              trade.side === 'LONG' ? 'bg-green-500/20 text-green-400' : 'bg-red-500/20 text-red-400'
            }`}>
              {trade.side === 'LONG' ? <TrendingUp size={18} /> : <TrendingDown size={18} />}
              <span className="font-bold">{trade.side}</span>
            </div>
            <span className="text-xl font-bold text-white">{trade.symbol}</span>
            <span className={`text-xs px-2 py-1 rounded ${strategy.color}`}>{strategy.label}</span>
            <span className="text-sm text-gray-400">{trade.timeframe}</span>
          </div>

          {/* Right: P&L, R, Score */}
          <div className="flex items-center gap-6">
            {/* P&L */}
            <div className="text-right">
              <div className={`text-xl font-bold ${isWin ? 'text-green-400' : isLoss ? 'text-red-400' : 'text-gray-400'}`}>
                {isWin ? '+' : ''}{(trade.realizedPnl || 0).toFixed(2)} USDT
              </div>
              <div className="text-sm text-gray-400">
                {isWin ? '+' : ''}{(trade.realizedPnlPercent || 0).toFixed(2)}%
              </div>
            </div>

            {/* R Multiple */}
            <div className="text-center px-4 py-2 bg-slate-700 rounded-lg">
              <div className={`text-lg font-bold ${
                (trade.rMultiple || 0) > 0 ? 'text-green-400' : 'text-red-400'
              }`}>
                {(trade.rMultiple || 0) > 0 ? '+' : ''}{(trade.rMultiple || 0).toFixed(2)}R
              </div>
            </div>

            {/* AI Score */}
            {trade.aiScore && (
              <div className="flex items-center gap-1 px-3 py-1 bg-violet-500/20 rounded-lg">
                <Star size={16} className="text-violet-400" />
                <span className="text-violet-400 font-bold">{trade.aiScore}/10</span>
              </div>
            )}

            {/* Duration */}
            <div className="flex items-center gap-2 text-gray-400">
              <Clock size={16} />
              <span>{formatDuration(trade.durationSeconds)}</span>
            </div>

            {/* Expand Icon */}
            {expanded ? <ChevronUp size={20} className="text-gray-400" /> : <ChevronDown size={20} className="text-gray-400" />}
          </div>
        </div>

        {/* Summary Row */}
        <div className="flex items-center gap-6 mt-3 text-sm text-gray-400">
          <span>📅 {formatDate(trade.createdAt)}</span>
          <span>📍 Entry: ${trade.entryPrice?.toFixed(2) || '-'}</span>
          <span>🎯 Exit: ${trade.exitPrice?.toFixed(2) || '-'}</span>
          <span className={exitReason.color}>🚪 {exitReason.label}</span>
          <span>⚡ {trade.appliedLeverage}x</span>
          <span>💰 Risk: {trade.riskPercent}%</span>
        </div>
      </div>

      {/* Expanded Details */}
      {expanded && (
        <div className="border-t border-slate-700 p-4 space-y-6">
          {/* Entry/Exit Details */}
          <div className="grid grid-cols-2 gap-6">
            {/* Entry */}
            <div className="bg-slate-900 rounded-lg p-4">
              <h4 className="text-green-400 font-bold mb-3 flex items-center gap-2">
                <TrendingUp size={16} /> Entry Details
              </h4>
              <div className="space-y-2 text-sm">
                <div className="flex justify-between">
                  <span className="text-gray-400">Price</span>
                  <span className="text-white font-mono">${trade.entryPrice?.toFixed(4) || '-'}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-400">Size</span>
                  <span className="text-white font-mono">{trade.entrySize?.toFixed(4) || '-'}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-400">Size USDT</span>
                  <span className="text-white font-mono">${trade.entrySizeUsdt?.toFixed(2) || '-'}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-400">Time</span>
                  <span className="text-white">{trade.entryFilledAt ? formatDate(trade.entryFilledAt) : '-'}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-400">Type</span>
                  <span className="text-white">{trade.entryType}</span>
                </div>
              </div>
            </div>

            {/* Exit */}
            <div className="bg-slate-900 rounded-lg p-4">
              <h4 className="text-red-400 font-bold mb-3 flex items-center gap-2">
                <TrendingDown size={16} /> Exit Details
              </h4>
              <div className="space-y-2 text-sm">
                <div className="flex justify-between">
                  <span className="text-gray-400">Price</span>
                  <span className="text-white font-mono">${trade.exitPrice?.toFixed(4) || '-'}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-400">Reason</span>
                  <span className={exitReason.color}>{exitReason.label}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-400">Time</span>
                  <span className="text-white">{trade.exitFilledAt ? formatDate(trade.exitFilledAt) : '-'}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-400">Fees</span>
                  <span className="text-amber-400">${(trade.fees || 0).toFixed(4)}</span>
                </div>
              </div>
            </div>
          </div>

          {/* Risk Management */}
          <div className="bg-slate-900 rounded-lg p-4">
            <h4 className="text-amber-400 font-bold mb-3 flex items-center gap-2">
              <AlertTriangle size={16} /> Risk Management
            </h4>
            <div className="grid grid-cols-4 gap-4 text-sm">
              <div>
                <span className="text-gray-400 block">SL Rule</span>
                <span className="text-white">{trade.slRule}</span>
              </div>
              <div>
                <span className="text-gray-400 block">SL Price</span>
                <span className="text-red-400 font-mono">${trade.slPrice?.toFixed(2) || '-'}</span>
              </div>
              <div>
                <span className="text-gray-400 block">TP Rule</span>
                <span className="text-white">{trade.tpRule}</span>
              </div>
              <div>
                <span className="text-gray-400 block">Trail Mode</span>
                <span className="text-white">{trade.trailMode}</span>
              </div>
              <div>
                <span className="text-gray-400 block">MFE (Best)</span>
                <span className="text-green-400">{trade.mfePercent ? `+${trade.mfePercent.toFixed(2)}%` : '-'}</span>
              </div>
              <div>
                <span className="text-gray-400 block">MAE (Worst)</span>
                <span className="text-red-400">{trade.maePercent ? `${trade.maePercent.toFixed(2)}%` : '-'}</span>
              </div>
              <div>
                <span className="text-gray-400 block">Leverage</span>
                <span className="text-white">{trade.appliedLeverage}x (req: {trade.requestedLeverage}x)</span>
              </div>
              <div>
                <span className="text-gray-400 block">Risk Amount</span>
                <span className="text-white">${trade.riskAmountUsdt.toFixed(2)}</span>
              </div>
            </div>
          </div>

          {/* AI Analysis */}
          {(trade.aiOpinion || trade.aiRecommendation) && (
            <div className="bg-slate-900 rounded-lg p-4">
              <h4 className="text-violet-400 font-bold mb-3 flex items-center gap-2">
                <MessageSquare size={16} /> AI Analysis at Entry
              </h4>
              <div className="space-y-3">
                <div className="flex items-center gap-4">
                  <span className={`px-3 py-1 rounded-lg text-sm font-bold ${
                    trade.aiRecommendation === 'ENTER' ? 'bg-green-500/20 text-green-400' :
                    trade.aiRecommendation === 'WAIT' ? 'bg-amber-500/20 text-amber-400' :
                    'bg-red-500/20 text-red-400'
                  }`}>
                    {trade.aiRecommendation}
                  </span>
                  {trade.aiScore && (
                    <span className="text-gray-400">
                      Confidence: <span className="text-violet-400 font-bold">{trade.aiScore}/10</span>
                    </span>
                  )}
                  {trade.aiRiskLevel && (
                    <span className={`text-sm ${
                      trade.aiRiskLevel === 'HIGH' ? 'text-red-400' :
                      trade.aiRiskLevel === 'MEDIUM' ? 'text-amber-400' :
                      'text-green-400'
                    }`}>
                      Risk: {trade.aiRiskLevel}
                    </span>
                  )}
                </div>
                {trade.aiOpinion && (
                  <p className="text-gray-300 text-sm">{trade.aiOpinion}</p>
                )}
                {trade.aiKeyPoints && trade.aiKeyPoints.length > 0 && (
                  <ul className="text-sm space-y-1">
                    {trade.aiKeyPoints.map((point, i) => (
                      <li key={i} className="text-gray-400 flex items-start gap-2">
                        <span className="text-violet-400">•</span> {point}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          )}

          {/* User Notes */}
          {(trade.userRawCommand || trade.userNote || trade.userReview) && (
            <div className="bg-slate-900 rounded-lg p-4">
              <h4 className="text-blue-400 font-bold mb-3 flex items-center gap-2">
                <MessageSquare size={16} /> User Input
              </h4>
              <div className="space-y-2 text-sm">
                {trade.userRawCommand && (
                  <div>
                    <span className="text-gray-400">Command:</span>
                    <span className="text-white ml-2 font-mono bg-slate-800 px-2 py-1 rounded">{trade.userRawCommand}</span>
                  </div>
                )}
                {trade.userNote && (
                  <div>
                    <span className="text-gray-400">Note:</span>
                    <span className="text-white ml-2">{trade.userNote}</span>
                  </div>
                )}
                {trade.userReview && (
                  <div>
                    <span className="text-gray-400">Review:</span>
                    <span className="text-white ml-2">{trade.userReview}</span>
                  </div>
                )}
                {trade.userTags && trade.userTags.length > 0 && (
                  <div className="flex items-center gap-2">
                    <span className="text-gray-400">Tags:</span>
                    {trade.userTags.map((tag, i) => (
                      <span key={i} className="px-2 py-1 bg-blue-500/20 text-blue-400 rounded text-xs">{tag}</span>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Strategy Snapshot */}
          {trade.strategySnapshotAtEntry && (
            <div className="bg-slate-900 rounded-lg p-4">
              <h4 className="text-cyan-400 font-bold mb-3 flex items-center gap-2">
                <BarChart3 size={16} /> Strategy Snapshot at Entry
              </h4>
              <div className="grid grid-cols-4 gap-4 text-sm">
                <div>
                  <span className="text-gray-400 block">Supertrend</span>
                  <span className={trade.strategySnapshotAtEntry.supertrendDir === 'LONG' ? 'text-green-400' : 'text-red-400'}>
                    {trade.strategySnapshotAtEntry.supertrendDir} @ ${trade.strategySnapshotAtEntry.supertrendValue?.toFixed(2)}
                  </span>
                </div>
                <div>
                  <span className="text-gray-400 block">SMA200</span>
                  <span className="text-white font-mono">${trade.strategySnapshotAtEntry.sma200?.toFixed(2)}</span>
                </div>
                <div>
                  <span className="text-gray-400 block">EMA1000</span>
                  <span className="text-white font-mono">${trade.strategySnapshotAtEntry.ema1000?.toFixed(2)}</span>
                </div>
                <div>
                  <span className="text-gray-400 block">Structure</span>
                  <span className={
                    trade.strategySnapshotAtEntry.structureBias === 'BULLISH' ? 'text-green-400' :
                    trade.strategySnapshotAtEntry.structureBias === 'BEARISH' ? 'text-red-400' :
                    'text-gray-400'
                  }>
                    {trade.strategySnapshotAtEntry.structureBias}
                  </span>
                </div>
              </div>
            </div>
          )}

          {/* Orders */}
          {trade.orders && trade.orders.length > 0 && (
            <div className="bg-slate-900 rounded-lg p-4">
              <h4 className="text-gray-300 font-bold mb-3">Orders ({trade.orders.length})</h4>
              <div className="text-xs space-y-1">
                {trade.orders.map((order, i) => (
                  <div key={i} className="flex items-center gap-4 text-gray-400">
                    <span className={order.side === 'LONG' ? 'text-green-400' : 'text-red-400'}>{order.side}</span>
                    <span>{order.orderType}</span>
                    <span>{order.size}</span>
                    <span className={order.status === 'FILLED' ? 'text-green-400' : 'text-amber-400'}>{order.status}</span>
                    {order.isEntry && <span className="text-blue-400">ENTRY</span>}
                    {order.isExit && <span className="text-violet-400">EXIT</span>}
                    {order.isStopLoss && <span className="text-red-400">SL</span>}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// Stats Panel Component
function StatsPanel({ stats }: { stats: Stats }) {
  const [dailyStats, setDailyStats] = useState<Array<{ date: string; pnl: number; trades: number; wins: number; losses: number }>>([]);
  const [loadingDaily, setLoadingDaily] = useState(true);

  useEffect(() => {
    loadDailyStats();
  }, []);

  const loadDailyStats = async () => {
    try {
      const res = await journal.getDailyStats(30);
      if (res.success) {
        setDailyStats(res.dailyStats);
      }
    } catch (error) {
      console.error('Failed to load daily stats:', error);
    }
    setLoadingDaily(false);
  };

  // Calculate max P&L for scaling the chart
  const maxPnl = Math.max(...dailyStats.map(d => Math.abs(d.pnl)), 1);

  return (
    <div className="space-y-6">
      {/* Daily P&L Chart */}
      <div className="bg-slate-800 rounded-xl p-4">
        <h3 className="text-white font-bold mb-4">📈 Daily P&L (Last 30 Days)</h3>
        {loadingDaily ? (
          <div className="h-32 flex items-center justify-center text-gray-400">Loading...</div>
        ) : dailyStats.length === 0 ? (
          <div className="h-32 flex items-center justify-center text-gray-400">No data yet</div>
        ) : (
          <div className="flex items-end gap-1 h-32">
            {dailyStats.slice(-30).map((day, i) => {
              const height = (Math.abs(day.pnl) / maxPnl) * 100;
              const isPositive = day.pnl >= 0;
              return (
                <div 
                  key={day.date} 
                  className="flex-1 flex flex-col items-center group relative"
                  title={`${day.date}: $${day.pnl.toFixed(2)} (${day.trades} trades)`}
                >
                  {/* Tooltip */}
                  <div className="absolute bottom-full mb-2 hidden group-hover:block bg-slate-900 text-white text-xs px-2 py-1 rounded whitespace-nowrap z-10">
                    <div className="font-bold">{day.date}</div>
                    <div className={isPositive ? 'text-green-400' : 'text-red-400'}>
                      {isPositive ? '+' : ''}${day.pnl.toFixed(2)}
                    </div>
                    <div className="text-gray-400">{day.trades} trades ({day.wins}W/{day.losses}L)</div>
                  </div>
                  {/* Bar */}
                  <div 
                    className={`w-full rounded-t transition-all ${
                      day.trades === 0 ? 'bg-slate-700' :
                      isPositive ? 'bg-green-500 hover:bg-green-400' : 'bg-red-500 hover:bg-red-400'
                    }`}
                    style={{ 
                      height: day.trades === 0 ? '2px' : `${Math.max(height, 4)}%`,
                    }}
                  />
                </div>
              );
            })}
          </div>
        )}
        {/* X-axis labels */}
        <div className="flex justify-between mt-2 text-xs text-gray-500">
          <span>{dailyStats[0]?.date || ''}</span>
          <span>{dailyStats[dailyStats.length - 1]?.date || ''}</span>
        </div>
      </div>

      {/* Overview Cards */}
      <div className="grid grid-cols-4 gap-4">
        <StatCard 
          label="Total Trades" 
          value={stats.overview.totalTrades.toString()}
          subValue={`${stats.overview.winningTrades}W / ${stats.overview.losingTrades}L`}
        />
        <StatCard 
          label="Win Rate" 
          value={`${stats.overview.winRate}%`}
          positive={stats.overview.winRate > 50}
          subValue={`Profit Factor: ${stats.overview.profitFactor}`}
        />
        <StatCard 
          label="Total P&L" 
          value={`$${stats.pnl.totalPnl.toFixed(2)}`}
          positive={stats.pnl.totalPnl > 0}
          subValue={`Avg: $${stats.pnl.avgPnl.toFixed(2)}`}
        />
        <StatCard 
          label="Total R" 
          value={`${stats.pnl.totalR > 0 ? '+' : ''}${stats.pnl.totalR.toFixed(2)}R`}
          positive={stats.pnl.totalR > 0}
          subValue={`Avg: ${stats.pnl.avgR.toFixed(2)}R`}
        />
      </div>

      {/* Secondary Stats */}
      <div className="grid grid-cols-3 gap-4">
        <div className="bg-slate-800 rounded-xl p-4">
          <h3 className="text-gray-400 text-sm mb-3">Win Streaks</h3>
          <div className="flex justify-between">
            <div>
              <span className="text-green-400 text-2xl font-bold">{stats.streaks.maxConsecutiveWins}</span>
              <span className="text-gray-400 text-sm ml-2">Best</span>
            </div>
            <div>
              <span className="text-red-400 text-2xl font-bold">{stats.streaks.maxConsecutiveLosses}</span>
              <span className="text-gray-400 text-sm ml-2">Worst</span>
            </div>
          </div>
        </div>

        <div className="bg-slate-800 rounded-xl p-4">
          <h3 className="text-gray-400 text-sm mb-3">Avg Duration</h3>
          <div className="text-2xl font-bold text-white">{stats.timing.avgDurationFormatted}</div>
        </div>

        <div className="bg-slate-800 rounded-xl p-4">
          <h3 className="text-gray-400 text-sm mb-3">Fees Paid</h3>
          <div className="text-2xl font-bold text-amber-400">${stats.pnl.totalFees.toFixed(2)}</div>
        </div>
      </div>

      {/* By Side */}
      <div className="bg-slate-800 rounded-xl p-4">
        <h3 className="text-white font-bold mb-4">📊 By Side</h3>
        <div className="grid grid-cols-2 gap-4">
          <div className="bg-slate-900 rounded-lg p-4">
            <div className="flex items-center gap-2 mb-2">
              <TrendingUp className="text-green-400" size={20} />
              <span className="text-green-400 font-bold">LONGS</span>
            </div>
            <div className="space-y-2 text-sm">
              <div className="flex justify-between">
                <span className="text-gray-400">Trades</span>
                <span className="text-white">{stats.bySide.longs.count}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-400">Win Rate</span>
                <span className={stats.bySide.longs.winRate > 50 ? 'text-green-400' : 'text-red-400'}>
                  {stats.bySide.longs.winRate}%
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-400">P&L</span>
                <span className={stats.bySide.longs.pnl > 0 ? 'text-green-400' : 'text-red-400'}>
                  ${stats.bySide.longs.pnl.toFixed(2)}
                </span>
              </div>
            </div>
          </div>
          <div className="bg-slate-900 rounded-lg p-4">
            <div className="flex items-center gap-2 mb-2">
              <TrendingDown className="text-red-400" size={20} />
              <span className="text-red-400 font-bold">SHORTS</span>
            </div>
            <div className="space-y-2 text-sm">
              <div className="flex justify-between">
                <span className="text-gray-400">Trades</span>
                <span className="text-white">{stats.bySide.shorts.count}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-400">Win Rate</span>
                <span className={stats.bySide.shorts.winRate > 50 ? 'text-green-400' : 'text-red-400'}>
                  {stats.bySide.shorts.winRate}%
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-400">P&L</span>
                <span className={stats.bySide.shorts.pnl > 0 ? 'text-green-400' : 'text-red-400'}>
                  ${stats.bySide.shorts.pnl.toFixed(2)}
                </span>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* By Strategy */}
      <div className="bg-slate-800 rounded-xl p-4">
        <h3 className="text-white font-bold mb-4">🎯 By Strategy</h3>
        <div className="space-y-3">
          {Object.entries(stats.byStrategy).map(([stratId, data]) => (
            <div key={stratId} className="flex items-center justify-between bg-slate-900 rounded-lg p-3">
              <div className="flex items-center gap-3">
                <span className={`px-2 py-1 rounded text-sm ${
                  stratId === 'S101' ? 'bg-green-500/20 text-green-400' :
                  stratId === 'S102' ? 'bg-blue-500/20 text-blue-400' :
                  'bg-amber-500/20 text-amber-400'
                }`}>{stratId}</span>
                <span className="text-gray-400">{data.trades} trades</span>
              </div>
              <div className="flex items-center gap-6">
                <span className={data.winRate > 50 ? 'text-green-400' : 'text-red-400'}>
                  {data.winRate.toFixed(1)}% WR
                </span>
                <span className={data.pnl > 0 ? 'text-green-400' : 'text-red-400'}>
                  ${data.pnl.toFixed(2)}
                </span>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Exit Reasons */}
      <div className="bg-slate-800 rounded-xl p-4">
        <h3 className="text-white font-bold mb-4">🚪 Exit Reasons</h3>
        <div className="grid grid-cols-4 gap-4">
          {Object.entries(stats.byExitReason).map(([reason, count]) => (
            <div key={reason} className="bg-slate-900 rounded-lg p-3 text-center">
              <div className="text-2xl font-bold text-white">{count}</div>
              <div className="text-xs text-gray-400 mt-1">{reason.replace(/_/g, ' ')}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function StatCard({ 
  label, 
  value, 
  subValue, 
  positive 
}: { 
  label: string; 
  value: string; 
  subValue?: string;
  positive?: boolean;
}) {
  return (
    <div className="bg-slate-800 rounded-xl p-4">
      <div className="text-gray-400 text-sm mb-1">{label}</div>
      <div className={`text-2xl font-bold ${
        positive === undefined ? 'text-white' : positive ? 'text-green-400' : 'text-red-400'
      }`}>{value}</div>
      {subValue && <div className="text-sm text-gray-500 mt-1">{subValue}</div>}
    </div>
  );
}
