import { useState, useEffect, useCallback } from 'react'
import { NotifyHelpDialog } from './NotifyHelpDialog'

interface WsStatus {
  running: boolean
  port: number | null
  token: string | null
  clientCount: number
  host: string
}

interface NotifyStatus {
  running: boolean
  enabled: boolean
  port: number
  token: string | null
  tokenPath: string
}

interface HookStatus {
  installed: boolean
  hasStop: boolean
  hasNotification: boolean
  scriptExists: boolean
}

interface AboutPanelProps {
  onClose: () => void
}

export function AboutPanel({ onClose }: AboutPanelProps) {
  const [wsStatus, setWsStatus] = useState<WsStatus | null>(null)
  const [wsToggling, setWsToggling] = useState(false)
  const [tokenVisible, setTokenVisible] = useState(false)
  const [tokenCopied, setTokenCopied] = useState(false)
  const [notifyStatus, setNotifyStatus] = useState<NotifyStatus | null>(null)
  const [notifyToggling, setNotifyToggling] = useState(false)
  const [hookStatus, setHookStatus] = useState<HookStatus | null>(null)
  const [showNotifyHelp, setShowNotifyHelp] = useState(false)
  const [showInstallConfirm, setShowInstallConfirm] = useState(false)
  const [installResult, setInstallResult] = useState<{ ok: boolean; msg: string } | null>(null)
  const [installing, setInstalling] = useState(false)

  const refreshWsStatus = useCallback(async () => {
    try {
      const status = await window.electronAPI.ws.getStatus()
      setWsStatus(status)
    } catch { /* ws API may not exist */ }
  }, [])

  const refreshNotifyStatus = useCallback(async () => {
    try {
      const status = await window.electronAPI.notify.getStatus()
      setNotifyStatus(status)
      if (status.running) {
        const hook = await window.electronAPI.notify.checkHookInstalled()
        setHookStatus(hook)
      }
    } catch { /* notify API may not exist */ }
  }, [])

  useEffect(() => {
    refreshWsStatus()
    refreshNotifyStatus()
    const unsubClient = window.electronAPI.ws?.onClientChange?.(() => refreshWsStatus())
    const unsubStatus = window.electronAPI.ws?.onStatusChange?.(() => refreshWsStatus())
    return () => { unsubClient?.(); unsubStatus?.() }
  }, [refreshWsStatus, refreshNotifyStatus])

  const handleNotifyToggle = async () => {
    if (!notifyStatus || notifyToggling) return
    setNotifyToggling(true)
    const newEnabled = !notifyStatus.running
    try {
      await window.electronAPI.notify.toggle(newEnabled)
      setTimeout(async () => {
        await refreshNotifyStatus()
        setNotifyToggling(false)
        // 啟用後若 hook 未安裝 → 跳確認對話框詢問是否自動安裝
        if (newEnabled) {
          const hook = await window.electronAPI.notify.checkHookInstalled()
          if (!hook.installed) {
            setShowInstallConfirm(true)
          }
        }
      }, 200)
    } catch { setNotifyToggling(false) }
  }

  const handleConfirmInstall = async () => {
    setShowInstallConfirm(false)
    setInstalling(true)
    try {
      const result = await window.electronAPI.notify.installHook()
      if (result.success) {
        setInstallResult({
          ok: true,
          msg: result.backedUp
            ? `已安裝 hook script 並合併 settings.json（原檔備份於 ${result.backupPath?.split('/').pop()}）`
            : '已安裝 hook script 並建立 settings.json'
        })
      } else {
        setInstallResult({ ok: false, msg: result.error || '安裝失敗' })
      }
      await refreshNotifyStatus()
    } catch (e: any) {
      setInstallResult({ ok: false, msg: e?.message || '安裝失敗' })
    }
    setInstalling(false)
    setTimeout(() => setInstallResult(null), 6000)
  }

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
    <>
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

          {/* Notifications */}
          {notifyStatus && (
            <div className="settings-section">
              <h3>
                Notifications
                <button
                  className="notify-help-btn"
                  onClick={() => setShowNotifyHelp(true)}
                  title="How to set up Claude Code hooks"
                >?</button>
              </h3>
              <div className="settings-group ws-toggle-row">
                <label>Agent Stop / Wait Alerts</label>
                <button
                  className={`ws-toggle-switch ${notifyStatus.running ? 'active' : ''}`}
                  onClick={handleNotifyToggle}
                  disabled={notifyToggling}
                >
                  <span className="ws-toggle-knob" />
                </button>
              </div>

              {notifyStatus.running && (
                <div className="ws-status-info">
                  <div className="ws-status-row">
                    <span className="ws-status-label">Listen</span>
                    <span className="ws-status-value">127.0.0.1:{notifyStatus.port}</span>
                  </div>
                  <div className="ws-status-row">
                    <span className="ws-status-label">Hook</span>
                    <span className="ws-status-value">
                      {hookStatus?.installed ? (
                        <span className="notify-status-installed">\u2713 Installed</span>
                      ) : (
                        <span className="notify-status-missing">\u2717 Not installed</span>
                      )}
                    </span>
                  </div>
                </div>
              )}

              {!notifyStatus.running && (
                <p className="ws-hint">Enable to receive red-dot alerts and macOS notifications when agents stop or wait for input. Click <strong>?</strong> to set up Claude Code hooks.</p>
              )}

              {installResult && (
                <p className={`ws-hint ${installResult.ok ? 'notify-status-installed' : 'notify-status-missing'}`}>
                  {installResult.ok ? '\u2713 ' : '\u2717 '}{installResult.msg}
                </p>
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
    {showNotifyHelp && <NotifyHelpDialog onClose={() => { setShowNotifyHelp(false); refreshNotifyStatus() }} />}
    {showInstallConfirm && (
      <div className="settings-overlay" onClick={() => setShowInstallConfirm(false)} style={{ zIndex: 1100 }}>
        <div className="settings-panel" style={{ width: 440 }} onClick={e => e.stopPropagation()}>
          <div className="settings-header">
            <h2>自動安裝 Hook</h2>
            <button className="close-btn" onClick={() => setShowInstallConfirm(false)}>×</button>
          </div>
          <div className="settings-content">
            <p>需要進行下列動作：</p>
            <ul style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.6, paddingLeft: 20 }}>
              <li>建立 <code>~/.claude/hooks/better-agent-notify.sh</code></li>
              <li>備份並修改 <code>~/.claude/settings.json</code>（合併 hooks 設定）</li>
            </ul>
            <p style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 12 }}>
              原 settings.json 會備份為 <code>settings.json.backup-{'<timestamp>'}</code>，可隨時還原。
              若已存在 better-agent-notify hook 設定，會自動跳過避免重複。
            </p>
            <div className="notify-help-actions" style={{ marginTop: 16 }}>
              <button onClick={handleConfirmInstall} disabled={installing}>
                {installing ? '安裝中...' : '是，自動安裝'}
              </button>
              <button onClick={() => setShowInstallConfirm(false)}>否，手動設定</button>
            </div>
          </div>
        </div>
      </div>
    )}
    </>
  )
}
