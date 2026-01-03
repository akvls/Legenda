import { useState } from 'react'
import ChatPanel from '../components/ChatPanel'
import PositionCard from '../components/PositionCard'
import PendingOrdersCard from '../components/PendingOrdersCard'
import StrategyPanel from '../components/StrategyPanel'
import WalletCard from '../components/WalletCard'
import { WatchPanel } from '../components/WatchPanel'
import TrackingTable from '../components/TrackingTable'

export default function Dashboard() {
  const [symbolInput, setSymbolInput] = useState('BTCUSDT')
  const [activeSymbol, setActiveSymbol] = useState('BTCUSDT')

  const handleSymbolSubmit = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      const symbol = symbolInput.toUpperCase().trim()
      if (symbol) {
        setActiveSymbol(symbol)
      }
    }
  }

  return (
    <div className="h-full flex">
      {/* Left Column - Chat (wider for big screens) */}
      <div className="w-[500px] xl:w-[600px] 2xl:w-[700px] h-full p-4 border-r border-dark-700">
        <ChatPanel />
      </div>

      {/* Right Column - Info Panels */}
      <div className="flex-1 h-full overflow-y-auto p-6">
        <div className="max-w-3xl mx-auto space-y-6">
          {/* Wallet */}
          <WalletCard />

          {/* Position */}
          <div>
            <h3 className="text-sm font-medium text-zinc-400 uppercase tracking-wider mb-3">
              Open Positions
            </h3>
            <PositionCard />
          </div>

          {/* Pending Limit Orders */}
          <div>
            <h3 className="text-sm font-medium text-zinc-400 uppercase tracking-wider mb-3">
              Pending Limit Orders
            </h3>
            <PendingOrdersCard />
          </div>

          {/* Watch List */}
          <div>
            <h3 className="text-sm font-medium text-zinc-400 uppercase tracking-wider mb-3">
              Active Watches
            </h3>
            <WatchPanel />
          </div>

          {/* Tracked Coins Table */}
          <div>
            <h3 className="text-sm font-medium text-zinc-400 uppercase tracking-wider mb-3">
              Tracked Coins
            </h3>
            <TrackingTable onSymbolClick={(symbol) => {
              setSymbolInput(symbol)
              setActiveSymbol(symbol)
            }} />
          </div>

          {/* Strategy State */}
          <div>
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-sm font-medium text-zinc-400 uppercase tracking-wider">
                Market Analysis
              </h3>
              <input
                type="text"
                value={symbolInput}
                onChange={e => setSymbolInput(e.target.value.toUpperCase())}
                onKeyDown={handleSymbolSubmit}
                placeholder="BTCUSDT"
                className="w-28 bg-dark-700 border border-dark-500 rounded-lg px-2 py-1 text-sm text-zinc-200 mono text-center focus:outline-none focus:border-accent-blue/50"
              />
            </div>
            <StrategyPanel symbol={activeSymbol} />
          </div>
        </div>
      </div>
    </div>
  )
}

