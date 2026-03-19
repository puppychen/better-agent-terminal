import { v4 as uuidv4 } from 'uuid'
import type { TerminalInstance, TerminalState, CreatePtyOptions, CodeAgentType } from '../types'

type Listener = () => void

class TerminalStore {
  private state: TerminalState = {
    terminals: [],
    activeTerminalId: null
  }
  private listeners: Set<Listener> = new Set()

  getState(): TerminalState { return this.state }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private notify(): void {
    this.listeners.forEach(l => l())
  }

  async createTerminal(workspaceId: string, cwd: string, options?: {
    type?: 'shell' | 'agent'
    agentType?: CodeAgentType
    label?: string
    initialCommand?: string
  }): Promise<TerminalInstance | null> {
    const id = uuidv4()
    const type = options?.type || 'shell'
    const folderName = cwd.split('/').pop() || cwd

    let label = options?.label
    if (!label) {
      if (type === 'agent') {
        label = `[C] ${folderName}`
      } else {
        label = `[T] ${folderName}`
      }
    }

    const instance: TerminalInstance = {
      id, workspaceId, label, type,
      agentType: options?.agentType,
      cwd, createdAt: Date.now()
    }

    const ptyOptions: CreatePtyOptions = {
      id, cwd, type,
      agentType: options?.agentType,
      initialCommand: options?.initialCommand
    }

    const ok = await window.electronAPI.pty.create(ptyOptions)
    if (!ok) return null

    // Deactivate previous, activate new (component stays mounted, listeners ready)
    if (this.state.activeTerminalId) {
      await window.electronAPI.pty.deactivate(this.state.activeTerminalId)
    }

    this.state = {
      terminals: [...this.state.terminals, instance],
      activeTerminalId: id
    }
    this.notify()

    await window.electronAPI.pty.activate(id)
    return instance
  }

  async setActiveTerminal(id: string): Promise<void> {
    const prev = this.state.activeTerminalId
    if (prev === id) return

    if (prev) {
      await window.electronAPI.pty.deactivate(prev)
    }

    this.state = { ...this.state, activeTerminalId: id }
    this.notify()

    await window.electronAPI.pty.activate(id)
  }

  async killTerminal(id: string): Promise<void> {
    await window.electronAPI.pty.kill(id)

    const terminals = this.state.terminals.filter(t => t.id !== id)
    let activeTerminalId = this.state.activeTerminalId

    if (activeTerminalId === id) {
      activeTerminalId = terminals[terminals.length - 1]?.id ?? null
    }

    this.state = { terminals, activeTerminalId }
    this.notify()

    if (activeTerminalId) {
      await window.electronAPI.pty.activate(activeTerminalId)
    }
  }

  getTerminalsForWorkspace(workspaceId: string): TerminalInstance[] {
    return this.state.terminals.filter(t => t.workspaceId === workspaceId)
  }

  async onWindowFocus(): Promise<void> {
    if (this.state.activeTerminalId) {
      await window.electronAPI.pty.activate(this.state.activeTerminalId)
    }
  }

  async disposeAll(): Promise<void> {
    for (const t of this.state.terminals) {
      await window.electronAPI.pty.kill(t.id)
    }
    this.state = { terminals: [], activeTerminalId: null }
    this.notify()
  }
}

export const terminalStore = new TerminalStore()
