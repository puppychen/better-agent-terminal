import { BrowserWindow } from 'electron'
import { spawn, ChildProcess } from 'child_process'
import type { CreatePtyOptions } from '../src/types'

// Try to import node-pty, fall back to child_process if not available
let pty: typeof import('node-pty') | null = null
let ptyAvailable = false
try {
  pty = require('node-pty')
  // Test if native module works by checking if spawn function exists and module is properly built
  if (pty && typeof pty.spawn === 'function') {
    ptyAvailable = true
  }
} catch (e) {
  console.warn('node-pty not available, falling back to child_process:', e)
}

interface PtyInstance {
  process: any // IPty or ChildProcess
  type: 'terminal' | 'claude-code'
  cwd: string
  usePty: boolean
  outputBuffer: string[] // Store output history for reconnection
  outputBufferSize: number // Track buffer size to avoid expensive join() calculations
}

export class PtyManager {
  private instances: Map<string, PtyInstance> = new Map()
  private window: BrowserWindow
  private disposed = false
  private onTerminalCountChange?: (count: number) => void

  constructor(window: BrowserWindow, onTerminalCountChange?: (count: number) => void) {
    this.window = window
    this.onTerminalCountChange = onTerminalCountChange
  }

  // Notify about terminal count changes for power management
  private notifyTerminalCountChange(): void {
    this.onTerminalCountChange?.(this.instances.size)
  }

  // Safe IPC send - checks if window is still valid before sending
  private safeSend(channel: string, ...args: unknown[]): void {
    if (!this.disposed && !this.window.isDestroyed()) {
      this.window.webContents.send(channel, ...args)
    }
  }

  // Get environment variables from user's shell profile
  // This is needed because Electron launched from Dock doesn't inherit shell profile env vars
  private getShellEnv(): Record<string, string> {
    const { execSync } = require('child_process')
    const os = require('os')

    try {
      const shell = process.env.SHELL || '/bin/zsh'
      // Run shell in interactive login mode to get all env vars
      const envOutput = execSync(`${shell} -ilc 'env'`, {
        encoding: 'utf-8',
        timeout: 5000,
        env: { ...process.env, HOME: os.homedir() }
      })

      const envVars: Record<string, string> = {}
      for (const line of envOutput.split('\n')) {
        const eqIndex = line.indexOf('=')
        if (eqIndex > 0) {
          const key = line.substring(0, eqIndex)
          const value = line.substring(eqIndex + 1)
          envVars[key] = value
        }
      }
      return envVars
    } catch (e) {
      console.warn('Failed to get shell environment:', e)
      return {}
    }
  }

  private findHappyExecutable(): string {
    const fs = require('fs')
    const path = require('path')
    const os = require('os')
    const homeDir = os.homedir()

    // Common locations where happy might be installed
    const possiblePaths: string[] = []

    if (process.platform === 'win32') {
      // Windows locations
      possiblePaths.push(
        path.join(homeDir, 'AppData', 'Roaming', 'npm', 'happy.cmd'),
        path.join(homeDir, 'AppData', 'Roaming', 'npm', 'happy'),
        'C:\\Program Files\\nodejs\\happy.cmd'
      )
    } else {
      // macOS/Linux locations
      // Check nvm installations
      const nvmDir = process.env.NVM_DIR || path.join(homeDir, '.nvm')
      if (fs.existsSync(nvmDir)) {
        const versionsDir = path.join(nvmDir, 'versions', 'node')
        if (fs.existsSync(versionsDir)) {
          try {
            const versions = fs.readdirSync(versionsDir)
            for (const version of versions.sort().reverse()) {
              possiblePaths.push(path.join(versionsDir, version, 'bin', 'happy'))
            }
          } catch (e) {
            // Ignore errors reading directory
          }
        }
      }

      // Other common locations
      possiblePaths.push(
        '/usr/local/bin/happy',
        '/opt/homebrew/bin/happy',
        path.join(homeDir, '.local', 'bin', 'happy'),
        path.join(homeDir, 'bin', 'happy'),
        '/usr/bin/happy'
      )
    }

    // Find the first existing path
    for (const p of possiblePaths) {
      if (fs.existsSync(p)) {
        console.log('Found happy at:', p)
        return p
      }
    }

    // Fallback to just 'happy' and hope it's in PATH
    console.warn('Could not find happy executable, falling back to PATH lookup')
    return 'happy'
  }

  private findClaudeExecutable(): string {
    const fs = require('fs')
    const path = require('path')
    const os = require('os')
    const homeDir = os.homedir()

    // Common locations where claude might be installed
    const possiblePaths: string[] = []

    if (process.platform === 'win32') {
      // Windows locations
      possiblePaths.push(
        path.join(homeDir, 'AppData', 'Roaming', 'npm', 'claude.cmd'),
        path.join(homeDir, 'AppData', 'Roaming', 'npm', 'claude'),
        'C:\\Program Files\\nodejs\\claude.cmd'
      )
    } else {
      // macOS/Linux locations
      // Check nvm installations
      const nvmDir = process.env.NVM_DIR || path.join(homeDir, '.nvm')
      if (fs.existsSync(nvmDir)) {
        const versionsDir = path.join(nvmDir, 'versions', 'node')
        if (fs.existsSync(versionsDir)) {
          try {
            const versions = fs.readdirSync(versionsDir)
            for (const version of versions.sort().reverse()) {
              possiblePaths.push(path.join(versionsDir, version, 'bin', 'claude'))
            }
          } catch (e) {
            // Ignore errors reading directory
          }
        }
      }

      // Other common locations
      possiblePaths.push(
        '/usr/local/bin/claude',
        '/opt/homebrew/bin/claude',
        path.join(homeDir, '.local', 'bin', 'claude'),
        path.join(homeDir, 'bin', 'claude'),
        '/usr/bin/claude'
      )
    }

    // Find the first existing path
    for (const p of possiblePaths) {
      if (fs.existsSync(p)) {
        console.log('Found claude at:', p)
        return p
      }
    }

    // Fallback to just 'claude' and hope it's in PATH
    console.warn('Could not find claude executable, falling back to PATH lookup')
    return 'claude'
  }

  private getDefaultShell(): string {
    if (process.platform === 'win32') {
      // Prefer PowerShell 7 (pwsh) over Windows PowerShell
      const fs = require('fs')
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
      return 'powershell.exe'
    } else if (process.platform === 'darwin') {
      return process.env.SHELL || '/bin/zsh'
    } else {
      // Linux - detect available shell
      const fs = require('fs')
      if (process.env.SHELL) {
        return process.env.SHELL
      } else if (fs.existsSync('/bin/bash')) {
        return '/bin/bash'
      } else {
        return '/bin/sh'
      }
    }
  }

  // Construct enhanced PATH that includes Node.js binary directories
  // This is needed for packaged Electron apps where process.env.PATH may not include node
  private getEnhancedPath(): string {
    const path = require('path')
    const fs = require('fs')
    const os = require('os')
    const homeDir = os.homedir()

    const pathParts: string[] = []

    if (process.platform === 'win32') {
      // Windows: check common Node.js locations
      const windowsPaths = [
        path.join(homeDir, 'AppData', 'Roaming', 'npm'),
        'C:\\Program Files\\nodejs',
        'C:\\Program Files (x86)\\nodejs'
      ]
      for (const p of windowsPaths) {
        if (fs.existsSync(p)) {
          pathParts.push(p)
        }
      }
    } else {
      // macOS/Linux: check nvm installations
      const nvmDir = process.env.NVM_DIR || path.join(homeDir, '.nvm')
      const versionsDir = path.join(nvmDir, 'versions', 'node')
      if (fs.existsSync(versionsDir)) {
        try {
          const versions = fs.readdirSync(versionsDir).sort().reverse()
          for (const version of versions) {
            pathParts.push(path.join(versionsDir, version, 'bin'))
          }
        } catch (e) {
          // Ignore errors reading directory
        }
      }

      // Add common system paths
      const systemPaths = [
        '/usr/local/bin',
        '/opt/homebrew/bin',
        path.join(homeDir, '.local', 'bin'),
        path.join(homeDir, 'bin'),
        '/usr/bin',
        '/bin'
      ]
      for (const p of systemPaths) {
        if (fs.existsSync(p)) {
          pathParts.push(p)
        }
      }
    }

    // Append original PATH
    if (process.env.PATH) {
      pathParts.push(process.env.PATH)
    }

    return pathParts.join(process.platform === 'win32' ? ';' : ':')
  }

  create(options: CreatePtyOptions): boolean {
    const { id, cwd, type, shell: shellOverride, codeAgentType } = options

    let executable: string
    let args: string[] = []

    if (type === 'claude-code') {
      // For Claude Code terminals, use happy or claude based on user selection
      if (codeAgentType === 'claude') {
        executable = this.findClaudeExecutable()
      } else {
        // Default to happy
        executable = this.findHappyExecutable()
      }
      args = []
    } else {
      // For regular terminals, use the shell
      executable = shellOverride || this.getDefaultShell()

      // For PowerShell (pwsh or powershell), bypass execution policy to allow unsigned scripts
      if (executable.includes('powershell') || executable.includes('pwsh')) {
        args = ['-ExecutionPolicy', 'Bypass', '-NoLogo']
      }
    }

    // Try node-pty first, fallback to child_process if it fails
    let usedPty = false

    // Get shell environment once (includes HAPPY_SERVER_URL from .zshrc, etc.)
    const shellEnv = this.getShellEnv()

    if (ptyAvailable && pty) {
      try {
        // Set UTF-8 environment variables and enhanced PATH for packaged apps
        // Merge shell env to get vars from .zshrc/.bash_profile (e.g., HAPPY_SERVER_URL)
        const homeDir = process.env.HOME || require('os').homedir()
        const envWithUtf8 = {
          ...shellEnv,
          ...process.env,
          HOME: homeDir,
          PATH: this.getEnhancedPath(),
          LANG: 'en_US.UTF-8',
          LC_ALL: 'en_US.UTF-8',
          PYTHONIOENCODING: 'utf-8',
          PYTHONUTF8: '1'
        }

        const ptyProcess = pty.spawn(executable, args, {
          name: 'xterm-256color',
          cols: 120,
          rows: 30,
          cwd,
          env: envWithUtf8 as { [key: string]: string }
        })

        ptyProcess.onData((data: string) => {
          // Buffer output for reconnection (keep last 200000 chars / 200KB per terminal)
          const instance = this.instances.get(id)
          if (instance) {
            instance.outputBuffer.push(data)
            instance.outputBufferSize += data.length
            // Limit buffer size using tracked size (avoids expensive join())
            if (instance.outputBufferSize > 200000) {
              while (instance.outputBuffer.length > 1 && instance.outputBufferSize > 160000) {
                const removed = instance.outputBuffer.shift()!
                instance.outputBufferSize -= removed.length
              }
            }
          }
          this.safeSend('pty:output', id, data)
        })

        ptyProcess.onExit(({ exitCode }: { exitCode: number }) => {
          this.safeSend('pty:exit', id, exitCode)
          this.instances.delete(id)
          this.notifyTerminalCountChange()
        })

        this.instances.set(id, { process: ptyProcess, type, cwd, usePty: true, outputBuffer: [], outputBufferSize: 0 })
        usedPty = true
        console.log('Created terminal using node-pty, id:', id)
        this.notifyTerminalCountChange()
      } catch (e) {
        console.warn('node-pty spawn failed, falling back to child_process:', e)
        ptyAvailable = false // Don't try again
      }
    }

    if (!usedPty) {
      try {
        // Fallback to child_process with proper stdio
        // For PowerShell, add -NoExit and UTF-8 command
        let shellArgs = [...args]
        if (executable.includes('powershell') || executable.includes('pwsh')) {
          shellArgs.push(
            '-NoExit',
            '-Command',
            '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; [Console]::InputEncoding = [System.Text.Encoding]::UTF8; $OutputEncoding = [System.Text.Encoding]::UTF8'
          )
        }

        // Set UTF-8 environment variables and enhanced PATH for packaged apps
        // Merge shell env to get vars from .zshrc/.bash_profile (e.g., HAPPY_SERVER_URL)
        const homeDir = process.env.HOME || require('os').homedir()
        const envWithUtf8 = {
          ...shellEnv,
          ...process.env,
          HOME: homeDir,
          PATH: this.getEnhancedPath(),
          LANG: 'en_US.UTF-8',
          LC_ALL: 'en_US.UTF-8',
          PYTHONIOENCODING: 'utf-8',
          PYTHONUTF8: '1'
        }

        const childProcess = spawn(executable, shellArgs, {
          cwd,
          env: envWithUtf8 as NodeJS.ProcessEnv,
          stdio: ['pipe', 'pipe', 'pipe'],
          shell: false
        })

        childProcess.stdout?.on('data', (data: Buffer) => {
          const str = data.toString()
          // Buffer output for reconnection (keep last 200KB per terminal)
          const instance = this.instances.get(id)
          if (instance) {
            instance.outputBuffer.push(str)
            instance.outputBufferSize += str.length
            // Limit buffer size using tracked size (avoids expensive join())
            if (instance.outputBufferSize > 200000) {
              while (instance.outputBuffer.length > 1 && instance.outputBufferSize > 160000) {
                const removed = instance.outputBuffer.shift()!
                instance.outputBufferSize -= removed.length
              }
            }
          }
          this.safeSend('pty:output', id, str)
        })

        childProcess.stderr?.on('data', (data: Buffer) => {
          const str = data.toString()
          // Buffer output for reconnection (keep last 200KB per terminal)
          const instance = this.instances.get(id)
          if (instance) {
            instance.outputBuffer.push(str)
            instance.outputBufferSize += str.length
            // Limit buffer size using tracked size (avoids expensive join())
            if (instance.outputBufferSize > 200000) {
              while (instance.outputBuffer.length > 1 && instance.outputBufferSize > 160000) {
                const removed = instance.outputBuffer.shift()!
                instance.outputBufferSize -= removed.length
              }
            }
          }
          this.safeSend('pty:output', id, str)
        })

        childProcess.on('exit', (exitCode: number | null) => {
          this.safeSend('pty:exit', id, exitCode ?? 0)
          this.instances.delete(id)
          this.notifyTerminalCountChange()
        })

        childProcess.on('error', (error) => {
          console.error('Child process error:', error)
          this.safeSend('pty:output', id, `\r\n[Error: ${error.message}]\r\n`)
        })

        // Send initial message
        this.safeSend('pty:output', id, `[Terminal - child_process mode]\r\n`)

        this.instances.set(id, { process: childProcess, type, cwd, usePty: false, outputBuffer: [], outputBufferSize: 0 })
        console.log('Created terminal using child_process fallback, id:', id)
        this.notifyTerminalCountChange()
      } catch (error) {
        console.error('Failed to create terminal:', error)
        return false
      }
    }

    return true
  }

  write(id: string, data: string): void {
    const instance = this.instances.get(id)
    if (instance) {
      if (instance.usePty) {
        instance.process.write(data)
      } else {
        // For child_process, write to stdin only (shell handles echo)
        const cp = instance.process as ChildProcess
        cp.stdin?.write(data)
      }
    }
  }

  resize(id: string, cols: number, rows: number): void {
    const instance = this.instances.get(id)
    if (instance && instance.usePty) {
      instance.process.resize(cols, rows)
    }
  }

  kill(id: string): boolean {
    const instance = this.instances.get(id)
    if (instance) {
      if (instance.usePty) {
        instance.process.kill()
      } else {
        (instance.process as ChildProcess).kill()
      }
      this.instances.delete(id)
      this.notifyTerminalCountChange()
      return true
    }
    return false
  }

  restart(id: string, cwd: string, shell?: string, codeAgentType?: 'happy' | 'claude'): boolean {
    const instance = this.instances.get(id)
    if (instance) {
      const type = instance.type
      const savedBuffer = [...instance.outputBuffer]  // Preserve history
      const savedBufferSize = instance.outputBufferSize  // Preserve size
      this.kill(id)
      const created = this.create({ id, cwd, type, shell, codeAgentType })
      if (created) {
        const newInstance = this.instances.get(id)
        if (newInstance) {
          newInstance.outputBuffer = savedBuffer  // Restore history
          newInstance.outputBufferSize = savedBufferSize  // Restore size
        }
      }
      return created
    }
    return false
  }

  getCwd(id: string): string | null {
    const instance = this.instances.get(id)
    if (instance) {
      return instance.cwd
    }
    return null
  }

  // Check if a PTY instance exists
  exists(id: string): boolean {
    return this.instances.has(id)
  }

  // Filter ANSI escape codes that clear the screen
  // These would be re-executed when restoring buffer, causing history loss
  private filterClearScreenCodes(buffer: string): string {
    return buffer
      .replace(/\x1b\[2J/g, '')       // Clear entire screen
      .replace(/\x1b\[3J/g, '')       // Clear scrollback buffer
      .replace(/\x1b\[H/g, '')        // Move cursor to home position
      .replace(/\x1b\[\?1049[hl]/g, '') // Alternate screen buffer switch
      .replace(/\x1bc/g, '')          // Reset terminal
  }

  // Get buffered output for reconnection
  getOutputBuffer(id: string): string | null {
    const instance = this.instances.get(id)
    if (instance) {
      const buffer = instance.outputBuffer.join('')
      return this.filterClearScreenCodes(buffer)
    }
    return null
  }

  // Clear output buffer (after it's been restored)
  clearOutputBuffer(id: string): void {
    const instance = this.instances.get(id)
    if (instance) {
      instance.outputBuffer = []
      instance.outputBufferSize = 0
    }
  }

  dispose(): void {
    this.disposed = true
    for (const [id] of this.instances) {
      this.kill(id)
    }
  }
}
