import { 
  LayoutDashboard, 
  BookOpen, 
  Settings, 
  Activity,
  Zap
} from 'lucide-react'

type Page = 'dashboard' | 'journal' | 'settings'

interface SidebarProps {
  currentPage: Page
  onPageChange: (page: Page) => void
  connected: boolean
}

export default function Sidebar({ currentPage, onPageChange, connected }: SidebarProps) {
  const navItems = [
    { id: 'dashboard' as Page, icon: LayoutDashboard, label: 'Dashboard' },
    { id: 'journal' as Page, icon: BookOpen, label: 'Journal' },
    { id: 'settings' as Page, icon: Settings, label: 'Settings' },
  ]

  return (
    <aside className="w-16 bg-dark-800 border-r border-dark-600 flex flex-col items-center py-4">
      {/* Logo */}
      <div className="mb-8">
        <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-accent-blue to-accent-green flex items-center justify-center">
          <Zap size={20} className="text-white" />
        </div>
      </div>

      {/* Navigation */}
      <nav className="flex-1 flex flex-col gap-2">
        {navItems.map(item => (
          <button
            key={item.id}
            onClick={() => onPageChange(item.id)}
            className={`
              w-10 h-10 rounded-xl flex items-center justify-center
              transition-all duration-200 group relative
              ${currentPage === item.id 
                ? 'bg-dark-600 text-white' 
                : 'text-zinc-500 hover:text-zinc-300 hover:bg-dark-700'
              }
            `}
            title={item.label}
          >
            <item.icon size={20} />
            
            {/* Tooltip */}
            <span className="
              absolute left-14 px-2 py-1 rounded-md bg-dark-600 text-xs text-white
              opacity-0 group-hover:opacity-100 pointer-events-none whitespace-nowrap
              transition-opacity duration-200
            ">
              {item.label}
            </span>
          </button>
        ))}
      </nav>

      {/* Connection Status */}
      <div className="mt-auto pt-4">
        <div 
          className={`
            w-10 h-10 rounded-xl flex items-center justify-center
            ${connected ? 'text-accent-green' : 'text-accent-red'}
          `}
          title={connected ? 'Connected' : 'Disconnected'}
        >
          <Activity size={18} />
        </div>
      </div>
    </aside>
  )
}

