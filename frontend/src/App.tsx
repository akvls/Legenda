import { useState, useEffect } from 'react'
import Sidebar from './components/Sidebar'
import Dashboard from './pages/Dashboard'
import Journal from './pages/Journal'
import Settings from './pages/Settings'

type Page = 'dashboard' | 'journal' | 'settings'

function App() {
  const [currentPage, setCurrentPage] = useState<Page>('dashboard')
  const [connected, setConnected] = useState(false)

  useEffect(() => {
    // Check API connection
    fetch('http://localhost:3001/api/health')
      .then(res => res.json())
      .then(data => setConnected(data.status === 'ok'))
      .catch(() => setConnected(false))
  }, [])

  return (
    <div className="flex h-screen bg-dark-900">
      {/* Sidebar */}
      <Sidebar 
        currentPage={currentPage} 
        onPageChange={setCurrentPage}
        connected={connected}
      />
      
      {/* Main Content */}
      <main className="flex-1 overflow-hidden">
        {currentPage === 'dashboard' && <Dashboard />}
        {currentPage === 'journal' && <Journal />}
        {currentPage === 'settings' && <Settings />}
      </main>
    </div>
  )
}

export default App

