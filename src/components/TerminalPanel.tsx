import { useEffect, useRef, useState, useCallback } from 'react'
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
  const lastActivityUpdateRef = useRef(0)  // For throttling activity updates
  const userScrolledUpRef = useRef(false)  // Track if user has scrolled up from bottom
  const lastScrollUpTimeRef = useRef(0)  // Timestamp of last scroll up action for debouncing
  const [contextMenu, setContextMenu] = useState<ContextMenu | null>(null)

  // Minimum time (ms) to respect user's scroll-up intent before allowing auto-scroll
  const SCROLL_LOCK_DURATION = 300

  // Sync isActiveRef immediately (not in useEffect) to avoid timing issues
  // This ensures onOutput callback always has the correct isActive value
  isActiveRef.current = isActive

  // Check if terminal is scrolled to the bottom
  const isAtBottom = useCallback(() => {
    const terminal = terminalRef.current
    if (!terminal) return true

    const buffer = terminal.buffer.active
    const viewportTop = buffer.viewportY
    const totalRows = buffer.length
    const viewportRows = terminal.rows
    const expectedTop = Math.max(0, totalRows - viewportRows)

    // Allow 2 rows tolerance for "at bottom"
    return viewportTop >= expectedTop - 2
  }, [])

  // Reliable scroll function with retry mechanism
  const scrollToBottomReliably = useCallback((retries = 3, delay = 50) => {
    const terminal = terminalRef.current
    if (!terminal) return

    const attemptScroll = (remainingRetries: number) => {
      if (remainingRetries <= 0) return

      terminal.scrollToBottom()

      // Verify scroll succeeded
      requestAnimationFrame(() => {
        const buffer = terminal.buffer.active
        const viewportTop = buffer.viewportY
        const totalRows = buffer.length
        const viewportRows = terminal.rows
        const expectedTop = Math.max(0, totalRows - viewportRows)

        // If scroll position is incorrect, retry
        if (viewportTop < expectedTop - 1) {
          setTimeout(() => attemptScroll(remainingRetries - 1), delay)
        }
      })
    }

    attemptScroll(retries)
  }, [])

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
      const terminal = terminalRef.current
      const shouldScrollToBottom = hasNewOutputWhileHiddenRef.current || !userScrolledUpRef.current

      // Only scroll to bottom if there's new output or user was at bottom
      if (shouldScrollToBottom) {
        terminal.scrollToBottom()
        requestAnimationFrame(() => {
          terminalRef.current?.scrollToBottom()
        })
      }

      // Delayed full processing
      const timeoutId = setTimeout(() => {
        if (fitAddonRef.current && terminalRef.current) {
          const term = terminalRef.current

          // Adjust size
          fitAddonRef.current.fit()
          const { cols, rows } = term
          window.electronAPI.pty.resize(terminalId, cols, rows)

          // Refresh visible viewport
          const viewportRows = term.rows
          const totalRows = term.buffer.active.length
          const startRow = Math.max(0, totalRows - viewportRows)
          term.refresh(startRow, totalRows - 1)

          // Only scroll to bottom if there was new output while hidden or user was at bottom
          if (shouldScrollToBottom) {
            scrollToBottomReliably(3, 50)
          }

          // Focus
          term.focus()
        }
      }, 100)

      // Handle new output while hidden
      let additionalTimeoutId: NodeJS.Timeout | null = null
      if (hasNewOutputWhileHiddenRef.current) {
        hasNewOutputWhileHiddenRef.current = false
        userScrolledUpRef.current = false  // Reset scroll state when switching with new output
        additionalTimeoutId = setTimeout(() => {
          scrollToBottomReliably(3, 30)
        }, 200)
      }

      return () => {
        clearTimeout(timeoutId)
        if (additionalTimeoutId) clearTimeout(additionalTimeoutId)
      }
    }
  }, [isActive, terminalId, scrollToBottomReliably])

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
          const term = terminalRef.current!
          fitAddonRef.current?.fit()
          const { cols, rows } = term
          window.electronAPI.pty.resize(terminalId, cols, rows)

          // Only refresh visible viewport
          const viewportRows = term.rows
          const totalRows = term.buffer.active.length
          const startRow = Math.max(0, totalRows - viewportRows)
          term.refresh(startRow, totalRows - 1)

          // Only scroll to bottom if user wasn't scrolled up
          if (!userScrolledUpRef.current) {
            term.scrollToBottom()
          }
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
      scrollOnUserInput: false,  // Don't auto-scroll on user input
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

    // Use wheel event to reliably detect user scroll intent
    // This is more reliable than onScroll as it directly captures user action
    const handleWheel = (e: WheelEvent) => {
      if (e.deltaY < 0) {
        // User scrolling up - mark as scrolled up and record timestamp
        userScrolledUpRef.current = true
        lastScrollUpTimeRef.current = Date.now()
      } else if (e.deltaY > 0) {
        // User scrolling down - check if at bottom after a short delay
        requestAnimationFrame(() => {
          if (isAtBottom()) {
            userScrolledUpRef.current = false
          }
        })
      }
    }
    const container = containerRef.current
    container.addEventListener('wheel', handleWheel, { passive: true })

    // Also track keyboard scrolling (Page Up, Page Down, Arrow keys)
    const handleKeyScroll = (e: KeyboardEvent) => {
      if (e.key === 'PageUp' || (e.key === 'ArrowUp' && e.shiftKey)) {
        userScrolledUpRef.current = true
        lastScrollUpTimeRef.current = Date.now()
      } else if (e.key === 'PageDown' || e.key === 'End' || (e.key === 'ArrowDown' && e.shiftKey)) {
        requestAnimationFrame(() => {
          if (isAtBottom()) {
            userScrolledUpRef.current = false
          }
        })
      }
    }
    container.addEventListener('keydown', handleKeyScroll)

    // Handle terminal output
    const unsubscribeOutput = window.electronAPI.pty.onOutput((id, data) => {
      if (id === terminalId) {
        // Check if user has scrolled up and we need to preserve scroll position
        const timeSinceLastScroll = Date.now() - lastScrollUpTimeRef.current
        const isWithinScrollLock = timeSinceLastScroll < SCROLL_LOCK_DURATION
        const shouldPreserveScroll = userScrolledUpRef.current || isWithinScrollLock

        // Save scroll position before write if user has scrolled up
        const savedViewportY = shouldPreserveScroll ? terminal.buffer.active.viewportY : -1

        terminal.write(data)

        // Restore scroll position if user had scrolled up
        if (shouldPreserveScroll && savedViewportY >= 0) {
          // Use scrollToLine to restore the exact position
          terminal.scrollToLine(savedViewportY)
        } else if (isActiveRef.current) {
          // Auto-scroll to bottom only if user hasn't scrolled up
          requestAnimationFrame(() => {
            const stillWithinLock = Date.now() - lastScrollUpTimeRef.current < SCROLL_LOCK_DURATION
            if (!userScrolledUpRef.current && !stillWithinLock) {
              terminal.scrollToBottom()
            }
          })
        }

        // Track if there's new output while terminal is hidden
        if (!isActiveRef.current) {
          hasNewOutputWhileHiddenRef.current = true
        }

        // Throttle activity updates to 1 second to reduce state updates
        const now = Date.now()
        if (now - lastActivityUpdateRef.current > 1000) {
          workspaceStore.updateTerminalActivity(terminalId)
          lastActivityUpdateRef.current = now
        }
      }
    })

    // Handle terminal exit
    const unsubscribeExit = window.electronAPI.pty.onExit((id, exitCode) => {
      if (id === terminalId) {
        terminal.write(`\r\n\x1b[90m[Process exited with code ${exitCode}]\x1b[0m\r\n`)
        // Clear activity so the indicator turns off immediately
        workspaceStore.clearTerminalActivity(terminalId)
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
      container.removeEventListener('wheel', handleWheel)
      container.removeEventListener('keydown', handleKeyScroll)
      // Clear any pending resize timeout
      if (resizeTimeoutRef.current) {
        clearTimeout(resizeTimeoutRef.current)
      }
      terminal.dispose()
    }
  }, [terminalId, isAtBottom])

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
