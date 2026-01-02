import ChatPanel from '../components/ChatPanel'
import PositionCard from '../components/PositionCard'
import StrategyPanel from '../components/StrategyPanel'
import WalletCard from '../components/WalletCard'
import { WatchPanel } from '../components/WatchPanel'

export default function Dashboard() {
  return (
    <div className="h-full flex">
      {/* Left Column - Chat */}
      <div className="w-[400px] h-full p-4 border-r border-dark-700">
        <ChatPanel />
      </div>

      {/* Right Column - Info Panels */}
      <div className="flex-1 h-full overflow-y-auto p-4">
        <div className="max-w-2xl mx-auto space-y-4">
          {/* Wallet */}
          <WalletCard />

          {/* Position */}
          <div>
            <h3 className="text-xs font-medium text-zinc-500 uppercase tracking-wider mb-2">
              Open Positions
            </h3>
            <PositionCard />
          </div>

          {/* Watch List */}
          <div>
            <h3 className="text-xs font-medium text-zinc-500 uppercase tracking-wider mb-2">
              Active Watches
            </h3>
            <WatchPanel />
          </div>

          {/* Strategy State */}
          <div>
            <h3 className="text-xs font-medium text-zinc-500 uppercase tracking-wider mb-2">
              Market Analysis
            </h3>
            <StrategyPanel symbol="BTCUSDT" />
          </div>
        </div>
      </div>
    </div>
  )
}

