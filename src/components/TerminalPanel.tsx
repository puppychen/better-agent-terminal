import { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import { workspaceStore } from '../stores/workspace-store'
import '@xterm/xterm/css/xterm.css'

interface TerminalPanelProps {
  terminalId: string
  isActive?: boolean
}

interface ContextMenu {
  x: number
  y: number
  hasSelection: boolean
}

export function TerminalPanel({ terminalId, isActive = true }: TerminalPanelProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const terminalRef = useRef<Terminal | null>(null)
  const fitAddonRef = useRef<FitAddon | null>(null)
  const isActiveRef = useRef(isActive)
  const resizeTimeoutRef = useRef<NodeJS.Timeout | null>(null)
  const hasNewOutputWhileHiddenRef = useRef(false)
  const [contextMenu, setContextMenu] = useState<ContextMenu | null>(null)

  // Keep isActiveRef in sync with isActive prop (fixes closure issue in ResizeObserver)
  useEffect(() => {
    isActiveRef.current = isActive
  }, [isActive])

  // Handle paste with text size checking
  const handlePasteText = (text: string) => {
    if (!text) return

    // For very long text (> 2000 chars), split into smaller chunks
    if (text.length > 2000) {
      const chunks = []
      for (let i = 0; i < text.length; i += 1000) {
        chunks.push(text.slice(i, i + 1000))
      }

      // Send chunks with small delays to prevent overwhelming the terminal
      chunks.forEach((chunk, index) => {
        setTimeout(() => {
          window.electronAPI.pty.write(terminalId, chunk)
        }, index * 50) // 50ms delay between chunks
      })
    } else {
      // Normal sized text, send directly
      window.electronAPI.pty.write(terminalId, text)
    }
  }

  // Handle context menu actions
  const handleCopy = () => {
    if (terminalRef.current) {
      const selection = terminalRef.current.getSelection()
      if (selection) {
        navigator.clipboard.writeText(selection)
      }
    }
    setContextMenu(null)
  }

  const handlePaste = async () => {
    try {
      const text = await navigator.clipboard.readText()
      if (text) {
        handlePasteText(text)
      }
    } catch (err) {
      console.error('Failed to read clipboard:', err)
    }
    setContextMenu(null)
  }

  // Close context menu when clicking outside
  useEffect(() => {
    const handleClickOutside = () => setContextMenu(null)
    document.addEventListener('click', handleClickOutside)
    return () => document.removeEventListener('click', handleClickOutside)
  }, [])

  // Handle terminal resize and focus when becoming active
  useEffect(() => {
    if (isActive && fitAddonRef.current && terminalRef.current) {
      // Small delay to ensure DOM is updated
      const timeoutId = setTimeout(() => {
        if (fitAddonRef.current && terminalRef.current) {
          const terminal = terminalRef.current

          // 1. Adjust size
          fitAddonRef.current.fit()
          const { cols, rows } = terminal
          window.electronAPI.pty.resize(terminalId, cols, rows)

          // 2. Force refresh entire buffer (including scrollback history)
          // This ensures all content written while terminal was hidden gets rendered
          const totalRows = terminal.buffer.active.length
          terminal.refresh(0, totalRows - 1)

          // 3. Scroll to bottom and focus
          terminal.scrollToBottom()
          terminal.focus()

          // 4. If there was new output while hidden, do additional refresh after a short delay
          // to ensure xterm.js has fully processed the content
          if (hasNewOutputWhileHiddenRef.current) {
            hasNewOutputWhileHiddenRef.current = false
            setTimeout(() => {
              if (terminalRef.current && fitAddonRef.current) {
                fitAddonRef.current.fit()
                const totalRows = terminalRef.current.buffer.active.length
                terminalRef.current.refresh(0, totalRows - 1)
                terminalRef.current.scrollToBottom()
              }
            }, 50)
          }
        }
      }, 100)

      return () => clearTimeout(timeoutId)
    }
  }, [isActive, terminalId])

  // Add intersection observer to detect when terminal becomes visible
  useEffect(() => {
    if (!containerRef.current || !fitAddonRef.current || !terminalRef.current) return

    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting && isActive && fitAddonRef.current && terminalRef.current) {
            // Terminal became visible, resize it
            setTimeout(() => {
              if (fitAddonRef.current && terminalRef.current) {
                fitAddonRef.current.fit()
                const { cols, rows } = terminalRef.current
                window.electronAPI.pty.resize(terminalId, cols, rows)
              }
            }, 50)
          }
        })
      },
      { threshold: 0.1 }
    )

    observer.observe(containerRef.current)

    return () => observer.disconnect()
  }, [isActive, terminalId])

  // Handle window visibility changes (e.g., macOS workspace switching)
  useEffect(() => {
    const unsubscribe = window.electronAPI?.window?.onVisibilityChanged?.((visible) => {
      // When window becomes visible again, just fit and refresh (no serialize/deserialize)
      if (visible && isActive && terminalRef.current && fitAddonRef.current) {
        requestAnimationFrame(() => {
          fitAddonRef.current?.fit()
          const { cols, rows } = terminalRef.current!
          window.electronAPI.pty.resize(terminalId, cols, rows)

          // Refresh entire buffer to ensure content is displayed correctly
          const totalRows = terminalRef.current!.buffer.active.length
          terminalRef.current!.refresh(0, totalRows - 1)
          terminalRef.current!.scrollToBottom()
        })
      }
    })

    return () => unsubscribe?.()
  }, [isActive, terminalId])

  useEffect(() => {
    if (!containerRef.current) return

    // Create terminal instance
    const terminal = new Terminal({
      theme: {
        background: '#1e1e1e',
        foreground: '#cccccc',
        cursor: '#ffffff',
        cursorAccent: '#000000',
        selectionBackground: '#264f78',
        black: '#000000',
        red: '#cd3131',
        green: '#0dbc79',
        yellow: '#e5e510',
        blue: '#2472c8',
        magenta: '#bc3fbc',
        cyan: '#11a8cd',
        white: '#e5e5e5',
        brightBlack: '#666666',
        brightRed: '#f14c4c',
        brightGreen: '#23d18b',
        brightYellow: '#f5f543',
        brightBlue: '#3b8eea',
        brightMagenta: '#d670d6',
        brightCyan: '#29b8db',
        brightWhite: '#e5e5e5'
      },
      fontSize: 14,
      fontFamily: 'Consolas, Monaco, "Courier New", monospace',
      cursorBlink: true,
      scrollback: 10000,
      convertEol: true,
      allowProposedApi: true,
      allowTransparency: true,
      scrollOnOutput: true,
      windowsMode: true
    })

    const fitAddon = new FitAddon()
    const unicode11Addon = new Unicode11Addon()
    terminal.loadAddon(fitAddon)
    terminal.open(containerRef.current)

    // Load unicode11 addon after terminal is open
    terminal.loadAddon(unicode11Addon)
    terminal.unicode.activeVersion = '11'

    // Delay fit to ensure terminal is fully initialized
    requestAnimationFrame(() => {
      fitAddon.fit()
    })

    // Note: IME textarea position is now handled purely by CSS in main.css
    // Using CSS !important ensures the position is fixed without JavaScript intervention
    // This prevents MutationObserver from repeatedly triggering and causing scroll issues

    terminalRef.current = terminal
    fitAddonRef.current = fitAddon

    // Handle terminal input
    terminal.onData((data) => {
      window.electronAPI.pty.write(terminalId, data)
    })

    // Handle copy and paste shortcuts
    terminal.attachCustomKeyEventHandler((event) => {
      // Let Ctrl+Tab and Ctrl+Alt+Tab bubble up for terminal/workspace switching
      if (event.ctrlKey && event.key === 'Tab') {
        return false // Don't handle in xterm, let it bubble to document
      }
      // Let Ctrl+[ and Ctrl+] bubble up for workspace switching
      if (event.ctrlKey && (event.key === '[' || event.key === ']')) {
        return false
      }

      // Shift+Enter for newline (same as Option+Enter in Claude Code)
      // Send ESC + Enter sequence which Claude Code interprets as insert newline
      if (event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey && event.key === 'Enter') {
        if (event.type === 'keydown') {
          window.electronAPI.pty.write(terminalId, '\x1b\r')
        }
        return false
      }

      // Ctrl+Shift+C for copy
      if (event.ctrlKey && event.shiftKey && event.key === 'C') {
        const selection = terminal.getSelection()
        if (selection) {
          navigator.clipboard.writeText(selection)
        }
        return false
      }
      // Ctrl+Shift+V for paste
      if (event.ctrlKey && event.shiftKey && event.key === 'V') {
        navigator.clipboard.readText().then((text) => {
          handlePasteText(text)
        })
        return false
      }
      // Ctrl+V for paste (standard shortcut)
      if (event.ctrlKey && !event.shiftKey && event.key === 'v') {
        event.preventDefault()
        navigator.clipboard.readText().then((text) => {
          handlePasteText(text)
        })
        return false
      }
      // Ctrl+C for copy when there's a selection
      if (event.ctrlKey && !event.shiftKey && event.key === 'c') {
        const selection = terminal.getSelection()
        if (selection) {
          navigator.clipboard.writeText(selection)
          return false
        }
        // If no selection, let Ctrl+C pass through for interrupt signal
        return true
      }
      return true
    })

    // Right-click context menu for copy/paste
    containerRef.current.addEventListener('contextmenu', (e) => {
      e.preventDefault()
      const selection = terminal.getSelection()
      setContextMenu({
        x: e.clientX,
        y: e.clientY,
        hasSelection: !!selection
      })
    })

    // Handle terminal output
    const unsubscribeOutput = window.electronAPI.pty.onOutput((id, data) => {
      if (id === terminalId) {
        terminal.write(data)
        // Update activity time when there's output
        workspaceStore.updateTerminalActivity(terminalId)
        // Track if there's new output while terminal is hidden
        if (!isActiveRef.current) {
          hasNewOutputWhileHiddenRef.current = true
        }
      }
    })

    // Handle terminal exit
    const unsubscribeExit = window.electronAPI.pty.onExit((id, exitCode) => {
      if (id === terminalId) {
        terminal.write(`\r\n\x1b[90m[Process exited with code ${exitCode}]\x1b[0m\r\n`)
      }
    })

    // Handle resize with debouncing to avoid excessive calls during window resize
    const resizeObserver = new ResizeObserver(() => {
      // Only resize if terminal is currently active (use ref to get current value)
      if (isActiveRef.current) {
        // Clear existing timeout to debounce
        if (resizeTimeoutRef.current) {
          clearTimeout(resizeTimeoutRef.current)
        }
        // Debounce resize to 100ms
        resizeTimeoutRef.current = setTimeout(() => {
          if (fitAddonRef.current && terminalRef.current) {
            fitAddonRef.current.fit()
            const { cols, rows } = terminalRef.current
            window.electronAPI.pty.resize(terminalId, cols, rows)
          }
        }, 100)
      }
    })
    resizeObserver.observe(containerRef.current)

    // Initial resize and restore buffer
    setTimeout(async () => {
      fitAddon.fit()
      const { cols, rows } = terminal
      window.electronAPI.pty.resize(terminalId, cols, rows)

      // Restore output buffer if PTY exists (for reconnection after workspace switch)
      const exists = await window.electronAPI.pty.exists(terminalId)
      if (exists) {
        const buffer = await window.electronAPI.pty.getOutputBuffer(terminalId)
        if (buffer) {
          console.log(`Restoring ${buffer.length} chars for terminal ${terminalId}`)
          terminal.write(buffer)
        }
      }
    }, 100)

    return () => {
      unsubscribeOutput()
      unsubscribeExit()
      resizeObserver.disconnect()
      // Clear any pending resize timeout
      if (resizeTimeoutRef.current) {
        clearTimeout(resizeTimeoutRef.current)
      }
      terminal.dispose()
    }
  }, [terminalId])

  return (
    <div ref={containerRef} className="terminal-panel">
      {contextMenu && (
        <div
          className="context-menu"
          style={{
            position: 'fixed',
            left: contextMenu.x,
            top: contextMenu.y,
            zIndex: 1000
          }}
        >
          {contextMenu.hasSelection && (
            <button onClick={handleCopy} className="context-menu-item">
              複製
            </button>
          )}
          <button onClick={handlePaste} className="context-menu-item">
            貼上
          </button>
        </div>
      )}
    </div>
  )
}
