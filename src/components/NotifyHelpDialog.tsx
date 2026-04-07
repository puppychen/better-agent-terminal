import { useState, useCallback } from 'react'

interface HookStatus {
  installed: boolean
  hasStop: boolean
  hasNotification: boolean
  scriptExists: boolean
}

interface NotifyHelpDialogProps {
  onClose: () => void
}

const HOOK_SCRIPT = `#!/bin/bash
TOKEN_FILE="$HOME/.claude/better-agent/notify-auth.txt"
[ -f "$TOKEN_FILE" ] || exit 0
TOKEN_INFO=$(cat "$TOKEN_FILE")
PORT="\${TOKEN_INFO%%:*}"
TOKEN="\${TOKEN_INFO##*:}"
[ -z "$TOKEN" ] && exit 0

CWD="\${CLAUDE_PROJECT_DIR:-$(pwd)}"
EVENT="\${1:-stop}"

curl -s -X POST "http://127.0.0.1:$PORT/notify" \\
  -H "Authorization: Bearer $TOKEN" \\
  -H "Content-Type: application/json" \\
  -d "{\\"cwd\\":\\"$CWD\\",\\"event\\":\\"$EVENT\\"}" \\
  --max-time 2 \\
  >/dev/null 2>&1 || true
`

const HOOKS_JSON = `{
  "hooks": {
    "Stop": [{
      "matcher": "",
      "hooks": [{
        "type": "command",
        "command": "~/.claude/hooks/better-agent-notify.sh stop"
      }]
    }],
    "Notification": [{
      "matcher": "",
      "hooks": [{
        "type": "command",
        "command": "~/.claude/hooks/better-agent-notify.sh wait"
      }]
    }]
  }
}`

export function NotifyHelpDialog({ onClose }: NotifyHelpDialogProps) {
  const [scriptCopied, setScriptCopied] = useState(false)
  const [jsonCopied, setJsonCopied] = useState(false)
  const [hookStatus, setHookStatus] = useState<HookStatus | null>(null)
  const [checking, setChecking] = useState(false)

  const handleCopy = useCallback(async (text: string, setter: (v: boolean) => void) => {
    try {
      await navigator.clipboard.writeText(text)
      setter(true)
      setTimeout(() => setter(false), 2000)
    } catch { /* noop */ }
  }, [])

  const handleRecheck = useCallback(async () => {
    setChecking(true)
    try {
      const status = await window.electronAPI.notify.checkHookInstalled()
      setHookStatus(status)
    } catch { /* noop */ }
    setChecking(false)
  }, [])

  return (
    <div className="settings-overlay" onClick={onClose}>
      <div className="settings-panel about-panel" onClick={e => e.stopPropagation()} style={{ width: 520 }}>
        <div className="settings-header">
          <h2>Notification Setup</h2>
          <button className="close-btn" onClick={onClose}>×</button>
        </div>

        <div className="settings-content">
          <div className="notify-help-step">
            <h4>Step 1: Create hook script</h4>
            <p>Save the script below to <code>~/.claude/hooks/better-agent-notify.sh</code>, then run <code>chmod +x</code> on it.</p>
            <pre className="notify-help-block">{HOOK_SCRIPT}</pre>
            <div className="notify-help-actions">
              <button onClick={() => handleCopy(HOOK_SCRIPT, setScriptCopied)}>
                {scriptCopied ? '\u2713 Copied' : 'Copy script'}
              </button>
            </div>
          </div>

          <div className="notify-help-step">
            <h4>Step 2: Edit ~/.claude/settings.json</h4>
            <p>Add the following <code>hooks</code> block. If you already have a <code>hooks</code> key, merge into it.</p>
            <pre className="notify-help-block">{HOOKS_JSON}</pre>
            <div className="notify-help-actions">
              <button onClick={() => handleCopy(HOOKS_JSON, setJsonCopied)}>
                {jsonCopied ? '\u2713 Copied' : 'Copy JSON'}
              </button>
            </div>
          </div>

          <div className="notify-help-step">
            <h4>Step 3: Verify</h4>
            <p>Click recheck to confirm both the script and the hook config are detected.</p>
            <div className="notify-help-actions">
              <button onClick={handleRecheck} disabled={checking}>
                {checking ? 'Checking...' : 'Recheck'}
              </button>
              {hookStatus && (
                <span className="notify-help-recheck-result">
                  Script: {hookStatus.scriptExists ? <span className="notify-status-installed">\u2713</span> : <span className="notify-status-missing">\u2717</span>}
                  {' · '}
                  Stop hook: {hookStatus.hasStop ? <span className="notify-status-installed">\u2713</span> : <span className="notify-status-missing">\u2717</span>}
                  {' · '}
                  Notification hook: {hookStatus.hasNotification ? <span className="notify-status-installed">\u2713</span> : <span className="notify-status-missing">\u2717</span>}
                </span>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
