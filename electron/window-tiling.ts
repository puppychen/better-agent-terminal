import { BrowserWindow } from 'electron'
import { exec } from 'child_process'

export class WindowTilingManager {
  private win: BrowserWindow
  private enabled = false
  private syncTimer: ReturnType<typeof setTimeout> | null = null
  private moveHandler: (() => void) | null = null
  private resizeHandler: (() => void) | null = null
  private focusHandler: (() => void) | null = null
  private raiseTimer: ReturnType<typeof setTimeout> | null = null

  constructor(win: BrowserWindow) {
    this.win = win
  }

  isEnabled(): boolean {
    return this.enabled
  }

  enable(): void {
    if (this.enabled) return
    this.enabled = true
    this.syncTerminalPosition()
    this.raiseTerminalWindow()
    this.startListening()
  }

  disable(): void {
    if (!this.enabled) return
    this.enabled = false
    this.stopListening()
    if (this.syncTimer) {
      clearTimeout(this.syncTimer)
      this.syncTimer = null
    }
    if (this.raiseTimer) {
      clearTimeout(this.raiseTimer)
      this.raiseTimer = null
    }
  }

  /** No-op: Better Agent window stays untouched */
  positionSidebar(): void {
    // Don't change Better Agent window position or size
  }

  /** Calculate Terminal target position (right of Better Agent, below tab bar) */
  getTerminalPosition(): { x: number; y: number } {
    const bounds = this.win.getBounds()
    // Offset Y to align Terminal top with bottom of sidebar tab bar
    // macOS title bar (~28px) + sidebar-tabs (~33px: padding 10*2 + font 11 + border 2)
    const TAB_BAR_OFFSET = 61
    return {
      x: bounds.x + bounds.width,
      y: bounds.y + TAB_BAR_OFFSET
    }
  }

  /** Use AppleScript to move Terminal.app window (position only, no resize) */
  syncTerminalPosition(): void {
    if (!this.enabled || process.platform !== 'darwin') return

    const pos = this.getTerminalPosition()
    const script = `
      tell application "Terminal"
        if not running then return
        if (count of windows) = 0 then return
        set position of front window to {${pos.x}, ${pos.y}}
      end tell
    `
    exec(`osascript -e '${script.replace(/'/g, "'\\''")}'`, (error) => {
      if (error) {
        console.error('Failed to sync Terminal position:', error.message)
      }
    })
  }

  /** Raise Terminal.app window to foreground without stealing keyboard focus */
  raiseTerminalWindow(): void {
    if (!this.enabled || process.platform !== 'darwin') return

    const script = `
      tell application "Terminal"
        if not running then return
        if (count of windows) = 0 then return
        set miniaturized of front window to false
      end tell
      tell application "System Events"
        tell process "Terminal"
          if (count of windows) > 0 then
            perform action "AXRaise" of window 1
          end if
        end tell
      end tell
    `
    exec(`osascript -e '${script.replace(/'/g, "'\\''")}'`, (error) => {
      if (error) {
        console.warn('raiseTerminalWindow failed:', error.message)
      }
    })
  }

  private debouncedRaise = (): void => {
    if (this.raiseTimer) clearTimeout(this.raiseTimer)
    this.raiseTimer = setTimeout(() => {
      this.raiseTerminalWindow()
    }, 100)
  }

  private debouncedSync = (): void => {
    if (this.syncTimer) clearTimeout(this.syncTimer)
    this.syncTimer = setTimeout(() => {
      this.syncTerminalPosition()
    }, 150)
  }

  private startListening(): void {
    this.moveHandler = this.debouncedSync
    this.resizeHandler = this.debouncedSync
    this.focusHandler = this.debouncedRaise
    this.win.on('move', this.moveHandler)
    this.win.on('resize', this.resizeHandler)
    this.win.on('focus', this.focusHandler)
  }

  private stopListening(): void {
    if (this.moveHandler) {
      this.win.removeListener('move', this.moveHandler)
      this.moveHandler = null
    }
    if (this.resizeHandler) {
      this.win.removeListener('resize', this.resizeHandler)
      this.resizeHandler = null
    }
    if (this.focusHandler) {
      this.win.removeListener('focus', this.focusHandler)
      this.focusHandler = null
    }
  }

  destroy(): void {
    this.disable()
  }
}
