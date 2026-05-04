import { v4 as uuidv4 } from 'uuid'
import type { TerminalInstance, TerminalState, CreatePtyOptions, CodeAgentType } from '../types'

type Listener = () => void

class TerminalStore {
  private state: TerminalState = {
    terminals: [],
    activeTerminalId: null
  }
  private listeners: Set<Listener> = new Set()
  /** Per-workspace 上次選定的 terminal id（in-memory，重啟不持久化） */
  private workspaceLastActive: Map<string, string> = new Map()

  getState(): TerminalState { return this.state }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private notify(): void {
    this.listeners.forEach(l => l())
  }

  private rememberWorkspaceActive(workspaceId: string, terminalId: string): void {
    this.workspaceLastActive.set(workspaceId, terminalId)
  }

  async createTerminal(workspaceId: string, cwd: string, options?: {
    type?: 'shell' | 'agent' | 'files'
    agentType?: CodeAgentType
    label?: string
    initialCommand?: string
    claudeSessionId?: string
    labelLockedByUser?: boolean
  }): Promise<TerminalInstance | null> {
    const id = uuidv4()
    const type = options?.type || 'shell'
    const folderName = cwd.split('/').pop() || cwd

    let label = options?.label
    if (!label) {
      if (type === 'agent' && options?.agentType === 'codex') label = `[X] ${folderName}`
      else if (type === 'agent') label = `[C] ${folderName}`
      else if (type === 'files') label = `[F] ${folderName}`
      else label = `[T] ${folderName}`
    }

    const instance: TerminalInstance = {
      id, workspaceId, label, type,
      agentType: options?.agentType,
      cwd, createdAt: Date.now(),
      claudeSessionId: options?.claudeSessionId,
      labelLockedByUser: options?.labelLockedByUser
    }

    // Files tab 沒有 PTY；只有 shell / agent 走 PTY 建立
    if (type === 'shell' || type === 'agent') {
      const ptyOptions: CreatePtyOptions = {
        id, cwd, type,
        agentType: options?.agentType,
        initialCommand: options?.initialCommand
      }
      const ok = await window.electronAPI.pty.create(ptyOptions)
      if (!ok) return null
    }

    this.state = {
      terminals: [...this.state.terminals, instance],
      activeTerminalId: id
    }
    this.rememberWorkspaceActive(workspaceId, id)
    this.notify()

    // activate 對 files tab 是 no-op（main 端 instance map 不存在，IPC handler 會 early return）
    if (type === 'shell' || type === 'agent') {
      await window.electronAPI.pty.activate(id)
    }
    return instance
  }

  async setActiveTerminal(id: string): Promise<void> {
    const prev = this.state.activeTerminalId
    const target = this.state.terminals.find(t => t.id === id)
    const needsClearUnread = target?.unread === true

    // 記錄該 workspace 最後選的 terminal（in-memory）
    if (target) this.rememberWorkspaceActive(target.workspaceId, id)

    // prev === id 且無 unread 要清 → 真正不用動
    if (prev === id && !needsClearUnread) return

    // 不 deactivate/activate — 所有 terminal 永遠在 activeSet，持續接收 IPC
    // 搭配 visibility:hidden CSS，切 tab 時畫面是最新狀態，零 replay 零 SIGWINCH
    // 切到該 tab（或重新點已 active tab）順便清除 unread 標記
    const terminals = needsClearUnread
      ? this.state.terminals.map(t => t.id === id ? { ...t, unread: false } : t)
      : this.state.terminals
    this.state = { ...this.state, terminals, activeTerminalId: id }
    this.notify()
  }

  /** 回傳該 workspace 上次選定的 terminal id（已驗證仍存在）；無記錄回 null */
  getLastActiveForWorkspace(workspaceId: string): string | null {
    const id = this.workspaceLastActive.get(workspaceId)
    if (!id) return null
    return this.state.terminals.some(t => t.id === id && t.workspaceId === workspaceId) ? id : null
  }

  /** 恢復 workspace 上次 active terminal；僅存在記憶體，重啟後不保留。 */
  async restoreActiveForWorkspace(workspaceId: string): Promise<void> {
    const wsTerminals = this.getTerminalsForWorkspace(workspaceId)
    if (wsTerminals.length === 0) {
      if (this.state.activeTerminalId !== null) {
        this.state = { ...this.state, activeTerminalId: null }
        this.notify()
      }
      return
    }

    const current = this.state.activeTerminalId
    if (wsTerminals.some(t => t.id === current)) return

    const lastId = this.getLastActiveForWorkspace(workspaceId)
    if (lastId) {
      await this.setActiveTerminal(lastId)
      return
    }

    // 首次切到 workspace 時保留既有行為：優先第一個 agent，沒有才用最後一個 tab。
    const agentTerm = wsTerminals.find(t => t.type === 'agent')
    await this.setActiveTerminal((agentTerm || wsTerminals[wsTerminals.length - 1]).id)
  }

  /**
   * 設定 label。lockByUser=true 時標記為手動命名，停止自動跟隨。
   * 自動跟隨呼叫請傳 lockByUser=false（預設），手動改名請傳 true。
   */
  setLabel(id: string, label: string, lockByUser: boolean = false): void {
    const idx = this.state.terminals.findIndex(t => t.id === id)
    if (idx === -1) return
    const cur = this.state.terminals[idx]
    // 已被手動鎖定，自動跟隨呼叫不得覆寫
    if (cur.labelLockedByUser && !lockByUser) return
    if (cur.label === label && (cur.labelLockedByUser ?? false) === lockByUser) return
    const next = [...this.state.terminals]
    next[idx] = { ...cur, label, labelLockedByUser: lockByUser || cur.labelLockedByUser }
    this.state = { ...this.state, terminals: next }
    this.notify()
  }

  private filesRequestNonce: number = 0

  /**
   * 在指定 workspace 的單例 Files tab 內開啟檔案；無則自動建立。
   * relativePath 相對於 workspaceCwd。nonce 遞增確保同檔重複請求也觸發 FilesTab 重載。
   */
  async openFileInFilesTab(workspaceId: string, workspaceCwd: string, relativePath: string): Promise<void> {
    let filesTerm = this.state.terminals.find(t => t.workspaceId === workspaceId && t.type === 'files')
    if (!filesTerm) {
      const created = await this.createTerminal(workspaceId, workspaceCwd, { type: 'files' })
      if (!created) return
      filesTerm = created
    }
    const idx = this.state.terminals.findIndex(t => t.id === filesTerm!.id)
    if (idx === -1) return
    this.filesRequestNonce += 1
    const next = [...this.state.terminals]
    next[idx] = { ...next[idx], filesActiveRequest: { path: relativePath, nonce: this.filesRequestNonce } }
    this.state = { ...this.state, terminals: next, activeTerminalId: filesTerm.id }
    this.rememberWorkspaceActive(workspaceId, filesTerm.id)
    this.notify()
  }

  /** 綁定 Claude session UUID（新建時若已透過 --session-id 指定，啟動後即可呼叫） */
  setClaudeSessionId(id: string, sessionId: string): void {
    const idx = this.state.terminals.findIndex(t => t.id === id)
    if (idx === -1) return
    if (this.state.terminals[idx].claudeSessionId === sessionId) return
    const next = [...this.state.terminals]
    next[idx] = { ...next[idx], claudeSessionId: sessionId }
    this.state = { ...this.state, terminals: next }
    this.notify()
  }

  /** 標記 terminal 為未讀（紅點） */
  markUnread(id: string, unread: boolean): void {
    const idx = this.state.terminals.findIndex(t => t.id === id)
    if (idx === -1) return
    if ((this.state.terminals[idx].unread ?? false) === unread) return
    const next = [...this.state.terminals]
    next[idx] = { ...next[idx], unread }
    this.state = { ...this.state, terminals: next }
    this.notify()
  }

  async killTerminal(id: string): Promise<void> {
    const removed = this.state.terminals.find(t => t.id === id)
    await window.electronAPI.pty.kill(id)

    const terminals = this.state.terminals.filter(t => t.id !== id)
    let activeTerminalId = this.state.activeTerminalId

    // 清掉指向被殺 terminal 的 per-workspace 記錄
    for (const [wsId, lastId] of Array.from(this.workspaceLastActive.entries())) {
      if (lastId === id) this.workspaceLastActive.delete(wsId)
    }

    if (activeTerminalId === id) {
      const sameWorkspace = removed
        ? terminals.filter(t => t.workspaceId === removed.workspaceId)
        : []
      const agentTerm = sameWorkspace.find(t => t.type === 'agent')
      activeTerminalId = agentTerm?.id ?? sameWorkspace[sameWorkspace.length - 1]?.id ?? null
      if (removed) {
        if (sameWorkspace.length > 0 && activeTerminalId) {
          this.rememberWorkspaceActive(removed.workspaceId, activeTerminalId)
        } else {
          this.workspaceLastActive.delete(removed.workspaceId)
        }
      }
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
    this.workspaceLastActive.clear()
    this.state = { terminals: [], activeTerminalId: null }
    this.notify()
  }
}

export const terminalStore = new TerminalStore()
