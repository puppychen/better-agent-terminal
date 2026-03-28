import { useEffect, useRef, memo } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import { WebglAddon } from '@xterm/addon-webgl'
import '@xterm/xterm/css/xterm.css'

// WebGL context manager — LRU eviction at 12 contexts (Chromium limit: 16, reserve 4)
const MAX_WEBGL_CONTEXTS = 12
const webglRegistry = new Map<string, { addon: WebglAddon; terminal: Terminal }>()
const webglLru: string[] = [] // oldest first

function attachWebgl(terminalId: string, terminal: Terminal): void {
  // Already has WebGL
  if (webglRegistry.has(terminalId)) {
    touchWebglLru(terminalId)
    return
  }

  // Evict oldest if at limit
  while (webglLru.length >= MAX_WEBGL_CONTEXTS) {
    const evictId = webglLru.shift()!
    const entry = webglRegistry.get(evictId)
    if (entry) {
      try { entry.addon.dispose() } catch { /* already disposed */ }
      webglRegistry.delete(evictId)
    }
  }

  try {
    const addon = new WebglAddon()
    addon.onContextLoss(() => {
      try { addon.dispose() } catch { /* noop */ }
      webglRegistry.delete(terminalId)
      const idx = webglLru.indexOf(terminalId)
      if (idx !== -1) webglLru.splice(idx, 1)
    })
    terminal.loadAddon(addon)
    webglRegistry.set(terminalId, { addon, terminal })
    webglLru.push(terminalId)
  } catch {
    // WebGL not available — fall back to DOM renderer silently
  }
}

function touchWebglLru(terminalId: string): void {
  const idx = webglLru.indexOf(terminalId)
  if (idx !== -1) {
    webglLru.splice(idx, 1)
    webglLru.push(terminalId)
  }
}

function detachWebgl(terminalId: string): void {
  const entry = webglRegistry.get(terminalId)
  if (entry) {
    try { entry.addon.dispose() } catch { /* noop */ }
    webglRegistry.delete(terminalId)
  }
  const idx = webglLru.indexOf(terminalId)
  if (idx !== -1) webglLru.splice(idx, 1)
}

interface TerminalPanelProps {
  terminalId: string
  isActive: boolean
  onCycleTab?: (direction: 1 | -1) => void
}

export const TerminalPanel = memo(function TerminalPanel({
  terminalId, isActive, onCycleTab
}: TerminalPanelProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const terminalRef = useRef<Terminal | null>(null)
  const fitAddonRef = useRef<FitAddon | null>(null)
  const isActiveRef = useRef(isActive)
  const doResizeRef = useRef<(() => void) | null>(null)
  const onCycleTabRef = useRef(onCycleTab)
  useEffect(() => { onCycleTabRef.current = onCycleTab }, [onCycleTab])

  useEffect(() => { isActiveRef.current = isActive }, [isActive])

  // 主 effect: 建立 xterm 實例
  useEffect(() => {
    if (!containerRef.current) return

    const terminal = new Terminal({
      theme: {
        background: '#1e1e1e',
        foreground: '#cccccc',
        cursor: '#cccccc',
        cursorAccent: '#1e1e1e',
        selectionBackground: '#264f78',
        black: '#3b3228',
        red: '#cb6077',
        green: '#beb55b',
        yellow: '#f4bc87',
        blue: '#8ab3b5',
        magenta: '#a89bb9',
        cyan: '#7bbda4',
        white: '#d0c8c6',
        brightBlack: '#554d46',
        brightRed: '#cb6077',
        brightGreen: '#beb55b',
        brightYellow: '#f4bc87',
        brightBlue: '#8ab3b5',
        brightMagenta: '#a89bb9',
        brightCyan: '#7bbda4',
        brightWhite: '#f5f1e6'
      },
      fontSize: 14,
      fontFamily: "'Menlo', 'Monaco', 'Courier New', monospace",
      cursorBlink: false, // 統一不閃，降低 idle CPU
      scrollback: 10000,
      convertEol: true,
      allowProposedApi: true,
    })

    const fitAddon = new FitAddon()
    const unicode11Addon = new Unicode11Addon()
    const webLinksAddon = new WebLinksAddon((_event, uri) => {
      window.electronAPI.shell.openExternal(uri)
    })

    terminal.loadAddon(fitAddon)
    terminal.loadAddon(webLinksAddon)
    terminal.open(containerRef.current)
    terminal.loadAddon(unicode11Addon)
    terminal.unicode.activeVersion = '11'

    // WebGL renderer — LRU managed, auto-fallback to DOM
    attachWebgl(terminalId, terminal)

    terminalRef.current = terminal
    fitAddonRef.current = fitAddon

    // Deduplicated resize — 只在容器實際尺寸改變時才 fit()，防止 write 引起的微小變化觸發
    let lastCols = 0, lastRows = 0
    let lastContainerW = 0, lastContainerH = 0
    const doResize = () => {
      if (!containerRef.current) return
      const cw = containerRef.current.clientWidth
      const ch = containerRef.current.clientHeight
      // 容器尺寸未變 → 跳過，隔絕 write 引起的無關 ResizeObserver 事件
      if (cw === lastContainerW && ch === lastContainerH) return
      lastContainerW = cw
      lastContainerH = ch

      fitAddon.fit()

      const { cols, rows } = terminal
      if (cols !== lastCols || rows !== lastRows) {
        lastCols = cols; lastRows = rows
        window.electronAPI.pty.resize(terminalId, cols, rows)
      }

      // fit() 後保持 scroll 狀態
      if (autoScroll) {
        terminal.scrollToBottom()
      }
    }
    doResizeRef.current = doResize

    // Terminal input → PTY (user typing = intent to see latest output)
    terminal.onData((data) => {
      autoScroll = true
      window.electronAPI.pty.write(terminalId, data)
    })

    // 自訂快捷鍵
    terminal.attachCustomKeyEventHandler((event) => {
      if (event.type !== 'keydown') return true
      // Ctrl+Tab / Ctrl+Shift+Tab → 切換 terminal tab
      if (event.ctrlKey && event.key === 'Tab') {
        event.preventDefault()
        const vp = containerRef.current?.querySelector('.xterm-viewport') as HTMLElement | null
        const buf = terminalRef.current?.buffer.active
        console.log('[ctrl+tab] BEFORE:', {
          scrollTop: vp?.scrollTop,
          scrollHeight: vp?.scrollHeight,
          clientHeight: vp?.clientHeight,
          ybase: buf?.baseY,
          ydisp: buf?.viewportY,
          display: containerRef.current?.parentElement?.style.display,
          offsetParent: !!vp?.offsetParent
        })
        onCycleTabRef.current?.(event.shiftKey ? -1 : 1)
        setTimeout(() => {
          const vp2 = containerRef.current?.querySelector('.xterm-viewport') as HTMLElement | null
          const buf2 = terminalRef.current?.buffer.active
          console.log('[ctrl+tab] AFTER 100ms:', {
            scrollTop: vp2?.scrollTop,
            scrollHeight: vp2?.scrollHeight,
            clientHeight: vp2?.clientHeight,
            ybase: buf2?.baseY,
            ydisp: buf2?.viewportY,
            display: containerRef.current?.parentElement?.style.display,
            offsetParent: !!vp2?.offsetParent
          })
        }, 100)
        return false
      }
      // Shift+Enter → 送 ESC+CR（等同 Option+Enter），讓 Claude CLI 換行
      if (event.shiftKey && event.key === 'Enter') {
        event.preventDefault()
        window.electronAPI.pty.write(terminalId, '\x1b\r')
        return false
      }
      // Cmd+C with selection → copy
      if (event.metaKey && event.key === 'c') {
        const sel = terminal.getSelection()
        if (sel) { navigator.clipboard.writeText(sel); return false }
        return true // no selection → pass through as Ctrl+C
      }
      // Cmd+V → paste
      if (event.metaKey && event.key === 'v') {
        event.preventDefault()
        navigator.clipboard.readText().then(text => {
          if (text) {
            // 大量貼上分塊
            if (text.length > 4000) {
              let offset = 0
              const sendNext = () => {
                if (offset >= text.length) return
                const chunk = text.slice(offset, offset + 2000)
                offset += 2000
                window.electronAPI.pty.write(terminalId, chunk)
                setTimeout(sendNext, 30)
              }
              sendNext()
            } else {
              window.electronAPI.pty.write(terminalId, text)
            }
          }
        })
        return false
      }
      return true
    })

    // === Window focus gate ===
    // 視窗 blur 時暫停 rAF 排程（資料累積在 writeBuf），focus 時恢復
    // 避免 main process Gate-and-Buffer 的 buffer flush 重播 partial ANSI 導致跑版
    let windowFocused = document.hasFocus()
    const handleWindowBlur = () => { windowFocused = false }
    const handleWindowFocus = () => {
      windowFocused = true
      if (writeBuf.length > 0 && writeRaf === null) {
        writeRaf = requestAnimationFrame(flushWriteBuf)
      }
    }
    window.addEventListener('blur', handleWindowBlur)
    window.addEventListener('focus', handleWindowFocus)

    // === Auto-scroll tracking ===
    // Sticky flag: default to auto-scroll, only disable when user explicitly scrolls up
    let autoScroll = true
    containerRef.current.addEventListener('wheel', () => {
      requestAnimationFrame(() => {
        const buf = terminal.buffer.active
        autoScroll = buf.baseY - buf.viewportY <= 1
      })
    }, { passive: true })

    // === Write batching ===
    // Claude agent 每秒輸出數百小 chunk，逐一 write 會產生中間渲染狀態導致 viewport 跳動
    // 用 rAF 收集同一 frame 內所有 chunk，一次 write，減少 parse/render 次數
    //
    // Scroll 策略：write callback 內不直接 scrollToBottom()（會和 renderer 同 frame 競爭），
    // 改為設 flag，在下一個 rAF 開頭先 scroll 再 write，確保 scroll 和 write 不在同一渲染週期。
    let writeBuf = ''
    let writeRaf: number | null = null
    let scrollPending = false

    const flushWriteBuf = () => {
      writeRaf = null

      // 先處理上一幀的 scroll（此時前一次 write 的資料已完全 parse + render）
      if (scrollPending) {
        terminal.scrollToBottom()
        scrollPending = false
      }

      if (writeBuf.length === 0) return
      const data = writeBuf
      writeBuf = ''

      const isNormal = terminal.buffer.active.type === 'normal'

      terminal.write(data, () => {
        if (!isNormal) return
        if (autoScroll) {
          scrollPending = true
          // 確保下一幀會執行 scroll（即使沒有新資料）
          if (writeRaf === null) {
            writeRaf = requestAnimationFrame(flushWriteBuf)
          }
        }
      })
    }

    // PTY output → xterm（gate 開啟時的即時輸出）
    // scroll 在 flushWriteBuf 的 write callback 中管理
    // windowFocused === false 時僅累積到 writeBuf，不排程 rAF（省渲染）
    const unsubOutput = window.electronAPI.pty.onOutput((id, data) => {
      if (id !== terminalId) return
      writeBuf += data
      if (windowFocused && writeRaf === null) {
        writeRaf = requestAnimationFrame(flushWriteBuf)
      }
    })

    // Buffer flushed → xterm（activate 時一次補回）
    // 同樣用延遲 scroll 避免同 frame 競爭
    const unsubFlush = window.electronAPI.pty.onBufferFlushed((id, data) => {
      if (id !== terminalId) return
      if (writeRaf !== null) { cancelAnimationFrame(writeRaf); writeRaf = null }
      const pending = writeBuf; writeBuf = ''
      terminal.write(pending + data, () => {
        scrollPending = true
        if (writeRaf === null) {
          writeRaf = requestAnimationFrame(flushWriteBuf)
        }
      })
    })

    // PTY exit
    const unsubExit = window.electronAPI.pty.onExit((id, code) => {
      if (id === terminalId) {
        terminal.write(`\r\n\x1b[90m[Process exited with code ${code}]\x1b[0m\r\n`)
      }
    })

    // ResizeObserver（去抖 200ms，不 refresh 避免 scroll 跳動）
    let resizeTimer: ReturnType<typeof setTimeout> | null = null
    const resizeObserver = new ResizeObserver(() => {
      if (resizeTimer) clearTimeout(resizeTimer)
      resizeTimer = setTimeout(() => {
        resizeTimer = null
        if (!isActiveRef.current) return
        doResize()
      }, 200)
    })
    resizeObserver.observe(containerRef.current)

    // Initial resize (activate is handled by store since components stay mounted)
    if (isActiveRef.current) {
      setTimeout(() => doResize(), 100)
    }

    // 右鍵選單
    containerRef.current.addEventListener('contextmenu', (e) => {
      e.preventDefault()
      const sel = terminal.getSelection()
      if (sel) {
        navigator.clipboard.writeText(sel)
      } else {
        navigator.clipboard.readText().then(text => {
          if (text) window.electronAPI.pty.write(terminalId, text)
        })
      }
    })

    // 拖曳檔案 → 寫入路徑（Electron File 物件有 path 屬性）
    const el = containerRef.current
    const handleDragOver = (e: DragEvent) => {
      e.preventDefault()
      e.stopPropagation()
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
    }
    const handleDrop = (e: DragEvent) => {
      e.preventDefault()
      e.stopPropagation()
      const files = e.dataTransfer?.files
      if (!files || files.length === 0) return
      // 多檔空白分隔，路徑含空白時自動加引號
      const paths = Array.from(files).map(f => {
        const p = (f as File & { path?: string }).path || f.name
        return p.includes(' ') ? `'${p}'` : p
      })
      window.electronAPI.pty.write(terminalId, paths.join(' '))
    }
    el.addEventListener('dragover', handleDragOver)
    el.addEventListener('drop', handleDrop)

    return () => {
      window.removeEventListener('blur', handleWindowBlur)
      window.removeEventListener('focus', handleWindowFocus)
      el.removeEventListener('dragover', handleDragOver)
      el.removeEventListener('drop', handleDrop)
      unsubOutput()
      unsubFlush()
      unsubExit()
      if (writeRaf !== null) cancelAnimationFrame(writeRaf)
      if (resizeTimer) clearTimeout(resizeTimer)
      resizeObserver.disconnect()
      doResizeRef.current = null
      detachWebgl(terminalId)
      terminal.dispose()
    }
  }, [terminalId])

  // isActive 變化時：resize + focus + WebGL LRU touch
  useEffect(() => {
    if (isActive && terminalRef.current) {
      if (!webglRegistry.has(terminalId)) {
        attachWebgl(terminalId, terminalRef.current)
      } else {
        touchWebglLru(terminalId)
      }
      requestAnimationFrame(() => {
        doResizeRef.current?.()
        requestAnimationFrame(() => {
          terminalRef.current?.focus()
        })
      })
    }
  }, [isActive, terminalId])

  return <div ref={containerRef} className="terminal-panel" />
}, (prev, next) => prev.terminalId === next.terminalId && prev.isActive === next.isActive)
