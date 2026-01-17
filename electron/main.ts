import { app, BrowserWindow, ipcMain, dialog, shell } from 'electron'
import path from 'path'

let mainWindow: BrowserWindow | null = null

const VITE_DEV_SERVER_URL = process.env['VITE_DEV_SERVER_URL']

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 380,
    height: 700,
    minWidth: 300,
    minHeight: 400,
    maxWidth: 500,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true
    },
    frame: true,
    titleBarStyle: 'default',
    title: 'Better Agent'
  })

  if (VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(VITE_DEV_SERVER_URL)
    mainWindow.webContents.openDevTools()
  } else {
    mainWindow.loadFile(path.join(__dirname, '../dist/index.html'))
  }

  mainWindow.on('closed', () => {
    mainWindow = null
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

// Helper: Find Terminal tab running specific command (claude/happy) at specific path
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
    const titlePrefix = `BA:${folderPath}`
    const found = await findExistingTerminalTab(titlePrefix)
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
    let found = false

    if (command.startsWith('happy')) {
      found = await findTerminalTabByProcessCwd('Happy', 'happy', folderPath)
    } else if (command.startsWith('claude')) {
      found = await findTerminalTabByProcessCwd('Claude Code', 'claude', folderPath)
    } else {
      found = await findExistingTerminalTab(`BA:CMD:${folderPath}`)
    }

    if (found) {
      return { action: 'focused' }
    }

    const titlePrefix = `BA:CMD:${folderPath}`
    await openNewTerminalTab(folderPath, titlePrefix, command)
    return { action: 'created' }
  }
  return { action: 'unsupported' }
})

// Check if agent (claude/happy) is running at specified path
ipcMain.handle('shell:check-agent-running', async (_event, folderPath: string) => {
  if (process.platform === 'darwin') {
    // Check for Claude Code first
    const claudeFound = await findTerminalTabByProcessCwd('Claude Code', 'claude', folderPath)
    if (claudeFound) {
      return { running: true, type: 'claude' }
    }

    // Check for Happy
    const happyFound = await findTerminalTabByProcessCwd('Happy', 'happy', folderPath)
    if (happyFound) {
      return { running: true, type: 'happy' }
    }

    return { running: false }
  }
  return { running: false }
})

// Focus existing agent tab (used when agent is already running)
ipcMain.handle('shell:focus-agent', async (_event, folderPath: string, agentType: 'claude' | 'happy') => {
  if (process.platform === 'darwin') {
    // Extract folder name for display in title
    const folderName = folderPath.split('/').pop() || folderPath

    if (agentType === 'claude') {
      const title = `Claude Code: ${folderName}`
      return await findTerminalTabByProcessCwd('Claude Code', 'claude', folderPath, title)
    } else {
      const title = `Happy: ${folderName}`
      return await findTerminalTabByProcessCwd('Happy', 'happy', folderPath, title)
    }
  }
  return false
})
