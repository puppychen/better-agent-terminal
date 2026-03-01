import { BrowserWindow } from 'electron'
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
