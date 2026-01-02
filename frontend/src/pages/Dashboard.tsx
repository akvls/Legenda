import ChatPanel from '../components/ChatPanel'
import PositionCard from '../components/PositionCard'
import StrategyPanel from '../components/StrategyPanel'
import WalletCard from '../components/WalletCard'
import { WatchPanel } from '../components/WatchPanel'

export default function Dashboard() {
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

          {/* Watch List */}
          <div>
            <h3 className="text-sm font-medium text-zinc-400 uppercase tracking-wider mb-3">
              Active Watches
            </h3>
            <WatchPanel />
          </div>

          {/* Strategy State */}
          <div>
            <h3 className="text-sm font-medium text-zinc-400 uppercase tracking-wider mb-3">
              Market Analysis
            </h3>
            <StrategyPanel symbol="BTCUSDT" />
          </div>
        </div>
      </div>
    </div>
  )
}

