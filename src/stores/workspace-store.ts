import { v4 as uuidv4 } from 'uuid'
import type { Workspace, AppState, SidebarTab } from '../types'

const DEFAULT_TABS: SidebarTab[] = [
  { id: 1, name: 'Tab 1' },
  { id: 2, name: 'Tab 2' },
  { id: 3, name: 'Tab 3' }
]

type Listener = () => void

class WorkspaceStore {
  private state: AppState = {
    workspaces: [],
    activeWorkspaceId: null,
    tabs: DEFAULT_TABS.map(t => ({ ...t }))
  }

  private listeners: Set<Listener> = new Set()

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
    const insertIndex = fromIndex < toIndex ? toIndex - 1 : toIndex
    workspaces.splice(insertIndex, 0, removed)

    this.state = {
      ...this.state,
      workspaces
    }

    this.notify()
    this.save()
  }

  // Tab management
  addTab(name?: string): SidebarTab {
    const maxId = Math.max(...this.state.tabs.map(t => t.id), 0)
    const newTab: SidebarTab = { id: maxId + 1, name: name || `Tab ${maxId + 1}` }

    this.state = {
      ...this.state,
      tabs: [...this.state.tabs, newTab]
    }

    this.notify()
    this.save()
    return newTab
  }

  removeTab(tabId: number): void {
    if (this.state.tabs.length <= 1) return

    const firstTab = this.state.tabs.find(t => t.id !== tabId)
    if (!firstTab) return

    this.state = {
      ...this.state,
      tabs: this.state.tabs.filter(t => t.id !== tabId),
      workspaces: this.state.workspaces.map(w =>
        (w.tabId || 1) === tabId ? { ...w, tabId: firstTab.id } : w
      )
    }

    this.notify()
    this.save()
  }

  renameTab(tabId: number, name: string): void {
    this.state = {
      ...this.state,
      tabs: this.state.tabs.map(t =>
        t.id === tabId ? { ...t, name: name.trim() || t.name } : t
      )
    }

    this.notify()
    this.save()
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
      activeWorkspaceId: this.state.activeWorkspaceId,
      tabs: this.state.tabs
    })
    await window.electronAPI.workspace.save(data)
  }

  async load(): Promise<void> {
    const data = await window.electronAPI.workspace.load()
    if (data) {
      try {
        const parsed = JSON.parse(data)
        const workspaces = parsed.workspaces || []
        const tabs: SidebarTab[] = parsed.tabs && parsed.tabs.length > 0
          ? parsed.tabs
          : DEFAULT_TABS.map(t => ({ ...t }))
        this.state = {
          ...this.state,
          workspaces,
          activeWorkspaceId: parsed.activeWorkspaceId || null,
          tabs
        }
        this.notify()
      } catch (e) {
        console.error('Failed to parse workspace data:', e)
      }
    }
  }
}

export const workspaceStore = new WorkspaceStore()
