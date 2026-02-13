import { useState, useRef, useEffect, useMemo, useCallback } from 'react'
import type { Workspace, CodeAgentType, SidebarTab } from '../types'
import { PRESET_ROLES } from '../types'
import { CodeAgentSelectDialog } from './CodeAgentSelectDialog'

interface TerminalTabState {
  tty: string
  busy: boolean
  processes: string[]
  cwd?: string
}

interface AgentStatus {
  type: 'claude' | 'happy'
}

interface SidebarProps {
  workspaces: Workspace[]
  activeWorkspaceId: string | null
  tabs: SidebarTab[]
  onSelectWorkspace: (id: string) => void
  onAddWorkspace: () => void
  onRemoveWorkspace: (id: string) => void
  onRenameWorkspace: (id: string, alias: string) => void
  onSetWorkspaceRole: (id: string, role: string) => void
  onSetWorkspaceTab: (id: string, tabId: number) => void
  onReorderWorkspaces: (fromId: string, toId: string) => void
  onAddTab: (name?: string) => void
  onRemoveTab: (tabId: number) => void
  onRenameTab: (tabId: number, name: string) => void
  onOpenAbout: () => void
  width?: number
}

function getRoleColor(role?: string): string {
  if (!role) return 'transparent'
  const preset = PRESET_ROLES.find(r => r.name.toLowerCase() === role.toLowerCase() || r.id === role.toLowerCase())
  return preset?.color || '#dfdbc3'
}

export function Sidebar({
  workspaces,
  activeWorkspaceId,
  tabs,
  onSelectWorkspace,
  onAddWorkspace,
  onRemoveWorkspace,
  onRenameWorkspace,
  onSetWorkspaceRole,
  onSetWorkspaceTab,
  onReorderWorkspaces,
  onAddTab,
  onRemoveTab,
  onRenameTab,
  onOpenAbout,
  width
}: SidebarProps) {
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editValue, setEditValue] = useState('')
  const [roleMenuId, setRoleMenuId] = useState<string | null>(null)
  const [customRoleInput, setCustomRoleInput] = useState('')
  const [draggedIndex, setDraggedIndex] = useState<number | null>(null)
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null)
  const [dragOverTabId, setDragOverTabId] = useState<number | null>(null)
  const [ideMenuId, setIdeMenuId] = useState<string | null>(null)
  const [activeTabId, setActiveTabId] = useState<number>(1)
  const [terminalAgentDialogId, setTerminalAgentDialogId] = useState<string | null>(null)
  const [tilingEnabled, setTilingEnabled] = useState(false)
  const [terminalStatus, setTerminalStatus] = useState<{ claude: boolean; happy: boolean; terminal: boolean } | null>(null)
  const [editingTabId, setEditingTabId] = useState<number | null>(null)
  const [editTabValue, setEditTabValue] = useState('')
  const [tabContextMenuId, setTabContextMenuId] = useState<number | null>(null)
  const [tabContextMenuPos, setTabContextMenuPos] = useState<{ x: number; y: number } | null>(null)
  const [agentStatuses, setAgentStatuses] = useState<Record<string, AgentStatus | null>>({})
  const inputRef = useRef<HTMLInputElement>(null)
  const tabInputRef = useRef<HTMLInputElement>(null)
  const roleMenuRef = useRef<HTMLDivElement>(null)
  const ideMenuRef = useRef<HTMLDivElement>(null)
  const lastDragOverTime = useRef<number>(0)
  const draggedWorkspaceId = useRef<string | null>(null)

  // Memoize role colors to avoid recalculating on every render
  const roleColors = useMemo(() => {
    const colors: Record<string, string> = {}
    workspaces.forEach(ws => {
      if (ws.role && !colors[ws.role]) {
        colors[ws.role] = getRoleColor(ws.role)
      }
    })
    return colors
  }, [workspaces])

  // Filter workspaces by active tab
  const filteredWorkspaces = useMemo(() =>
    workspaces.filter(w => (w.tabId || 1) === activeTabId),
    [workspaces, activeTabId]
  )

  // Count workspaces per tab
  const tabCounts = useMemo(() => {
    const counts: Record<number, number> = {}
    tabs.forEach(t => { counts[t.id] = 0 })
    workspaces.forEach(w => {
      const tabId = w.tabId || 1
      counts[tabId] = (counts[tabId] || 0) + 1
    })
    return counts
  }, [workspaces, tabs])

  // Aggregate agent status per tab: true if any workspace in the tab has an agent
  const tabHasAgent = useMemo(() => {
    const result: Record<number, boolean> = {}
    tabs.forEach(t => { result[t.id] = false })
    workspaces.forEach(ws => {
      if (agentStatuses[ws.id]) {
        result[ws.tabId || 1] = true
      }
    })
    return result
  }, [tabs, workspaces, agentStatuses])

  // Load tiling status on mount
  useEffect(() => {
    window.electronAPI.tiling.getStatus().then(s => setTilingEnabled(s.enabled))
  }, [])

  // Check terminal status when active workspace changes
  useEffect(() => {
    if (!activeWorkspaceId) {
      setTerminalStatus(null)
      return
    }
    const ws = workspaces.find(w => w.id === activeWorkspaceId)
    if (!ws) {
      setTerminalStatus(null)
      return
    }
    window.electronAPI.shell.checkTerminals(ws.folderPath).then(setTerminalStatus)
  }, [activeWorkspaceId, workspaces])

  useEffect(() => {
    if (editingId && inputRef.current) {
      inputRef.current.focus()
      inputRef.current.select()
    }
  }, [editingId])

  // Close menus when clicking outside (unified listener for both menus)
  useEffect(() => {
    if (!roleMenuId && !ideMenuId) return

    const handleClickOutside = (e: MouseEvent) => {
      const target = e.target as Node
      if (roleMenuId && roleMenuRef.current && !roleMenuRef.current.contains(target)) {
        setRoleMenuId(null)
        setCustomRoleInput('')
      }
      if (ideMenuId && ideMenuRef.current && !ideMenuRef.current.contains(target)) {
        setIdeMenuId(null)
      }
    }

    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [roleMenuId, ideMenuId])

  // Focus tab rename input when editing
  useEffect(() => {
    if (editingTabId !== null && tabInputRef.current) {
      tabInputRef.current.focus()
      tabInputRef.current.select()
    }
  }, [editingTabId])

  // Close tab context menu on click outside
  useEffect(() => {
    if (tabContextMenuId === null) return
    const handleClick = () => {
      setTabContextMenuId(null)
      setTabContextMenuPos(null)
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [tabContextMenuId])

  // Ensure activeTabId exists in tabs
  useEffect(() => {
    if (tabs.length > 0 && !tabs.find(t => t.id === activeTabId)) {
      setActiveTabId(tabs[0].id)
    }
  }, [tabs, activeTabId])

  // Agent status polling — only when window is visible
  const workspacesRef = useRef(workspaces)
  workspacesRef.current = workspaces
  const pollingTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const pollAgentStatuses = useCallback(async () => {
    try {
      const terminalStates: TerminalTabState[] = await window.electronAPI.shell.getAllTerminalStates()
      const newStatuses: Record<string, AgentStatus | null> = {}

      for (const ws of workspacesRef.current) {
        let found: AgentStatus | null = null
        for (const ts of terminalStates) {
          if (ts.cwd === ws.folderPath) {
            const hasClaude = ts.processes.some(p => p.includes('claude'))
            const hasHappy = ts.processes.some(p => p.includes('happy'))
            if (hasClaude || hasHappy) {
              found = { type: hasClaude ? 'claude' : 'happy' }
              break
            }
          }
        }
        newStatuses[ws.id] = found
      }

      setAgentStatuses(newStatuses)
    } catch {
      // Silently ignore polling errors
    }
  }, [])

  const startPolling = useCallback(() => {
    if (pollingTimerRef.current) return
    pollAgentStatuses()
    pollingTimerRef.current = setInterval(pollAgentStatuses, 30000)
  }, [pollAgentStatuses])

  const stopPolling = useCallback(() => {
    if (!pollingTimerRef.current) return
    clearInterval(pollingTimerRef.current)
    pollingTimerRef.current = null
  }, [])

  // Poll only when window is focused; stop when user switches to another app
  useEffect(() => {
    const handleFocus = () => startPolling()
    const handleBlur = () => stopPolling()

    // Start if already focused
    if (document.hasFocus()) {
      startPolling()
    }

    window.addEventListener('focus', handleFocus)
    window.addEventListener('blur', handleBlur)
    return () => {
      window.removeEventListener('focus', handleFocus)
      window.removeEventListener('blur', handleBlur)
      stopPolling()
    }
  }, [startPolling, stopPolling])

  const handleToggleTiling = async () => {
    if (tilingEnabled) {
      await window.electronAPI.tiling.disable()
      setTilingEnabled(false)
    } else {
      await window.electronAPI.tiling.enable()
      setTilingEnabled(true)
    }
  }

  // When selecting a workspace, try to focus the corresponding Terminal tab
  const handleWorkspaceSelect = async (workspace: Workspace) => {
    onSelectWorkspace(workspace.id)

    // Check all terminal types available
    const status = await window.electronAPI.shell.checkTerminals(workspace.folderPath)
    setTerminalStatus(status)

    // Focus priority: agent first, then pure terminal
    if (status.claude) {
      await window.electronAPI.shell.focusAgent(workspace.folderPath, 'claude')
    } else if (status.happy) {
      await window.electronAPI.shell.focusAgent(workspace.folderPath, 'happy')
    } else if (status.terminal) {
      await window.electronAPI.shell.focusTerminalAtPath(workspace.folderPath)
    }
  }

  // Focus a specific terminal type for the active workspace
  const handleFocusTerminal = async (type: 'claude' | 'happy' | 'terminal') => {
    const ws = workspaces.find(w => w.id === activeWorkspaceId)
    if (!ws) return

    if (type === 'terminal') {
      await window.electronAPI.shell.focusTerminalAtPath(ws.folderPath)
    } else {
      await window.electronAPI.shell.focusAgent(ws.folderPath, type)
    }
  }

  // Refresh terminal status for active workspace
  const refreshTerminalStatus = async () => {
    const ws = workspaces.find(w => w.id === activeWorkspaceId)
    if (!ws) return
    const status = await window.electronAPI.shell.checkTerminals(ws.folderPath)
    setTerminalStatus(status)
  }

  const handleOpenWithIde = (folderPath: string, appName: string) => {
    window.electronAPI.shell.openWithApp(appName, folderPath)
    setIdeMenuId(null)
  }

  const handleOpenNativeTerminal = (folderPath: string, e: React.MouseEvent) => {
    e.stopPropagation()
    window.electronAPI.shell.openTerminalAtPath(folderPath)
  }

  // Smart CAgent click handler: check if running first, then focus or show dialog
  const handleCAgentClick = async (workspace: Workspace, e: React.MouseEvent) => {
    e.stopPropagation()

    // Check if agent is already running at this path
    const result = await window.electronAPI.shell.checkAgentRunning(workspace.folderPath)

    if (result.running && result.type) {
      // Agent is running, focus on it
      await window.electronAPI.shell.focusAgent(workspace.folderPath, result.type as 'claude' | 'happy')
    } else {
      // No agent running, show selection dialog
      setTerminalAgentDialogId(workspace.id)
    }
  }

  const handleTerminalAgentSelect = (folderPath: string, agentType: CodeAgentType) => {
    const commands: Record<CodeAgentType, string> = {
      happy: 'happy -c --fork-session',
      claude: 'claude -c',
      'claude-chrome': 'claude -c --chrome'
    }
    window.electronAPI.shell.openTerminalWithCommand(folderPath, commands[agentType])
    setTerminalAgentDialogId(null)
    // Trigger poll after delay so the new agent can be detected
    setTimeout(pollAgentStatuses, 3000)
  }

  const handleRoleClick = (workspaceId: string, e: React.MouseEvent) => {
    e.stopPropagation()
    setRoleMenuId(roleMenuId === workspaceId ? null : workspaceId)
    setCustomRoleInput('')
  }

  const handleSelectRole = (workspaceId: string, role: string) => {
    if (role === 'custom') {
      // Show custom input instead
      return
    }
    onSetWorkspaceRole(workspaceId, role)
    setRoleMenuId(null)
  }

  const handleCustomRoleSubmit = (workspaceId: string) => {
    if (customRoleInput.trim()) {
      onSetWorkspaceRole(workspaceId, customRoleInput.trim())
    }
    setRoleMenuId(null)
    setCustomRoleInput('')
  }

  const handleDoubleClick = (workspace: Workspace, e: React.MouseEvent) => {
    e.stopPropagation()
    setEditingId(workspace.id)
    setEditValue(workspace.alias || workspace.name)
  }

  const handleRenameSubmit = (id: string) => {
    onRenameWorkspace(id, editValue)
    setEditingId(null)
  }

  const handleKeyDown = (id: string, e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      handleRenameSubmit(id)
    } else if (e.key === 'Escape') {
      setEditingId(null)
    }
  }

  const handleDragStart = (index: number, workspace: Workspace, e: React.DragEvent) => {
    setDraggedIndex(index)
    draggedWorkspaceId.current = workspace.id
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('text/plain', index.toString())
    e.dataTransfer.setData('text/workspace-id', workspace.id)
    // Add a slight delay to allow the drag image to be captured
    setTimeout(() => {
      const target = e.target as HTMLElement
      target.style.opacity = '0.5'
    }, 0)
  }

  const handleDragEnd = (e: React.DragEvent) => {
    const target = e.target as HTMLElement
    target.style.opacity = '1'
    setDraggedIndex(null)
    setDragOverIndex(null)
    setDragOverTabId(null)
    draggedWorkspaceId.current = null
  }

  // Tab drag handlers
  const handleTabDragOver = (tabId: number, e: React.DragEvent) => {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    if (draggedWorkspaceId.current) {
      setDragOverTabId(tabId)
    }
  }

  const handleTabDragLeave = () => {
    setDragOverTabId(null)
  }

  const handleTabDrop = (targetTabId: number, e: React.DragEvent) => {
    e.preventDefault()
    const workspaceId = draggedWorkspaceId.current
    if (workspaceId) {
      onSetWorkspaceTab(workspaceId, targetTabId)
      setActiveTabId(targetTabId)
    }
    setDragOverTabId(null)
    setDraggedIndex(null)
    draggedWorkspaceId.current = null
  }

  const handleDragOver = (index: number, e: React.DragEvent) => {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    // Throttle state updates to reduce re-renders (50ms)
    const now = Date.now()
    if (now - lastDragOverTime.current < 50) return
    lastDragOverTime.current = now

    if (draggedIndex !== null && draggedIndex !== index) {
      setDragOverIndex(index)
    }
  }

  const handleDragLeave = () => {
    setDragOverIndex(null)
  }

  const handleDrop = (toWorkspaceId: string, e: React.DragEvent) => {
    e.preventDefault()
    const fromId = draggedWorkspaceId.current
    if (fromId && fromId !== toWorkspaceId) {
      onReorderWorkspaces(fromId, toWorkspaceId)
    }
    setDraggedIndex(null)
    setDragOverIndex(null)
    draggedWorkspaceId.current = null
  }

  const handleTabDoubleClick = (tab: SidebarTab, e: React.MouseEvent) => {
    e.stopPropagation()
    setEditingTabId(tab.id)
    setEditTabValue(tab.name)
  }

  const handleTabRenameSubmit = (tabId: number) => {
    onRenameTab(tabId, editTabValue)
    setEditingTabId(null)
  }

  const handleTabKeyDown = (tabId: number, e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      handleTabRenameSubmit(tabId)
    } else if (e.key === 'Escape') {
      setEditingTabId(null)
    }
  }

  const handleTabContextMenu = (tabId: number, e: React.MouseEvent) => {
    e.preventDefault()
    setTabContextMenuId(tabId)
    setTabContextMenuPos({ x: e.clientX, y: e.clientY })
  }

  const handleDeleteTab = (tabId: number) => {
    onRemoveTab(tabId)
    setTabContextMenuId(null)
    setTabContextMenuPos(null)
  }

  const handleAgentIndicatorClick = async (workspace: Workspace, status: AgentStatus, e: React.MouseEvent) => {
    e.stopPropagation()
    await window.electronAPI.shell.focusAgent(workspace.folderPath, status.type)
  }

  const handleWorkspaceClick = (workspace: Workspace) => {
    handleWorkspaceSelect(workspace)
  }

  return (
    <aside className="sidebar" style={width ? { width: `${width}px` } : undefined}>
      <div className="sidebar-tabs">
        {tabs.map(tab => (
          <button
            key={tab.id}
            className={`sidebar-tab ${activeTabId === tab.id ? 'active' : ''} ${dragOverTabId === tab.id ? 'drag-over' : ''}`}
            onClick={() => setActiveTabId(tab.id)}
            onDoubleClick={(e) => handleTabDoubleClick(tab, e)}
            onContextMenu={(e) => handleTabContextMenu(tab.id, e)}
            onDragOver={(e) => handleTabDragOver(tab.id, e)}
            onDragLeave={handleTabDragLeave}
            onDrop={(e) => handleTabDrop(tab.id, e)}
          >
            {editingTabId === tab.id ? (
              <input
                ref={tabInputRef}
                type="text"
                className="tab-rename-input"
                value={editTabValue}
                onChange={(e) => setEditTabValue(e.target.value)}
                onBlur={() => handleTabRenameSubmit(tab.id)}
                onKeyDown={(e) => handleTabKeyDown(tab.id, e)}
                onClick={(e) => e.stopPropagation()}
              />
            ) : (
              <>
                {tabHasAgent[tab.id] && <span className="tab-agent-dot" />}
                {tab.name}
                <span className="tab-count">{tabCounts[tab.id] || 0}</span>
              </>
            )}
          </button>
        ))}
        <button
          className="sidebar-tab tab-add-btn"
          onClick={() => onAddTab()}
          title="Add new tab"
        >
          +
        </button>
      </div>
      {tabContextMenuId !== null && tabContextMenuPos && (
        <div
          className="tab-context-menu"
          style={{ left: tabContextMenuPos.x, top: tabContextMenuPos.y }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <button
            onClick={() => handleDeleteTab(tabContextMenuId)}
            disabled={tabs.length <= 1}
          >
            Delete Tab
          </button>
        </div>
      )}
      <div className="workspace-list">
        {filteredWorkspaces.map((workspace, index) => (
          <div
            key={workspace.id}
            className={`workspace-item ${workspace.id === activeWorkspaceId ? 'active' : ''} ${draggedIndex === index ? 'dragging' : ''} ${dragOverIndex === index ? 'drag-over' : ''}`}
            onClick={() => handleWorkspaceClick(workspace)}
            draggable={editingId !== workspace.id}
            onDragStart={(e) => handleDragStart(index, workspace, e)}
            onDragEnd={handleDragEnd}
            onDragOver={(e) => handleDragOver(index, e)}
            onDragLeave={handleDragLeave}
            onDrop={(e) => handleDrop(workspace.id, e)}
          >
            <div className="workspace-item-content">
              {/* Agent indicator */}
              {agentStatuses[workspace.id] && (
                <span
                  className="agent-indicator active"
                  title={`${agentStatuses[workspace.id]!.type} running`}
                  onClick={(e) => handleAgentIndicatorClick(workspace, agentStatuses[workspace.id]!, e)}
                />
              )}
              <div
                className="workspace-item-info"
                onDoubleClick={(e) => handleDoubleClick(workspace, e)}
              >
                {editingId === workspace.id ? (
                  <input
                    ref={inputRef}
                    type="text"
                    className="workspace-rename-input"
                    value={editValue}
                    onChange={(e) => setEditValue(e.target.value)}
                    onBlur={() => handleRenameSubmit(workspace.id)}
                    onKeyDown={(e) => handleKeyDown(workspace.id, e)}
                    onClick={(e) => e.stopPropagation()}
                  />
                ) : (
                  <>
                    <div className="workspace-name-row">
                      <span className="workspace-alias">{workspace.alias || workspace.name}</span>
                      <span
                        className="workspace-role-badge"
                        style={{
                          backgroundColor: workspace.role ? roleColors[workspace.role] || 'transparent' : 'transparent',
                          opacity: workspace.role ? 1 : 0.3
                        }}
                        onClick={(e) => handleRoleClick(workspace.id, e)}
                        title={workspace.role || 'Click to set role'}
                      >
                        {workspace.role || '＋'}
                      </span>
                    </div>
                    <span className="workspace-folder">{workspace.name}</span>
                  </>
                )}
              </div>
              {roleMenuId === workspace.id && (
                <div className="role-selector-menu" ref={roleMenuRef} onClick={(e) => e.stopPropagation()}>
                  <div className="role-menu-title">Select Role</div>
                  {PRESET_ROLES.filter(r => r.id !== 'custom').map(role => (
                    <div
                      key={role.id}
                      className={`role-menu-item ${workspace.role === role.name ? 'selected' : ''}`}
                      onClick={() => handleSelectRole(workspace.id, role.name)}
                    >
                      <span className="role-color-dot" style={{ backgroundColor: role.color }} />
                      {role.name}
                    </div>
                  ))}
                  <div className="role-menu-divider" />
                  <div className="role-menu-custom">
                    <input
                      type="text"
                      placeholder="Custom role..."
                      value={customRoleInput}
                      onChange={(e) => setCustomRoleInput(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') handleCustomRoleSubmit(workspace.id)
                        if (e.key === 'Escape') setRoleMenuId(null)
                      }}
                      autoFocus
                    />
                    <button onClick={() => handleCustomRoleSubmit(workspace.id)}>OK</button>
                  </div>
                  {workspace.role && (
                    <>
                      <div className="role-menu-divider" />
                      <div
                        className="role-menu-item role-menu-clear"
                        onClick={() => handleSelectRole(workspace.id, '')}
                      >
                        Clear Role
                      </div>
                    </>
                  )}
                </div>
              )}
              <div className="workspace-item-actions">
                <button
                  className="folder-btn"
                  onClick={(e) => {
                    e.stopPropagation()
                    window.electronAPI.shell.openPath(workspace.folderPath)
                  }}
                  title="Open in Finder"
                >
                  📁
                </button>
                <button
                  className="terminal-btn"
                  onClick={(e) => handleOpenNativeTerminal(workspace.folderPath, e)}
                  title="Open in Terminal"
                >
                  {'>_'}
                </button>
                <button
                  className="agent-terminal-btn"
                  onClick={(e) => handleCAgentClick(workspace, e)}
                  title="Open Code Agent in Terminal"
                >
                  CAgent
                </button>
                <div className="ide-menu-container" ref={ideMenuId === workspace.id ? ideMenuRef : null}>
                  <button
                    className="ide-btn"
                    onClick={(e) => {
                      e.stopPropagation()
                      setIdeMenuId(ideMenuId === workspace.id ? null : workspace.id)
                    }}
                    title="Open in IDE"
                  >
                    {"</>"}
                  </button>
                  {ideMenuId === workspace.id && (
                    <div className="ide-dropdown" onClick={(e) => e.stopPropagation()}>
                      <button onClick={() => handleOpenWithIde(workspace.folderPath, 'IntelliJ IDEA')}>
                        IntelliJ IDEA
                      </button>
                      <button onClick={() => handleOpenWithIde(workspace.folderPath, 'WebStorm')}>
                        WebStorm
                      </button>
                      <button onClick={() => handleOpenWithIde(workspace.folderPath, 'PhpStorm')}>
                        PhpStorm
                      </button>
                      <button onClick={() => handleOpenWithIde(workspace.folderPath, 'PyCharm')}>
                        PyCharm
                      </button>
                      <button onClick={() => handleOpenWithIde(workspace.folderPath, 'Visual Studio Code')}>
                        VS Code
                      </button>
                    </div>
                  )}
                </div>
                <button
                  className="remove-btn"
                  onClick={(e) => {
                    e.stopPropagation()
                    onRemoveWorkspace(workspace.id)
                  }}
                >
                  ×
                </button>
              </div>
              </div>
            </div>
          )
        )}
      </div>
      {activeWorkspaceId && terminalStatus && (terminalStatus.claude || terminalStatus.happy || terminalStatus.terminal) && (
        <div className="terminal-switcher">
          <span className="terminal-switcher-label">Terminals</span>
          <div className="terminal-switcher-buttons">
            {terminalStatus.claude && (
              <button
                className="terminal-switcher-btn claude"
                onClick={() => handleFocusTerminal('claude')}
                title="Focus Claude Agent"
              >
                [C]
              </button>
            )}
            {terminalStatus.happy && (
              <button
                className="terminal-switcher-btn happy"
                onClick={() => handleFocusTerminal('happy')}
                title="Focus Happy Agent"
              >
                [H]
              </button>
            )}
            {terminalStatus.terminal && (
              <button
                className="terminal-switcher-btn terminal"
                onClick={() => handleFocusTerminal('terminal')}
                title="Focus Terminal"
              >
                [T]
              </button>
            )}
          </div>
          <button
            className="terminal-switcher-refresh"
            onClick={refreshTerminalStatus}
            title="Refresh terminal status"
          >
            R
          </button>
        </div>
      )}
      <div className="sidebar-footer">
        <button className="add-workspace-btn" onClick={onAddWorkspace}>
          + Add Workspace
        </button>
        <div className="sidebar-footer-buttons">
          <button
            className={`tiling-btn ${tilingEnabled ? 'active' : ''}`}
            onClick={handleToggleTiling}
            title={tilingEnabled ? 'Disable window tiling' : 'Enable window tiling'}
          >
            {tilingEnabled ? 'Tiling ON' : 'Tiling'}
          </button>
          <button className="settings-btn" onClick={onOpenAbout}>
            About
          </button>
        </div>
      </div>

      {terminalAgentDialogId && (() => {
        const ws = workspaces.find(w => w.id === terminalAgentDialogId)
        return ws ? (
          <CodeAgentSelectDialog
            onSelect={(type) => handleTerminalAgentSelect(ws.folderPath, type)}
            onCancel={() => setTerminalAgentDialogId(null)}
          />
        ) : null
      })()}
    </aside>
  )
}
