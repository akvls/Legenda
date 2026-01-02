import { useState, useEffect } from 'react'
import { Save, RefreshCw, Shield, Gauge, Bell, Brain } from 'lucide-react'

interface Settings {
  defaultRiskPercent: number
  defaultLeverage: number
  maxLeverage: number
  circuitBreakerThreshold: number
  supertrendPeriod: number
  supertrendMult: number
  llmEnabled: boolean
}

export default function Settings() {
  const [settings, setSettings] = useState<Settings>({
    defaultRiskPercent: 1,
    defaultLeverage: 5,
    maxLeverage: 10,
    circuitBreakerThreshold: 50,
    supertrendPeriod: 5,
    supertrendMult: 8,
    llmEnabled: true,
  })
  const [saved, setSaved] = useState(false)

  const handleChange = (key: keyof Settings, value: number | boolean) => {
    setSettings(prev => ({ ...prev, [key]: value }))
    setSaved(false)
  }

  const handleSave = async () => {
    // In real app, save to backend
    setSaved(true)
    setTimeout(() => setSaved(false), 2000)
  }

  return (
    <div className="h-full overflow-y-auto p-6">
      <div className="max-w-2xl mx-auto">
        {/* Header */}
        <div className="mb-8">
          <h1 className="text-xl font-semibold text-zinc-100">Settings</h1>
          <p className="text-sm text-zinc-500">Configure your trading parameters</p>
        </div>

        {/* Risk Management */}
        <SettingsSection 
          icon={Shield} 
          title="Risk Management"
          description="Control your exposure and protect your capital"
        >
          <SettingsRow label="Default Risk %" description="Risk per trade">
            <NumberInput 
              value={settings.defaultRiskPercent}
              onChange={v => handleChange('defaultRiskPercent', v)}
              min={0.1}
              max={10}
              step={0.1}
              suffix="%"
            />
          </SettingsRow>

          <SettingsRow label="Default Leverage" description="Starting leverage for trades">
            <NumberInput 
              value={settings.defaultLeverage}
              onChange={v => handleChange('defaultLeverage', v)}
              min={1}
              max={10}
              step={1}
              suffix="x"
            />
          </SettingsRow>

          <SettingsRow label="Max Leverage" description="Hard cap on leverage (cannot exceed)">
            <div className="flex items-center gap-2">
              <span className="text-zinc-300 mono">10x</span>
              <span className="text-xs text-zinc-500">(Fixed)</span>
            </div>
          </SettingsRow>

          <SettingsRow label="Circuit Breaker" description="Daily loss % that triggers 24hr lockout">
            <NumberInput 
              value={settings.circuitBreakerThreshold}
              onChange={v => handleChange('circuitBreakerThreshold', v)}
              min={10}
              max={100}
              step={5}
              suffix="%"
            />
          </SettingsRow>
        </SettingsSection>

        {/* Strategy Parameters */}
        <SettingsSection 
          icon={Gauge} 
          title="Strategy Parameters"
          description="Indicator settings for strategy engine"
        >
          <SettingsRow label="Supertrend Period" description="ATR lookback period">
            <NumberInput 
              value={settings.supertrendPeriod}
              onChange={v => handleChange('supertrendPeriod', v)}
              min={1}
              max={50}
              step={1}
            />
          </SettingsRow>

          <SettingsRow label="Supertrend Multiplier" description="ATR multiplier">
            <NumberInput 
              value={settings.supertrendMult}
              onChange={v => handleChange('supertrendMult', v)}
              min={1}
              max={20}
              step={0.5}
            />
          </SettingsRow>
        </SettingsSection>

        {/* AI Settings */}
        <SettingsSection 
          icon={Brain} 
          title="AI Assistant"
          description="LLM-powered trading insights"
        >
          <SettingsRow label="Enable LLM" description="Use AI for command parsing and opinions">
            <Toggle 
              enabled={settings.llmEnabled}
              onChange={v => handleChange('llmEnabled', v)}
            />
          </SettingsRow>
        </SettingsSection>

        {/* Save Button */}
        <div className="mt-8 flex justify-end">
          <button
            onClick={handleSave}
            className={`
              flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium
              transition-all
              ${saved 
                ? 'bg-accent-green text-white' 
                : 'bg-accent-blue hover:bg-accent-blue/80 text-white'
              }
            `}
          >
            {saved ? (
              <>
                <RefreshCw size={16} className="animate-spin" />
                Saved!
              </>
            ) : (
              <>
                <Save size={16} />
                Save Changes
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  )
}

function SettingsSection({ 
  icon: Icon, 
  title, 
  description, 
  children 
}: { 
  icon: React.ElementType
  title: string
  description: string
  children: React.ReactNode 
}) {
  return (
    <div className="mb-8">
      <div className="flex items-center gap-3 mb-4">
        <div className="w-8 h-8 rounded-lg bg-dark-700 flex items-center justify-center">
          <Icon size={16} className="text-accent-blue" />
        </div>
        <div>
          <h2 className="text-sm font-medium text-zinc-200">{title}</h2>
          <p className="text-xs text-zinc-500">{description}</p>
        </div>
      </div>
      <div className="bg-dark-800 rounded-xl border border-dark-600 divide-y divide-dark-600">
        {children}
      </div>
    </div>
  )
}

function SettingsRow({ 
  label, 
  description, 
  children 
}: { 
  label: string
  description: string
  children: React.ReactNode 
}) {
  return (
    <div className="flex items-center justify-between px-4 py-3">
      <div>
        <div className="text-sm text-zinc-300">{label}</div>
        <div className="text-xs text-zinc-500">{description}</div>
      </div>
      {children}
    </div>
  )
}

function NumberInput({ 
  value, 
  onChange, 
  min, 
  max, 
  step, 
  suffix 
}: { 
  value: number
  onChange: (v: number) => void
  min: number
  max: number
  step: number
  suffix?: string
}) {
  return (
    <div className="flex items-center gap-1">
      <input
        type="number"
        value={value}
        onChange={e => onChange(parseFloat(e.target.value))}
        min={min}
        max={max}
        step={step}
        className="
          w-20 bg-dark-700 border border-dark-500 rounded-lg px-2 py-1
          text-sm text-zinc-200 text-right mono
          focus:outline-none focus:border-accent-blue/50
        "
      />
      {suffix && <span className="text-xs text-zinc-500">{suffix}</span>}
    </div>
  )
}

function Toggle({ enabled, onChange }: { enabled: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      onClick={() => onChange(!enabled)}
      className={`
        w-11 h-6 rounded-full transition-colors
        ${enabled ? 'bg-accent-blue' : 'bg-dark-600'}
      `}
    >
      <div className={`
        w-5 h-5 rounded-full bg-white shadow-sm transition-transform
        ${enabled ? 'translate-x-5' : 'translate-x-0.5'}
      `} />
    </button>
  )
}

