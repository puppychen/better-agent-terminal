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
