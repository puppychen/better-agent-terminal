import type { CodeAgentType } from './index'

interface SubRepoInfo {
  name: string
  path: string
  branch: string
  dirty: boolean
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
    getGitInfoBatch: (paths: string[]) => Promise<Record<string, { branch: string; dirty: boolean } | null>>
    getSubReposBatch: (paths: string[]) => Promise<Record<string, SubRepoInfo[]>>
  }
  tiling: {
    enable: () => Promise<boolean>
    disable: () => Promise<boolean>
    syncPosition: () => Promise<boolean>
    getStatus: () => Promise<{ enabled: boolean }>
  }
}

declare global {
  interface Window {
    electronAPI: ElectronAPI
  }
}

export {}
