import { useState, useEffect, useCallback } from 'react'
import type { AppSettings, ShellType } from '../types'
import { settingsStore } from '../stores/settings-store'

interface WsStatus {
  running: boolean
  port: number | null
  token: string | null
  clientCount: number
  host: string
}

interface SettingsPanelProps {
  onClose: () => void
}

export function SettingsPanel({ onClose }: SettingsPanelProps) {
  const [settings, setSettings] = useState<AppSettings>(settingsStore.getSettings())
  const [wsStatus, setWsStatus] = useState<WsStatus | null>(null)
  const [wsToggling, setWsToggling] = useState(false)
  const [tokenVisible, setTokenVisible] = useState(false)
  const [tokenCopied, setTokenCopied] = useState(false)

  useEffect(() => {
    return settingsStore.subscribe(() => {
      setSettings(settingsStore.getSettings())
    })
  }, [])

  // Load WS status on mount + subscribe to client changes
  const refreshWsStatus = useCallback(async () => {
    try {
      const status = await window.electronAPI.ws.getStatus()
      setWsStatus(status)
    } catch { /* ws API may not exist in older builds */ }
  }, [])

  useEffect(() => {
    refreshWsStatus()
    const unsub = window.electronAPI.ws?.onClientChange?.(() => {
      refreshWsStatus()
    })
    return () => { unsub?.() }
  }, [refreshWsStatus])

  const handleWsToggle = async () => {
    if (!wsStatus || wsToggling) return
    setWsToggling(true)
    try {
      await window.electronAPI.ws.toggle(!wsStatus.running)
      // Small delay for server to start/stop
      setTimeout(async () => {
        await refreshWsStatus()
        setWsToggling(false)
        setTokenVisible(false)
        setTokenCopied(false)
      }, 300)
    } catch {
      setWsToggling(false)
    }
  }

  const handleCopyToken = async () => {
    if (wsStatus?.token) {
      await navigator.clipboard.writeText(wsStatus.token)
      setTokenCopied(true)
      setTimeout(() => setTokenCopied(false), 2000)
    }
  }

  const handleShellChange = (shell: ShellType) => {
    settingsStore.setShell(shell)
  }

  const handleCustomPathChange = (path: string) => {
    settingsStore.setCustomShellPath(path)
  }

  const handleFontSizeChange = (size: number) => {
    settingsStore.setFontSize(size)
  }

  return (
    <div className="settings-overlay" onClick={onClose}>
      <div className="settings-panel" onClick={e => e.stopPropagation()}>
        <div className="settings-header">
          <h2>Settings</h2>
          <button className="close-btn" onClick={onClose}>×</button>
        </div>

        <div className="settings-content">
          <div className="settings-section">
            <h3>Shell</h3>
            <div className="settings-group">
              <label>Default Shell</label>
              <select
                value={settings.shell}
                onChange={e => handleShellChange(e.target.value as ShellType)}
              >
                <option value="auto">Auto (prefer pwsh)</option>
                <option value="pwsh">PowerShell 7 (pwsh)</option>
                <option value="powershell">Windows PowerShell</option>
                <option value="cmd">Command Prompt (cmd)</option>
                <option value="custom">Custom</option>
              </select>
            </div>

            {settings.shell === 'custom' && (
              <div className="settings-group">
                <label>Custom Shell Path</label>
                <input
                  type="text"
                  value={settings.customShellPath}
                  onChange={e => handleCustomPathChange(e.target.value)}
                  placeholder="C:\path\to\shell.exe"
                />
              </div>
            )}
          </div>

          <div className="settings-section">
            <h3>Appearance</h3>
            <div className="settings-group">
              <label>Font Size: {settings.fontSize}px</label>
              <input
                type="range"
                min="10"
                max="24"
                value={settings.fontSize}
                onChange={e => handleFontSizeChange(Number(e.target.value))}
              />
            </div>
          </div>

          {wsStatus && (
            <div className="settings-section">
              <h3>WebSocket Server</h3>
              <div className="settings-group ws-toggle-row">
                <label>Remote Control</label>
                <button
                  className={`ws-toggle-switch ${wsStatus.running ? 'active' : ''}`}
                  onClick={handleWsToggle}
                  disabled={wsToggling}
                >
                  <span className="ws-toggle-knob" />
                </button>
              </div>

              {wsStatus.running && (
                <div className="ws-status-info">
                  <div className="ws-status-row">
                    <span className="ws-status-label">Status</span>
                    <span className="ws-status-value">
                      <span className="ws-dot ws-dot-on" />
                      Running
                    </span>
                  </div>
                  <div className="ws-status-row">
                    <span className="ws-status-label">Listen</span>
                    <span className="ws-status-value">{wsStatus.host}:{wsStatus.port}</span>
                  </div>
                  <div className="ws-status-row">
                    <span className="ws-status-label">Clients</span>
                    <span className="ws-status-value">{wsStatus.clientCount} connected</span>
                  </div>
                  <div className="ws-status-row">
                    <span className="ws-status-label">Token</span>
                    <span className="ws-status-value ws-token-value">
                      <code className="ws-token-text">
                        {tokenVisible ? wsStatus.token : '\u2022'.repeat(16)}
                      </code>
                      <button className="ws-token-btn" onClick={() => setTokenVisible(!tokenVisible)} title={tokenVisible ? 'Hide' : 'Show'}>
                        {tokenVisible ? '\u25C9' : '\u25CE'}
                      </button>
                      <button className="ws-token-btn" onClick={handleCopyToken} title="Copy">
                        {tokenCopied ? '\u2713' : '\u2398'}
                      </button>
                    </span>
                  </div>
                </div>
              )}

              {!wsStatus.running && (
                <p className="ws-hint">Enable to allow external clients (e.g. Telegram Bot) to interact with sessions.</p>
              )}
            </div>
          )}
        </div>

        <div className="settings-footer">
          <p className="settings-note">Changes are saved automatically. Restart terminals to apply shell changes.</p>
        </div>
      </div>
    </div>
  )
}
