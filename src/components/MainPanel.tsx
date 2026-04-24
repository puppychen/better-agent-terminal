import { useEffect, useState, useCallback, useRef, lazy, Suspense } from 'react'
import { terminalStore } from '../stores/terminal-store'
import { workspaceStore } from '../stores/workspace-store'
import { TerminalPanel } from './TerminalPanel'
import type { TerminalState } from '../types'

// Files tab 走 lazy chunk —— CodeMirror + 9 語言 packages 不進主 bundle
const FilesTab = lazy(() => import('./FilesTab').then(m => ({ default: m.FilesTab })))

interface GitInfo {
  branch: string
  dirty: boolean
  filesChanged: number
  insertions: number
  deletions: number
}

interface SubRepoInfo {
  name: string
  path: string
  branch: string
  dirty: boolean
  filesChanged: number
  insertions: number
  deletions: number
}

interface MainPanelProps {
  activeWorkspaceId: string | null
  workspaceCwd: string | null
  onRequestCloseTab?: (id: string) => void
  onCycleAgent?: (direction: 1 | -1) => void
  onAddAgent?: (workspaceId: string, cwd: string) => void
  onAddCodexAgent?: (workspaceId: string, cwd: string) => void
}

export function MainPanel({ activeWorkspaceId, workspaceCwd, onRequestCloseTab, onCycleAgent, onAddAgent, onAddCodexAgent }: MainPanelProps) {
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

  const handleNewClaude = useCallback(() => {
    if (!activeWorkspaceId || !workspaceCwd || !onAddAgent) return
    onAddAgent(activeWorkspaceId, workspaceCwd)
  }, [activeWorkspaceId, workspaceCwd, onAddAgent])

  const handleNewCodex = useCallback(() => {
    if (!activeWorkspaceId || !workspaceCwd || !onAddCodexAgent) return
    onAddCodexAgent(activeWorkspaceId, workspaceCwd)
  }, [activeWorkspaceId, workspaceCwd, onAddCodexAgent])

  const handleNewFiles = useCallback(async () => {
    if (!activeWorkspaceId || !workspaceCwd) return
    // 單例：若已存在 Files tab，切過去而非新建
    const existing = terminalStore.getTerminalsForWorkspace(activeWorkspaceId).find(t => t.type === 'files')
    if (existing) {
      await terminalStore.setActiveTerminal(existing.id)
      return
    }
    await terminalStore.createTerminal(activeWorkspaceId, workspaceCwd, { type: 'files' })
  }, [activeWorkspaceId, workspaceCwd])

  // Cmd+click 終端輸出路徑 → 開啟 Files tab 中的對應檔案
  // text 形如 "src/foo.ts" 或 "src/foo.ts:42" 或 "/abs/path/foo.ts"；解析後丟給 store
  const handleActivateLink = useCallback((text: string) => {
    if (!activeWorkspaceId || !workspaceCwd) return
    // 拆掉 :line:col 後綴（PR-A 不跳行；保留供 PR-D 使用）
    const pathOnly = text.replace(/:\d+(?::\d+)?$/, '')
    let relativePath: string
    if (pathOnly.startsWith('/')) {
      // 絕對路徑：必須在 workspace 內，否則放棄
      const root = workspaceCwd.replace(/\/$/, '')
      if (pathOnly !== root && !pathOnly.startsWith(root + '/')) return
      relativePath = pathOnly === root ? '' : pathOnly.slice(root.length + 1)
    } else if (pathOnly.startsWith('~/') || pathOnly === '~') {
      // home 路徑暫不支援
      return
    } else {
      relativePath = pathOnly
    }
    terminalStore.openFileInFilesTab(activeWorkspaceId, workspaceCwd, relativePath)
  }, [activeWorkspaceId, workspaceCwd])

  // === Tab inline rename ===
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renamePrefix, setRenamePrefix] = useState('')   // 不可編輯的識別前綴（如 "[C] "）
  const [renameValue, setRenameValue] = useState('')      // 可編輯的後綴部分
  const renameInputRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    if (renamingId && renameInputRef.current) {
      renameInputRef.current.focus()
      renameInputRef.current.select()
    }
  }, [renamingId])

  /** 拆 label：如 "[C] 規劃-A" → ["[C] ", "規劃-A"]；無 prefix 則為 ["", label] */
  const splitPrefix = (label: string): [string, string] => {
    const m = label.match(/^(\[[CFTX]\]\s)/)
    return m ? [m[1], label.slice(m[1].length)] : ['', label]
  }

  const startRename = (terminalId: string, currentLabel: string) => {
    const [prefix, body] = splitPrefix(currentLabel)
    setRenamingId(terminalId)
    setRenamePrefix(prefix)
    setRenameValue(body)
  }

  const commitRename = () => {
    const id = renamingId
    if (!id) return
    const body = renameValue.trim()
    if (body) {
      const newLabel = renamePrefix + body
      const term = terminalStore.getState().terminals.find(t => t.id === id)
      terminalStore.setLabel(id, newLabel, true)
      // 同步寫入 workspace 的 sessionId → label map（agent + 有 sessionId 才存）
      if (term?.type === 'agent' && term.claudeSessionId) {
        workspaceStore.setClaudeSessionLabel(term.workspaceId, term.claudeSessionId, newLabel)
      }
    }
    setRenamingId(null)
    setRenamePrefix('')
    setRenameValue('')
  }

  const cancelRename = () => {
    setRenamingId(null)
    setRenamePrefix('')
    setRenameValue('')
  }

  const handleTabContextMenu = (e: React.MouseEvent, t: TerminalState['terminals'][number]) => {
    e.preventDefault()
    startRename(t.id, t.label)
  }

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
            onClick={() => renamingId !== t.id && handleSelectTab(t.id)}
            onContextMenu={(e) => handleTabContextMenu(e, t)}
            onDoubleClick={(e) => { e.stopPropagation(); startRename(t.id, t.label) }}
            title="右鍵 / 雙擊 重新命名"
          >
            {renamingId === t.id ? (
              <>
                {renamePrefix && <span className="terminal-tab-rename-prefix">{renamePrefix}</span>}
                <input
                  ref={renameInputRef}
                  className="terminal-tab-rename-input"
                  value={renameValue}
                  onChange={(e) => setRenameValue(e.target.value)}
                  onBlur={commitRename}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') { e.preventDefault(); commitRename() }
                    else if (e.key === 'Escape') { e.preventDefault(); cancelRename() }
                  }}
                  onClick={(e) => e.stopPropagation()}
                />
              </>
            ) : (
              <span className="terminal-tab-label">{t.label}</span>
            )}
            {t.unread && <span className="terminal-tab-unread-dot" title="Unread notification" />}
            <button
              className="terminal-tab-close"
              onClick={(e) => { e.stopPropagation(); handleCloseTab(t.id) }}
            >
              ×
            </button>
          </div>
        ))}
        <button
          className="terminal-tab-new terminal-tab-new-shell"
          onClick={handleNewShell}
          title="New Terminal"
        >
          + T
        </button>
        {onAddAgent && (
          <button
            className="terminal-tab-new terminal-tab-new-claude"
            onClick={handleNewClaude}
            title="New Claude session"
          >
            + C
          </button>
        )}
        {onAddCodexAgent && (
          <button
            className="terminal-tab-new terminal-tab-new-codex"
            onClick={handleNewCodex}
            title="New Codex session"
          >
            + X
          </button>
        )}
        <button
          className="terminal-tab-new terminal-tab-new-files"
          onClick={handleNewFiles}
          title="Open Files panel"
        >
          + F
        </button>
      </div>

      {/* Terminal Panels — render ALL terminals, CSS show/hide to avoid unmount/remount */}
      <div className="terminal-panels">
        {termState.terminals.map(t => (
          <div
            key={t.id}
            className={`terminal-panel-wrapper ${t.id === activeTerminalId ? 'active' : ''}`}
          >
            {t.type === 'files' ? (
              <Suspense fallback={<div className="files-tab-placeholder">載入編輯器中…</div>}>
                <FilesTab
                  workspaceCwd={t.cwd}
                  isActive={t.id === activeTerminalId}
                  request={t.filesActiveRequest}
                />
              </Suspense>
            ) : (
              <TerminalPanel
                terminalId={t.id}
                isActive={t.id === activeTerminalId}
                onCycleTab={handleCycleTab}
                onActivateLink={handleActivateLink}
              />
            )}
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
            {gitInfo.dirty && (
              <span className="git-stats">
                {gitInfo.filesChanged > 0 && <span className="git-stat-files">M{gitInfo.filesChanged}</span>}
                {gitInfo.insertions > 0 && <span className="git-stat-ins">+{gitInfo.insertions}</span>}
                {gitInfo.deletions > 0 && <span className="git-stat-del">-{gitInfo.deletions}</span>}
              </span>
            )}
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
            {repo.dirty && (
              <span className="git-stats">
                {repo.filesChanged > 0 && <span className="git-stat-files">M{repo.filesChanged}</span>}
                {repo.insertions > 0 && <span className="git-stat-ins">+{repo.insertions}</span>}
                {repo.deletions > 0 && <span className="git-stat-del">-{repo.deletions}</span>}
              </span>
            )}
          </span>
        ))}
      </div>
    </div>
  )
}
