import { useState, useRef, useEffect } from 'react'
import { Send, Bot, User, Loader2 } from 'lucide-react'
import { agent } from '../api/client'

interface Message {
  id: string
  role: 'user' | 'assistant'
  content: string
  timestamp: Date
  type?: string
}

export default function ChatPanel() {
  const [messages, setMessages] = useState<Message[]>([])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const messagesEndRef = useRef<HTMLDivElement>(null)

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }

  useEffect(() => {
    scrollToBottom()
  }, [messages])

  const sendMessage = async () => {
    if (!input.trim() || loading) return

    const userMessage: Message = {
      id: Date.now().toString(),
      role: 'user',
      content: input,
      timestamp: new Date(),
    }

    setMessages(prev => [...prev, userMessage])
    setInput('')
    setLoading(true)

    try {
      const response = await agent.chat(input)
      
      const assistantMessage: Message = {
        id: (Date.now() + 1).toString(),
        role: 'assistant',
        content: response.message,
        timestamp: new Date(),
        type: response.type,
      }

      setMessages(prev => [...prev, assistantMessage])
    } catch (error) {
      const errorMessage: Message = {
        id: (Date.now() + 1).toString(),
        role: 'assistant',
        content: '❌ Failed to connect to server',
        timestamp: new Date(),
        type: 'error',
      }
      setMessages(prev => [...prev, errorMessage])
    }

    setLoading(false)
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      sendMessage()
    }
  }

  const getMessageStyle = (type?: string) => {
    switch (type) {
      case 'success': return 'border-l-accent-green'
      case 'error': return 'border-l-accent-red'
      case 'warning': return 'border-l-accent-amber'
      default: return 'border-l-accent-blue'
    }
  }

  return (
    <div className="h-full flex flex-col bg-dark-800 rounded-xl border border-dark-600">
      {/* Header */}
      <div className="px-4 py-3 border-b border-dark-600">
        <h2 className="text-sm font-medium text-zinc-300">Command Center</h2>
        <p className="text-xs text-zinc-500">Type commands like "long BTC 1%" or ask questions</p>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto p-4 space-y-3">
        {messages.length === 0 && (
          <div className="text-center text-zinc-500 text-sm py-8">
            <Bot size={32} className="mx-auto mb-2 opacity-50" />
            <p>Start by typing a command</p>
            <p className="text-xs mt-1">Try: "long BTCUSDT 1%" or "what's the market bias?"</p>
          </div>
        )}

        {messages.map(msg => (
          <div
            key={msg.id}
            className={`flex gap-3 ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
          >
            {msg.role === 'assistant' && (
              <div className="w-7 h-7 rounded-lg bg-dark-600 flex items-center justify-center flex-shrink-0">
                <Bot size={14} className="text-accent-blue" />
              </div>
            )}
            
            <div
              className={`
                max-w-[85%] px-3 py-2 rounded-xl text-sm
                ${msg.role === 'user' 
                  ? 'bg-accent-blue/20 text-zinc-200' 
                  : `bg-dark-700 text-zinc-300 border-l-2 ${getMessageStyle(msg.type)}`
                }
              `}
            >
              <pre className="whitespace-pre-wrap font-sans">{msg.content}</pre>
              <span className="text-[10px] text-zinc-500 mt-1 block">
                {msg.timestamp.toLocaleTimeString()}
              </span>
            </div>

            {msg.role === 'user' && (
              <div className="w-7 h-7 rounded-lg bg-accent-blue/20 flex items-center justify-center flex-shrink-0">
                <User size={14} className="text-accent-blue" />
              </div>
            )}
          </div>
        ))}

        {loading && (
          <div className="flex gap-3">
            <div className="w-7 h-7 rounded-lg bg-dark-600 flex items-center justify-center">
              <Loader2 size={14} className="text-accent-blue animate-spin" />
            </div>
            <div className="bg-dark-700 px-3 py-2 rounded-xl">
              <span className="text-zinc-400 text-sm">Thinking...</span>
            </div>
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* Input */}
      <div className="p-3 border-t border-dark-600">
        <div className="flex gap-2">
          <input
            type="text"
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Type a command..."
            className="
              flex-1 bg-dark-700 border border-dark-500 rounded-lg px-3 py-2
              text-sm text-zinc-200 placeholder-zinc-500
              focus:outline-none focus:border-accent-blue/50
              transition-colors
            "
          />
          <button
            onClick={sendMessage}
            disabled={!input.trim() || loading}
            className="
              w-10 h-10 rounded-lg bg-accent-blue flex items-center justify-center
              hover:bg-accent-blue/80 disabled:opacity-50 disabled:cursor-not-allowed
              transition-all
            "
          >
            <Send size={16} className="text-white" />
          </button>
        </div>
      </div>
    </div>
  )
}

