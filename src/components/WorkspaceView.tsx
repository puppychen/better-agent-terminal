import { useEffect, useCallback, useState, useRef } from 'react'
import type { Workspace, TerminalInstance, CodeAgentType } from '../types'
import { workspaceStore } from '../stores/workspace-store'
import { settingsStore } from '../stores/settings-store'
import { TerminalPanel } from './TerminalPanel'
import { ThumbnailBar } from './ThumbnailBar'
import { CloseConfirmDialog } from './CloseConfirmDialog'
import { CodeAgentSelectDialog } from './CodeAgentSelectDialog'
import { ActivityIndicator } from './ActivityIndicator'

interface WorkspaceViewProps {
  workspace: Workspace
  terminals: TerminalInstance[]
  focusedTerminalId: string | null
}

// Helper to get shell path from settings
async function getShellFromSettings(): Promise<string | undefined> {
  const settings = settingsStore.getSettings()
  if (settings.shell === 'custom' && settings.customShellPath) {
    return settings.customShellPath
  }
  return window.electronAPI.settings.getShellPath(settings.shell)
}

export function WorkspaceView({ workspace, terminals, focusedTerminalId }: WorkspaceViewProps) {
  const [showCloseConfirm, setShowCloseConfirm] = useState<string | null>(null)
  const [showAgentSelect, setShowAgentSelect] = useState(false)
  // Track workspaceId to allow creating Claude Code for different workspaces
  const creatingClaudeCodeRef = useRef<string | null>(null)

  const claudeCode = terminals.find(t => t.type === 'claude-code')
  const regularTerminals = terminals.filter(t => t.type === 'terminal')

  const focusedTerminal = terminals.find(t => t.id === focusedTerminalId)
  const isClaudeCodeFocused = focusedTerminal?.type === 'claude-code'

  // Show agent selection dialog when workspace loads (no Claude Code terminal exists)
  // Using ref to track which workspace we're showing dialog for
  useEffect(() => {
    if (!claudeCode && creatingClaudeCodeRef.current !== workspace.id) {
      creatingClaudeCodeRef.current = workspace.id
      setShowAgentSelect(true)
    }
  }, [workspace.id, claudeCode])

  // Handle agent selection and create Claude Code terminal
  const handleAgentSelect = useCallback(async (agentType: CodeAgentType) => {
    setShowAgentSelect(false)
    const terminal = workspaceStore.addTerminal(workspace.id, 'claude-code', agentType)
    const shell = await getShellFromSettings()

    window.electronAPI.pty.create({
      id: terminal.id,
      cwd: workspace.folderPath,
      type: 'claude-code',
      shell,
      codeAgentType: agentType
    })
  }, [workspace.id, workspace.folderPath])

  // Auto-create first terminal if none exists
  useEffect(() => {
    if (regularTerminals.length === 0 && claudeCode) {
      const createTerminal = async () => {
        const terminal = workspaceStore.addTerminal(workspace.id, 'terminal')
        const shell = await getShellFromSettings()
        window.electronAPI.pty.create({
          id: terminal.id,
          cwd: workspace.folderPath,
          type: 'terminal',
          shell
        })
      }
      createTerminal()
    }
  }, [workspace.id, regularTerminals.length, claudeCode])

  // Set default focus
  useEffect(() => {
    if (!focusedTerminalId && claudeCode) {
      workspaceStore.setFocusedTerminal(claudeCode.id)
    }
  }, [focusedTerminalId, claudeCode])

  const handleAddTerminal = useCallback(async () => {
    const terminal = workspaceStore.addTerminal(workspace.id, 'terminal')
    const shell = await getShellFromSettings()
    window.electronAPI.pty.create({
      id: terminal.id,
      cwd: workspace.folderPath,
      type: 'terminal',
      shell
    })
  }, [workspace.id, workspace.folderPath])

  const handleCloseTerminal = useCallback((id: string) => {
    const terminal = terminals.find(t => t.id === id)
    if (terminal?.type === 'claude-code') {
      setShowCloseConfirm(id)
    } else {
      window.electronAPI.pty.kill(id)
      workspaceStore.removeTerminal(id)
    }
  }, [terminals])

  const handleConfirmClose = useCallback(() => {
    if (showCloseConfirm) {
      window.electronAPI.pty.kill(showCloseConfirm)
      workspaceStore.removeTerminal(showCloseConfirm)
      setShowCloseConfirm(null)
    }
  }, [showCloseConfirm])

  const handleRestart = useCallback(async (id: string) => {
    const terminal = terminals.find(t => t.id === id)
    if (terminal) {
      const cwd = await window.electronAPI.pty.getCwd(id) || terminal.cwd
      const shell = await getShellFromSettings()
      // Pass codeAgentType for claude-code terminals to reuse the previous selection
      await window.electronAPI.pty.restart(id, cwd, shell, terminal.codeAgentType)
      workspaceStore.updateTerminalCwd(id, cwd)
    }
  }, [terminals])

  const handleFocus = useCallback((id: string) => {
    workspaceStore.setFocusedTerminal(id)
  }, [])

  // Determine what to show in thumbnail bar
  const mainTerminal = focusedTerminal || claudeCode
  const thumbnailTerminals = isClaudeCodeFocused
    ? regularTerminals
    : (claudeCode ? [claudeCode] : [])

  return (
    <div className="workspace-view">
      {/* Render ALL terminals, show/hide with CSS - keeps processes running */}
      <div className="terminals-container">
        {terminals.map(terminal => (
          <div
            key={terminal.id}
            className={`terminal-wrapper ${terminal.id === mainTerminal?.id ? 'active' : 'hidden'}`}
          >
            <div className="main-panel">
              <div className="main-panel-header">
                <div className={`main-panel-title ${terminal.type === 'claude-code' ? 'claude-code' : ''}`}>
                  {terminal.type === 'claude-code' && <span>✦</span>}
                  <span>{terminal.title}</span>
                </div>
                <div className="main-panel-actions">
                  <ActivityIndicator
                    terminalId={terminal.id}
                    size="small"
                  />
                  <button
                    className="action-btn"
                    onClick={() => handleRestart(terminal.id)}
                    title="Restart terminal"
                  >
                    ⟳
                  </button>
                  <button
                    className="action-btn danger"
                    onClick={() => handleCloseTerminal(terminal.id)}
                    title="Close terminal"
                  >
                    ×
                  </button>
                </div>
              </div>
              <div className="main-panel-content">
                <TerminalPanel
                  terminalId={terminal.id}
                  isActive={terminal.id === mainTerminal?.id}
                />
              </div>
            </div>
          </div>
        ))}
      </div>

      <ThumbnailBar
        terminals={thumbnailTerminals}
        focusedTerminalId={focusedTerminalId}
        onFocus={handleFocus}
        onAddTerminal={isClaudeCodeFocused ? handleAddTerminal : undefined}
        showAddButton={isClaudeCodeFocused}
      />

      {showCloseConfirm && (
        <CloseConfirmDialog
          onConfirm={handleConfirmClose}
          onCancel={() => setShowCloseConfirm(null)}
        />
      )}

      {showAgentSelect && (
        <CodeAgentSelectDialog onSelect={handleAgentSelect} />
      )}
    </div>
  )
}
