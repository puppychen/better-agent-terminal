import { app, BrowserWindow, ipcMain, dialog, shell } from 'electron'
import path from 'path'
import { WindowTilingManager } from './window-tiling'

let mainWindow: BrowserWindow | null = null
let tilingManager: WindowTilingManager | null = null

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
  const defaultWidth = 420
  const defaultHeight = 800

  mainWindow = new BrowserWindow({
    width: savedState?.width || defaultWidth,
    height: savedState?.height || defaultHeight,
    x: savedState?.x,
    y: savedState?.y,
    minWidth: 300,
    minHeight: 400,
    maxWidth: 600,
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

  mainWindow.on('close', () => {
    if (mainWindow) {
      const bounds = mainWindow.getBounds()
      saveWindowState({
        x: bounds.x,
        y: bounds.y,
        width: bounds.width,
        height: bounds.height
      })
    }
  })

  mainWindow.on('closed', () => {
    if (tilingManager) {
      tilingManager.destroy()
      tilingManager = null
    }
    mainWindow = null
  })

  tilingManager = new WindowTilingManager(mainWindow)
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
      if (tilingManager?.isEnabled()) tilingManager.syncTerminalPosition()
      return { action: 'focused' }
    }
    await openNewTerminalTab(folderPath, titlePrefix)
    if (tilingManager?.isEnabled()) {
      setTimeout(() => tilingManager?.syncTerminalPosition(), 500)
    }
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
      if (tilingManager?.isEnabled()) tilingManager.syncTerminalPosition()
      return { action: 'focused' }
    }

    await openNewTerminalTab(folderPath, titlePrefix, command)
    if (tilingManager?.isEnabled()) {
      setTimeout(() => tilingManager?.syncTerminalPosition(), 500)
    }
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

    if (result && tilingManager?.isEnabled()) {
      tilingManager.syncTerminalPosition()
    }
    return result
  }
  return false
})

// Focus pure Terminal tab at path (non-agent)
ipcMain.handle('shell:focus-terminal-at-path', async (_event, folderPath: string) => {
  if (process.platform === 'darwin') {
    const found = await findTerminalTabByCwd(folderPath)
    if (found && tilingManager?.isEnabled()) {
      tilingManager.syncTerminalPosition()
    }
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
}

async function getSubReposForPath(folderPath: string): Promise<SubRepoInfo[]> {
  const { exec } = await import('child_process')
  const gitPath = '/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin'
  return new Promise((resolve) => {
    const cmd = `for d in "${folderPath}"/*/; do
      if [ -d "$d/.git" ]; then
        name=$(basename "$d")
        branch=$(cd "$d" && git rev-parse --abbrev-ref HEAD 2>/dev/null)
        if [ -n "$(cd "$d" && git status --porcelain 2>/dev/null)" ]; then dirty="true"; else dirty="false"; fi
        echo "$name|||$d|||$branch|||$dirty"
      fi
    done`
    exec(cmd, { timeout: 10000, env: { ...process.env, PATH: `${gitPath}:${process.env.PATH || ''}` } }, (err, stdout) => {
      if (err || !stdout.trim()) { resolve([]); return }
      const repos: SubRepoInfo[] = []
      for (const line of stdout.trim().split('\n')) {
        const [name, repoPath, branch, dirty] = line.split('|||')
        if (name && branch) {
          repos.push({
            name,
            path: repoPath.replace(/\/$/, ''),
            branch,
            dirty: dirty === 'true'
          })
        }
      }
      resolve(repos)
    })
  })
}

// Git info for a single path: combine branch + dirty into 1 shell command
async function getGitInfoForPath(folderPath: string): Promise<{ branch: string; dirty: boolean } | null> {
  const { exec } = await import('child_process')
  // Electron launched from Finder has minimal PATH; include common git locations
  const gitPath = '/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin'
  return new Promise((resolve) => {
    const cmd = `cd "${folderPath}" && echo "$(git rev-parse --abbrev-ref HEAD 2>/dev/null)" && echo "---" && git status --porcelain 2>/dev/null`
    exec(cmd, { timeout: 5000, env: { ...process.env, PATH: `${gitPath}:${process.env.PATH || ''}` } }, (err, stdout) => {
      if (err) { resolve(null); return }
      const parts = stdout.split('---\n')
      const branch = (parts[0] || '').trim()
      if (!branch) { resolve(null); return }
      const dirty = (parts[1] || '').trim().length > 0
      resolve({ branch, dirty })
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

// Tiling management
ipcMain.handle('tiling:enable', () => {
  tilingManager?.enable()
  return true
})

ipcMain.handle('tiling:disable', () => {
  tilingManager?.disable()
  return true
})

ipcMain.handle('tiling:sync', () => {
  tilingManager?.syncTerminalPosition()
  return true
})

ipcMain.handle('tiling:get-status', () => {
  return { enabled: tilingManager?.isEnabled() ?? false }
})
