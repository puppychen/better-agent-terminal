import { useEffect, useState, useCallback } from 'react'
import { terminalStore } from '../stores/terminal-store'
import { TerminalPanel } from './TerminalPanel'
import type { TerminalState } from '../types'

interface GitInfo {
  branch: string
  dirty: boolean
}

interface SubRepoInfo {
  name: string
  path: string
  branch: string
  dirty: boolean
}

interface MainPanelProps {
  activeWorkspaceId: string | null
  workspaceCwd: string | null
  onRequestCloseTab?: (id: string) => void
  onCycleAgent?: (direction: 1 | -1) => void
}

export function MainPanel({ activeWorkspaceId, workspaceCwd, onRequestCloseTab, onCycleAgent }: MainPanelProps) {
  const [termState, setTermState] = useState<TerminalState>(terminalStore.getState())
  const [gitInfo, setGitInfo] = useState<GitInfo | null>(null)
  const [subRepos, setSubRepos] = useState<SubRepoInfo[]>([])

  useEffect(() => {
    return terminalStore.subscribe(() => setTermState(terminalStore.getState()))
  }, [])

  // Fetch git info when active workspace changes
  useEffect(() => {
    if (!workspaceCwd) {
      setGitInfo(null)
      setSubRepos([])
      return
    }

    let cancelled = false
    const fetchGit = async () => {
      try {
        const batch = await window.electronAPI.shell.getGitInfoBatch([workspaceCwd])
        if (cancelled) return
        const info = batch[workspaceCwd] ?? null
        setGitInfo(info)

        if (!info) {
          const subBatch = await window.electronAPI.shell.getSubReposBatch([workspaceCwd])
          if (cancelled) return
          setSubRepos(subBatch[workspaceCwd] ?? [])
        } else {
          setSubRepos([])
        }
      } catch { /* silent */ }
    }
    fetchGit()

    // Re-fetch on focus (user may have committed)
    const handleFocus = () => fetchGit()
    window.addEventListener('focus', handleFocus)
    return () => { cancelled = true; window.removeEventListener('focus', handleFocus) }
  }, [workspaceCwd])

  const wsTerminals = activeWorkspaceId
    ? termState.terminals.filter(t => t.workspaceId === activeWorkspaceId)
    : []

  const activeTerminalId = termState.activeTerminalId

  const handleNewShell = useCallback(async () => {
    if (!activeWorkspaceId || !workspaceCwd) return
    await terminalStore.createTerminal(activeWorkspaceId, workspaceCwd, { type: 'shell' })
  }, [activeWorkspaceId, workspaceCwd])

  const handleCloseTab = useCallback((id: string) => {
    if (onRequestCloseTab) {
      onRequestCloseTab(id)
    } else {
      terminalStore.killTerminal(id)
    }
  }, [onRequestCloseTab])

  const handleSelectTab = useCallback(async (id: string) => {
    await terminalStore.setActiveTerminal(id)
  }, [])

  const handleCycleTab = useCallback((direction: 1 | -1) => {
    if (onCycleAgent) {
      onCycleAgent(direction)
    } else {
      if (wsTerminals.length <= 1) return
      const currentIdx = wsTerminals.findIndex(t => t.id === activeTerminalId)
      const nextIdx = (currentIdx + direction + wsTerminals.length) % wsTerminals.length
      terminalStore.setActiveTerminal(wsTerminals[nextIdx].id)
    }
  }, [wsTerminals, activeTerminalId, onCycleAgent])

  const handleOpenSourceTree = (path: string) => {
    window.electronAPI.shell.openWithApp('Sourcetree', path)
  }

  if (!activeWorkspaceId) {
    return (
      <div className="main-panel main-panel-empty">
        <span>Select a workspace</span>
      </div>
    )
  }

  return (
    <div className="main-panel">
      {/* Terminal Tab Bar */}
      <div className="terminal-tab-bar">
        {wsTerminals.map(t => (
          <div
            key={t.id}
            className={`terminal-tab ${t.id === activeTerminalId ? 'active' : ''}`}
            onClick={() => handleSelectTab(t.id)}
          >
            <span className="terminal-tab-label">{t.label}</span>
            <button
              className="terminal-tab-close"
              onClick={(e) => { e.stopPropagation(); handleCloseTab(t.id) }}
            >
              ×
            </button>
          </div>
        ))}
        <button className="terminal-tab-new" onClick={handleNewShell} title="New Terminal">
          +
        </button>
      </div>

      {/* Terminal Panels — render ALL terminals, CSS show/hide to avoid unmount/remount */}
      <div className="terminal-panels">
        {termState.terminals.map(t => (
          <div
            key={t.id}
            className={`terminal-panel-wrapper ${t.id === activeTerminalId ? 'active' : ''}`}
          >
            <TerminalPanel
              terminalId={t.id}
              isActive={t.id === activeTerminalId}
              onCycleTab={handleCycleTab}
            />
          </div>
        ))}
        {wsTerminals.length === 0 && (
          <div className="terminal-panels-empty">
            <p>No terminal open</p>
            <button onClick={handleNewShell}>Open Terminal</button>
          </div>
        )}
      </div>

      {/* Git Info Bar — fixed height bottom section */}
      <div className="git-info-bar">
        {gitInfo && (
          <span
            className="git-info-badge"
            onClick={() => workspaceCwd && handleOpenSourceTree(workspaceCwd)}
            title={`${gitInfo.branch}${gitInfo.dirty ? ' (uncommitted changes)' : ''} — click to open SourceTree`}
          >
            {gitInfo.dirty && <span className="git-dirty-dot" />}
            ⎇ {gitInfo.branch}
          </span>
        )}
        {!gitInfo && subRepos.map(repo => (
          <span
            key={repo.path}
            className="git-info-badge"
            onClick={() => handleOpenSourceTree(repo.path)}
            title={`${repo.name}: ${repo.branch}${repo.dirty ? ' (uncommitted changes)' : ''}`}
          >
            {repo.dirty && <span className="git-dirty-dot" />}
            ⎇ {repo.name}/{repo.branch}
          </span>
        ))}
      </div>
    </div>
  )
}
