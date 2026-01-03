import { useState, useEffect } from 'react'
import { Save, RefreshCw, Shield, Gauge, Brain, AlertCircle, Check } from 'lucide-react'
import { settings as settingsApi, type SettingsData, type SymbolConfig } from '../api/client'

interface LocalSettings {
  defaultRiskPercent: number
  defaultLeverage: number
  maxLeverage: number
  defaultSlRule: string
  defaultTpRule: string
  defaultTrailMode: string
  watchDefaultThreshold: number
  watchDefaultExpiryMin: number
  coachStrictness: number
  autoExitOnInvalidation: boolean
}

export default function Settings() {
  const [localSettings, setLocalSettings] = useState<LocalSettings>({
    defaultRiskPercent: 0.5,
    defaultLeverage: 5,
    maxLeverage: 10,
    defaultSlRule: 'SWING',
    defaultTpRule: 'NONE',
    defaultTrailMode: 'SUPERTREND',
    watchDefaultThreshold: 0.2,
    watchDefaultExpiryMin: 120,
    coachStrictness: 1,
    autoExitOnInvalidation: true,
  })
  const [symbolConfigs, setSymbolConfigs] = useState<SymbolConfig[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const fetchSettings = async () => {
      try {
        const [settingsRes, symbolsRes] = await Promise.all([
          settingsApi.get(),
          settingsApi.getSymbols(),
        ])
        if (settingsRes.data) {
          setLocalSettings({
            defaultRiskPercent: settingsRes.data.defaultRiskPercent,
            defaultLeverage: settingsRes.data.defaultLeverage,
            maxLeverage: settingsRes.data.maxLeverage,
            defaultSlRule: settingsRes.data.defaultSlRule,
            defaultTpRule: settingsRes.data.defaultTpRule,
            defaultTrailMode: settingsRes.data.defaultTrailMode,
            watchDefaultThreshold: settingsRes.data.watchDefaultThreshold,
            watchDefaultExpiryMin: settingsRes.data.watchDefaultExpiryMin,
            coachStrictness: settingsRes.data.coachStrictness,
            autoExitOnInvalidation: settingsRes.data.autoExitOnInvalidation,
          })
        }
        if (symbolsRes.data) {
          setSymbolConfigs(symbolsRes.data)
        }
      } catch (err) {
        setError('Failed to load settings')
        console.error(err)
      }
      setLoading(false)
    }
    fetchSettings()
  }, [])

  const handleChange = (key: keyof LocalSettings, value: number | boolean | string) => {
    setLocalSettings(prev => ({ ...prev, [key]: value }))
    setSaved(false)
  }

  const handleSave = async () => {
    setSaving(true)
    setError(null)
    try {
      await settingsApi.update(localSettings)
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
    } catch (err) {
      setError('Failed to save settings')
      console.error(err)
    }
    setSaving(false)
  }

  if (loading) {
    return (
      <div className="h-full flex items-center justify-center">
        <RefreshCw size={24} className="animate-spin text-zinc-500" />
      </div>
    )
  }

  return (
    <div className="h-full overflow-y-auto p-6">
      <div className="max-w-2xl mx-auto">
        {/* Header */}
        <div className="mb-8">
          <h1 className="text-xl font-semibold text-zinc-100">Settings</h1>
          <p className="text-sm text-zinc-500">Configure your trading parameters</p>
        </div>

        {/* Error Display */}
        {error && (
          <div className="mb-6 p-3 bg-accent-red/20 border border-accent-red/50 rounded-lg flex items-center gap-2 text-accent-red text-sm">
            <AlertCircle size={16} />
            {error}
          </div>
        )}

        {/* Risk Management */}
        <SettingsSection 
          icon={Shield} 
          title="Risk Management"
          description="Control your exposure and protect your capital"
        >
          <SettingsRow label="Default Risk %" description="Risk per trade">
            <NumberInput 
              value={localSettings.defaultRiskPercent}
              onChange={v => handleChange('defaultRiskPercent', v)}
              min={0.1}
              max={10}
              step={0.1}
              suffix="%"
            />
          </SettingsRow>

          <SettingsRow label="Default Leverage" description="Starting leverage for trades">
            <NumberInput 
              value={localSettings.defaultLeverage}
              onChange={v => handleChange('defaultLeverage', v)}
              min={1}
              max={10}
              step={1}
              suffix="x"
            />
          </SettingsRow>

          <SettingsRow label="Max Leverage" description="Hard cap on leverage (cannot exceed)">
            <div className="flex items-center gap-2">
              <span className="text-zinc-300 mono">{localSettings.maxLeverage}x</span>
              <span className="text-xs text-zinc-500">(Fixed)</span>
            </div>
          </SettingsRow>

          <SettingsRow label="Coach Strictness" description="1=relaxed, 2=normal, 3=strict">
            <NumberInput 
              value={localSettings.coachStrictness}
              onChange={v => handleChange('coachStrictness', v)}
              min={1}
              max={3}
              step={1}
            />
          </SettingsRow>

          <SettingsRow label="Auto Exit on Invalidation" description="Exit when strategy invalidates">
            <Toggle 
              enabled={localSettings.autoExitOnInvalidation}
              onChange={v => handleChange('autoExitOnInvalidation', v)}
            />
          </SettingsRow>
        </SettingsSection>

        {/* Default Rules */}
        <SettingsSection 
          icon={Gauge} 
          title="Default Trade Rules"
          description="Default parameters for new trades"
        >
          <SettingsRow label="Stop Loss Rule" description="Default SL calculation">
            <SelectInput 
              value={localSettings.defaultSlRule}
              onChange={v => handleChange('defaultSlRule', v)}
              options={[
                { value: 'SWING', label: 'Swing' },
                { value: 'SUPERTREND', label: 'Supertrend' },
                { value: 'PRICE', label: 'Manual Price' },
                { value: 'NONE', label: 'None' },
              ]}
            />
          </SettingsRow>

          <SettingsRow label="Take Profit Rule" description="Default TP calculation">
            <SelectInput 
              value={localSettings.defaultTpRule}
              onChange={v => handleChange('defaultTpRule', v)}
              options={[
                { value: 'NONE', label: 'None' },
                { value: 'RR', label: 'Risk:Reward' },
                { value: 'PRICE', label: 'Manual Price' },
                { value: 'STRUCTURE', label: 'Structure' },
              ]}
            />
          </SettingsRow>

          <SettingsRow label="Trail Mode" description="Default trailing stop mode">
            <SelectInput 
              value={localSettings.defaultTrailMode}
              onChange={v => handleChange('defaultTrailMode', v)}
              options={[
                { value: 'NONE', label: 'None' },
                { value: 'SUPERTREND', label: 'Supertrend' },
                { value: 'STRUCTURE', label: 'Structure' },
              ]}
            />
          </SettingsRow>
        </SettingsSection>

        {/* Watch Settings */}
        <SettingsSection 
          icon={Brain} 
          title="Watch Defaults"
          description="Default settings for watch rules"
        >
          <SettingsRow label="Default Threshold" description="Distance % for triggers">
            <NumberInput 
              value={localSettings.watchDefaultThreshold}
              onChange={v => handleChange('watchDefaultThreshold', v)}
              min={0.1}
              max={5}
              step={0.1}
              suffix="%"
            />
          </SettingsRow>

          <SettingsRow label="Default Expiry" description="Watch expiry in minutes">
            <NumberInput 
              value={localSettings.watchDefaultExpiryMin}
              onChange={v => handleChange('watchDefaultExpiryMin', v)}
              min={5}
              max={1440}
              step={5}
              suffix="min"
            />
          </SettingsRow>
        </SettingsSection>

        {/* Symbol Configs Display */}
        {symbolConfigs.length > 0 && (
          <SettingsSection 
            icon={Gauge} 
            title="Symbol Configurations"
            description="Per-symbol indicator settings"
          >
            {symbolConfigs.map(sym => (
              <SettingsRow key={sym.symbol} label={sym.symbol} description={`TF: ${sym.timeframe}, ST: ${sym.supertrendPeriod}/${sym.supertrendMult}`}>
                <span className={`text-xs px-2 py-1 rounded ${sym.enabled ? 'bg-accent-green/20 text-accent-green' : 'bg-dark-600 text-zinc-500'}`}>
                  {sym.enabled ? 'Active' : 'Disabled'}
                </span>
              </SettingsRow>
            ))}
          </SettingsSection>
        )}

        {/* Save Button */}
        <div className="mt-8 flex justify-end">
          <button
            onClick={handleSave}
            disabled={saving}
            className={`
              flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium
              transition-all disabled:opacity-50
              ${saved 
                ? 'bg-accent-green text-white' 
                : 'bg-accent-blue hover:bg-accent-blue/80 text-white'
              }
            `}
          >
            {saving ? (
              <>
                <RefreshCw size={16} className="animate-spin" />
                Saving...
              </>
            ) : saved ? (
              <>
                <Check size={16} />
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

function SelectInput({ 
  value, 
  onChange, 
  options 
}: { 
  value: string
  onChange: (v: string) => void
  options: { value: string; label: string }[]
}) {
  return (
    <select
      value={value}
      onChange={e => onChange(e.target.value)}
      className="
        bg-dark-700 border border-dark-500 rounded-lg px-2 py-1
        text-sm text-zinc-200 mono
        focus:outline-none focus:border-accent-blue/50
      "
    >
      {options.map(opt => (
        <option key={opt.value} value={opt.value}>{opt.label}</option>
      ))}
    </select>
  )
}

