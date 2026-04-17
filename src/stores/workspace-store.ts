import { v4 as uuidv4 } from 'uuid'
import type { Workspace, AppState } from '../types'

const DEFAULT_GROUP = 'Others'

type Listener = () => void

class WorkspaceStore {
  private state: AppState = {
    workspaces: [],
    activeWorkspaceId: null
  }

  private listeners: Set<Listener> = new Set()
  private extraFields: Record<string, unknown> = {}
  private groupOrder: string[] = []

  getState(): AppState {
    return this.state
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private notify(): void {
    this.listeners.forEach(listener => listener())
  }

  // Group management
  getGroups(): string[] {
    const wsGroups = new Set(
      this.state.workspaces.map(w => w.group || DEFAULT_GROUP)
    )
    const result: string[] = []
    for (const g of this.groupOrder) {
      result.push(g)
    }
    for (const g of wsGroups) {
      if (!result.includes(g)) result.push(g)
    }
    return result.length > 0 ? result : [DEFAULT_GROUP]
  }

  private getActiveGroup(): string {
    const active = this.state.workspaces.find(
      w => w.id === this.state.activeWorkspaceId
    )
    return active?.group || DEFAULT_GROUP
  }

  // Workspace actions
  addWorkspace(name: string, folderPath: string): Workspace {
    const workspace: Workspace = {
      id: uuidv4(),
      name,
      folderPath,
      createdAt: Date.now(),
      group: this.getActiveGroup()
    }

    this.state = {
      ...this.state,
      workspaces: [...this.state.workspaces, workspace],
      activeWorkspaceId: workspace.id
    }

    this.notify()
    this.save()
    return workspace
  }

  removeWorkspace(id: string): void {
    const workspaces = this.state.workspaces.filter(w => w.id !== id)

    this.state = {
      ...this.state,
      workspaces,
      activeWorkspaceId: this.state.activeWorkspaceId === id
        ? (workspaces[0]?.id ?? null)
        : this.state.activeWorkspaceId
    }

    this.notify()
    this.save()
  }

  setActiveWorkspace(id: string): void {
    if (this.state.activeWorkspaceId === id) return

    this.state = {
      ...this.state,
      activeWorkspaceId: id
    }

    this.notify()
    this.save()
  }

  renameWorkspace(id: string, alias: string): void {
    this.state = {
      ...this.state,
      workspaces: this.state.workspaces.map(w =>
        w.id === id ? { ...w, alias: alias.trim() || undefined } : w
      )
    }

    this.notify()
    this.save()
  }

  setWorkspaceRole(id: string, role: string): void {
    this.state = {
      ...this.state,
      workspaces: this.state.workspaces.map(w =>
        w.id === id ? { ...w, role: role.trim() || undefined } : w
      )
    }

    this.notify()
    this.save()
  }

  setWorkspaceGroup(id: string, group: string): void {
    this.state = {
      ...this.state,
      workspaces: this.state.workspaces.map(w =>
        w.id === id ? { ...w, group } : w
      )
    }

    this.notify()
    this.save()
  }

  getWorkspacesByGroup(group: string): Workspace[] {
    return this.state.workspaces.filter(w => (w.group || DEFAULT_GROUP) === group)
  }

  reorderWorkspaces(fromId: string, toId: string): void {
    if (fromId === toId) return

    const workspaces = [...this.state.workspaces]
    const fromIndex = workspaces.findIndex(w => w.id === fromId)
    const toIndex = workspaces.findIndex(w => w.id === toId)

    if (fromIndex === -1 || toIndex === -1) return

    const [removed] = workspaces.splice(fromIndex, 1)
    const insertIndex = fromIndex < toIndex ? toIndex - 1 : toIndex
    workspaces.splice(insertIndex, 0, removed)

    this.state = {
      ...this.state,
      workspaces
    }

    this.notify()
    this.save()
  }

  // Group management
  addGroup(name?: string): string {
    const existing = this.getGroups()
    let finalName = name || 'New Group'
    let counter = 1
    while (existing.includes(finalName)) {
      finalName = `New Group ${counter++}`
    }
    this.groupOrder = [...this.getGroups(), finalName]
    this.notify()
    this.save()
    return finalName
  }

  removeGroup(group: string): void {
    const groups = this.getGroups()
    if (groups.length <= 1) return

    const fallback = groups.find(g => g !== group) || DEFAULT_GROUP

    this.state = {
      ...this.state,
      workspaces: this.state.workspaces.map(w =>
        (w.group || DEFAULT_GROUP) === group
          ? { ...w, group: fallback }
          : w
      )
    }
    this.groupOrder = this.groupOrder.filter(g => g !== group)

    this.notify()
    this.save()
  }

  renameGroup(oldName: string, newName: string): void {
    const trimmed = newName.trim()
    if (!trimmed || trimmed === oldName) return

    this.state = {
      ...this.state,
      workspaces: this.state.workspaces.map(w =>
        (w.group || DEFAULT_GROUP) === oldName
          ? { ...w, group: trimmed }
          : w
      )
    }
    this.groupOrder = this.groupOrder.map(g => g === oldName ? trimmed : g)

    this.notify()
    this.save()
  }

  // Workspace switching (within current group only)
  switchToNextWorkspace(): void {
    const { workspaces, activeWorkspaceId } = this.state
    const currentWorkspace = workspaces.find(w => w.id === activeWorkspaceId)
    const currentGroup = currentWorkspace?.group || DEFAULT_GROUP

    const groupWorkspaces = workspaces.filter(w => (w.group || DEFAULT_GROUP) === currentGroup)
    if (groupWorkspaces.length <= 1) return

    const currentIndex = groupWorkspaces.findIndex(w => w.id === activeWorkspaceId)
    const nextIndex = currentIndex === -1 ? 0 : (currentIndex + 1) % groupWorkspaces.length
    this.setActiveWorkspace(groupWorkspaces[nextIndex].id)
  }

  switchToPreviousWorkspace(): void {
    const { workspaces, activeWorkspaceId } = this.state
    const currentWorkspace = workspaces.find(w => w.id === activeWorkspaceId)
    const currentGroup = currentWorkspace?.group || DEFAULT_GROUP

    const groupWorkspaces = workspaces.filter(w => (w.group || DEFAULT_GROUP) === currentGroup)
    if (groupWorkspaces.length <= 1) return

    const currentIndex = groupWorkspaces.findIndex(w => w.id === activeWorkspaceId)
    const prevIndex = currentIndex <= 0 ? groupWorkspaces.length - 1 : currentIndex - 1
    this.setActiveWorkspace(groupWorkspaces[prevIndex].id)
  }

  /** 寫入或刪除 sessionId 對應的 user-given label（label 為 falsy 時刪除 entry） */
  setClaudeSessionLabel(workspaceId: string, sessionId: string, label: string | null | undefined): void {
    const idx = this.state.workspaces.findIndex(w => w.id === workspaceId)
    if (idx === -1) return
    const cur = this.state.workspaces[idx]
    const next = { ...(cur.claudeSessionLabels || {}) }
    if (label) {
      if (next[sessionId] === label) return
      next[sessionId] = label
    } else {
      if (!(sessionId in next)) return
      delete next[sessionId]
    }
    const workspaces = [...this.state.workspaces]
    workspaces[idx] = {
      ...cur,
      claudeSessionLabels: Object.keys(next).length > 0 ? next : undefined
    }
    this.state = { ...this.state, workspaces }
    this.notify()
    this.save()
  }

  /** 讀取 sessionId 對應的 user-given label（沒有則 undefined） */
  getClaudeSessionLabel(workspaceId: string, sessionId: string): string | undefined {
    const ws = this.state.workspaces.find(w => w.id === workspaceId)
    return ws?.claudeSessionLabels?.[sessionId]
  }

  // Persistence
  async save(): Promise<void> {
    const activeGroup = this.getActiveGroup()

    const data = JSON.stringify({
      ...this.extraFields,
      workspaces: this.state.workspaces,
      activeWorkspaceId: this.state.activeWorkspaceId,
      activeGroup,
      groupOrder: this.groupOrder
    })
    await window.electronAPI.workspace.save(data)
  }

  async load(): Promise<void> {
    const data = await window.electronAPI.workspace.load()
    if (data) {
      try {
        const parsed = JSON.parse(data)
        const { workspaces: rawWorkspaces, activeWorkspaceId, groupOrder, ...rest } = parsed

        // Preserve extra fields (terminals, activeTerminalId, etc.)
        this.extraFields = rest

        // Ensure every workspace has a group
        const workspaces: Workspace[] = (rawWorkspaces || []).map((w: Workspace) => {
          if (!w.group) {
            return { ...w, group: DEFAULT_GROUP }
          }
          return w
        })

        // Restore groupOrder, or derive from workspaces
        this.groupOrder = Array.isArray(groupOrder) && groupOrder.length > 0
          ? groupOrder
          : [...new Set(workspaces.map(w => w.group || DEFAULT_GROUP))]

        this.state = {
          workspaces,
          activeWorkspaceId: activeWorkspaceId || null
        }
        this.notify()
      } catch (e) {
        console.error('Failed to parse workspace data:', e)
      }
    }
  }
}

export const workspaceStore = new WorkspaceStore()
