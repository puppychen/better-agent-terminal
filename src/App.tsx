import { useEffect, useState, useCallback } from 'react'
import { workspaceStore } from './stores/workspace-store'
import { Sidebar } from './components/Sidebar'
import { AboutPanel } from './components/AboutPanel'
import { ToastProvider, useToast } from './components/Toast'
import { DuplicateWorkspaceDialog } from './components/DuplicateWorkspaceDialog'
import type { AppState, Workspace } from './types'

function AppContent() {
  const [state, setState] = useState<AppState>(workspaceStore.getState())
  const [showAbout, setShowAbout] = useState(false)
  const [duplicateInfo, setDuplicateInfo] = useState<{
    folderPath: string
    existingWorkspace: Workspace
  } | null>(null)
  const { showToast } = useToast()

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

    // Load saved workspaces on startup
    workspaceStore.load()

    return () => {
      unsubscribe()
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
    const tabName = state.tabs.find(t => t.id === (existingWorkspace.tabId || 1))?.name || 'Tab'
    showToast(`已跳轉到「${existingWorkspace.alias || existingWorkspace.name}」（${tabName}）`, 'info')
    setDuplicateInfo(null)
  }, [duplicateInfo, state.tabs, showToast])

  const handleDuplicateAddAnyway = useCallback(() => {
    if (!duplicateInfo) return
    const name = duplicateInfo.folderPath.split(/[/\\]/).pop() || 'Workspace'
    workspaceStore.addWorkspace(name, duplicateInfo.folderPath)
    setDuplicateInfo(null)
  }, [duplicateInfo])

  return (
    <div className="app app-sidebar-only">
      <Sidebar
        workspaces={state.workspaces}
        activeWorkspaceId={state.activeWorkspaceId}
        tabs={state.tabs}
        onSelectWorkspace={(id) => workspaceStore.setActiveWorkspace(id)}
        onAddWorkspace={handleAddWorkspace}
        onRemoveWorkspace={(id) => workspaceStore.removeWorkspace(id)}
        onRenameWorkspace={(id, alias) => workspaceStore.renameWorkspace(id, alias)}
        onSetWorkspaceRole={(id, role) => workspaceStore.setWorkspaceRole(id, role)}
        onSetWorkspaceTab={(id, tabId) => workspaceStore.setWorkspaceTab(id, tabId)}
        onReorderWorkspaces={(fromId, toId) => workspaceStore.reorderWorkspaces(fromId, toId)}
        onAddTab={(name) => workspaceStore.addTab(name)}
        onRemoveTab={(tabId) => workspaceStore.removeTab(tabId)}
        onRenameTab={(tabId, name) => workspaceStore.renameTab(tabId, name)}
        onOpenAbout={() => setShowAbout(true)}
      />
      {showAbout && (
        <AboutPanel onClose={() => setShowAbout(false)} />
      )}
      {duplicateInfo && (
        <DuplicateWorkspaceDialog
          folderPath={duplicateInfo.folderPath}
          existingName={duplicateInfo.existingWorkspace.alias || duplicateInfo.existingWorkspace.name}
          existingTabName={state.tabs.find(t => t.id === (duplicateInfo.existingWorkspace.tabId || 1))?.name || 'Tab'}
          onGoToExisting={handleDuplicateGoToExisting}
          onAddAnyway={handleDuplicateAddAnyway}
          onCancel={() => setDuplicateInfo(null)}
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
