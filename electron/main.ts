import { app, BrowserWindow, ipcMain, dialog, shell, powerSaveBlocker } from 'electron'
import path from 'path'
import { PtyManager } from './pty-manager'

let mainWindow: BrowserWindow | null = null
let ptyManager: PtyManager | null = null
let powerSaveBlockerId: number | null = null

const VITE_DEV_SERVER_URL = process.env['VITE_DEV_SERVER_URL']

// Prevent App Nap on macOS - must be set before app is ready
if (process.platform === 'darwin') {
  app.commandLine.appendSwitch('disable-renderer-backgrounding')
  app.commandLine.appendSwitch('disable-background-timer-throttling')
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 800,
    minHeight: 600,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      backgroundThrottling: false  // Prevent throttling when app is in background
    },
    frame: true,
    titleBarStyle: 'default',
    title: 'Better Agent Terminal'
  })

  // Start power save blocker to prevent system from suspending PTY processes
  if (powerSaveBlockerId === null) {
    powerSaveBlockerId = powerSaveBlocker.start('prevent-app-suspension')
    console.log('Power save blocker started:', powerSaveBlockerId)
  }

  ptyManager = new PtyManager(mainWindow)

  if (VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(VITE_DEV_SERVER_URL)
    mainWindow.webContents.openDevTools()
  } else {
    mainWindow.loadFile(path.join(__dirname, '../dist/index.html'))
  }

  // Dispose PTY manager before window is destroyed to prevent IPC errors
  mainWindow.on('close', () => {
    ptyManager?.dispose()
  })

  mainWindow.on('closed', () => {
    mainWindow = null
    ptyManager = null
    // Stop power save blocker
    if (powerSaveBlockerId !== null) {
      powerSaveBlocker.stop(powerSaveBlockerId)
      powerSaveBlockerId = null
    }
  })
}

app.whenReady().then(createWindow)

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow()
  }
})

// IPC Handlers
ipcMain.handle('pty:create', async (_event, options) => {
  return ptyManager?.create(options)
})

ipcMain.handle('pty:write', async (_event, id: string, data: string) => {
  ptyManager?.write(id, data)
})

ipcMain.handle('pty:resize', async (_event, id: string, cols: number, rows: number) => {
  ptyManager?.resize(id, cols, rows)
})

ipcMain.handle('pty:kill', async (_event, id: string) => {
  return ptyManager?.kill(id)
})

ipcMain.handle('pty:restart', async (_event, id: string, cwd: string, shell?: string) => {
  return ptyManager?.restart(id, cwd, shell)
})

ipcMain.handle('pty:get-cwd', async (_event, id: string) => {
  return ptyManager?.getCwd(id)
})

ipcMain.handle('pty:exists', async (_event, id: string) => {
  return ptyManager?.exists(id) ?? false
})

ipcMain.handle('pty:get-output-buffer', async (_event, id: string) => {
  return ptyManager?.getOutputBuffer(id)
})

ipcMain.handle('pty:clear-output-buffer', async (_event, id: string) => {
  ptyManager?.clearOutputBuffer(id)
})

ipcMain.handle('dialog:select-folder', async () => {
  const result = await dialog.showOpenDialog(mainWindow!, {
    properties: ['openDirectory']
  })
  return result.canceled ? null : result.filePaths[0]
})

ipcMain.handle('workspace:save', async (_event, data: string) => {
  const fs = await import('fs/promises')
  const configPath = path.join(app.getPath('userData'), 'workspaces.json')
  await fs.writeFile(configPath, data, 'utf-8')
  return true
})

ipcMain.handle('workspace:load', async () => {
  const fs = await import('fs/promises')
  const configPath = path.join(app.getPath('userData'), 'workspaces.json')
  try {
    const data = await fs.readFile(configPath, 'utf-8')
    return data
  } catch {
    return null
  }
})

// Settings handlers
ipcMain.handle('settings:save', async (_event, data: string) => {
  const fs = await import('fs/promises')
  const configPath = path.join(app.getPath('userData'), 'settings.json')
  await fs.writeFile(configPath, data, 'utf-8')
  return true
})

ipcMain.handle('settings:load', async () => {
  const fs = await import('fs/promises')
  const configPath = path.join(app.getPath('userData'), 'settings.json')
  try {
    const data = await fs.readFile(configPath, 'utf-8')
    return data
  } catch {
    return null
  }
})

ipcMain.handle('settings:get-shell-path', async (_event, shellType: string) => {
  const fs = await import('fs')

  // Handle auto - return undefined to let pty-manager use its cross-platform logic
  if (shellType === 'auto') {
    return undefined
  }

  // Windows-specific shells
  if (process.platform === 'win32') {
    if (shellType === 'pwsh') {
      const pwshPaths = [
        'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
        'C:\\Program Files (x86)\\PowerShell\\7\\pwsh.exe',
        process.env.LOCALAPPDATA + '\\Microsoft\\WindowsApps\\pwsh.exe'
      ]
      for (const p of pwshPaths) {
        if (fs.existsSync(p)) {
          return p
        }
      }
      return 'pwsh.exe'
    }

    if (shellType === 'powershell') {
      return 'powershell.exe'
    }

    if (shellType === 'cmd') {
      return 'cmd.exe'
    }
  }

  // macOS/Linux - return undefined for default shells to use pty-manager logic
  if (shellType === 'zsh' || shellType === 'bash') {
    return undefined // Let pty-manager handle it
  }

  return shellType // custom path
})

ipcMain.handle('shell:open-external', async (_event, url: string) => {
  await shell.openExternal(url)
})
