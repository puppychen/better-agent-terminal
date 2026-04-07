import { useState, useRef, useEffect, useMemo } from 'react'
import type { Workspace } from '../types'
import { PRESET_ROLES } from '../types'
import { terminalStore } from '../stores/terminal-store'

interface AgentStatus {
  type: 'claude'
}

interface SidebarProps {
  workspaces: Workspace[]
  activeWorkspaceId: string | null
  groups: string[]
  onSelectWorkspace: (id: string) => void
  onAddWorkspace: () => void
  onRemoveWorkspace: (id: string) => void
  onRenameWorkspace: (id: string, alias: string) => void
  onSetWorkspaceRole: (id: string, role: string) => void
  onSetWorkspaceGroup: (id: string, group: string) => void
  onReorderWorkspaces: (fromId: string, toId: string) => void
  onAddGroup: (name?: string) => void
  onRemoveGroup: (group: string) => void
  onRenameGroup: (oldName: string, newName: string) => void
  onOpenAbout: () => void
  onCreateEmbeddedTerminal?: (workspaceId: string, cwd: string, options?: {
    type?: 'shell' | 'agent'
    agentType?: 'claude'
    initialCommand?: string
  }) => void
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
  groups,
  onSelectWorkspace,
  onAddWorkspace,
  onRemoveWorkspace,
  onRenameWorkspace,
  onSetWorkspaceRole,
  onSetWorkspaceGroup,
  onReorderWorkspaces,
  onAddGroup,
  onRemoveGroup,
  onRenameGroup,
  onOpenAbout,
  onCreateEmbeddedTerminal,
  width
}: SidebarProps) {
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editValue, setEditValue] = useState('')
  const [roleMenuId, setRoleMenuId] = useState<string | null>(null)
  const [customRoleInput, setCustomRoleInput] = useState('')
  const [draggedIndex, setDraggedIndex] = useState<number | null>(null)
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null)
  const [dragOverGroup, setDragOverGroup] = useState<string | null>(null)
  const [ideMenuId, setIdeMenuId] = useState<string | null>(null)
  const [activeGroup, setActiveGroup] = useState<string>(groups[0] || 'Others')
  const [wsContextMenu, setWsContextMenu] = useState<string | null>(null)
  const [wsContextMenuPos, setWsContextMenuPos] = useState<{ x: number; y: number } | null>(null)
  const [agentPanelOpen, setAgentPanelOpen] = useState(true)
  const [editingGroup, setEditingGroup] = useState<string | null>(null)
  const [editTabValue, setEditTabValue] = useState('')
  const [groupContextMenu, setGroupContextMenu] = useState<string | null>(null)
  const [groupContextMenuPos, setGroupContextMenuPos] = useState<{ x: number; y: number } | null>(null)
  const [embeddedTerminals, setEmbeddedTerminals] = useState(terminalStore.getState())
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

  // Filter workspaces by active group
  const filteredWorkspaces = useMemo(() =>
    workspaces.filter(w => (w.group || 'Others') === activeGroup),
    [workspaces, activeGroup]
  )

  useEffect(() => {
    if (editingId && inputRef.current) {
      inputRef.current.focus()
      inputRef.current.select()
    }
  }, [editingId])

  // Close menus when clicking outside
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

  // Focus group rename input when editing
  useEffect(() => {
    if (editingGroup !== null && tabInputRef.current) {
      tabInputRef.current.focus()
      tabInputRef.current.select()
    }
  }, [editingGroup])

  // Close group context menu on click outside
  useEffect(() => {
    if (groupContextMenu === null) return
    const handleClick = () => {
      setGroupContextMenu(null)
      setGroupContextMenuPos(null)
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [groupContextMenu])

  // Close workspace context menu on click outside
  useEffect(() => {
    if (wsContextMenu === null) return
    const handleClick = () => {
      setWsContextMenu(null)
      setWsContextMenuPos(null)
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [wsContextMenu])

  // Ensure activeGroup exists in groups
  useEffect(() => {
    if (groups.length > 0 && !groups.includes(activeGroup)) {
      setActiveGroup(groups[0])
    }
  }, [groups, activeGroup])

  // Auto-switch group only when activeWorkspaceId actually changes (e.g. "go to existing" action)
  const prevActiveWorkspaceId = useRef(activeWorkspaceId)
  useEffect(() => {
    if (activeWorkspaceId && activeWorkspaceId !== prevActiveWorkspaceId.current) {
      const ws = workspaces.find(w => w.id === activeWorkspaceId)
      if (ws) {
        setActiveGroup(ws.group || 'Others')
      }
    }
    prevActiveWorkspaceId.current = activeWorkspaceId
  }, [activeWorkspaceId, workspaces])

  // Subscribe to embedded terminal store for agent indicators
  useEffect(() => {
    return terminalStore.subscribe(() => setEmbeddedTerminals(terminalStore.getState()))
  }, [])

  // Derive agent statuses from embedded terminal store
  const agentStatuses = useMemo(() => {
    const statuses: Record<string, AgentStatus | null> = {}
    for (const ws of workspaces) {
      const hasAgent = embeddedTerminals.terminals.some(
        t => t.workspaceId === ws.id && t.type === 'agent'
      )
      statuses[ws.id] = hasAgent ? { type: 'claude' } : null
    }
    return statuses
  }, [workspaces, embeddedTerminals])

  // 計算每個 workspace 的 unread agent terminal 數
  const unreadCounts = useMemo(() => {
    const counts: Record<string, number> = {}
    for (const t of embeddedTerminals.terminals) {
      if (t.unread) counts[t.workspaceId] = (counts[t.workspaceId] || 0) + 1
    }
    return counts
  }, [embeddedTerminals])

  // Count agents per group (must be after agentStatuses)
  const groupAgentCount = useMemo(() => {
    const counts: Record<string, number> = {}
    groups.forEach(g => { counts[g] = 0 })
    workspaces.forEach(ws => {
      if (agentStatuses[ws.id]) {
        const g = ws.group || 'Others'
        counts[g] = (counts[g] || 0) + 1
      }
    })
    return counts
  }, [groups, workspaces, agentStatuses])

  // 計算每個 group 是否有 workspace 含 unread
  const groupHasUnread = useMemo(() => {
    const map: Record<string, boolean> = {}
    workspaces.forEach(ws => {
      if (unreadCounts[ws.id] > 0) {
        const g = ws.group || 'Others'
        map[g] = true
      }
    })
    return map
  }, [workspaces, unreadCounts])

  // Agent Overview: running agents list
  const runningAgents = useMemo(() => {
    return embeddedTerminals.terminals
      .filter(t => t.type === 'agent')
      .map(t => ({
        terminalId: t.id,
        workspaceId: t.workspaceId,
        unread: !!t.unread,
        workspaceName: workspaces.find(w => w.id === t.workspaceId)?.alias
          || workspaces.find(w => w.id === t.workspaceId)?.name
          || '...'
      }))
  }, [embeddedTerminals, workspaces])

  // 任意 agent 有 unread 時，header 顯示紅色信號
  const agentOverviewHasUnread = useMemo(
    () => runningAgents.some(a => a.unread),
    [runningAgents]
  )

  // 未讀總數（標在 header）
  const agentOverviewUnreadCount = useMemo(
    () => runningAgents.filter(a => a.unread).length,
    [runningAgents]
  )

  const handleAgentOverviewClick = async (agent: { terminalId: string; workspaceId: string }) => {
    const ws = workspaces.find(w => w.id === agent.workspaceId)
    if (ws) {
      setActiveGroup(ws.group || 'Others')
      onSelectWorkspace(ws.id)
    }
    await terminalStore.setActiveTerminal(agent.terminalId)
  }

  // When selecting a workspace, switch to its most recent terminal
  const handleWorkspaceSelect = (workspace: Workspace) => {
    onSelectWorkspace(workspace.id)
    // Auto-switch to the workspace's last active terminal if any
    const wsTerminals = terminalStore.getTerminalsForWorkspace(workspace.id)
    if (wsTerminals.length > 0) {
      const current = terminalStore.getState().activeTerminalId
      const belongsToWs = wsTerminals.some(t => t.id === current)
      if (!belongsToWs) {
        // 優先切到 agent terminal，沒有才切最後一個
        const agentTerm = wsTerminals.find(t => t.type === 'agent')
        terminalStore.setActiveTerminal((agentTerm || wsTerminals[wsTerminals.length - 1]).id)
      }
    }
  }

  const handleOpenWithIde = (folderPath: string, appName: string) => {
    window.electronAPI.shell.openWithApp(appName, folderPath)
    setIdeMenuId(null)
    setWsContextMenu(null)
    setWsContextMenuPos(null)
  }

  const handleWorkspaceContextMenu = (workspace: Workspace, e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setWsContextMenu(workspace.id)
    setWsContextMenuPos({ x: e.clientX, y: e.clientY })
  }

  // Agent click: launch Claude or switch to existing Claude terminal
  const handleCAgentClick = async (workspace: Workspace, e: React.MouseEvent) => {
    e.stopPropagation()
    onSelectWorkspace(workspace.id)

    if (onCreateEmbeddedTerminal) {
      // Check if a Claude terminal already exists for this workspace
      const existing = terminalStore.getTerminalsForWorkspace(workspace.id)
        .find(t => t.type === 'agent' && t.agentType === 'claude')
      if (existing) {
        await terminalStore.setActiveTerminal(existing.id)
      } else {
        onCreateEmbeddedTerminal(workspace.id, workspace.folderPath, {
          type: 'agent', agentType: 'claude', initialCommand: 'claude -c --permission-mode bypassPermissions'
        })
      }
    } else {
      // Fallback: external Terminal.app
      const result = await window.electronAPI.shell.checkAgentRunning(workspace.folderPath)
      if (result.running && result.type) {
        await window.electronAPI.shell.focusAgent(workspace.folderPath, result.type as 'claude')
      } else {
        window.electronAPI.shell.openTerminalWithCommand(workspace.folderPath, 'claude -c --permission-mode bypassPermissions')
      }
    }
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
    setDragOverGroup(null)
    draggedWorkspaceId.current = null
  }

  // Group drag handlers
  const handleGroupDragOver = (group: string, e: React.DragEvent) => {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    if (draggedWorkspaceId.current) {
      setDragOverGroup(group)
    }
  }

  const handleGroupDragLeave = () => {
    setDragOverGroup(null)
  }

  const handleGroupDrop = (targetGroup: string, e: React.DragEvent) => {
    e.preventDefault()
    const workspaceId = draggedWorkspaceId.current
    if (workspaceId) {
      onSetWorkspaceGroup(workspaceId, targetGroup)
      setActiveGroup(targetGroup)
    }
    setDragOverGroup(null)
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

  const handleGroupDoubleClick = (group: string, e: React.MouseEvent) => {
    e.stopPropagation()
    setEditingGroup(group)
    setEditTabValue(group)
  }

  const handleGroupRenameSubmit = (group: string) => {
    onRenameGroup(group, editTabValue)
    setEditingGroup(null)
  }

  const handleGroupKeyDown = (group: string, e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      handleGroupRenameSubmit(group)
    } else if (e.key === 'Escape') {
      setEditingGroup(null)
    }
  }

  const handleGroupContextMenu = (group: string, e: React.MouseEvent) => {
    e.preventDefault()
    setGroupContextMenu(group)
    setGroupContextMenuPos({ x: e.clientX, y: e.clientY })
  }

  const handleDeleteGroup = (group: string) => {
    onRemoveGroup(group)
    setGroupContextMenu(null)
    setGroupContextMenuPos(null)
  }

  const handleAgentIndicatorClick = async (workspace: Workspace, _status: AgentStatus, e: React.MouseEvent) => {
    e.stopPropagation()
    onSelectWorkspace(workspace.id)
    // Switch to the agent terminal tab in right panel
    const agentTerm = terminalStore.getTerminalsForWorkspace(workspace.id)
      .find(t => t.type === 'agent')
    if (agentTerm) {
      await terminalStore.setActiveTerminal(agentTerm.id)
    }
  }

  const handleWorkspaceClick = (workspace: Workspace) => {
    handleWorkspaceSelect(workspace)
  }

  return (
    <aside className="sidebar" style={width ? { width: `${width}px` } : undefined}>
      <div className="sidebar-tabs">
        {groups.map(group => (
          <button
            key={group}
            className={`sidebar-tab ${activeGroup === group ? 'active' : ''} ${dragOverGroup === group ? 'drag-over' : ''} ${groupHasUnread[group] ? 'has-unread' : ''}`}
            onClick={() => setActiveGroup(group)}
            onDoubleClick={(e) => handleGroupDoubleClick(group, e)}
            onContextMenu={(e) => handleGroupContextMenu(group, e)}
            onDragOver={(e) => handleGroupDragOver(group, e)}
            onDragLeave={handleGroupDragLeave}
            onDrop={(e) => handleGroupDrop(group, e)}
          >
            {editingGroup === group ? (
              <input
                ref={tabInputRef}
                type="text"
                className="tab-rename-input"
                value={editTabValue}
                onChange={(e) => setEditTabValue(e.target.value)}
                onBlur={() => handleGroupRenameSubmit(group)}
                onKeyDown={(e) => handleGroupKeyDown(group, e)}
                onClick={(e) => e.stopPropagation()}
              />
            ) : (
              <>
                {groupAgentCount[group] > 0 && <span className="tab-agent-dot" />}
                {group}
                {groupAgentCount[group] > 0 && (
                  <span className="tab-count">{groupAgentCount[group]}</span>
                )}
              </>
            )}
          </button>
        ))}
        <button
          className="sidebar-tab tab-add-btn"
          onClick={() => onAddGroup()}
          title="Add new group"
        >
          +
        </button>
      </div>
      {groupContextMenu !== null && groupContextMenuPos && (
        <div
          className="tab-context-menu"
          style={{ left: groupContextMenuPos.x, top: groupContextMenuPos.y }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <button
            onClick={() => handleDeleteGroup(groupContextMenu)}
            disabled={groups.length <= 1}
          >
            Delete Group
          </button>
        </div>
      )}
      <div className="workspace-list">
        {filteredWorkspaces.map((workspace, index) => (
          <div
            key={workspace.id}
            className={`workspace-item ${workspace.id === activeWorkspaceId ? 'active' : ''} ${draggedIndex === index ? 'dragging' : ''} ${dragOverIndex === index ? 'drag-over' : ''}`}
            onClick={() => handleWorkspaceClick(workspace)}
            onContextMenu={(e) => handleWorkspaceContextMenu(workspace, e)}
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
              {/* Unread notification badge */}
              {unreadCounts[workspace.id] > 0 && (
                <span
                  className="workspace-unread-badge"
                  title={`${unreadCounts[workspace.id]} unread notification(s)`}
                >
                  {unreadCounts[workspace.id]}
                </span>
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
                <div className="ide-menu-container" ref={ideMenuId === workspace.id ? ideMenuRef : null}>
                  <button
                    className="ide-btn"
                    onClick={(e) => {
                      e.stopPropagation()
                      setIdeMenuId(ideMenuId === workspace.id ? null : workspace.id)
                    }}
                    title="Open in IDE"
                  >
                    {"{}"}
                  </button>
                  {ideMenuId === workspace.id && (
                    <div className="ide-dropdown" onClick={(e) => e.stopPropagation()}>
                      <button onClick={() => handleOpenWithIde(workspace.folderPath, 'Sourcetree')}>
                        SourceTree
                      </button>
                      <div className="ide-dropdown-divider" />
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
                  className="agent-launch-btn"
                  onClick={(e) => handleCAgentClick(workspace, e)}
                  title={agentStatuses[workspace.id] ? 'Switch to Claude Agent' : 'Launch Claude Agent'}
                >
                  {agentStatuses[workspace.id] ? '\u25FC' : '\u25B6'}
                </button>
              </div>
              </div>
            </div>
          )
        )}
      </div>
      {wsContextMenu !== null && wsContextMenuPos && (() => {
        const ws = workspaces.find(w => w.id === wsContextMenu)
        if (!ws) return null
        return (
          <div
            className="ws-context-menu"
            style={{ left: wsContextMenuPos.x, top: wsContextMenuPos.y }}
            onMouseDown={(e) => e.stopPropagation()}
          >
            <button onClick={() => {
              if (onCreateEmbeddedTerminal) {
                onCreateEmbeddedTerminal(ws.id, ws.folderPath, { type: 'shell' })
              } else {
                window.electronAPI.shell.openTerminalAtPath(ws.folderPath)
              }
              onSelectWorkspace(ws.id)
              setWsContextMenu(null)
              setWsContextMenuPos(null)
            }}>
              Open Terminal
            </button>
            <div className="ws-context-menu-divider" />
            <button onClick={() => {
              setEditingId(ws.id)
              setEditValue(ws.alias || ws.name)
              setWsContextMenu(null)
              setWsContextMenuPos(null)
            }}>
              Rename
            </button>
            <button
              className="ws-context-menu-danger"
              onClick={() => {
                onRemoveWorkspace(ws.id)
                setWsContextMenu(null)
                setWsContextMenuPos(null)
              }}
            >
              Remove
            </button>
          </div>
        )
      })()}
      {runningAgents.length > 0 && (
        <div className={`agent-overview ${agentOverviewHasUnread ? 'has-unread' : ''}`}>
          <div
            className="agent-overview-header"
            onClick={() => setAgentPanelOpen(!agentPanelOpen)}
          >
            <span className="agent-overview-chevron">{agentPanelOpen ? '\u25BE' : '\u25B8'}</span>
            <span>Agents</span>
            <span className="agent-overview-count">{runningAgents.length}</span>
            {agentOverviewUnreadCount > 0 && (
              <span className="agent-overview-unread-badge" title={`${agentOverviewUnreadCount} unread`}>
                {agentOverviewUnreadCount}
              </span>
            )}
          </div>
          {agentPanelOpen && (
            <div className="agent-overview-list">
              {runningAgents.map(agent => (
                <div
                  key={agent.terminalId}
                  className={`agent-overview-item ${agent.unread ? 'unread' : ''}`}
                  onClick={() => handleAgentOverviewClick(agent)}
                >
                  <span className="agent-overview-dot" />
                  <span className="agent-overview-name">{agent.workspaceName}</span>
                  {agent.unread && <span className="agent-overview-unread-dot" title="Unread notification" />}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
      <WsStatusIndicator />
      <div className="sidebar-footer">
        <button className="add-workspace-btn" onClick={onAddWorkspace}>+ Add Workspace</button>
        <button className="settings-btn" onClick={onOpenAbout}>Settings</button>
      </div>
    </aside>
  )
}

/** Sidebar 底部的 WS Server 狀態指示（僅在啟用時顯示） */
function WsStatusIndicator() {
  const [running, setRunning] = useState(false)
  const [clientCount, setClientCount] = useState(0)

  useEffect(() => {
    let mounted = true

    // 初始狀態
    window.electronAPI.ws?.getStatus?.().then(status => {
      if (mounted) {
        setRunning(status.running)
        setClientCount(status.clientCount)
      }
    }).catch(() => {})

    // 事件驅動：WS 啟停 + client 數量變化
    const unsubStatus = window.electronAPI.ws?.onStatusChange?.((on) => {
      if (mounted) {
        setRunning(on)
        if (!on) setClientCount(0)
      }
    })
    const unsubClient = window.electronAPI.ws?.onClientChange?.((count) => {
      if (mounted) setClientCount(count)
    })

    return () => {
      mounted = false
      unsubStatus?.()
      unsubClient?.()
    }
  }, [])

  if (!running) return null

  return (
    <div className="ws-indicator" title={`WebSocket: ${clientCount} client(s) connected`}>
      <span className="ws-dot ws-dot-on" />
      <span className="ws-indicator-label">WS</span>
      {clientCount > 0 && <span className="ws-indicator-count">{clientCount}</span>}
    </div>
  )
}
