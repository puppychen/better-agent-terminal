import { BrowserWindow, screen } from 'electron'
import { exec } from 'child_process'

export class WindowTilingManager {
  private win: BrowserWindow
  private enabled = false
  private syncTimer: ReturnType<typeof setTimeout> | null = null
  private moveHandler: (() => void) | null = null
  private resizeHandler: (() => void) | null = null

  constructor(win: BrowserWindow) {
    this.win = win
  }

  isEnabled(): boolean {
    return this.enabled
  }

  enable(): void {
    if (this.enabled) return
    this.enabled = true
    this.positionSidebar()
    this.syncTerminalPosition()
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
  }

  /** Position sidebar to the left portion of the current display */
  positionSidebar(): void {
    const bounds = this.win.getBounds()
    const display = screen.getDisplayMatching(bounds)
    const workArea = display.workArea

    // Sidebar takes its current width, positioned at left edge
    const sidebarWidth = Math.min(bounds.width, Math.floor(workArea.width * 0.35))
    this.win.setBounds({
      x: workArea.x,
      y: workArea.y,
      width: sidebarWidth,
      height: workArea.height
    })
  }

  /** Calculate Terminal.app bounds based on current sidebar position */
  getTerminalBounds(): { x: number; y: number; width: number; height: number } {
    const bounds = this.win.getBounds()
    const display = screen.getDisplayMatching(bounds)
    const workArea = display.workArea

    const termX = bounds.x + bounds.width
    const termWidth = workArea.x + workArea.width - termX

    return {
      x: termX,
      y: workArea.y,
      width: Math.max(termWidth, 400),
      height: workArea.height
    }
  }

  /** Use AppleScript to position Terminal.app window */
  syncTerminalPosition(): void {
    if (!this.enabled || process.platform !== 'darwin') return

    const tb = this.getTerminalBounds()
    const script = `
      tell application "Terminal"
        if not running then return
        if (count of windows) = 0 then return
        set bounds of front window to {${tb.x}, ${tb.y}, ${tb.x + tb.width}, ${tb.y + tb.height}}
      end tell
    `
    exec(`osascript -e '${script.replace(/'/g, "'\\''")}'`, (error) => {
      if (error) {
        console.error('Failed to sync Terminal position:', error.message)
      }
    })
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
    this.win.on('move', this.moveHandler)
    this.win.on('resize', this.resizeHandler)
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
  }

  destroy(): void {
    this.disable()
  }
}
