import { useState, useRef, useEffect } from 'react'
import type { Workspace } from '../types'
import { PRESET_ROLES } from '../types'
import { ActivityIndicator } from './ActivityIndicator'

interface SidebarProps {
  workspaces: Workspace[]
  activeWorkspaceId: string | null
  onSelectWorkspace: (id: string) => void
  onAddWorkspace: () => void
  onRemoveWorkspace: (id: string) => void
  onRenameWorkspace: (id: string, alias: string) => void
  onSetWorkspaceRole: (id: string, role: string) => void
  onReorderWorkspaces: (fromIndex: number, toIndex: number) => void
  onOpenSettings: () => void
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
  onSelectWorkspace,
  onAddWorkspace,
  onRemoveWorkspace,
  onRenameWorkspace,
  onSetWorkspaceRole,
  onReorderWorkspaces,
  onOpenSettings,
  onOpenAbout,
  width
}: SidebarProps) {
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editValue, setEditValue] = useState('')
  const [roleMenuId, setRoleMenuId] = useState<string | null>(null)
  const [customRoleInput, setCustomRoleInput] = useState('')
  const [draggedIndex, setDraggedIndex] = useState<number | null>(null)
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const roleMenuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (editingId && inputRef.current) {
      inputRef.current.focus()
      inputRef.current.select()
    }
  }, [editingId])

  // Close role menu when clicking outside
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (roleMenuRef.current && !roleMenuRef.current.contains(e.target as Node)) {
        setRoleMenuId(null)
        setCustomRoleInput('')
      }
    }
    if (roleMenuId) {
      document.addEventListener('mousedown', handleClickOutside)
      return () => document.removeEventListener('mousedown', handleClickOutside)
    }
  }, [roleMenuId])

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

  const handleDragStart = (index: number, e: React.DragEvent) => {
    setDraggedIndex(index)
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('text/plain', index.toString())
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
  }

  const handleDragOver = (index: number, e: React.DragEvent) => {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    if (draggedIndex !== null && draggedIndex !== index) {
      setDragOverIndex(index)
    }
  }

  const handleDragLeave = () => {
    setDragOverIndex(null)
  }

  const handleDrop = (toIndex: number, e: React.DragEvent) => {
    e.preventDefault()
    if (draggedIndex !== null && draggedIndex !== toIndex) {
      onReorderWorkspaces(draggedIndex, toIndex)
    }
    setDraggedIndex(null)
    setDragOverIndex(null)
  }

  return (
    <aside className="sidebar" style={width ? { width: `${width}px` } : undefined}>
      <div className="sidebar-header">Workspaces</div>
      <div className="workspace-list">
        {workspaces.map((workspace, index) => (
          <div
            key={workspace.id}
            className={`workspace-item ${workspace.id === activeWorkspaceId ? 'active' : ''} ${draggedIndex === index ? 'dragging' : ''} ${dragOverIndex === index ? 'drag-over' : ''}`}
            onClick={() => onSelectWorkspace(workspace.id)}
            draggable={editingId !== workspace.id}
            onDragStart={(e) => handleDragStart(index, e)}
            onDragEnd={handleDragEnd}
            onDragOver={(e) => handleDragOver(index, e)}
            onDragLeave={handleDragLeave}
            onDrop={(e) => handleDrop(index, e)}
          >
            <div className="workspace-item-content">
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
                          backgroundColor: getRoleColor(workspace.role),
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
                <ActivityIndicator
                  workspaceId={workspace.id}
                  size="small"
                />
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
      <div className="sidebar-footer">
        <button className="add-workspace-btn" onClick={onAddWorkspace}>
          + Add Workspace
        </button>
        <div className="sidebar-footer-buttons">
          <button className="settings-btn" onClick={onOpenSettings}>
            Settings
          </button>
          <button className="settings-btn" onClick={onOpenAbout}>
            About
          </button>
        </div>
      </div>
    </aside>
  )
}
