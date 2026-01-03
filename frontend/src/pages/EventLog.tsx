import React, { useState, useEffect } from 'react';
import { 
  Activity,
  Filter,
  RefreshCw,
  ChevronDown,
  ChevronUp,
  AlertCircle,
  CheckCircle,
  XCircle,
  Eye,
  TrendingUp,
  TrendingDown,
  Bell,
  Shield,
  Zap,
} from 'lucide-react';
import { journal } from '../api/client';

interface Event {
  id: string;
  symbol: string | null;
  tradeId: string | null;
  eventType: string;
  payload: any;
  message: string | null;
  timestamp: string;
}

interface EventType {
  type: string;
  count: number;
}

export default function EventLog() {
  const [events, setEvents] = useState<Event[]>([]);
  const [eventTypes, setEventTypes] = useState<EventType[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedEvent, setExpandedEvent] = useState<string | null>(null);
  const [filters, setFilters] = useState({
    eventType: '',
    symbol: '',
  });
  const [showFilters, setShowFilters] = useState(false);

  useEffect(() => {
    loadEvents();
    loadEventTypes();
  }, [filters]);

  const loadEvents = async () => {
    setLoading(true);
    try {
      const res = await journal.getEvents({
        eventType: filters.eventType || undefined,
        symbol: filters.symbol || undefined,
        limit: 200,
      });
      if (res.success) setEvents(res.events);
    } catch (error) {
      console.error('Failed to load events:', error);
    }
    setLoading(false);
  };

  const loadEventTypes = async () => {
    try {
      const res = await journal.getEventTypes();
      if (res.success) setEventTypes(res.types);
    } catch (error) {
      console.error('Failed to load event types:', error);
    }
  };

  const getEventIcon = (type: string) => {
    if (type.includes('ENTRY') && type.includes('PLACED')) return <TrendingUp className="text-green-400" size={18} />;
    if (type.includes('ENTRY') && type.includes('BLOCKED')) return <XCircle className="text-red-400" size={18} />;
    if (type.includes('EXIT')) return <TrendingDown className="text-amber-400" size={18} />;
    if (type.includes('SL') || type.includes('STOP')) return <Shield className="text-red-400" size={18} />;
    if (type.includes('TP') || type.includes('PROFIT')) return <CheckCircle className="text-green-400" size={18} />;
    if (type.includes('WATCH') || type.includes('TRIGGER')) return <Eye className="text-violet-400" size={18} />;
    if (type.includes('NOTIFY') || type.includes('ALERT')) return <Bell className="text-blue-400" size={18} />;
    if (type.includes('LEVERAGE') || type.includes('CLAMP')) return <AlertCircle className="text-amber-400" size={18} />;
    if (type.includes('BIAS') || type.includes('FLIP')) return <Zap className="text-cyan-400" size={18} />;
    return <Activity className="text-gray-400" size={18} />;
  };

  const getEventColor = (type: string): string => {
    if (type.includes('BLOCKED') || type.includes('ERROR') || type.includes('FAIL')) return 'border-red-500/50';
    if (type.includes('PLACED') || type.includes('SUCCESS') || type.includes('PROFIT')) return 'border-green-500/50';
    if (type.includes('EXIT') || type.includes('CLOSE')) return 'border-amber-500/50';
    if (type.includes('WATCH') || type.includes('TRIGGER')) return 'border-violet-500/50';
    if (type.includes('CLAMP') || type.includes('WARNING')) return 'border-amber-500/50';
    return 'border-slate-600';
  };

  const formatTime = (timestamp: string): string => {
    const d = new Date(timestamp);
    return d.toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  };

  const formatEventType = (type: string): string => {
    return type.replace(/_/g, ' ');
  };

  return (
    <div className="p-6 max-w-6xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-3xl font-bold text-white flex items-center gap-3">
          <Activity className="text-violet-400" />
          Event Log
        </h1>
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
            onClick={loadEvents}
            className="flex items-center gap-2 px-4 py-2 bg-slate-700 text-gray-300 rounded-lg hover:bg-slate-600 transition-colors"
          >
            <RefreshCw size={18} />
            Refresh
          </button>
        </div>
      </div>

      {/* Event Type Summary */}
      <div className="flex gap-2 flex-wrap mb-6">
        {eventTypes.slice(0, 8).map((et) => (
          <button
            key={et.type}
            onClick={() => setFilters({ ...filters, eventType: filters.eventType === et.type ? '' : et.type })}
            className={`px-3 py-1 rounded-full text-sm transition-colors ${
              filters.eventType === et.type
                ? 'bg-violet-600 text-white'
                : 'bg-slate-800 text-gray-400 hover:bg-slate-700'
            }`}
          >
            {formatEventType(et.type)} ({et.count})
          </button>
        ))}
      </div>

      {/* Filters */}
      {showFilters && (
        <div className="bg-slate-800 rounded-xl p-4 mb-6 flex gap-4 items-center flex-wrap">
          <select
            value={filters.eventType}
            onChange={(e) => setFilters({ ...filters, eventType: e.target.value })}
            className="bg-slate-700 text-white px-4 py-2 rounded-lg border border-slate-600"
          >
            <option value="">All Event Types</option>
            {eventTypes.map((et) => (
              <option key={et.type} value={et.type}>
                {formatEventType(et.type)} ({et.count})
              </option>
            ))}
          </select>
          <select
            value={filters.symbol}
            onChange={(e) => setFilters({ ...filters, symbol: e.target.value })}
            className="bg-slate-700 text-white px-4 py-2 rounded-lg border border-slate-600"
          >
            <option value="">All Symbols</option>
            <option value="BTCUSDT">BTCUSDT</option>
            <option value="ETHUSDT">ETHUSDT</option>
          </select>
          {(filters.eventType || filters.symbol) && (
            <button
              onClick={() => setFilters({ eventType: '', symbol: '' })}
              className="text-gray-400 hover:text-white"
            >
              Clear
            </button>
          )}
        </div>
      )}

      {/* Events Timeline */}
      {loading ? (
        <div className="text-center text-gray-400 py-12">Loading events...</div>
      ) : events.length === 0 ? (
        <div className="bg-slate-800 rounded-xl p-12 text-center">
          <Activity size={48} className="text-gray-600 mx-auto mb-4" />
          <p className="text-gray-400 text-lg">No events recorded yet</p>
          <p className="text-gray-500 mt-2">Events will appear here as you trade</p>
        </div>
      ) : (
        <div className="space-y-2">
          {events.map((event, index) => (
            <div
              key={event.id}
              className={`bg-slate-800 rounded-lg border-l-4 ${getEventColor(event.eventType)} overflow-hidden`}
            >
              {/* Event Header */}
              <div
                className="p-4 cursor-pointer hover:bg-slate-700/50 transition-colors"
                onClick={() => setExpandedEvent(expandedEvent === event.id ? null : event.id)}
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-4">
                    {getEventIcon(event.eventType)}
                    <div>
                      <span className="text-white font-medium">
                        {formatEventType(event.eventType)}
                      </span>
                      {event.symbol && (
                        <span className="ml-3 px-2 py-0.5 bg-slate-700 text-gray-300 rounded text-sm">
                          {event.symbol}
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-4">
                    <span className="text-gray-400 text-sm">{formatTime(event.timestamp)}</span>
                    {expandedEvent === event.id ? (
                      <ChevronUp size={18} className="text-gray-400" />
                    ) : (
                      <ChevronDown size={18} className="text-gray-400" />
                    )}
                  </div>
                </div>
                {event.message && (
                  <p className="text-gray-400 text-sm mt-2 ml-8">{event.message}</p>
                )}
              </div>

              {/* Expanded Details */}
              {expandedEvent === event.id && event.payload && (
                <div className="border-t border-slate-700 p-4 bg-slate-900">
                  <h4 className="text-gray-400 text-sm mb-2">Payload Details</h4>
                  <pre className="text-xs text-gray-300 bg-slate-800 p-3 rounded-lg overflow-x-auto">
                    {JSON.stringify(event.payload, null, 2)}
                  </pre>
                  {event.tradeId && (
                    <div className="mt-3">
                      <span className="text-gray-400 text-sm">Trade ID: </span>
                      <span className="text-violet-400 font-mono text-sm">{event.tradeId}</span>
                    </div>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Load More */}
      {events.length >= 200 && (
        <div className="text-center mt-6">
          <button className="px-6 py-2 bg-slate-700 text-gray-300 rounded-lg hover:bg-slate-600 transition-colors">
            Load More Events
          </button>
        </div>
      )}
    </div>
  );
}



