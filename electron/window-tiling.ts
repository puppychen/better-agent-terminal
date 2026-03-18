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

  /** No-op: Better Agent Workspace window stays untouched */
  positionSidebar(): void {
    // Don't change Better Agent Workspace window position or size
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

  /** Use AppleScript to cascade all visible Terminal.app windows (position only, no resize) */
  syncTerminalPosition(): void {
    if (!this.enabled || process.platform !== 'darwin') return

    const pos = this.getTerminalPosition()
    const CASCADE_X = 56  // horizontal offset per window
    const CASCADE_Y = 56  // vertical offset per window
    const script = `
      tell application "Terminal"
        if not running then return
        if (count of windows) = 0 then return
        set idx to 0
        repeat with w in windows
          if visible of w is true and miniaturized of w is false then
            set position of w to {${pos.x} + idx * ${CASCADE_X}, ${pos.y} + idx * ${CASCADE_Y}}
            set idx to idx + 1
          end if
        end repeat
      end tell
    `
    exec(`osascript -e '${script.replace(/'/g, "'\\''")}'`, (error) => {
      if (error) {
        console.error('Failed to sync Terminal position:', error.message)
      }
    })
  }

  /** Raise all visible Terminal.app windows (reverse order so first window ends on top) */
  raiseTerminalWindow(): void {
    if (!this.enabled || process.platform !== 'darwin') return

    const script = `
      tell application "Terminal"
        if not running then return
        if (count of windows) = 0 then return
        repeat with w in windows
          if visible of w is true then
            set miniaturized of w to false
          end if
        end repeat
      end tell
      tell application "System Events"
        tell process "Terminal"
          if (count of windows) = 0 then return
          repeat with i from (count of windows) to 1 by -1
            perform action "AXRaise" of window i
          end repeat
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
