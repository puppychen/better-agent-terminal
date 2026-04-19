import { contextBridge, ipcRenderer } from 'electron'
import type { CodeAgentType } from '../src/types'

const electronAPI = {
  workspace: {
    save: (data: string) => ipcRenderer.invoke('workspace:save', data),
    load: () => ipcRenderer.invoke('workspace:load')
  },
  dialog: {
    selectFolder: () => ipcRenderer.invoke('dialog:select-folder')
  },
  shell: {
    openExternal: (url: string) => ipcRenderer.invoke('shell:open-external', url),
    openPath: (path: string) => ipcRenderer.invoke('shell:open-path', path),
    openWithApp: (appName: string, path: string) => ipcRenderer.invoke('shell:open-with-app', appName, path),
    openTerminalAtPath: (path: string) => ipcRenderer.invoke('shell:open-terminal-at-path', path),
    openTerminalWithCommand: (path: string, command: string) => ipcRenderer.invoke('shell:open-terminal-with-command', path, command),
    checkAgentRunning: (path: string) => ipcRenderer.invoke('shell:check-agent-running', path) as Promise<{ running: boolean; type?: CodeAgentType }>,
    focusAgent: (path: string, agentType: 'claude' | 'happy') => ipcRenderer.invoke('shell:focus-agent', path, agentType) as Promise<boolean>,
    focusTerminalAtPath: (path: string) => ipcRenderer.invoke('shell:focus-terminal-at-path', path) as Promise<boolean>,
    checkTerminals: (path: string) => ipcRenderer.invoke('shell:check-terminals', path) as Promise<{ claude: boolean; happy: boolean; terminal: boolean }>,
    getAllTerminalStates: () => ipcRenderer.invoke('shell:get-all-terminal-states') as Promise<Array<{ tty: string; busy: boolean; processes: string[]; cwd?: string }>>,
    getGitInfoBatch: (paths: string[]) => ipcRenderer.invoke('shell:get-git-info-batch', paths) as Promise<Record<string, { branch: string; dirty: boolean } | null>>,
    getSubReposBatch: (paths: string[]) => ipcRenderer.invoke('shell:get-sub-repos-batch', paths) as Promise<Record<string, Array<{ name: string; path: string; branch: string; dirty: boolean }>>>
  },
  pty: {
    create: (options: any) => ipcRenderer.invoke('pty:create', options),
    write: (id: string, data: string) => ipcRenderer.invoke('pty:write', id, data),
    resize: (id: string, cols: number, rows: number) => ipcRenderer.invoke('pty:resize', id, cols, rows),
    kill: (id: string) => ipcRenderer.invoke('pty:kill', id),
    activate: (id: string) => ipcRenderer.invoke('pty:activate', id),
    deactivate: (id: string) => ipcRenderer.invoke('pty:deactivate', id),
    resume: (id: string) => ipcRenderer.invoke('pty:resume', id),
    onOutput: (callback: (id: string, data: string) => void) => {
      const handler = (_event: any, id: string, data: string) => callback(id, data)
      ipcRenderer.on('pty:output', handler)
      return () => { ipcRenderer.removeListener('pty:output', handler) }
    },
    onExit: (callback: (id: string, exitCode: number) => void) => {
      const handler = (_event: any, id: string, exitCode: number) => callback(id, exitCode)
      ipcRenderer.on('pty:exit', handler)
      return () => { ipcRenderer.removeListener('pty:exit', handler) }
    },
    onBufferFlushed: (callback: (id: string, data: string) => void) => {
      const handler = (_event: any, id: string, data: string) => callback(id, data)
      ipcRenderer.on('pty:buffer-flushed', handler)
      return () => { ipcRenderer.removeListener('pty:buffer-flushed', handler) }
    }
  },
  ws: {
    getStatus: () => ipcRenderer.invoke('ws:get-status'),
    toggle: (enabled: boolean) => ipcRenderer.invoke('ws:toggle', enabled),
    onClientChange: (callback: (count: number) => void) => {
      const handler = (_event: any, count: number) => callback(count)
      ipcRenderer.on('ws:client-change', handler)
      return () => { ipcRenderer.removeListener('ws:client-change', handler) }
    },
    onStatusChange: (callback: (running: boolean) => void) => {
      const handler = (_event: any, running: boolean) => callback(running)
      ipcRenderer.on('ws:status-change', handler)
      return () => { ipcRenderer.removeListener('ws:status-change', handler) }
    }
  },
  notify: {
    getStatus: () => ipcRenderer.invoke('notify:get-status'),
    toggle: (enabled: boolean) => ipcRenderer.invoke('notify:toggle', enabled),
    checkHookInstalled: () => ipcRenderer.invoke('notify:check-hook-installed'),
    installHook: () => ipcRenderer.invoke('notify:install-hook'),
    onEvent: (callback: (event: { cwd: string; event: 'stop' | 'wait'; sessionId?: string; meta?: { tool?: string; description?: string } }) => void) => {
      const handler = (_e: any, event: any) => callback(event)
      ipcRenderer.on('notify:event', handler)
      return () => { ipcRenderer.removeListener('notify:event', handler) }
    },
    onFocusTerminal: (callback: (event: { cwd: string; sessionId?: string }) => void) => {
      const handler = (_e: any, event: any) => callback(event)
      ipcRenderer.on('notify:focus-terminal', handler)
      return () => { ipcRenderer.removeListener('notify:focus-terminal', handler) }
    }
  },
  fs: {
    listDir: (workspaceCwd: string, relativePath: string) => ipcRenderer.invoke('fs:list-dir', workspaceCwd, relativePath),
    readFile: (workspaceCwd: string, relativePath: string) => ipcRenderer.invoke('fs:read-file', workspaceCwd, relativePath),
    stat: (workspaceCwd: string, relativePath: string) => ipcRenderer.invoke('fs:stat', workspaceCwd, relativePath),
    writeFile: (workspaceCwd: string, relativePath: string, content: string, expectedMtime?: number) => ipcRenderer.invoke('fs:write-file', workspaceCwd, relativePath, content, expectedMtime)
  },
  git: {
    getFileStatus: (workspaceCwd: string) => ipcRenderer.invoke('git:file-status', workspaceCwd)
  },
  claudeSessions: {
    list: (cwd: string) => ipcRenderer.invoke('claude-sessions:list', cwd),
    delete: (cwd: string, sessionId: string) => ipcRenderer.invoke('claude-sessions:delete', cwd, sessionId),
    watch: (cwd: string) => ipcRenderer.invoke('claude-sessions:watch', cwd),
    unwatch: (cwd: string) => ipcRenderer.invoke('claude-sessions:unwatch', cwd),
    onChange: (callback: (cwd: string) => void) => {
      const handler = (_e: any, cwd: string) => callback(cwd)
      ipcRenderer.on('claude-sessions:changed', handler)
      return () => { ipcRenderer.removeListener('claude-sessions:changed', handler) }
    }
  },
  window: {
    onFocus: (callback: () => void) => {
      const handler = () => callback()
      ipcRenderer.on('window:focus', handler)
      return () => { ipcRenderer.removeListener('window:focus', handler) }
    },
    onCloseActiveTab: (callback: () => void) => {
      const handler = () => callback()
      ipcRenderer.on('terminal:close-active-tab', handler)
      return () => { ipcRenderer.removeListener('terminal:close-active-tab', handler) }
    },
    onConfirmQuit: (callback: () => void) => {
      const handler = () => callback()
      ipcRenderer.on('app:confirm-quit', handler)
      return () => { ipcRenderer.removeListener('app:confirm-quit', handler) }
    },
    confirmQuit: () => ipcRenderer.send('app:quit-confirmed')
  }
}

contextBridge.exposeInMainWorld('electronAPI', electronAPI)

declare global {
  interface Window {
    electronAPI: typeof electronAPI
  }
}
