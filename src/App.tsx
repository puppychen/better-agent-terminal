import { useEffect, useState, useCallback } from 'react'
import { workspaceStore } from './stores/workspace-store'
import { settingsStore } from './stores/settings-store'
import { Sidebar } from './components/Sidebar'
import { WorkspaceView } from './components/WorkspaceView'
import { SettingsPanel } from './components/SettingsPanel'
import { AboutPanel } from './components/AboutPanel'
import type { AppState } from './types'

export default function App() {
  const [state, setState] = useState<AppState>(workspaceStore.getState())
  const [showSettings, setShowSettings] = useState(false)
  const [showAbout, setShowAbout] = useState(false)

  useEffect(() => {
    const unsubscribe = workspaceStore.subscribe(() => {
      setState(workspaceStore.getState())
    })

    // Global listener for all terminal output - updates activity for ALL terminals
    // This is needed because WorkspaceView only renders terminals for the active workspace
    const unsubscribeOutput = window.electronAPI.pty.onOutput((id) => {
      workspaceStore.updateTerminalActivity(id)
    })

    // Global keyboard shortcuts for terminal/workspace switching
    const handleKeyDown = (e: KeyboardEvent) => {
      // Debug: log all key events with modifiers
      if (e.ctrlKey || e.altKey || e.metaKey) {
        console.log('Key event:', { key: e.key, code: e.code, ctrlKey: e.ctrlKey, altKey: e.altKey, shiftKey: e.shiftKey, metaKey: e.metaKey })
      }

      // Ctrl+Tab / Ctrl+Shift+Tab - Terminal switching
      if (e.ctrlKey && !e.altKey && e.key === 'Tab') {
        e.preventDefault()
        console.log('Terminal switch triggered')
        if (e.shiftKey) {
          workspaceStore.switchToPreviousTerminal()
        } else {
          workspaceStore.switchToNextTerminal()
        }
      }

      // Ctrl+Alt+Tab / Ctrl+Alt+Shift+Tab - Workspace switching
      // Also support Cmd+Option+Tab on macOS
      if ((e.ctrlKey || e.metaKey) && e.altKey && e.key === 'Tab') {
        e.preventDefault()
        console.log('Workspace switch triggered')
        if (e.shiftKey) {
          workspaceStore.switchToPreviousWorkspace()
        } else {
          workspaceStore.switchToNextWorkspace()
        }
      }

      // Alternative: Ctrl+[ and Ctrl+] for workspace switching (works better cross-platform)
      if (e.ctrlKey && !e.altKey && !e.shiftKey && (e.key === '[' || e.key === ']')) {
        e.preventDefault()
        console.log('Workspace switch (bracket) triggered')
        if (e.key === '[') {
          workspaceStore.switchToPreviousWorkspace()
        } else {
          workspaceStore.switchToNextWorkspace()
        }
      }
    }

    document.addEventListener('keydown', handleKeyDown)

    // Load saved workspaces and settings on startup
    workspaceStore.load()
    settingsStore.load()

    return () => {
      unsubscribe()
      unsubscribeOutput()
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [])

  const handleAddWorkspace = useCallback(async () => {
    const folderPath = await window.electronAPI.dialog.selectFolder()
    if (folderPath) {
      const name = folderPath.split(/[/\\]/).pop() || 'Workspace'
      workspaceStore.addWorkspace(name, folderPath)
      workspaceStore.save()
    }
  }, [])

  const activeWorkspace = state.workspaces.find(w => w.id === state.activeWorkspaceId)

  return (
    <div className="app">
      <Sidebar
        workspaces={state.workspaces}
        activeWorkspaceId={state.activeWorkspaceId}
        onSelectWorkspace={(id) => workspaceStore.setActiveWorkspace(id)}
        onAddWorkspace={handleAddWorkspace}
        onRemoveWorkspace={(id) => {
          workspaceStore.removeWorkspace(id)
          workspaceStore.save()
        }}
        onRenameWorkspace={(id, alias) => {
          workspaceStore.renameWorkspace(id, alias)
          workspaceStore.save()
        }}
        onOpenSettings={() => setShowSettings(true)}
        onOpenAbout={() => setShowAbout(true)}
      />
      <main className="main-content">
        {activeWorkspace ? (
          <WorkspaceView
            workspace={activeWorkspace}
            terminals={workspaceStore.getWorkspaceTerminals(activeWorkspace.id)}
            focusedTerminalId={state.focusedTerminalId}
          />
        ) : (
          <div className="empty-state">
            <h2>Welcome to Better Agent Terminal</h2>
            <p>Click "+ Add Workspace" to get started</p>
          </div>
        )}
      </main>
      {showSettings && (
        <SettingsPanel onClose={() => setShowSettings(false)} />
      )}
      {showAbout && (
        <AboutPanel onClose={() => setShowAbout(false)} />
      )}
    </div>
  )
}
