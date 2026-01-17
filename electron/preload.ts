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
    focusAgent: (path: string, agentType: 'claude' | 'happy') => ipcRenderer.invoke('shell:focus-agent', path, agentType) as Promise<boolean>
  }
}

contextBridge.exposeInMainWorld('electronAPI', electronAPI)

declare global {
  interface Window {
    electronAPI: typeof electronAPI
  }
}
