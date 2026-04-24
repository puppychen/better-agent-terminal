import { useEffect, useState, useCallback, useRef } from 'react'
import { workspaceStore } from './stores/workspace-store'
import { terminalStore } from './stores/terminal-store'
import { Sidebar } from './components/Sidebar'
import { MainPanel } from './components/MainPanel'
import { AboutPanel } from './components/AboutPanel'
import { ToastProvider, useToast } from './components/Toast'
import { DuplicateWorkspaceDialog } from './components/DuplicateWorkspaceDialog'
import { ConfirmDialog } from './components/ConfirmDialog'
import type { AppState, Workspace } from './types'

function AppContent() {
  const [state, setState] = useState<AppState>(workspaceStore.getState())
  const [showAbout, setShowAbout] = useState(false)
  const [closeConfirm, setCloseConfirm] = useState<{
    terminalId: string
    label: string
    isAgent: boolean
  } | null>(null)
  const [showQuitConfirm, setShowQuitConfirm] = useState(false)
  const [duplicateInfo, setDuplicateInfo] = useState<{
    folderPath: string
    existingWorkspace: Workspace
  } | null>(null)
  const { showToast } = useToast()

  // Resizable sidebar
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    const saved = localStorage.getItem('sidebar-width')
    return saved ? Math.max(150, Math.min(600, Number(saved))) : 260
  })
  const isDragging = useRef(false)

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!isDragging.current) return
      const newWidth = Math.max(150, Math.min(600, e.clientX))
      setSidebarWidth(newWidth)
    }
    const handleMouseUp = () => {
      if (!isDragging.current) return
      isDragging.current = false
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', handleMouseUp)
    return () => {
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
    }
  }, [])

  useEffect(() => {
    localStorage.setItem('sidebar-width', String(sidebarWidth))
  }, [sidebarWidth])

  const handleResizeStart = useCallback(() => {
    isDragging.current = true
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
  }, [])

  useEffect(() => {
    const unsubscribe = workspaceStore.subscribe(() => {
      setState(workspaceStore.getState())
    })

    // Global keyboard shortcuts for workspace switching
    const handleKeyDown = (e: KeyboardEvent) => {
      // Ctrl+[ and Ctrl+] for workspace switching
      if (e.ctrlKey && !e.altKey && !e.shiftKey && (e.key === '[' || e.key === ']')) {
        e.preventDefault()
        if (e.key === '[') {
          workspaceStore.switchToPreviousWorkspace()
        } else {
          workspaceStore.switchToNextWorkspace()
        }
      }
    }

    document.addEventListener('keydown', handleKeyDown)

    // Window focus — 清除當前 active terminal 的 unread（使用者切回視窗等於看到了）
    const unsubWindowFocus = window.electronAPI.window?.onFocus(() => {
      const { activeTerminalId } = terminalStore.getState()
      if (activeTerminalId) {
        terminalStore.markUnread(activeTerminalId, false)
      }
    })

    // Cmd+W → close active terminal tab with confirmation
    const unsubCloseTab = window.electronAPI.window?.onCloseActiveTab(() => {
      const { activeTerminalId, terminals } = terminalStore.getState()
      if (!activeTerminalId) return
      const terminal = terminals.find(t => t.id === activeTerminalId)
      if (!terminal) return

      setCloseConfirm({
        terminalId: activeTerminalId,
        label: terminal.label || 'terminal',
        isAgent: terminal.type === 'agent'
      })
    })

    // Cmd+Q / window close → show quit confirmation
    const unsubQuit = window.electronAPI.window?.onConfirmQuit(() => {
      setShowQuitConfirm(true)
    })

    // 路由優先順序：sessionId → cwd（兼容舊版 hook）
    // 多 agent 同 cwd 時，sessionId 才能精準對應到正確的 terminal
    const findAgentTarget = (cwd: string, sessionId?: string) => {
      const terminals = terminalStore.getState().terminals
      if (sessionId) {
        const bySession = terminals.find(t => t.claudeSessionId === sessionId && t.type === 'agent')
        if (bySession) return bySession
      }
      const activeWorkspaceId = workspaceStore.getState().activeWorkspaceId
      return terminals.find(t =>
        t.cwd === cwd && t.type === 'agent' && t.workspaceId === activeWorkspaceId
      ) || terminals.find(t => t.cwd === cwd && t.type === 'agent')
    }

    // 點 macOS 通知 → 切換到對應 workspace + terminal
    const unsubFocusTerminal = window.electronAPI.notify?.onFocusTerminal?.(({ cwd, sessionId }) => {
      const target = findAgentTarget(cwd, sessionId)
      if (!target) return
      if (target.workspaceId !== workspaceStore.getState().activeWorkspaceId) {
        workspaceStore.setActiveWorkspace(target.workspaceId)
      }
      terminalStore.setActiveTerminal(target.id)
    })

    // Notify event → mark terminal as unread
    const unsubNotify = window.electronAPI.notify?.onEvent?.((event) => {
      const target = findAgentTarget(event.cwd, event.sessionId)
      if (!target) return
      const { activeTerminalId } = terminalStore.getState()
      if (target.id === activeTerminalId && document.hasFocus()) return
      terminalStore.markUnread(target.id, true)
    })

    // Load saved workspaces on startup
    workspaceStore.load()

    return () => {
      unsubscribe()
      unsubWindowFocus?.()
      unsubCloseTab?.()
      unsubQuit?.()
      unsubNotify?.()
      unsubFocusTerminal?.()
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [])

  const handleAddWorkspace = useCallback(async () => {
    const folderPath = await window.electronAPI.dialog.selectFolder()
    if (!folderPath) return

    const existing = workspaceStore.getState().workspaces.find(
      w => w.folderPath === folderPath
    )
    if (existing) {
      setDuplicateInfo({ folderPath, existingWorkspace: existing })
      return
    }

    const name = folderPath.split(/[/\\]/).pop() || 'Workspace'
    workspaceStore.addWorkspace(name, folderPath)
  }, [])

  const handleDuplicateGoToExisting = useCallback(() => {
    if (!duplicateInfo) return
    const { existingWorkspace } = duplicateInfo
    workspaceStore.setActiveWorkspace(existingWorkspace.id)
    const groupName = existingWorkspace.group || 'Others'
    showToast(`已跳轉到「${existingWorkspace.alias || existingWorkspace.name}」（${groupName}）`, 'info')
    setDuplicateInfo(null)
  }, [duplicateInfo, showToast])

  const handleDuplicateAddAnyway = useCallback(() => {
    if (!duplicateInfo) return
    const name = duplicateInfo.folderPath.split(/[/\\]/).pop() || 'Workspace'
    workspaceStore.addWorkspace(name, duplicateInfo.folderPath)
    setDuplicateInfo(null)
  }, [duplicateInfo])

  const handleCreateEmbeddedTerminal = useCallback(async (
    workspaceId: string, cwd: string,
    options?: { type?: 'shell' | 'agent'; agentType?: 'claude'; initialCommand?: string; claudeSessionId?: string; label?: string }
  ) => {
    await terminalStore.createTerminal(workspaceId, cwd, options)
  }, [])

  // === Claude session label auto-tracking ===
  // 對所有 agent terminal 的 cwd 動態 watch，當 sessions-index 變動時自動更新 label（除非用戶已手動鎖定）
  useEffect(() => {
    const watched = new Set<string>()

    const refreshLabelsForCwd = async (cwd: string) => {
      const allAgents = terminalStore.getState().terminals
        .filter(t => t.type === 'agent' && t.agentType === 'claude' && t.cwd === cwd)
      if (allAgents.length === 0) return
      const result = await window.electronAPI.claudeSessions.list(cwd)
      if (!result.ok) return

      // === Phase 1: 回填未綁 sessionId 的 -c agent ===
      // 啟發式：對 modified 在 terminal createdAt 之後且未被別人綁的 entry，
      // 按 modified 升序與 unbound terminal createdAt 升序 1:1 配對。
      const unboundAgents = allAgents.filter(t => !t.claudeSessionId)
      const filledMap = new Map<string, string>()  // terminalId → sessionId
      if (unboundAgents.length > 0) {
        const usedSessionIds = new Set(allAgents.map(a => a.claudeSessionId).filter(Boolean) as string[])
        const minCreatedAt = Math.min(...unboundAgents.map(t => t.createdAt))
        const candidates = result.entries
          .filter(e => new Date(e.modified).getTime() >= minCreatedAt)
          .filter(e => !usedSessionIds.has(e.sessionId))
          .sort((a, b) => new Date(a.modified).getTime() - new Date(b.modified).getTime())
        const sortedUnbound = [...unboundAgents].sort((a, b) => a.createdAt - b.createdAt)
        sortedUnbound.forEach((agent, idx) => {
          const entry = candidates[idx]
          if (entry) {
            filledMap.set(agent.id, entry.sessionId)
            terminalStore.setClaudeSessionId(agent.id, entry.sessionId)
          }
        })
      }

      // === Phase 2: 對所有有 sessionId（含剛回填）的 agent 套 label ===
      for (const term of allAgents) {
        const sessionId = filledMap.get(term.id) ?? term.claudeSessionId
        if (!sessionId) continue
        const entry = result.entries.find(e => e.sessionId === sessionId)
        if (!entry) continue
        const summary = entry.summary?.trim()
        const fp = (entry.firstPrompt || '').trim()
        const fallback = fp.length > 60 ? fp.slice(0, 60) + '…' : fp
        const newLabel = summary || fallback
        if (newLabel) terminalStore.setLabel(term.id, newLabel, false)
      }
    }

    const syncWatchers = () => {
      const next = new Set(
        terminalStore.getState().terminals
          .filter(t => t.type === 'agent' && t.agentType === 'claude')
          .map(t => t.cwd)
      )
      // 新增
      for (const cwd of next) {
        if (!watched.has(cwd)) {
          window.electronAPI.claudeSessions.watch(cwd)
          watched.add(cwd)
          // 啟動時立即 sync 一次（resume 場景已有 entry 可套用）
          refreshLabelsForCwd(cwd)
        }
      }
      // 移除
      for (const cwd of watched) {
        if (!next.has(cwd)) {
          window.electronAPI.claudeSessions.unwatch(cwd)
          watched.delete(cwd)
        }
      }
    }

    const unsubStore = terminalStore.subscribe(syncWatchers)
    syncWatchers()

    const unsubChange = window.electronAPI.claudeSessions.onChange((cwd) => {
      refreshLabelsForCwd(cwd)
    })

    return () => {
      unsubStore()
      unsubChange()
      for (const cwd of watched) window.electronAPI.claudeSessions.unwatch(cwd)
      watched.clear()
    }
  }, [])

  // === Claude Agent launch ===
  // 簡化：不再使用對話框，直接啟動。
  // Sidebar Claude 按鈕：已有 active agent → 切過去；否則 -c 沿用最近 session。
  // MainPanel +C 按鈕：永遠純新建（--session-id uuid 預先綁定，方便 label 自動跟隨）。

  const handleLaunchAgent = useCallback(async (workspaceId: string, cwd: string) => {
    const existing = terminalStore.getTerminalsForWorkspace(workspaceId)
      .find(t => t.type === 'agent' && t.agentType === 'claude')
    if (existing) {
      await terminalStore.setActiveTerminal(existing.id)
      return
    }
    // -c continue 最近一次。sessionId 由 claude 自己決定，我們不做精準 label 跟隨；用戶可右鍵改名
    terminalStore.createTerminal(workspaceId, cwd, {
      type: 'agent',
      agentType: 'claude',
      initialCommand: `claude -c --model 'claude-opus-4-6[1M]' --permission-mode bypassPermissions`,
      labelLockedByUser: true  // 鎖定 default label，避免 onChange 誤套用其他 entry summary
    })
  }, [])

  const handleAddAgent = useCallback((workspaceId: string, cwd: string) => {
    const sessionId = crypto.randomUUID()
    terminalStore.createTerminal(workspaceId, cwd, {
      type: 'agent',
      agentType: 'claude',
      initialCommand: `claude --session-id ${sessionId} --model 'claude-opus-4-6[1M]' --permission-mode bypassPermissions`,
      claudeSessionId: sessionId
    })
  }, [])

  // === Codex Agent launch ===
  // resume --last 接最近 session；首次無歷史時 fallback 新建
  const handleAddCodexAgent = useCallback((workspaceId: string, cwd: string) => {
    terminalStore.createTerminal(workspaceId, cwd, {
      type: 'agent',
      agentType: 'codex',
      initialCommand: 'codex resume --last --full-auto || codex --full-auto'
    })
  }, [])

  const handleCycleAgent = useCallback((direction: 1 | -1) => {
    const { terminals, activeTerminalId } = terminalStore.getState()
    const agents = terminals.filter(t => t.type === 'agent')
    if (agents.length <= 1) return

    const currentIdx = agents.findIndex(t => t.id === activeTerminalId)
    const nextIdx = (currentIdx + direction + agents.length) % agents.length
    const nextAgent = agents[nextIdx]

    workspaceStore.setActiveWorkspace(nextAgent.workspaceId)
    terminalStore.setActiveTerminal(nextAgent.id)
  }, [])

  const activeWorkspace = state.workspaces.find(w => w.id === state.activeWorkspaceId)

  return (
    <div className="app">
      <Sidebar
        width={sidebarWidth}
        workspaces={state.workspaces}
        activeWorkspaceId={state.activeWorkspaceId}
        groups={workspaceStore.getGroups()}
        onSelectWorkspace={(id) => workspaceStore.setActiveWorkspace(id)}
        onAddWorkspace={handleAddWorkspace}
        onRemoveWorkspace={(id) => workspaceStore.removeWorkspace(id)}
        onRenameWorkspace={(id, alias) => workspaceStore.renameWorkspace(id, alias)}
        onSetWorkspaceRole={(id, role) => workspaceStore.setWorkspaceRole(id, role)}
        onSetWorkspaceGroup={(id, group) => workspaceStore.setWorkspaceGroup(id, group)}
        onReorderWorkspaces={(fromId, toId) => workspaceStore.reorderWorkspaces(fromId, toId)}
        onAddGroup={(name) => workspaceStore.addGroup(name)}
        onRemoveGroup={(group) => workspaceStore.removeGroup(group)}
        onRenameGroup={(oldName, newName) => workspaceStore.renameGroup(oldName, newName)}
        onOpenAbout={() => setShowAbout(true)}
        onCreateEmbeddedTerminal={handleCreateEmbeddedTerminal}
        onLaunchAgent={handleLaunchAgent}
      />
      <div
        className="resize-handle"
        onMouseDown={handleResizeStart}
      />
      <MainPanel
        activeWorkspaceId={state.activeWorkspaceId}
        workspaceCwd={activeWorkspace?.folderPath ?? null}
        onCycleAgent={handleCycleAgent}
        onAddAgent={handleAddAgent}
        onAddCodexAgent={handleAddCodexAgent}
        onRequestCloseTab={(id) => {
          const terminal = terminalStore.getState().terminals.find(t => t.id === id)
          if (!terminal) return
          setCloseConfirm({
            terminalId: id,
            label: terminal.label || 'terminal',
            isAgent: terminal.type === 'agent'
          })
        }}
      />
      {showAbout && (
        <AboutPanel onClose={() => setShowAbout(false)} />
      )}
      {duplicateInfo && (
        <DuplicateWorkspaceDialog
          folderPath={duplicateInfo.folderPath}
          existingName={duplicateInfo.existingWorkspace.alias || duplicateInfo.existingWorkspace.name}
          existingGroupName={duplicateInfo.existingWorkspace.group || 'Others'}
          onGoToExisting={handleDuplicateGoToExisting}
          onAddAnyway={handleDuplicateAddAnyway}
          onCancel={() => setDuplicateInfo(null)}
        />
      )}
      {closeConfirm && (
        <ConfirmDialog
          title={closeConfirm.isAgent ? 'Close Agent' : 'Close Terminal'}
          message={`Close "${closeConfirm.label}"?`}
          detail={closeConfirm.isAgent ? 'The running agent process will be terminated.' : undefined}
          confirmLabel={closeConfirm.isAgent ? 'Terminate' : 'Close'}
          danger={closeConfirm.isAgent}
          onConfirm={() => {
            terminalStore.killTerminal(closeConfirm.terminalId)
            setCloseConfirm(null)
          }}
          onCancel={() => setCloseConfirm(null)}
        />
      )}
      {showQuitConfirm && (
        <ConfirmDialog
          title="Quit Better Agent Workspace"
          message="Are you sure you want to quit?"
          detail="All running terminals and agents will be terminated."
          confirmLabel="Quit"
          danger
          onConfirm={() => {
            setShowQuitConfirm(false)
            window.electronAPI.window.confirmQuit()
          }}
          onCancel={() => setShowQuitConfirm(false)}
        />
      )}
    </div>
  )
}

export default function App() {
  return (
    <ToastProvider>
      <AppContent />
    </ToastProvider>
  )
}
