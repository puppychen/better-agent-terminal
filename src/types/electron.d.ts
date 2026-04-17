import type { CodeAgentType, CreatePtyOptions } from './index'

export interface ClaudeSessionEntry {
  sessionId: string
  fullPath: string
  fileMtime: number
  firstPrompt: string
  summary?: string
  messageCount: number
  created: string
  modified: string
  gitBranch?: string
  projectPath: string
  isSidechain: boolean
}

export type ClaudeSessionListResult =
  | { ok: true; entries: ClaudeSessionEntry[] }
  | { ok: false; error: 'NO_INDEX' | 'PARSE_ERROR' | 'UNSUPPORTED_VERSION'; message?: string }

export type ClaudeSessionDeleteResult =
  | { ok: true }
  | { ok: false; error: 'NO_INDEX' | 'UNSUPPORTED_VERSION' | 'NOT_FOUND' | 'IO_ERROR'; message?: string }

export interface FsDirEntry {
  name: string
  isDirectory: boolean
  isSymlink: boolean
}

export type FsListDirResult =
  | { ok: true; entries: FsDirEntry[] }
  | { ok: false; error: 'OUT_OF_SCOPE' | 'NOT_FOUND' | 'NOT_DIRECTORY' | 'IO_ERROR'; message?: string }

export type FsReadFileResult =
  | { ok: true; content: string; mtime: number; size: number }
  | { ok: false; error: 'OUT_OF_SCOPE' | 'NOT_FOUND' | 'NOT_FILE' | 'TOO_LARGE' | 'BINARY' | 'IO_ERROR'; message?: string }

export type FsStatResult =
  | { ok: true; mtime: number; size: number; isDirectory: boolean }
  | { ok: false; error: 'OUT_OF_SCOPE' | 'NOT_FOUND' | 'IO_ERROR'; message?: string }

interface SubRepoInfo {
  name: string
  path: string
  branch: string
  dirty: boolean
  filesChanged: number
  insertions: number
  deletions: number
}

interface ElectronAPI {
  workspace: {
    save: (data: string) => Promise<boolean>
    load: () => Promise<string | null>
  }
  dialog: {
    selectFolder: () => Promise<string | null>
  }
  shell: {
    openExternal: (url: string) => Promise<void>
    openPath: (path: string) => Promise<void>
    openWithApp: (appName: string, path: string) => Promise<void>
    openTerminalAtPath: (path: string) => Promise<{ action: 'created' | 'focused' | 'unsupported' }>
    openTerminalWithCommand: (path: string, command: string) => Promise<{ action: 'created' | 'focused' | 'unsupported' }>
    checkAgentRunning: (path: string) => Promise<{ running: boolean; type?: CodeAgentType }>
    focusAgent: (path: string, agentType: 'claude' | 'happy') => Promise<boolean>
    focusTerminalAtPath: (path: string) => Promise<boolean>
    checkTerminals: (path: string) => Promise<{ claude: boolean; happy: boolean; terminal: boolean }>
    getAllTerminalStates: () => Promise<Array<{ tty: string; busy: boolean; processes: string[]; cwd?: string }>>
    getGitInfoBatch: (paths: string[]) => Promise<Record<string, { branch: string; dirty: boolean; filesChanged: number; insertions: number; deletions: number } | null>>
    getSubReposBatch: (paths: string[]) => Promise<Record<string, SubRepoInfo[]>>
  }
  pty: {
    create: (options: CreatePtyOptions) => Promise<boolean>
    write: (id: string, data: string) => Promise<void>
    resize: (id: string, cols: number, rows: number) => Promise<void>
    kill: (id: string) => Promise<boolean>
    activate: (id: string) => Promise<void>
    deactivate: (id: string) => Promise<void>
    resume: (id: string) => Promise<void>
    onOutput: (callback: (id: string, data: string) => void) => () => void
    onExit: (callback: (id: string, exitCode: number) => void) => () => void
    onBufferFlushed: (callback: (id: string, data: string) => void) => () => void
  }
  ws: {
    getStatus: () => Promise<{
      running: boolean
      port: number | null
      token: string | null
      clientCount: number
      host: string
    }>
    toggle: (enabled: boolean) => Promise<void>
    onClientChange: (callback: (count: number) => void) => () => void
    onStatusChange: (callback: (running: boolean) => void) => () => void
  }
  notify: {
    getStatus: () => Promise<{
      running: boolean
      enabled: boolean
      port: number
      token: string | null
      tokenPath: string
    }>
    toggle: (enabled: boolean) => Promise<void>
    checkHookInstalled: () => Promise<{
      installed: boolean
      hasStop: boolean
      hasNotification: boolean
      scriptExists: boolean
    }>
    installHook: () => Promise<{
      success: boolean
      scriptPath?: string
      settingsPath?: string
      backupPath?: string | null
      backedUp?: boolean
      error?: string
    }>
    onEvent: (callback: (event: { cwd: string; event: 'stop' | 'wait'; sessionId?: string; meta?: { tool?: string; description?: string } }) => void) => () => void
    onFocusTerminal: (callback: (event: { cwd: string; sessionId?: string }) => void) => () => void
  }
  claudeSessions: {
    list: (cwd: string) => Promise<ClaudeSessionListResult>
    delete: (cwd: string, sessionId: string) => Promise<ClaudeSessionDeleteResult>
    watch: (cwd: string) => Promise<boolean>
    unwatch: (cwd: string) => Promise<boolean>
    onChange: (callback: (cwd: string) => void) => () => void
  }
  fs: {
    listDir: (workspaceCwd: string, relativePath: string) => Promise<FsListDirResult>
    readFile: (workspaceCwd: string, relativePath: string) => Promise<FsReadFileResult>
    stat: (workspaceCwd: string, relativePath: string) => Promise<FsStatResult>
  }
  window: {
    onFocus: (callback: () => void) => () => void
    onCloseActiveTab: (callback: () => void) => () => void
    onConfirmQuit: (callback: () => void) => () => void
    confirmQuit: () => void
  }
}

declare global {
  interface Window {
    electronAPI: ElectronAPI
  }
}

export {}
