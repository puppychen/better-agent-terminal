import { v4 as uuidv4 } from 'uuid'
import type { Workspace, TerminalInstance, AppState, CodeAgentType } from '../types'

// Note: uuidv4 is still used for generating workspace and terminal IDs

type Listener = () => void

class WorkspaceStore {
  private state: AppState = {
    workspaces: [],
    activeWorkspaceId: null,
    terminals: [],
    activeTerminalId: null,
    focusedTerminalId: null
  }

  private listeners: Set<Listener> = new Set()
  private activityListeners: Set<Listener> = new Set()

  getState(): AppState {
    return this.state
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  subscribeToActivity(listener: Listener): () => void {
    this.activityListeners.add(listener)
    return () => this.activityListeners.delete(listener)
  }

  private notify(): void {
    this.listeners.forEach(listener => listener())
  }

  private notifyActivity(): void {
    this.activityListeners.forEach(listener => listener())
  }

  // Workspace actions
  addWorkspace(name: string, folderPath: string): Workspace {
    const workspace: Workspace = {
      id: uuidv4(),
      name,
      folderPath,
      createdAt: Date.now(),
      tabId: 1
    }

    this.state = {
      ...this.state,
      workspaces: [...this.state.workspaces, workspace],
      activeWorkspaceId: workspace.id
    }

    this.notify()
    return workspace
  }

  removeWorkspace(id: string): void {
    const terminals = this.state.terminals.filter(t => t.workspaceId !== id)
    const workspaces = this.state.workspaces.filter(w => w.id !== id)

    this.state = {
      ...this.state,
      workspaces,
      terminals,
      activeWorkspaceId: this.state.activeWorkspaceId === id
        ? (workspaces[0]?.id ?? null)
        : this.state.activeWorkspaceId
    }

    this.notify()
  }

  setActiveWorkspace(id: string): void {
    if (this.state.activeWorkspaceId === id) return

    this.state = {
      ...this.state,
      activeWorkspaceId: id,
      focusedTerminalId: null
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

  setWorkspaceTab(id: string, tabId: number): void {
    this.state = {
      ...this.state,
      workspaces: this.state.workspaces.map(w =>
        w.id === id ? { ...w, tabId } : w
      )
    }

    this.notify()
    this.save()
  }

  getWorkspacesByTab(tabId: number): Workspace[] {
    return this.state.workspaces.filter(w => (w.tabId || 1) === tabId)
  }

  reorderWorkspaces(fromId: string, toId: string): void {
    if (fromId === toId) return

    const workspaces = [...this.state.workspaces]
    const fromIndex = workspaces.findIndex(w => w.id === fromId)
    const toIndex = workspaces.findIndex(w => w.id === toId)

    if (fromIndex === -1 || toIndex === -1) return

    const [removed] = workspaces.splice(fromIndex, 1)
    // When moving forward (fromIndex < toIndex), the target index shifts by -1 after removal
    const insertIndex = fromIndex < toIndex ? toIndex - 1 : toIndex
    workspaces.splice(insertIndex, 0, removed)

    this.state = {
      ...this.state,
      workspaces
    }

    this.notify()
    this.save()
  }

  // Terminal actions
  addTerminal(workspaceId: string, type: 'terminal' | 'claude-code', codeAgentType?: CodeAgentType): TerminalInstance {
    const workspace = this.state.workspaces.find(w => w.id === workspaceId)
    if (!workspace) throw new Error('Workspace not found')

    const existingTerminals = this.state.terminals.filter(
      t => t.workspaceId === workspaceId && t.type === 'terminal'
    )

    const terminal: TerminalInstance = {
      id: uuidv4(),
      workspaceId,
      type,
      title: type === 'claude-code' ? 'Code Agent' : `Terminal ${existingTerminals.length + 1}`,
      cwd: workspace.folderPath,
      scrollbackBuffer: [],
      lastActivityTime: Date.now(),
      codeAgentType: type === 'claude-code' ? codeAgentType : undefined
    }

    // Only auto-focus Claude Code, keep current focus for regular terminals
    const shouldFocus = type === 'claude-code' || !this.state.focusedTerminalId

    this.state = {
      ...this.state,
      terminals: [...this.state.terminals, terminal],
      focusedTerminalId: shouldFocus ? terminal.id : this.state.focusedTerminalId
    }

    this.notify()
    return terminal
  }

  removeTerminal(id: string): void {
    const terminals = this.state.terminals.filter(t => t.id !== id)

    this.state = {
      ...this.state,
      terminals,
      focusedTerminalId: this.state.focusedTerminalId === id
        ? (terminals[0]?.id ?? null)
        : this.state.focusedTerminalId
    }

    this.notify()
  }

  setFocusedTerminal(id: string | null): void {
    if (this.state.focusedTerminalId === id) return

    this.state = {
      ...this.state,
      focusedTerminalId: id
    }

    this.notify()
  }

  updateTerminalCwd(id: string, cwd: string): void {
    this.state = {
      ...this.state,
      terminals: this.state.terminals.map(t =>
        t.id === id ? { ...t, cwd } : t
      )
    }

    this.notify()
  }

  updateTerminalCodeAgentType(id: string, codeAgentType: CodeAgentType): void {
    this.state = {
      ...this.state,
      terminals: this.state.terminals.map(t =>
        t.id === id ? { ...t, codeAgentType } : t
      )
    }

    this.notify()
  }

  appendScrollback(id: string, data: string): void {
    this.state = {
      ...this.state,
      terminals: this.state.terminals.map(t =>
        t.id === id ? { ...t, scrollbackBuffer: [...t.scrollbackBuffer, data] } : t
      )
    }
    // Don't notify for scrollback updates to avoid re-renders
  }

  clearScrollback(id: string): void {
    this.state = {
      ...this.state,
      terminals: this.state.terminals.map(t =>
        t.id === id ? { ...t, scrollbackBuffer: [] } : t
      )
    }

    this.notify()
  }

  // Get terminals for current workspace
  getWorkspaceTerminals(workspaceId: string): TerminalInstance[] {
    return this.state.terminals.filter(t => t.workspaceId === workspaceId)
  }

  getClaudeCodeTerminal(workspaceId: string): TerminalInstance | undefined {
    return this.state.terminals.find(
      t => t.workspaceId === workspaceId && t.type === 'claude-code'
    )
  }

  getRegularTerminals(workspaceId: string): TerminalInstance[] {
    return this.state.terminals.filter(
      t => t.workspaceId === workspaceId && t.type === 'terminal'
    )
  }

  // Activity tracking
  private lastActivityNotify: number = 0

  updateTerminalActivity(id: string): void {
    const now = Date.now()
    this.state = {
      ...this.state,
      terminals: this.state.terminals.map(t =>
        t.id === id ? { ...t, lastActivityTime: now } : t
      )
    }
    // Throttle activity notifications (max once per 500ms)
    // Only notify activity listeners, not all subscribers
    if (now - this.lastActivityNotify > 500) {
      this.lastActivityNotify = now
      this.notifyActivity()
    }
  }

  clearTerminalActivity(id: string): void {
    this.state = {
      ...this.state,
      terminals: this.state.terminals.map(t =>
        t.id === id ? { ...t, lastActivityTime: undefined } : t
      )
    }
    this.notifyActivity()
  }

  getWorkspaceLastActivity(workspaceId: string): number | null {
    const terminals = this.getWorkspaceTerminals(workspaceId)
    const lastActivities = terminals
      .map(t => t.lastActivityTime)
      .filter((time): time is number => time !== undefined)

    return lastActivities.length > 0 ? Math.max(...lastActivities) : null
  }

  // Terminal switching
  switchToNextTerminal(): void {
    const { activeWorkspaceId, focusedTerminalId } = this.state
    if (!activeWorkspaceId) return

    const terminals = this.getWorkspaceTerminals(activeWorkspaceId)
    if (terminals.length <= 1) return

    const currentIndex = terminals.findIndex(t => t.id === focusedTerminalId)
    const nextIndex = currentIndex === -1 ? 0 : (currentIndex + 1) % terminals.length
    this.setFocusedTerminal(terminals[nextIndex].id)
  }

  switchToPreviousTerminal(): void {
    const { activeWorkspaceId, focusedTerminalId } = this.state
    if (!activeWorkspaceId) return

    const terminals = this.getWorkspaceTerminals(activeWorkspaceId)
    if (terminals.length <= 1) return

    const currentIndex = terminals.findIndex(t => t.id === focusedTerminalId)
    const prevIndex = currentIndex <= 0 ? terminals.length - 1 : currentIndex - 1
    this.setFocusedTerminal(terminals[prevIndex].id)
  }

  // Workspace switching (within current tab only)
  switchToNextWorkspace(): void {
    const { workspaces, activeWorkspaceId } = this.state
    const currentWorkspace = workspaces.find(w => w.id === activeWorkspaceId)
    const currentTabId = currentWorkspace?.tabId || 1

    const tabWorkspaces = workspaces.filter(w => (w.tabId || 1) === currentTabId)
    if (tabWorkspaces.length <= 1) return

    const currentIndex = tabWorkspaces.findIndex(w => w.id === activeWorkspaceId)
    const nextIndex = currentIndex === -1 ? 0 : (currentIndex + 1) % tabWorkspaces.length
    this.setActiveWorkspace(tabWorkspaces[nextIndex].id)
  }

  switchToPreviousWorkspace(): void {
    const { workspaces, activeWorkspaceId } = this.state
    const currentWorkspace = workspaces.find(w => w.id === activeWorkspaceId)
    const currentTabId = currentWorkspace?.tabId || 1

    const tabWorkspaces = workspaces.filter(w => (w.tabId || 1) === currentTabId)
    if (tabWorkspaces.length <= 1) return

    const currentIndex = tabWorkspaces.findIndex(w => w.id === activeWorkspaceId)
    const prevIndex = currentIndex <= 0 ? tabWorkspaces.length - 1 : currentIndex - 1
    this.setActiveWorkspace(tabWorkspaces[prevIndex].id)
  }

  // Persistence
  async save(): Promise<void> {
    const data = JSON.stringify({
      workspaces: this.state.workspaces,
      activeWorkspaceId: this.state.activeWorkspaceId
    })
    await window.electronAPI.workspace.save(data)
  }

  async load(): Promise<void> {
    const data = await window.electronAPI.workspace.load()
    if (data) {
      try {
        const parsed = JSON.parse(data)
        const workspaces = parsed.workspaces || []
        this.state = {
          ...this.state,
          workspaces,
          activeWorkspaceId: parsed.activeWorkspaceId || null
        }
        this.notify()
      } catch (e) {
        console.error('Failed to parse workspace data:', e)
      }
    }
  }
}

export const workspaceStore = new WorkspaceStore()
