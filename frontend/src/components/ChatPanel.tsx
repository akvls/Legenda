import React, { useState, useRef, useEffect } from 'react'
import { Send, Bot, User, Loader2, Trash2 } from 'lucide-react'
import { agent } from '../api/client'

interface Message {
  id: string
  role: 'user' | 'assistant'
  content: string
  timestamp: Date
  type?: string
}

/**
 * Format message with colors and bold text
 */
function formatMessage(content: string): React.ReactNode {
  // Split by lines to process each line
  const lines = content.split('\n')
  
  return (
    <div className="space-y-1">
      {lines.map((line, i) => (
        <div key={i}>{formatLine(line)}</div>
      ))}
    </div>
  )
}

function formatLine(line: string): React.ReactNode {
  // Process bold markers **text**
  const parts: React.ReactNode[] = []
  let key = 0
  
  // Pattern to match **bold** text
  const boldRegex = /\*\*([^*]+)\*\*/g
  let lastIndex = 0
  let match
  
  while ((match = boldRegex.exec(line)) !== null) {
    // Add text before the match
    if (match.index > lastIndex) {
      parts.push(
        <span key={key++}>
          {colorizeText(line.slice(lastIndex, match.index))}
        </span>
      )
    }
    // Add the bold text
    parts.push(
      <strong key={key++} className="font-bold text-white">
        {colorizeText(match[1])}
      </strong>
    )
    lastIndex = match.index + match[0].length
  }
  
  // Add remaining text
  if (lastIndex < line.length) {
    parts.push(
      <span key={key++}>
        {colorizeText(line.slice(lastIndex))}
      </span>
    )
  }
  
  if (parts.length === 0) {
    return <span>{colorizeText(line)}</span>
  }
  
  return <>{parts}</>
}

function colorizeText(text: string): React.ReactNode {
  // Color keywords
  const colorMap: Record<string, string> = {
    'ENTER': 'text-emerald-400 font-semibold',
    'WAIT': 'text-amber-400 font-semibold',
    'SKIP': 'text-red-400 font-semibold',
    'EXIT': 'text-red-400 font-semibold',
    'LONG': 'text-emerald-400 font-semibold',
    'SHORT': 'text-red-400 font-semibold',
    'HIGH': 'text-red-400 font-semibold',
    'MEDIUM': 'text-amber-400 font-semibold',
    'LOW': 'text-emerald-400 font-semibold',
    'BULLISH': 'text-emerald-400 font-semibold',
    'BEARISH': 'text-red-400 font-semibold',
    'BOS': 'text-blue-400 font-semibold',
    'CHoCH': 'text-purple-400 font-semibold',
    '✅': 'text-emerald-400',
    '❌': 'text-red-400',
    '⚠️': 'text-amber-400',
    '🎯': 'text-blue-400',
    '💰': 'text-amber-400',
    '📊': 'text-blue-400',
    '💡': 'text-yellow-400',
  }
  
  // Build regex from keywords
  const keywords = Object.keys(colorMap).map(k => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  const regex = new RegExp(`(${keywords.join('|')})`, 'g')
  
  const parts = text.split(regex)
  
  return (
    <>
      {parts.map((part, i) => {
        const colorClass = colorMap[part]
        if (colorClass) {
          return <span key={i} className={colorClass}>{part}</span>
        }
        return <span key={i}>{part}</span>
      })}
    </>
  )
}

export default function ChatPanel() {
  const [messages, setMessages] = useState<Message[]>([])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [historyLoaded, setHistoryLoaded] = useState(false)
  const messagesEndRef = useRef<HTMLDivElement>(null)

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }

  // Load chat history on mount
  useEffect(() => {
    const loadHistory = async () => {
      try {
        const response = await agent.chatHistory()
        if (response.success && response.messages.length > 0) {
          const loadedMessages: Message[] = response.messages.map((m, i) => ({
            id: `history-${i}`,
            role: m.role,
            content: m.content,
            timestamp: new Date(m.timestamp),
          }))
          setMessages(loadedMessages)
        }
      } catch (error) {
        console.error('Failed to load chat history:', error)
      } finally {
        setHistoryLoaded(true)
      }
    }
    loadHistory()
  }, [])

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

  const clearChat = async () => {
    try {
      await agent.clearChat()
      setMessages([])
    } catch (error) {
      console.error('Failed to clear chat:', error)
    }
  }

  return (
    <div className="h-full flex flex-col bg-dark-800 rounded-xl border border-dark-600">
      {/* Header */}
      <div className="px-6 py-4 border-b border-dark-600 flex justify-between items-start">
        <div>
          <h2 className="text-lg font-semibold text-zinc-200">🎯 Legenda Command Center</h2>
          <p className="text-sm text-zinc-400 mt-1">Type commands like "long BTC" or ask for advice</p>
        </div>
        {messages.length > 0 && (
          <button
            onClick={clearChat}
            className="p-2 hover:bg-dark-600 rounded-lg transition-colors text-zinc-500 hover:text-red-400"
            title="Clear chat (archives to memory)"
          >
            <Trash2 size={18} />
          </button>
        )}
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto p-6 space-y-4">
        {!historyLoaded && (
          <div className="text-center text-zinc-500 text-base py-12">
            <Loader2 size={32} className="mx-auto mb-3 animate-spin opacity-50" />
            <p>Loading chat history...</p>
          </div>
        )}
        
        {historyLoaded && messages.length === 0 && (
          <div className="text-center text-zinc-500 text-base py-12">
            <Bot size={48} className="mx-auto mb-3 opacity-50" />
            <p className="text-lg">Start by typing a command</p>
            <p className="text-sm mt-2 text-zinc-600">Try: "long BTCUSDT" or "what's your opinion on BTC?"</p>
          </div>
        )}

        {messages.map(msg => (
          <div
            key={msg.id}
            className={`flex gap-4 ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
          >
            {msg.role === 'assistant' && (
              <div className="w-10 h-10 rounded-xl bg-dark-600 flex items-center justify-center flex-shrink-0">
                <Bot size={20} className="text-accent-blue" />
              </div>
            )}
            
            <div
              className={`
                max-w-[85%] px-5 py-4 rounded-2xl text-[15px] leading-relaxed
                ${msg.role === 'user' 
                  ? 'bg-accent-blue/20 text-zinc-100' 
                  : `bg-dark-700/80 text-zinc-300 border-l-4 ${getMessageStyle(msg.type)}`
                }
              `}
            >
              {msg.role === 'assistant' 
                ? formatMessage(msg.content)
                : <span>{msg.content}</span>
              }
              <span className="text-xs text-zinc-600 mt-3 block">
                {msg.timestamp.toLocaleTimeString()}
              </span>
            </div>

            {msg.role === 'user' && (
              <div className="w-10 h-10 rounded-xl bg-accent-blue/20 flex items-center justify-center flex-shrink-0">
                <User size={20} className="text-accent-blue" />
              </div>
            )}
          </div>
        ))}

        {loading && (
          <div className="flex gap-4">
            <div className="w-10 h-10 rounded-xl bg-dark-600 flex items-center justify-center">
              <Loader2 size={20} className="text-accent-blue animate-spin" />
            </div>
            <div className="bg-dark-700 px-5 py-3 rounded-2xl">
              <span className="text-zinc-400 text-base">Thinking...</span>
            </div>
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* Input */}
      <div className="p-4 border-t border-dark-600">
        <div className="flex gap-3">
          <input
            type="text"
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Type a command or ask Legenda..."
            className="
              flex-1 bg-dark-700 border border-dark-500 rounded-xl px-5 py-3
              text-base text-zinc-100 placeholder-zinc-500
              focus:outline-none focus:border-accent-blue/50
              transition-colors
            "
          />
          <button
            onClick={sendMessage}
            disabled={!input.trim() || loading}
            className="
              w-14 h-14 rounded-xl bg-accent-blue flex items-center justify-center
              hover:bg-accent-blue/80 disabled:opacity-50 disabled:cursor-not-allowed
              transition-all
            "
          >
            <Send size={22} className="text-white" />
          </button>
        </div>
      </div>
    </div>
  )
}

