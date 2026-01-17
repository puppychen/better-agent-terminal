import { useEffect, useState, useCallback } from 'react'
import { workspaceStore } from './stores/workspace-store'
import { Sidebar } from './components/Sidebar'
import { AboutPanel } from './components/AboutPanel'
import { ToastProvider } from './components/Toast'
import type { AppState } from './types'

export default function App() {
  const [state, setState] = useState<AppState>(workspaceStore.getState())
  const [showAbout, setShowAbout] = useState(false)

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
    if (folderPath) {
      const name = folderPath.split(/[/\\]/).pop() || 'Workspace'
      workspaceStore.addWorkspace(name, folderPath)
    }
  }, [])

  return (
    <ToastProvider>
      <div className="app app-sidebar-only">
        <Sidebar
          workspaces={state.workspaces}
          activeWorkspaceId={state.activeWorkspaceId}
          onSelectWorkspace={(id) => workspaceStore.setActiveWorkspace(id)}
          onAddWorkspace={handleAddWorkspace}
          onRemoveWorkspace={(id) => workspaceStore.removeWorkspace(id)}
          onRenameWorkspace={(id, alias) => workspaceStore.renameWorkspace(id, alias)}
          onSetWorkspaceRole={(id, role) => workspaceStore.setWorkspaceRole(id, role)}
          onSetWorkspaceTab={(id, tabId) => workspaceStore.setWorkspaceTab(id, tabId)}
          onReorderWorkspaces={(fromId, toId) => workspaceStore.reorderWorkspaces(fromId, toId)}
          onOpenAbout={() => setShowAbout(true)}
        />
        {showAbout && (
          <AboutPanel onClose={() => setShowAbout(false)} />
        )}
      </div>
    </ToastProvider>
  )
}
