import { useState, useCallback } from 'react'

interface HookStatus {
  installed: boolean
  hasStop: boolean
  hasNotification: boolean
  scriptExists: boolean
  claude: {
    installed: boolean
    hasStop: boolean
    hasNotification: boolean
    scriptExists: boolean
  }
  codex: {
    installed: boolean
    hasStop: boolean
    configEnabled: boolean
    hooksFileExists: boolean
    scriptExists: boolean
  }
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

INPUT=$(cat 2>/dev/null || echo "")
SESSION_ID=$(printf '%s' "$INPUT" | sed -n 's/.*"session_id"[[:space:]]*:[[:space:]]*"\\([^"]*\\)".*/\\1/p' | head -1)
INPUT_CWD=$(printf '%s' "$INPUT" | sed -n 's/.*"cwd"[[:space:]]*:[[:space:]]*"\\([^"]*\\)".*/\\1/p' | head -1)
HOOK_EVENT=$(printf '%s' "$INPUT" | sed -n 's/.*"hook_event_name"[[:space:]]*:[[:space:]]*"\\([^"]*\\)".*/\\1/p' | head -1)
CWD="\${CLAUDE_PROJECT_DIR:-\${INPUT_CWD:-$(pwd)}}"
EVENT="\${1:-stop}"
AGENT_TYPE="\${2:-}"

if [ "$HOOK_EVENT" = "Stop" ]; then
  EVENT="stop"
fi

if [ -z "$AGENT_TYPE" ]; then
  if [ -n "$HOOK_EVENT" ]; then
    AGENT_TYPE="codex"
  else
    AGENT_TYPE="claude"
  fi
fi

json_escape() {
  printf '%s' "$1" | tr '\\n' ' ' | sed 's/\\\\/\\\\\\\\/g; s/"/\\\\"/g; s/\\r/ /g; s/\\t/ /g'
}

CWD_JSON=$(json_escape "$CWD")
SESSION_ID_JSON=$(json_escape "$SESSION_ID")
AGENT_TYPE_JSON=$(json_escape "$AGENT_TYPE")
SESSION_FIELD=""
if [ -n "$SESSION_ID_JSON" ]; then
  SESSION_FIELD=",\\"sessionId\\":\\"$SESSION_ID_JSON\\""
fi
AGENT_FIELD=""
if [ -n "$AGENT_TYPE_JSON" ]; then
  AGENT_FIELD=",\\"agentType\\":\\"$AGENT_TYPE_JSON\\""
fi

curl -s -X POST "http://127.0.0.1:$PORT/notify" \\
  -H "Authorization: Bearer $TOKEN" \\
  -H "Content-Type: application/json" \\
  -d "{\\"cwd\\":\\"$CWD_JSON\\",\\"event\\":\\"$EVENT\\"$SESSION_FIELD$AGENT_FIELD}" \\
  --max-time 2 \\
  >/dev/null 2>&1 || true
`

const CLAUDE_HOOKS_JSON = `{
  "hooks": {
    "Stop": [{
      "matcher": "",
      "hooks": [{
        "type": "command",
        "command": "~/.claude/hooks/better-agent-notify.sh stop claude"
      }]
    }],
    "Notification": [{
      "matcher": "",
      "hooks": [{
        "type": "command",
        "command": "~/.claude/hooks/better-agent-notify.sh wait claude"
      }]
    }]
  }
}`

const CODEX_CONFIG_TOML = `[features]
codex_hooks = true
`

const CODEX_HOOKS_JSON = `{
  "hooks": {
    "Stop": [{
      "matcher": "*",
      "hooks": [{
        "type": "command",
        "command": "~/.claude/hooks/better-agent-notify.sh stop codex"
      }]
    }]
  }
}`

export function NotifyHelpDialog({ onClose }: NotifyHelpDialogProps) {
  const [scriptCopied, setScriptCopied] = useState(false)
  const [claudeJsonCopied, setClaudeJsonCopied] = useState(false)
  const [codexConfigCopied, setCodexConfigCopied] = useState(false)
  const [codexJsonCopied, setCodexJsonCopied] = useState(false)
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
            <h4>Step 2: Edit Claude Code settings</h4>
            <p>Add the following <code>hooks</code> block. If you already have a <code>hooks</code> key, merge into it.</p>
            <pre className="notify-help-block">{CLAUDE_HOOKS_JSON}</pre>
            <div className="notify-help-actions">
              <button onClick={() => handleCopy(CLAUDE_HOOKS_JSON, setClaudeJsonCopied)}>
                {claudeJsonCopied ? '\u2713 Copied' : 'Copy Claude JSON'}
              </button>
            </div>
          </div>

          <div className="notify-help-step">
            <h4>Step 3: Edit Codex settings</h4>
            <p>Enable Codex hooks in <code>~/.codex/config.toml</code>, then merge the <code>Stop</code> hook into <code>~/.codex/hooks.json</code>.</p>
            <pre className="notify-help-block">{CODEX_CONFIG_TOML}</pre>
            <div className="notify-help-actions">
              <button onClick={() => handleCopy(CODEX_CONFIG_TOML, setCodexConfigCopied)}>
                {codexConfigCopied ? '\u2713 Copied' : 'Copy Codex TOML'}
              </button>
            </div>
            <pre className="notify-help-block">{CODEX_HOOKS_JSON}</pre>
            <div className="notify-help-actions">
              <button onClick={() => handleCopy(CODEX_HOOKS_JSON, setCodexJsonCopied)}>
                {codexJsonCopied ? '\u2713 Copied' : 'Copy Codex JSON'}
              </button>
            </div>
          </div>

          <div className="notify-help-step">
            <h4>Step 4: Verify</h4>
            <p>Click recheck to confirm both the script and the hook config are detected.</p>
            <div className="notify-help-actions">
              <button onClick={handleRecheck} disabled={checking}>
                {checking ? 'Checking...' : 'Recheck'}
              </button>
              {hookStatus && (
                <span className="notify-help-recheck-result">
                  Script: {hookStatus.scriptExists ? <span className="notify-status-installed">\u2713</span> : <span className="notify-status-missing">\u2717</span>}
                  {' · '}
                  Claude: {hookStatus.claude.installed ? <span className="notify-status-installed">\u2713</span> : <span className="notify-status-missing">\u2717</span>}
                  {' · '}
                  Codex: {hookStatus.codex.installed ? <span className="notify-status-installed">\u2713</span> : <span className="notify-status-missing">\u2717</span>}
                </span>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
