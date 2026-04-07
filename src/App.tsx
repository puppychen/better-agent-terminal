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

    // 點 macOS 通知 → 切換到對應 workspace + terminal
    const unsubFocusTerminal = window.electronAPI.notify?.onFocusTerminal?.(({ cwd }) => {
      const terminals = terminalStore.getState().terminals
      const target = terminals.find(t => t.cwd === cwd && t.type === 'agent')
      if (!target) return
      // 切 workspace
      if (target.workspaceId !== workspaceStore.getState().activeWorkspaceId) {
        workspaceStore.setActiveWorkspace(target.workspaceId)
      }
      // 切 terminal
      terminalStore.setActiveTerminal(target.id)
    })

    // Notify event → mark terminal as unread
    const unsubNotify = window.electronAPI.notify?.onEvent?.((event) => {
      const terminals = terminalStore.getState().terminals
      // 找出 cwd 對應的 agent terminal
      // 優先找 active workspace 內的，否則找任何符合的
      const activeWorkspaceId = workspaceStore.getState().activeWorkspaceId
      const target = terminals.find(t =>
        t.cwd === event.cwd && t.type === 'agent' && t.workspaceId === activeWorkspaceId
      ) || terminals.find(t => t.cwd === event.cwd && t.type === 'agent')
      if (!target) return
      // 若已是 active terminal 且視窗在前景 → 不標（使用者正在看）
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
    options?: { type?: 'shell' | 'agent'; agentType?: 'claude'; initialCommand?: string }
  ) => {
    await terminalStore.createTerminal(workspaceId, cwd, options)
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
      />
      <div
        className="resize-handle"
        onMouseDown={handleResizeStart}
      />
      <MainPanel
        activeWorkspaceId={state.activeWorkspaceId}
        workspaceCwd={activeWorkspace?.folderPath ?? null}
        onCycleAgent={handleCycleAgent}
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
