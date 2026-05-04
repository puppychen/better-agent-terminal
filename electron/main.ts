import { app, BrowserWindow, ipcMain, dialog, shell, Menu, Notification } from 'electron'
import path from 'path'
import os from 'os'
import fs from 'fs'
import { PtyManager } from './pty-manager'
import { WsServer } from './ws-server'
import type { WsServerConfig } from './ws-types'
import { NotifyServer } from './notify-server'
import type { NotifyConfig, NotifyEvent } from './notify-server'
import { listSessions as csList, deleteSession as csDelete, watchSessions as csWatch } from './claude-sessions'
import { listDir as fsListDir, readFile as fsReadFile, stat as fsStat, writeFile as fsWriteFile } from './file-system'
import { getFileStatuses as gitGetFileStatuses } from './git-status'

// userData migration: Better Agent Terminal → Better Agent Workspace
// Dev mode uses package.json "name" (lowercase), production uses "productName" (title case)
const newUserDataDir = app.getPath('userData')
const appDataDir = app.getPath('appData')
const oldUserDataCandidates = [
  path.join(appDataDir, 'Better Agent Terminal'),  // production build
  path.join(appDataDir, 'better-agent-terminal'),  // dev mode
]
if (!fs.existsSync(newUserDataDir)) {
  for (const oldDir of oldUserDataCandidates) {
    if (oldDir !== newUserDataDir && fs.existsSync(oldDir)) {
      fs.cpSync(oldDir, newUserDataDir, { recursive: true })
      break
    }
  }
}

let mainWindow: BrowserWindow | null = null
let ptyManager: PtyManager | null = null
let wsServer: WsServer | null = null
let notifyServer: NotifyServer | null = null

// === Notification Config（模組層級） ===
const notifySettingsPath = path.join(os.homedir(), '.claude', 'better-agent', 'notify-settings.json')
const notifyConfig: NotifyConfig = {
  enabled: false,
  port: 19837,
  tokenPath: path.join(os.homedir(), '.claude', 'better-agent', 'notify-auth.txt')
}
try {
  if (fs.existsSync(notifySettingsPath)) {
    const saved = JSON.parse(fs.readFileSync(notifySettingsPath, 'utf-8'))
    if (typeof saved.enabled === 'boolean') notifyConfig.enabled = saved.enabled
    const port = Number(saved.port)
    if (port >= 1024 && port <= 65535) notifyConfig.port = port
  }
} catch { /* ignore parse errors */ }

// === WebSocket Config（模組層級，供 IPC handler 存取） ===
const wsSettingsPath = path.join(os.homedir(), '.claude', 'better-agent', 'ws-settings.json')
let wsConfig: WsServerConfig = {
  enabled: false,
  port: 19836,
  host: '127.0.0.1',
  tokenPath: path.join(os.homedir(), '.claude', 'better-agent', 'ws-auth.json')
}
try {
  if (fs.existsSync(wsSettingsPath)) {
    const saved = JSON.parse(fs.readFileSync(wsSettingsPath, 'utf-8'))
    // Validate saved settings before applying
    if (typeof saved.enabled === 'boolean') wsConfig.enabled = saved.enabled
    const port = Number(saved.port)
    if (port >= 1024 && port <= 65535) wsConfig.port = port
    if (saved.host === '127.0.0.1' || saved.host === '0.0.0.0') wsConfig.host = saved.host
  }
} catch { /* ignore parse errors */ }
let forceQuit = false

const VITE_DEV_SERVER_URL = process.env['VITE_DEV_SERVER_URL']
const WINDOW_STATE_FILE = 'window-state.json'

interface WindowState {
  x?: number
  y?: number
  width: number
  height: number
}

async function loadWindowState(): Promise<WindowState | null> {
  const fs = await import('fs/promises')
  const configPath = path.join(app.getPath('userData'), WINDOW_STATE_FILE)
  try {
    const data = await fs.readFile(configPath, 'utf-8')
    return JSON.parse(data)
  } catch {
    return null
  }
}

async function saveWindowState(state: WindowState): Promise<void> {
  const fs = await import('fs/promises')
  const configPath = path.join(app.getPath('userData'), WINDOW_STATE_FILE)
  await fs.writeFile(configPath, JSON.stringify(state), 'utf-8')
}

async function createWindow() {
  const savedState = await loadWindowState()
  const defaultWidth = 1200
  const defaultHeight = 800

  mainWindow = new BrowserWindow({
    width: savedState?.width || defaultWidth,
    height: savedState?.height || defaultHeight,
    x: savedState?.x,
    y: savedState?.y,
    minWidth: 600,
    minHeight: 400,
    icon: path.join(__dirname, '..', 'assets', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true
    },
    frame: true,
    titleBarStyle: 'default',
    title: 'Better Agent Workspace'
  })

  if (VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(VITE_DEV_SERVER_URL)
    mainWindow.webContents.openDevTools()
  } else {
    mainWindow.loadFile(path.join(__dirname, '../dist/index.html'))
  }

  mainWindow.on('closed', () => {
    if (notifyServer) {
      notifyServer.stop()
      notifyServer = null
    }
    if (wsServer) {
      wsServer.stop()
      wsServer = null
    }
    if (ptyManager) {
      ptyManager.dispose()
      ptyManager = null
    }
    // 清理 sessions-index 監聽（避免 hot reload / 多視窗場景累積）
    for (const [, w] of claudeSessionWatchers) {
      try { w.dispose() } catch { /* ignore */ }
    }
    claudeSessionWatchers.clear()
    mainWindow = null
  })

  // Window blur: 不再 deactivate — renderer 自行暫停 xterm 寫入
  // Gate-and-Buffer (deactivateAll/activate) 僅用於 tab 切換
  mainWindow.on('blur', () => {
    // noop — IPC 持續流動，renderer 端暫停 rAF 排程
  })

  // Window focus → 通知 renderer 恢復 active terminal
  mainWindow.on('focus', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('window:focus')
    }
  })

  ptyManager = new PtyManager()
  ptyManager.setMainWindow(mainWindow)

  // === WebSocket Server（預設關閉，wsConfig 已在模組層級初始化） ===
  if (wsConfig.enabled) {
    wsServer = new WsServer(wsConfig, ptyManager)
    ptyManager.setWsServer(wsServer)
    wsServer.start()
  }

  // === Notification Server（預設關閉） ===
  if (notifyConfig.enabled) {
    startNotifyServer()
  }

  // === Custom application menu ===
  // Cmd+W → close active terminal tab (not window)
  // Cmd+Q → quit with confirmation
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        {
          label: 'Quit',
          accelerator: 'CmdOrCtrl+Q',
          click: () => {
            if (!mainWindow || mainWindow.isDestroyed()) { app.quit(); return }
            mainWindow.webContents.send('app:confirm-quit')
          }
        }
      ]
    },
    {
      label: 'File',
      submenu: [
        {
          label: 'Close Tab',
          accelerator: 'CmdOrCtrl+W',
          click: () => {
            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.webContents.send('terminal:close-active-tab')
            }
          }
        }
      ]
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' }
      ]
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        { type: 'separator' },
        { role: 'front' }
      ]
    }
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))

  // Prevent close from instantly quitting — send to renderer for confirmation
  mainWindow.on('close', (e) => {
    if (!forceQuit && mainWindow && !mainWindow.isDestroyed()) {
      e.preventDefault()
      mainWindow.webContents.send('app:confirm-quit')
    }
  })
}

app.whenReady().then(createWindow)

app.on('before-quit', () => {
  if (ptyManager) {
    ptyManager.dispose()
    ptyManager = null
  }
})

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
ipcMain.handle('dialog:select-folder', async () => {
  const result = await dialog.showOpenDialog(mainWindow!, {
    properties: ['openDirectory']
  })
  return result.canceled ? null : result.filePaths[0]
})

ipcMain.handle('workspace:save', async (_event, data: string) => {
  const fs = await import('fs/promises')
  const configPath = path.join(app.getPath('appData'), 'better-agent-terminal', 'workspaces.json')
  await fs.mkdir(path.dirname(configPath), { recursive: true })
  await fs.writeFile(configPath, data, 'utf-8')
  return true
})

ipcMain.handle('workspace:load', async () => {
  const fs = await import('fs/promises')
  const configPath = path.join(app.getPath('appData'), 'better-agent-terminal', 'workspaces.json')
  try {
    const data = await fs.readFile(configPath, 'utf-8')
    return data
  } catch {
    return null
  }
})

ipcMain.handle('shell:open-external', async (_event, url: string) => {
  await shell.openExternal(url)
})

ipcMain.handle('shell:open-path', async (_event, folderPath: string) => {
  await shell.openPath(folderPath)
})

ipcMain.handle('shell:open-with-app', async (_event, appName: string, folderPath: string) => {
  const { exec } = await import('child_process')
  const handleExecError = (error: Error | null) => {
    if (error) {
      console.error(`Failed to open ${appName}:`, error.message)
    }
  }

  if (process.platform === 'darwin') {
    exec(`open -a "${appName}" "${folderPath}"`, handleExecError)
  } else if (process.platform === 'win32') {
    if (appName === 'Visual Studio Code') {
      exec(`code "${folderPath}"`, handleExecError)
    } else {
      exec(`"${appName}" "${folderPath}"`, handleExecError)
    }
  } else {
    exec(`${appName.toLowerCase().replace(/ /g, '')} "${folderPath}"`, handleExecError)
  }
})

// Helper: Find existing Terminal.app tab with matching title (startsWith or contains)
async function findExistingTerminalTab(pattern: string, matchMode: 'startsWith' | 'contains' = 'startsWith'): Promise<boolean> {
  const { exec } = await import('child_process')
  return new Promise((resolve) => {
    const escapedPattern = pattern.replace(/"/g, '\\"')
    const condition = matchMode === 'startsWith'
      ? `custom title of t starts with "${escapedPattern}"`
      : `custom title of t contains "${escapedPattern}"`

    const script = `
      tell application "Terminal"
        if not running then return false
        repeat with w in windows
          repeat with i from 1 to (count of tabs of w)
            set t to tab i of w
            if ${condition} then
              set frontmost of w to true
              set selected of t to true
              activate
              return true
            end if
          end repeat
        end repeat
        return false
      end tell
    `
    exec(`osascript -e '${script.replace(/'/g, "'\\''")}'`, (error, stdout) => {
      if (error) {
        resolve(false)
        return
      }
      resolve(stdout.trim() === 'true')
    })
  })
}

// Helper: Find Terminal tab by process name and cwd (does NOT rely on title)
// This searches ALL terminal tabs and checks if the specified process is running at the target path
async function findTerminalTabByProcess(processName: string, targetPath: string, options?: { focus?: boolean; updateTitle?: string }): Promise<boolean> {
  const { exec } = await import('child_process')

  return new Promise((resolve) => {
    // Get ALL terminal tabs (no title filtering)
    const script = `
      tell application "Terminal"
        if not running then return ""
        set output to ""
        repeat with w in windows
          set winId to id of w
          set tabCount to count of tabs of w
          repeat with i from 1 to tabCount
            set t to tab i of w
            set tabTty to tty of t
            set output to output & (winId as string) & "," & (i as string) & "," & tabTty & linefeed
          end repeat
        end repeat
        return output
      end tell
    `

    exec(`osascript -e '${script.replace(/'/g, "'\\''")}'`, (error, stdout) => {
      if (error || !stdout.trim()) {
        resolve(false)
        return
      }

      const tabs = stdout.trim().split('\n').filter(Boolean)

      const checkNextTab = (index: number) => {
        if (index >= tabs.length) {
          resolve(false)
          return
        }

        const [winId, tabIndex, tty] = tabs[index].split(',')
        const ttyShort = tty.replace('/dev/', '')

        // Check if the specified process is running at the target path
        const cwdCmd = `ps -t ${ttyShort} -o pid,comm 2>/dev/null | grep "${processName}" | head -1 | awk '{print $1}' | xargs -I{} lsof -a -d cwd -p {} 2>/dev/null | awk 'NR==2 {print $NF}'`

        exec(cwdCmd, (err, cwdOutput) => {
          const cwd = cwdOutput?.trim()
          if (cwd === targetPath) {
            // Found! Optionally focus and update title
            if (options?.focus !== false) {
              const escapedTitle = options?.updateTitle ? options.updateTitle.replace(/"/g, '\\"') : ''

              const focusScript = options?.updateTitle
                ? `
                tell application "Terminal"
                  set w to window id ${winId}
                  set frontmost of w to true
                  set selected of tab ${tabIndex} of w to true
                  set custom title of tab ${tabIndex} of w to "${escapedTitle}"
                  set title displays custom title of tab ${tabIndex} of w to true
                  set title displays shell path of tab ${tabIndex} of w to false
                  set title displays window size of tab ${tabIndex} of w to false
                  set title displays device name of tab ${tabIndex} of w to false
                  set title displays file name of tab ${tabIndex} of w to false
                  activate
                end tell
              `
                : `
                tell application "Terminal"
                  set w to window id ${winId}
                  set frontmost of w to true
                  set selected of tab ${tabIndex} of w to true
                  activate
                end tell
              `
              exec(`osascript -e '${focusScript.replace(/'/g, "'\\''")}'`, () => {
                resolve(true)
              })
            } else {
              // Just check, don't focus
              resolve(true)
            }
          } else {
            checkNextTab(index + 1)
          }
        })
      }

      checkNextTab(0)
    })
  })
}

// Find Terminal tab by shell's current working directory (for pure Terminal tabs)
async function findTerminalTabByCwd(targetPath: string, options?: { focus?: boolean }): Promise<boolean> {
  const { exec } = await import('child_process')

  return new Promise((resolve) => {
    // Get ALL terminal tabs
    const script = `
      tell application "Terminal"
        if not running then return ""
        set output to ""
        repeat with w in windows
          set winId to id of w
          set tabCount to count of tabs of w
          repeat with i from 1 to tabCount
            set t to tab i of w
            set tabTty to tty of t
            set output to output & (winId as string) & "," & (i as string) & "," & tabTty & linefeed
          end repeat
        end repeat
        return output
      end tell
    `

    exec(`osascript -e '${script.replace(/'/g, "'\\''")}'`, (error, stdout) => {
      if (error || !stdout.trim()) {
        resolve(false)
        return
      }

      const tabs = stdout.trim().split('\n').filter(Boolean)

      const checkNextTab = (index: number) => {
        if (index >= tabs.length) {
          resolve(false)
          return
        }

        const [winId, tabIndex, tty] = tabs[index].split(',')
        const ttyShort = tty.replace('/dev/', '')

        // Check shell process (bash/zsh) cwd - look for shell that is NOT running claude/happy
        const cwdCmd = `ps -t ${ttyShort} -o pid,comm 2>/dev/null | grep -E "(bash|zsh)" | head -1 | awk '{print $1}' | xargs -I{} lsof -a -d cwd -p {} 2>/dev/null | awk 'NR==2 {print $NF}'`

        exec(cwdCmd, (err, cwdOutput) => {
          const cwd = cwdOutput?.trim()
          if (cwd === targetPath) {
            // Also check that claude/happy is NOT running in this tab
            const agentCheckCmd = `ps -t ${ttyShort} -o comm 2>/dev/null | grep -E "(claude|happy)" | head -1`
            exec(agentCheckCmd, (agentErr, agentOutput) => {
              if (!agentOutput?.trim()) {
                // No agent running, this is a pure terminal tab
                if (options?.focus === false) {
                  resolve(true)
                  return
                }
                const focusScript = `
                  tell application "Terminal"
                    set w to window id ${winId}
                    set frontmost of w to true
                    set selected of tab ${tabIndex} of w to true
                    activate
                  end tell
                `
                exec(`osascript -e '${focusScript.replace(/'/g, "'\\''")}'`, () => {
                  resolve(true)
                })
              } else {
                checkNextTab(index + 1)
              }
            })
          } else {
            checkNextTab(index + 1)
          }
        })
      }

      checkNextTab(0)
    })
  })
}

// Legacy: Find Terminal tab by title pattern (kept for non-agent commands)
async function findTerminalTabByProcessCwd(titlePattern: string, processName: string, targetPath: string, updateTitle?: string): Promise<boolean> {
  const { exec } = await import('child_process')

  return new Promise((resolve) => {
    const escapedPattern = titlePattern.replace(/"/g, '\\"')
    const script = `
      tell application "Terminal"
        if not running then return ""
        set output to ""
        repeat with w in windows
          set winId to id of w
          set tabCount to count of tabs of w
          repeat with i from 1 to tabCount
            set t to tab i of w
            set tabTitle to custom title of t
            if tabTitle contains "${escapedPattern}" then
              set tabTty to tty of t
              set output to output & (winId as string) & "," & (i as string) & "," & tabTty & linefeed
            end if
          end repeat
        end repeat
        return output
      end tell
    `

    exec(`osascript -e '${script.replace(/'/g, "'\\''")}'`, (error, stdout) => {
      if (error || !stdout.trim()) {
        resolve(false)
        return
      }

      const tabs = stdout.trim().split('\n').filter(Boolean)

      const checkNextTab = (index: number) => {
        if (index >= tabs.length) {
          resolve(false)
          return
        }

        const [winId, tabIndex, tty] = tabs[index].split(',')
        const ttyShort = tty.replace('/dev/', '')

        const cwdCmd = `ps -t ${ttyShort} -o pid,comm 2>/dev/null | grep "${processName}" | head -1 | awk '{print $1}' | xargs -I{} lsof -a -d cwd -p {} 2>/dev/null | awk 'NR==2 {print $NF}'`

        exec(cwdCmd, (err, cwdOutput) => {
          const cwd = cwdOutput?.trim()
          if (cwd === targetPath) {
            // Build focus script with title update for both tab and window
            const escapedTitle = updateTitle ? updateTitle.replace(/"/g, '\\"') : ''

            const focusScript = updateTitle
              ? `
              tell application "Terminal"
                set w to window id ${winId}
                set frontmost of w to true
                set selected of tab ${tabIndex} of w to true
                set custom title of tab ${tabIndex} of w to "${escapedTitle}"
                set title displays custom title of tab ${tabIndex} of w to true
                set title displays shell path of tab ${tabIndex} of w to false
                set title displays window size of tab ${tabIndex} of w to false
                set title displays device name of tab ${tabIndex} of w to false
                set title displays file name of tab ${tabIndex} of w to false
                activate
              end tell
            `
              : `
              tell application "Terminal"
                set w to window id ${winId}
                set frontmost of w to true
                set selected of tab ${tabIndex} of w to true
                activate
              end tell
            `
            exec(`osascript -e '${focusScript.replace(/'/g, "'\\''")}'`, () => {
              resolve(true)
            })
          } else {
            checkNextTab(index + 1)
          }
        })
      }

      checkNextTab(0)
    })
  })
}

// Helper: Open new Terminal.app tab with title marker
async function openNewTerminalTab(folderPath: string, titlePrefix: string, command?: string): Promise<void> {
  const { exec } = await import('child_process')
  const escapedPath = folderPath.replace(/"/g, '\\"')
  const escapedTitle = titlePrefix.replace(/"/g, '\\"')

  // Build the final command (set title + run command or clear)
  let finalCommand: string
  if (command) {
    const escapedCommand = command.replace(/'/g, "'\\''")
    finalCommand = `printf '\\\\e]0;${escapedTitle}\\\\a'; ${escapedCommand}`
  } else {
    finalCommand = `printf '\\\\e]0;${escapedTitle}\\\\a'; clear`
  }

  // Split into two steps: cd first, wait, then run command
  // This ensures Terminal updates the directory display before running the agent
  const script = `tell application "Terminal"
    activate
    if (count of windows) > 0 then
      tell application "System Events" to keystroke "t" using command down
      delay 0.3
      do script "cd \\"${escapedPath}\\"" in front window
      delay 0.2
      do script "${finalCommand}" in front window
    else
      do script "cd \\"${escapedPath}\\""
      delay 0.2
      do script "${finalCommand}" in front window
    end if
  end tell`

  exec(`osascript -e '${script.replace(/'/g, "'\\''")}'`, (error) => {
    if (error) {
      console.error('Failed to open Terminal:', error.message)
    }
  })
}

// Open native Terminal.app at specified path (reuses existing tab if found)
ipcMain.handle('shell:open-terminal-at-path', async (_event, folderPath: string) => {
  if (process.platform === 'darwin') {
    const folderName = folderPath.split('/').pop() || folderPath
    const titlePrefix = `[T] ${folderName}`

    // Search by cwd instead of title (more reliable for same-named projects)
    const found = await findTerminalTabByCwd(folderPath)
    if (found) {
      return { action: 'focused' }
    }
    await openNewTerminalTab(folderPath, titlePrefix)
    return { action: 'created' }
  }
  return { action: 'unsupported' }
})

// Open native Terminal.app and execute command (reuses existing tab if found)
ipcMain.handle('shell:open-terminal-with-command', async (_event, folderPath: string, command: string) => {
  if (process.platform === 'darwin') {
    const folderName = folderPath.split('/').pop() || folderPath
    let found = false
    let titlePrefix: string

    if (command.startsWith('claude')) {
      // Use function that doesn't rely on title (title changes when claude runs)
      found = await findTerminalTabByProcess('claude', folderPath)
      titlePrefix = `[C] ${folderName}`
    } else if (command.startsWith('happy')) {
      // Use function that doesn't rely on title (title changes when happy runs)
      found = await findTerminalTabByProcess('happy', folderPath)
      titlePrefix = `[H] ${folderName}`
    } else {
      found = await findTerminalTabByCwd(folderPath)
      titlePrefix = `[T] ${folderName}`
    }

    if (found) {
      return { action: 'focused' }
    }

    await openNewTerminalTab(folderPath, titlePrefix, command)
    return { action: 'created' }
  }
  return { action: 'unsupported' }
})

// Check if agent (claude/happy) is running at specified path
ipcMain.handle('shell:check-agent-running', async (_event, folderPath: string) => {
  if (process.platform === 'darwin') {
    // Check for Claude Code first (don't rely on title, search by process)
    const claudeFound = await findTerminalTabByProcess('claude', folderPath, { focus: false })
    if (claudeFound) {
      return { running: true, type: 'claude' }
    }

    // Check for Happy (don't rely on title, search by process)
    const happyFound = await findTerminalTabByProcess('happy', folderPath, { focus: false })
    if (happyFound) {
      return { running: true, type: 'happy' }
    }

    return { running: false }
  }
  return { running: false }
})

// Check all terminal types available at specified path
ipcMain.handle('shell:check-terminals', async (_event, folderPath: string) => {
  if (process.platform === 'darwin') {
    const [claudeFound, happyFound, terminalFound] = await Promise.all([
      findTerminalTabByProcess('claude', folderPath, { focus: false }),
      findTerminalTabByProcess('happy', folderPath, { focus: false }),
      findTerminalTabByCwd(folderPath, { focus: false }).catch(() => false)
    ])
    return {
      claude: claudeFound,
      happy: happyFound,
      terminal: terminalFound
    }
  }
  return { claude: false, happy: false, terminal: false }
})

// Focus existing agent tab (used when agent is already running)
ipcMain.handle('shell:focus-agent', async (_event, folderPath: string, agentType: 'claude' | 'happy') => {
  if (process.platform === 'darwin') {
    // Extract folder name for display in title
    const folderName = folderPath.split('/').pop() || folderPath

    let result: boolean
    if (agentType === 'claude') {
      const title = `[C] ${folderName}`
      result = await findTerminalTabByProcess('claude', folderPath, { focus: true, updateTitle: title })
    } else {
      const title = `[H] ${folderName}`
      result = await findTerminalTabByProcess('happy', folderPath, { focus: true, updateTitle: title })
    }

    return result
  }
  return false
})

// Focus pure Terminal tab at path (non-agent)
ipcMain.handle('shell:focus-terminal-at-path', async (_event, folderPath: string) => {
  if (process.platform === 'darwin') {
    const found = await findTerminalTabByCwd(folderPath)
    return found
  }
  return false
})

// Batch get all terminal tab states (for agent status polling)
// Uses winName to extract cwd path directly — no ps+lsof needed
ipcMain.handle('shell:get-all-terminal-states', async () => {
  if (process.platform !== 'darwin') return []

  const { exec } = await import('child_process')
  const homedir = (await import('os')).homedir()

  return new Promise<Array<{ tty: string; busy: boolean; processes: string[]; cwd?: string }>>((resolve) => {
    // Single AppleScript: get winName (contains cwd), processes, busy
    const script = `
      tell application "Terminal"
        if not running then return ""
        set output to ""
        repeat with w in windows
          set winName to name of w
          set tabCount to count of tabs of w
          repeat with i from 1 to tabCount
            set t to tab i of w
            set tabTty to tty of t
            set tabBusy to busy of t
            set tabProcs to processes of t
            set procStr to ""
            repeat with p in tabProcs
              set procStr to procStr & (p as string) & "|"
            end repeat
            set output to output & tabTty & "\\t" & (tabBusy as string) & "\\t" & procStr & "\\t" & winName & linefeed
          end repeat
        end repeat
        return output
      end tell
    `

    exec(`osascript -e '${script.replace(/'/g, "'\\''")}'`, { timeout: 5000 }, (error, stdout) => {
      if (error || !stdout.trim()) {
        resolve([])
        return
      }

      const lines = stdout.trim().split('\n').filter(Boolean)
      const tabs: Array<{ tty: string; busy: boolean; processes: string[]; cwd?: string }> = []

      for (const line of lines) {
        const parts = line.split('\t')
        if (parts.length < 4) continue
        const tty = parts[0].trim()
        const busy = parts[1].trim() === 'true'
        const processes = parts[2].split('|').map(p => p.trim()).filter(Boolean)

        // Extract cwd from winName: "~/path/to/dir — title — processes"
        const winName = parts.slice(3).join('\t').trim()
        const dashIdx = winName.indexOf(' \u2014 ')
        const rawPath = dashIdx > 0 ? winName.substring(0, dashIdx).trim() : winName.trim()
        const cwd = rawPath.startsWith('~') ? rawPath.replace('~', homedir) : rawPath

        tabs.push({ tty, busy, processes, cwd })
      }

      resolve(tabs)
    })
  })
})

// Sub-repo scanning: find child directories that are independent git repos
interface SubRepoInfo {
  name: string
  path: string
  branch: string
  dirty: boolean
  filesChanged: number
  insertions: number
  deletions: number
}

async function getSubReposForPath(folderPath: string): Promise<SubRepoInfo[]> {
  const { exec } = await import('child_process')
  const gitPath = '/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin'
  return new Promise((resolve) => {
    // 單一 shell 迴圈：branch + porcelain + shortstat 一次完成，每個 sub-repo 只 fork 一次 exec
    const cmd = `for d in "${folderPath}"/*/; do
      if [ -d "$d/.git" ]; then
        name=$(basename "$d")
        branch=$(cd "$d" && git rev-parse --abbrev-ref HEAD 2>/dev/null)
        porcelain=$(cd "$d" && git status --porcelain 2>/dev/null)
        if [ -n "$porcelain" ]; then dirty="true"; else dirty="false"; fi
        fc=$(echo "$porcelain" | grep -c '.' 2>/dev/null || echo 0)
        stats=$(cd "$d" && git diff --shortstat 2>/dev/null)
        cstats=$(cd "$d" && git diff --cached --shortstat 2>/dev/null)
        echo "$name|||$d|||$branch|||$dirty|||$fc|||$stats====$cstats"
      fi
    done`
    exec(cmd, { timeout: 10000, env: { ...process.env, PATH: `${gitPath}:${process.env.PATH || ''}` } }, (err, stdout) => {
      if (err || !stdout.trim()) { resolve([]); return }
      const parseShortstat = (s: string) => {
        const ins = s.match(/(\d+)\s+insertion/)
        const del = s.match(/(\d+)\s+deletion/)
        return { insertions: ins ? parseInt(ins[1]) : 0, deletions: del ? parseInt(del[1]) : 0 }
      }
      const repos: SubRepoInfo[] = []
      for (const line of stdout.trim().split('\n')) {
        const [name, repoPath, branch, dirty, fc, statsPart] = line.split('|||')
        if (name && branch) {
          const sections = (statsPart || '').split('====')
          const unstaged = parseShortstat(sections[0] || '')
          const staged = parseShortstat(sections[1] || '')
          repos.push({
            name,
            path: repoPath.replace(/\/$/, ''),
            branch,
            dirty: dirty === 'true',
            filesChanged: parseInt(fc) || 0,
            insertions: unstaged.insertions + staged.insertions,
            deletions: unstaged.deletions + staged.deletions
          })
        }
      }
      resolve(repos)
    })
  })
}

// Git info for a single path: branch + dirty + diff stats in 1 shell call
async function getGitInfoForPath(folderPath: string): Promise<{ branch: string; dirty: boolean; filesChanged: number; insertions: number; deletions: number } | null> {
  const { exec } = await import('child_process')
  // Electron launched from Finder has minimal PATH; include common git locations
  const gitPath = '/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin'
  return new Promise((resolve) => {
    const cmd = `cd "${folderPath}" && echo "$(git rev-parse --abbrev-ref HEAD 2>/dev/null)" && echo "---" && git status --porcelain 2>/dev/null && echo "---" && git diff --shortstat 2>/dev/null && echo "===" && git diff --cached --shortstat 2>/dev/null`
    exec(cmd, { timeout: 5000, env: { ...process.env, PATH: `${gitPath}:${process.env.PATH || ''}` } }, (err, stdout) => {
      if (err) { resolve(null); return }
      const parts = stdout.split('---\n')
      const branch = (parts[0] || '').trim()
      if (!branch) { resolve(null); return }
      const dirty = (parts[1] || '').split('---')[0].trim().length > 0
      const filesChanged = ((parts[1] || '').split('---')[0].trim().split('\n').filter(Boolean)).length

      // Parse shortstat: "N files changed, N insertions(+), N deletions(-)"
      const statPart = (parts[2] || '')
      const parseShortstat = (s: string) => {
        const ins = s.match(/(\d+)\s+insertion/)
        const del = s.match(/(\d+)\s+deletion/)
        return { insertions: ins ? parseInt(ins[1]) : 0, deletions: del ? parseInt(del[1]) : 0 }
      }
      const statSections = statPart.split('===')
      const unstaged = parseShortstat(statSections[0] || '')
      const staged = parseShortstat(statSections[1] || '')

      resolve({
        branch, dirty, filesChanged,
        insertions: unstaged.insertions + staged.insertions,
        deletions: unstaged.deletions + staged.deletions
      })
    })
  })
}

// Batch get git info for multiple paths (sequential to limit child processes)
ipcMain.handle('shell:get-git-info-batch', async (_event, paths: string[]) => {
  if (!paths || paths.length === 0) return {}
  const result: Record<string, { branch: string; dirty: boolean } | null> = {}
  for (const p of paths) {
    result[p] = await getGitInfoForPath(p)
  }
  return result
})

// Batch get sub-repos for multiple paths
ipcMain.handle('shell:get-sub-repos-batch', async (_event, paths: string[]) => {
  if (!paths || paths.length === 0) return {}
  const result: Record<string, SubRepoInfo[]> = {}
  for (const p of paths) {
    result[p] = await getSubReposForPath(p)
  }
  return result
})

// Quit confirmation from renderer
ipcMain.on('app:quit-confirmed', () => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    const bounds = mainWindow.getBounds()
    saveWindowState({ x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height })
  }
  forceQuit = true
  app.quit()
})

// === PTY IPC Handlers (embedded terminal) ===

ipcMain.handle('pty:create', async (_event, options) => {
  return ptyManager?.create(options) ?? false
})

ipcMain.handle('pty:write', async (_event, id: string, data: string) => {
  ptyManager?.write(id, data)
})

ipcMain.handle('pty:resize', async (_event, id: string, cols: number, rows: number) => {
  ptyManager?.resize(id, cols, rows)
})

ipcMain.handle('pty:kill', async (_event, id: string) => {
  return ptyManager?.kill(id) ?? false
})

ipcMain.handle('pty:activate', async (_event, id: string) => {
  ptyManager?.activate(id)
})

ipcMain.handle('pty:deactivate', async (_event, id: string) => {
  ptyManager?.deactivate(id)
})

ipcMain.handle('pty:resume', async (_event, id: string) => {
  ptyManager?.resume(id)
})

// === WebSocket IPC Handlers ===

ipcMain.handle('ws:get-status', async () => ({
  running: wsServer?.isRunning() ?? false,
  port: wsServer?.getPort() ?? null,
  token: wsServer?.getToken() ?? null,
  clientCount: wsServer?.getClientCount() ?? 0,
  host: wsConfig?.host ?? '127.0.0.1'
}))

ipcMain.handle('ws:toggle', async (_event, enabled: unknown) => {
  if (!ptyManager) return
  const shouldEnable = enabled === true

  if (shouldEnable && !wsServer) {
    wsServer = new WsServer(wsConfig, ptyManager)
    ptyManager.setWsServer(wsServer)
    wsServer.start()
  } else if (!shouldEnable && wsServer) {
    wsServer.stop()
    ptyManager.setWsServer(null)
    wsServer = null
  }

  // 通知 renderer WS 狀態變化（Settings toggle → Sidebar indicator 同步）
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('ws:status-change', shouldEnable)
  }

  // 持久化設定
  const settingsPath = path.join(os.homedir(), '.claude', 'better-agent', 'ws-settings.json')
  const settingsDir = path.dirname(settingsPath)
  if (!fs.existsSync(settingsDir)) {
    fs.mkdirSync(settingsDir, { recursive: true })
  }
  const settings = { enabled: shouldEnable, port: wsConfig.port, host: wsConfig.host }
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2))
})

// === Notification Server ===

// 保持 Notification 物件活著，避免 GC 後 click handler 失效（macOS 容易發生）
const activeNotifications = new Set<Notification>()

function startNotifyServer(): void {
  if (notifyServer) return
  notifyServer = new NotifyServer(notifyConfig, (event: NotifyEvent) => {
    if (!mainWindow || mainWindow.isDestroyed()) return
    // 1. 通知 renderer 更新 unread state
    mainWindow.webContents.send('notify:event', event)
    // 2. 一律發 macOS 通知（不論視窗是否 focus）
    if (Notification.isSupported()) {
      const projectName = path.basename(event.cwd)
      const agentTag = event.agentType === 'codex' ? '[X]' : '[C]'
      const title = event.event === 'stop'
        ? `${agentTag} finished: ${projectName}`
        : `${agentTag} waiting: ${projectName}`
      const body = event.event === 'stop'
        ? 'Process completed'
        : (event.meta?.description || 'Waiting for input')
      try {
        const notification = new Notification({ title, body, silent: false })
        activeNotifications.add(notification)
        const cleanup = () => { activeNotifications.delete(notification) }
        // 點通知 → 聚焦視窗 + 切換到該 workspace/terminal
        notification.on('click', () => {
          if (mainWindow && !mainWindow.isDestroyed()) {
            if (mainWindow.isMinimized()) mainWindow.restore()
            mainWindow.show()
            mainWindow.focus()
            mainWindow.webContents.send('notify:focus-terminal', {
              cwd: event.cwd,
              sessionId: event.sessionId,
              agentType: event.agentType
            })
          }
          cleanup()
        })
        notification.on('close', cleanup)
        notification.on('failed', cleanup)
        notification.show()
      } catch (e) {
        console.error('[notify] Failed to show notification:', e)
      }
    }
  })
  notifyServer.start()
}

ipcMain.handle('notify:get-status', () => ({
  running: notifyServer?.isRunning() ?? false,
  enabled: notifyConfig.enabled,
  port: notifyServer?.getPort() ?? notifyConfig.port,
  token: notifyServer?.getToken() ?? null,
  tokenPath: notifyConfig.tokenPath
}))

ipcMain.handle('notify:toggle', async (_event, enabled: unknown) => {
  const shouldEnable = enabled === true
  notifyConfig.enabled = shouldEnable

  if (shouldEnable && !notifyServer) {
    startNotifyServer()
  } else if (!shouldEnable && notifyServer) {
    notifyServer.stop()
    notifyServer = null
  }

  // 持久化設定
  const settingsDir = path.dirname(notifySettingsPath)
  if (!fs.existsSync(settingsDir)) {
    fs.mkdirSync(settingsDir, { recursive: true })
  }
  fs.writeFileSync(notifySettingsPath, JSON.stringify({
    enabled: shouldEnable,
    port: notifyConfig.port
  }, null, 2))
})

interface ClaudeNotifyHookStatus {
  installed: boolean
  hasStop: boolean
  hasNotification: boolean
  scriptExists: boolean
}

interface CodexNotifyHookStatus {
  installed: boolean
  hasStop: boolean
  configEnabled: boolean
  hooksFileExists: boolean
  scriptExists: boolean
}

const notifyHookCommand = '~/.claude/hooks/better-agent-notify.sh'

type JsonObject = Record<string, unknown>

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasNotifyCommand(hookList: unknown): boolean {
  if (!Array.isArray(hookList)) return false
  return hookList.some((entry) =>
    isJsonObject(entry) && Array.isArray(entry.hooks) && entry.hooks.some((cmd) =>
      isJsonObject(cmd) && typeof cmd.command === 'string' && cmd.command.includes('better-agent-notify')
    )
  )
}

/** 移除所有 better-agent-notify 的 entry（reinstall 時清舊版用） */
function stripNotifyEntries(hookList: unknown[]): void {
  for (let i = hookList.length - 1; i >= 0; i--) {
    const entry = hookList[i]
    if (!isJsonObject(entry) || !Array.isArray(entry.hooks)) continue
    const filtered = entry.hooks.filter((cmd) =>
      !(isJsonObject(cmd) && typeof cmd.command === 'string' && cmd.command.includes('better-agent-notify'))
    )
    if (filtered.length === 0) {
      hookList.splice(i, 1)
    } else {
      entry.hooks = filtered
    }
  }
}

function parseJsonObject(filePath: string): JsonObject {
  const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8'))
  return isJsonObject(parsed) ? parsed : {}
}

function ensureHooksObject(target: JsonObject): JsonObject {
  if (isJsonObject(target.hooks)) return target.hooks
  const hooks: JsonObject = {}
  target.hooks = hooks
  return hooks
}

function isCodexHooksFeatureEnabled(content: string): boolean {
  let inFeatures = false
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const section = line.match(/^\[([^\]]+)\]$/)
    if (section) {
      inFeatures = section[1].trim() === 'features'
      continue
    }
    if (inFeatures) {
      const match = line.match(/^codex_hooks\s*=\s*(true|false)\b/i)
      if (match) return match[1].toLowerCase() === 'true'
    }
  }
  return false
}

function enableCodexHooksFeature(content: string): string {
  const trimmed = content.replace(/\s*$/, '')
  if (!trimmed) {
    return '[features]\ncodex_hooks = true\n'
  }

  const lines = trimmed.split(/\r?\n/)
  const featureIndex = lines.findIndex(line => line.trim() === '[features]')
  if (featureIndex === -1) {
    return `${trimmed}\n\n[features]\ncodex_hooks = true\n`
  }

  let sectionEnd = lines.length
  for (let i = featureIndex + 1; i < lines.length; i += 1) {
    if (/^\[[^\]]+\]\s*$/.test(lines[i].trim())) {
      sectionEnd = i
      break
    }
  }

  for (let i = featureIndex + 1; i < sectionEnd; i += 1) {
    if (/^\s*codex_hooks\s*=/.test(lines[i])) {
      lines[i] = 'codex_hooks = true'
      return `${lines.join('\n')}\n`
    }
  }

  lines.splice(featureIndex + 1, 0, 'codex_hooks = true')
  return `${lines.join('\n')}\n`
}

function getClaudeHookStatus(homedir: string, scriptPath: string): ClaudeNotifyHookStatus {
  const settingsPath = path.join(homedir, '.claude', 'settings.json')
  const scriptExists = fs.existsSync(scriptPath)
  if (!fs.existsSync(settingsPath)) {
    return { installed: false, hasStop: false, hasNotification: false, scriptExists }
  }

  const settings = parseJsonObject(settingsPath)
  const hooks = isJsonObject(settings.hooks) ? settings.hooks : {}
  const hasStop = hasNotifyCommand(hooks.Stop)
  const hasNotification = hasNotifyCommand(hooks.Notification)
  return {
    installed: hasStop && hasNotification && scriptExists,
    hasStop,
    hasNotification,
    scriptExists
  }
}

function getCodexHookStatus(homedir: string, scriptPath: string): CodexNotifyHookStatus {
  const codexConfigPath = path.join(homedir, '.codex', 'config.toml')
  const codexHooksPath = path.join(homedir, '.codex', 'hooks.json')
  const scriptExists = fs.existsSync(scriptPath)
  const hooksFileExists = fs.existsSync(codexHooksPath)
  const configEnabled = fs.existsSync(codexConfigPath)
    ? isCodexHooksFeatureEnabled(fs.readFileSync(codexConfigPath, 'utf-8'))
    : false

  let hasStop = false
  if (hooksFileExists) {
    const hooksConfig = parseJsonObject(codexHooksPath)
    const hooks = isJsonObject(hooksConfig.hooks) ? hooksConfig.hooks : {}
    hasStop = hasNotifyCommand(hooks.Stop)
  }

  return {
    installed: hasStop && configEnabled && scriptExists,
    hasStop,
    configEnabled,
    hooksFileExists,
    scriptExists
  }
}

// 偵測 Claude Code 與 Codex hook 是否已安裝
ipcMain.handle('notify:check-hook-installed', async () => {
  try {
    const homedir = os.homedir()
    const scriptPath = path.join(homedir, '.claude', 'hooks', 'better-agent-notify.sh')
    const claude = getClaudeHookStatus(homedir, scriptPath)
    const codex = getCodexHookStatus(homedir, scriptPath)
    return {
      installed: claude.installed && codex.installed,
      hasStop: claude.hasStop,
      hasNotification: claude.hasNotification,
      scriptExists: claude.scriptExists && codex.scriptExists,
      claude,
      codex
    }
  } catch {
    return {
      installed: false,
      hasStop: false,
      hasNotification: false,
      scriptExists: false,
      claude: { installed: false, hasStop: false, hasNotification: false, scriptExists: false },
      codex: { installed: false, hasStop: false, configEnabled: false, hooksFileExists: false, scriptExists: false }
    }
  }
})

// 自動安裝 hook script + merge Claude/Codex hook 設定
ipcMain.handle('notify:install-hook', async () => {
  try {
    const homedir = os.homedir()
    const hooksDir = path.join(homedir, '.claude', 'hooks')
    const scriptPath = path.join(hooksDir, 'better-agent-notify.sh')
    const settingsPath = path.join(homedir, '.claude', 'settings.json')
    const codexDir = path.join(homedir, '.codex')
    const codexConfigPath = path.join(codexDir, 'config.toml')
    const codexHooksPath = path.join(codexDir, 'hooks.json')
    const backupPaths: string[] = []

    // 1. 建立 hook script
    // Claude/Codex hook 透過 stdin 餵 JSON，用 sed 擷取 session_id/cwd 以路由到對應 terminal。
    const scriptContent = `#!/bin/bash
TOKEN_FILE="$HOME/.claude/better-agent/notify-auth.txt"
[ -f "$TOKEN_FILE" ] || exit 0
TOKEN_INFO=$(cat "$TOKEN_FILE")
PORT="\${TOKEN_INFO%%:*}"
TOKEN="\${TOKEN_INFO##*:}"
[ -z "$TOKEN" ] && exit 0

INPUT=$(cat 2>/dev/null || echo "")
SESSION_ID=$(printf '%s' "$INPUT" | sed -n 's/.*"session_id"[[:space:]]*:[[:space:]]*"\\([^"]*\\)".*/\\1/p' | head -1)
INPUT_CWD=$(printf '%s' "$INPUT" | sed -n 's/.*"cwd"[[:space:]]*:[[:space:]]*"\\([^"]*\\)".*/\\1/p' | head -1)
HOOK_EVENT=$(printf '%s' "$INPUT" | sed -n 's/.*"hook_event_name"[[:space:]]*:[[:space:]]*"\\([^"]*\\)".*/\\1/p' | head -1)
CWD="\${CLAUDE_PROJECT_DIR:-\${INPUT_CWD:-$(pwd)}}"
EVENT="\${1:-stop}"
AGENT_TYPE="\${2:-}"

if [ "$HOOK_EVENT" = "Stop" ]; then
  EVENT="stop"
fi

if [ -z "$AGENT_TYPE" ]; then
  AGENT_TYPE="claude"
fi

json_escape() {
  printf '%s' "$1" | tr '\\n' ' ' | sed 's/\\\\/\\\\\\\\/g; s/"/\\\\"/g; s/\\r/ /g; s/\\t/ /g'
}

CWD_JSON=$(json_escape "$CWD")
SESSION_ID_JSON=$(json_escape "$SESSION_ID")
AGENT_TYPE_JSON=$(json_escape "$AGENT_TYPE")
SESSION_FIELD=""
if [ -n "$SESSION_ID_JSON" ]; then
  SESSION_FIELD=",\\"sessionId\\":\\"$SESSION_ID_JSON\\""
fi
AGENT_FIELD=""
if [ -n "$AGENT_TYPE_JSON" ]; then
  AGENT_FIELD=",\\"agentType\\":\\"$AGENT_TYPE_JSON\\""
fi

curl -s -X POST "http://127.0.0.1:$PORT/notify" \\
  -H "Authorization: Bearer $TOKEN" \\
  -H "Content-Type: application/json" \\
  -d "{\\"cwd\\":\\"$CWD_JSON\\",\\"event\\":\\"$EVENT\\"$SESSION_FIELD$AGENT_FIELD}" \\
  --max-time 2 \\
  >/dev/null 2>&1 || true
`
    if (!fs.existsSync(hooksDir)) {
      fs.mkdirSync(hooksDir, { recursive: true })
    }
    fs.writeFileSync(scriptPath, scriptContent, { mode: 0o755 })

    // 2. 備份並 merge settings.json
    let settings: JsonObject = {}
    let backupPath: string | null = null
    if (fs.existsSync(settingsPath)) {
      backupPath = `${settingsPath}.backup-${Date.now()}`
      fs.copyFileSync(settingsPath, backupPath)
      backupPaths.push(backupPath)
      try {
        settings = parseJsonObject(settingsPath)
      } catch {
        return { success: false, error: 'Failed to parse existing settings.json' }
      }
    }

    const settingsHooks = ensureHooksObject(settings)

    const addHookCommand = (hookName: 'Stop' | 'Notification', cmdSuffix: string) => {
      if (!Array.isArray(settingsHooks[hookName])) {
        settingsHooks[hookName] = []
      }
      const hookList = settingsHooks[hookName] as unknown[]
      // 先移除舊版 entry（不論第二參數有無），確保 reinstall 會更新到新版命令
      stripNotifyEntries(hookList)
      hookList.push({
        matcher: '',
        hooks: [{
          type: 'command',
          command: `${notifyHookCommand} ${cmdSuffix} claude`
        }]
      })
    }

    addHookCommand('Stop', 'stop')
    addHookCommand('Notification', 'wait')

    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2))

    // 3. 啟用 Codex hooks feature（~/.codex/config.toml）
    if (!fs.existsSync(codexDir)) {
      fs.mkdirSync(codexDir, { recursive: true })
    }
    let codexConfigContent = ''
    if (fs.existsSync(codexConfigPath)) {
      const codexConfigBackup = `${codexConfigPath}.backup-${Date.now()}`
      fs.copyFileSync(codexConfigPath, codexConfigBackup)
      backupPaths.push(codexConfigBackup)
      codexConfigContent = fs.readFileSync(codexConfigPath, 'utf-8')
    }
    fs.writeFileSync(codexConfigPath, enableCodexHooksFeature(codexConfigContent))

    // 4. 合併 Codex hooks.json 的 Stop hook
    let codexHooks: JsonObject = {}
    if (fs.existsSync(codexHooksPath)) {
      const codexHooksBackup = `${codexHooksPath}.backup-${Date.now()}`
      fs.copyFileSync(codexHooksPath, codexHooksBackup)
      backupPaths.push(codexHooksBackup)
      try {
        codexHooks = parseJsonObject(codexHooksPath)
      } catch {
        return { success: false, error: 'Failed to parse existing ~/.codex/hooks.json' }
      }
    }
    const codexHookRoot = ensureHooksObject(codexHooks)
    if (!Array.isArray(codexHookRoot.Stop)) {
      codexHookRoot.Stop = []
    }
    const codexStopHooks = codexHookRoot.Stop as unknown[]
    stripNotifyEntries(codexStopHooks)
    codexStopHooks.push({
      matcher: '*',
      hooks: [{
        type: 'command',
        command: `${notifyHookCommand} stop codex`
      }]
    })
    fs.writeFileSync(codexHooksPath, JSON.stringify(codexHooks, null, 2))

    return {
      success: true,
      scriptPath,
      settingsPath,
      codexConfigPath,
      codexHooksPath,
      backupPath,
      backupPaths,
      backedUp: backupPaths.length > 0
    }
  } catch (e: any) {
    return { success: false, error: e?.message || 'Unknown error' }
  }
})

// === Claude Sessions IPC Handlers ===
// 讀取 / 監聽 / 刪除 ~/.claude/projects/<encoded>/sessions-index.json

const claudeSessionWatchers: Map<string, { dispose: () => void; refCount: number }> = new Map()

ipcMain.handle('claude-sessions:list', async (_event, cwd: string) => {
  return csList(cwd)
})

ipcMain.handle('claude-sessions:delete', async (_event, cwd: string, sessionId: string) => {
  return csDelete(cwd, sessionId)
})

ipcMain.handle('claude-sessions:watch', async (_event, cwd: string) => {
  const existing = claudeSessionWatchers.get(cwd)
  if (existing) {
    existing.refCount += 1
    return true
  }
  const dispose = csWatch(cwd, () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      try { mainWindow.webContents.send('claude-sessions:changed', cwd) } catch { /* window closing */ }
    }
  })
  claudeSessionWatchers.set(cwd, { dispose, refCount: 1 })
  return true
})

ipcMain.handle('claude-sessions:unwatch', async (_event, cwd: string) => {
  const entry = claudeSessionWatchers.get(cwd)
  if (!entry) return false
  entry.refCount -= 1
  if (entry.refCount <= 0) {
    entry.dispose()
    claudeSessionWatchers.delete(cwd)
  }
  return true
})

// === File System IPC Handlers ===
// 限定在 workspace folder 內，防 path traversal

ipcMain.handle('fs:list-dir', async (_event, workspaceCwd: string, relativePath: string) => {
  return fsListDir(workspaceCwd, relativePath)
})

ipcMain.handle('fs:read-file', async (_event, workspaceCwd: string, relativePath: string) => {
  return fsReadFile(workspaceCwd, relativePath)
})

ipcMain.handle('fs:stat', async (_event, workspaceCwd: string, relativePath: string) => {
  return fsStat(workspaceCwd, relativePath)
})

ipcMain.handle('fs:write-file', async (_event, workspaceCwd: string, relativePath: string, content: string, expectedMtime?: number) => {
  return fsWriteFile(workspaceCwd, relativePath, content, expectedMtime)
})

ipcMain.handle('git:file-status', async (_event, workspaceCwd: string) => {
  return gitGetFileStatuses(workspaceCwd)
})
