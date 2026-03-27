import { useState, useEffect, useCallback } from 'react'

interface WsStatus {
  running: boolean
  port: number | null
  token: string | null
  clientCount: number
  host: string
}

interface AboutPanelProps {
  onClose: () => void
}

export function AboutPanel({ onClose }: AboutPanelProps) {
  const [wsStatus, setWsStatus] = useState<WsStatus | null>(null)
  const [wsToggling, setWsToggling] = useState(false)
  const [tokenVisible, setTokenVisible] = useState(false)
  const [tokenCopied, setTokenCopied] = useState(false)

  const refreshWsStatus = useCallback(async () => {
    try {
      const status = await window.electronAPI.ws.getStatus()
      setWsStatus(status)
    } catch { /* ws API may not exist */ }
  }, [])

  useEffect(() => {
    refreshWsStatus()
    const unsubClient = window.electronAPI.ws?.onClientChange?.(() => refreshWsStatus())
    const unsubStatus = window.electronAPI.ws?.onStatusChange?.(() => refreshWsStatus())
    return () => { unsubClient?.(); unsubStatus?.() }
  }, [refreshWsStatus])

  const handleWsToggle = async () => {
    if (!wsStatus || wsToggling) return
    setWsToggling(true)
    try {
      await window.electronAPI.ws.toggle(!wsStatus.running)
      setTimeout(async () => {
        await refreshWsStatus()
        setWsToggling(false)
        setTokenVisible(false)
        setTokenCopied(false)
      }, 300)
    } catch { setWsToggling(false) }
  }

  const handleCopyToken = async () => {
    if (wsStatus?.token) {
      await navigator.clipboard.writeText(wsStatus.token)
      setTokenCopied(true)
      setTimeout(() => setTokenCopied(false), 2000)
    }
  }

  return (
    <div className="settings-overlay" onClick={onClose}>
      <div className="settings-panel about-panel" onClick={e => e.stopPropagation()}>
        <div className="settings-header">
          <h2>Settings</h2>
          <button className="close-btn" onClick={onClose}>×</button>
        </div>

        <div className="settings-content">
          {/* WebSocket Server */}
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

          {/* About */}
          <div className="settings-section about-content">
            <div className="about-logo">
              <span className="about-icon">⬛</span>
              <h1>Better Agent Workspace</h1>
            </div>

            <p className="about-description">
              A terminal aggregator with multi-workspace support and Claude Code integration.
            </p>

            <div className="about-info">
              <div className="about-row">
                <span className="about-label">Author</span>
                <span className="about-value">TonyQ + Puppy Chen</span>
              </div>
            </div>

            <div className="about-credits">
              <p>Built with Electron, React, and xterm.js</p>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
