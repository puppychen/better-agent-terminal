import { BrowserWindow } from 'electron'
import { spawn, ChildProcess } from 'child_process'
import { basename } from 'path'
import type { CreatePtyOptions } from '../src/types'
import type { WsServer } from './ws-server'
import type { SessionInfo } from './ws-types'
import { PermissionDetector } from './ws-permission-detector'

// node-pty 動態載入：優先使用，不可用時 fallback child_process
let pty: typeof import('node-pty') | null = null
let ptyAvailable = false
try {
  pty = require('node-pty')
  if (pty && typeof pty.spawn === 'function') {
    ptyAvailable = true
    console.log('[pty-manager] node-pty loaded successfully')
  }
} catch (e) {
  console.warn('[pty-manager] node-pty not available, falling back to child_process:', e)
}

/**
 * Ring Buffer — 每個 terminal 的輸出暫存區
 * Gate-and-Buffer 架構的核心：永遠捕獲所有輸出，activate 時 flush
 */
class RingBuffer {
  private chunks: string[] = []
  private totalSize = 0
  private readonly maxSize: number

  constructor(maxSize = 1024 * 1024) { // 1MB
    this.maxSize = maxSize
  }

  append(data: string): void {
    this.chunks.push(data)
    this.totalSize += data.length
    while (this.totalSize > this.maxSize && this.chunks.length > 1) {
      const removed = this.chunks.shift()!
      this.totalSize -= removed.length
    }
  }

  flush(): string {
    const result = this.chunks.join('')
    this.chunks = []
    this.totalSize = 0
    return result
  }

  get size(): number { return this.totalSize }
}

interface PtyInstance {
  process: any // IPty or ChildProcess
  usePty: boolean
  cwd: string
  type: 'shell' | 'agent'
  buffer: RingBuffer
  lastCols: number
  lastRows: number
  startedAt: string           // ISO 8601
  permissionDetector?: PermissionDetector
}

export class PtyManager {
  private instances: Map<string, PtyInstance> = new Map()
  private activeSet: Set<string> = new Set()
  private mainWindow: BrowserWindow | null = null
  private wsServer: WsServer | null = null

  setMainWindow(win: BrowserWindow | null): void {
    this.mainWindow = win
  }

  getMainWindow(): BrowserWindow | null {
    return this.mainWindow
  }

  setWsServer(ws: WsServer | null): void {
    this.wsServer = ws
  }

  private send(channel: string, ...args: unknown[]): void {
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      try {
        this.mainWindow.webContents.send(channel, ...args)
      } catch { /* window may be closing */ }
    }
  }

  // === Gate-and-Buffer ===

  private handleOutput(id: string, data: string): void {
    const instance = this.instances.get(id)
    if (!instance) return

    // ALWAYS buffer（不漏任何資料）
    instance.buffer.append(data)

    // 只在 activeSet 內才推送 IPC
    if (this.activeSet.has(id)) {
      this.send('pty:output', id, data)
    }

    // Permission 偵測（agent session only）
    instance.permissionDetector?.feedOutput(data)

    // WS 廣播（不受 activeSet 限制 — WS 訂閱者獨立管理）
    this.wsServer?.broadcastOutput(id, data)
  }

  activate(id: string): void {
    if (!this.instances.has(id)) return
    this.activeSet.add(id)

    // Flush 累積的 buffer（不送 SIGWINCH — SIGWINCH 會觸發 CLI 重繪改變內容位置）
    const instance = this.instances.get(id)!
    const buffered = instance.buffer.flush()
    if (buffered.length > 0) {
      this.send('pty:buffer-flushed', id, buffered)
    }
  }

  // Resume: reopen IPC gate without flushing buffer (for window refocus)
  // Discards buffered data from blur period to avoid display glitch
  resume(id: string): void {
    if (!this.instances.has(id)) return
    this.activeSet.add(id)
    // Clear buffer without sending — blur period data is mostly CLI refresh sequences
    this.instances.get(id)!.buffer.flush()
  }

  deactivate(id: string): void {
    this.activeSet.delete(id)
  }

  deactivateAll(): void {
    this.activeSet.clear()
  }

  // === PTY 生命週期 ===

  private getDefaultShell(): string {
    return process.env.SHELL || '/bin/zsh'
  }

  create(options: CreatePtyOptions): boolean {
    const { id, cwd, shell: shellOverride, initialCommand } = options

    const shell = shellOverride || this.getDefaultShell()
    const args: string[] = ['-l', '-i'] // login interactive shell

    const envWithUtf8: Record<string, string> = {
      ...process.env as Record<string, string>,
      LANG: 'en_US.UTF-8',
      LC_ALL: 'en_US.UTF-8',
      PYTHONIOENCODING: 'utf-8',
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      TERM_PROGRAM: 'better-agent',
      FORCE_COLOR: '3',
      CI: ''
    }

    let usedPty = false

    if (ptyAvailable && pty) {
      try {
        const ptyProcess = pty.spawn(shell, args, {
          name: 'xterm-256color',
          cols: 120,
          rows: 30,
          cwd,
          env: envWithUtf8
        })

        ptyProcess.onData((data: string) => {
          this.handleOutput(id, data)
        })

        ptyProcess.onExit(({ exitCode }: { exitCode: number }) => {
          this.send('pty:exit', id, exitCode)
          this.wsServer?.broadcastExit(id, exitCode)
          this.activeSet.delete(id)
          this.instances.delete(id)
        })

        const inst = {
          process: ptyProcess, usePty: true, cwd,
          type: options.type, buffer: new RingBuffer(),
          lastCols: 120, lastRows: 30,
          startedAt: new Date().toISOString()
        } as PtyInstance
        if (options.type === 'agent') {
          inst.permissionDetector = new PermissionDetector(id,
            (perm) => this.wsServer?.broadcastPermission(id, perm),
            (res) => this.wsServer?.broadcastPermissionResolved(id, res)
          )
        }
        this.instances.set(id, inst)
        usedPty = true
      } catch (e) {
        console.warn('[pty-manager] node-pty spawn failed, falling back:', e)
        ptyAvailable = false
      }
    }

    if (!usedPty) {
      try {
        const childProcess = spawn(shell, args, {
          cwd,
          env: envWithUtf8 as NodeJS.ProcessEnv,
          stdio: ['pipe', 'pipe', 'pipe'],
          shell: false
        })

        childProcess.stdout?.on('data', (data: Buffer) => {
          this.handleOutput(id, data.toString())
        })

        childProcess.stderr?.on('data', (data: Buffer) => {
          this.handleOutput(id, data.toString())
        })

        childProcess.on('exit', (exitCode: number | null) => {
          const code = exitCode ?? 0
          this.send('pty:exit', id, code)
          this.wsServer?.broadcastExit(id, code)
          this.activeSet.delete(id)
          this.instances.delete(id)
        })

        childProcess.on('error', (error) => {
          this.handleOutput(id, `\r\n[Error: ${error.message}]\r\n`)
        })

        const inst2 = {
          process: childProcess, usePty: false, cwd,
          type: options.type, buffer: new RingBuffer(),
          lastCols: 120, lastRows: 30,
          startedAt: new Date().toISOString()
        } as PtyInstance
        if (options.type === 'agent') {
          inst2.permissionDetector = new PermissionDetector(id,
            (perm) => this.wsServer?.broadcastPermission(id, perm),
            (res) => this.wsServer?.broadcastPermissionResolved(id, res)
          )
        }
        this.instances.set(id, inst2)
      } catch (error) {
        console.error('[pty-manager] Failed to create terminal:', error)
        return false
      }
    }

    // initialCommand 延遲注入（等 shell ready）
    if (initialCommand) {
      setTimeout(() => {
        this.write(id, initialCommand + '\r')
      }, 1500)
    }

    // 通知 WS clients session 列表變化
    this.wsServer?.broadcastSessionList()

    return true
  }

  write(id: string, data: string): void {
    const instance = this.instances.get(id)
    if (!instance) return

    // 偵測本地 stdin 的 y/n（permission 解決）
    instance.permissionDetector?.feedStdin(data)

    if (instance.usePty) {
      instance.process.write(data)
    } else {
      const cp = instance.process as ChildProcess
      cp.stdin?.write(data)
    }
  }

  resize(id: string, cols: number, rows: number): void {
    const instance = this.instances.get(id)
    if (instance && instance.usePty) {
      instance.process.resize(cols, rows)
      instance.lastCols = cols
      instance.lastRows = rows
    }
  }

  kill(id: string): boolean {
    const instance = this.instances.get(id)
    if (!instance) return false

    instance.permissionDetector?.dispose()
    if (instance.usePty) {
      instance.process.kill()
    } else {
      (instance.process as ChildProcess).kill()
    }
    this.activeSet.delete(id)
    this.instances.delete(id)

    // 通知 WS clients session 列表變化
    this.wsServer?.broadcastSessionList()

    return true
  }

  dispose(): void {
    for (const [id] of this.instances) {
      this.kill(id)
    }
  }

  // === WS Server 查詢介面 ===

  /** 取得所有 session 列表（供 WS server） */
  getSessionList(): SessionInfo[] {
    return Array.from(this.instances.entries()).map(([id, inst]) => {
      const name = basename(inst.cwd)
      const tag = inst.type === 'agent' ? 'agent' : 'shell'
      return {
        sessionId: id,
        projectName: name,
        projectPath: inst.cwd,
        type: inst.type,
        label: `${name} [${tag}]`,
        status: 'running' as const,
        startedAt: inst.startedAt,
        pid: inst.usePty ? (inst.process.pid ?? 0) : (inst.process as ChildProcess).pid ?? 0,
        metadata: { type: inst.type }
      }
    })
  }

  /** 檢查 session 是否存在 */
  hasSession(id: string): boolean {
    return this.instances.has(id)
  }

  /** 遠端寫入 pty stdin（由 WS input 觸發） */
  writeFromRemote(id: string, data: string): { success: boolean; bytesWritten?: number; error?: string } {
    const instance = this.instances.get(id)
    if (!instance) return { success: false, error: 'SESSION_NOT_FOUND' }
    try {
      this.write(id, data)
      return { success: true, bytesWritten: data.length }
    } catch (e) {
      return { success: false, error: 'PTY_WRITE_ERROR' }
    }
  }

  /** 取得指定 session 的 PermissionDetector（供 WS permission resolve） */
  getPermissionDetector(id: string): PermissionDetector | undefined {
    return this.instances.get(id)?.permissionDetector
  }
}
