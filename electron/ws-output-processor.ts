/**
 * Output Processor — 從 TUI raw output 萃取可讀文字
 *
 * Claude Code CLI 是 TUI 應用（ink/React-CLI），PTY output 充滿游標定位和清行序列。
 * TUI 每秒重繪多次，strip ANSI 後每次重繪的文字大部分相同。
 *
 * 策略：
 * 1. 累積 raw output，用較長的 debounce（1.5s 靜默）等 TUI 重繪穩定
 * 2. Flush 時 strip ANSI，與上次送出的內容比對去重
 * 3. 只有「新內容」才送出
 */

// strip-ansi v6 是 CJS，可直接 require
const stripAnsi = require('strip-ansi') as (text: string) => string

export type OutputContentType = 'text' | 'code' | 'mixed' | 'status'

export interface TextChunk {
  content: string
  contentType: OutputContentType
  timestamp: string
}

interface OutputProcessorConfig {
  debounceMs: number       // 靜默多久後 flush（預設 1500ms）
  maxRawBuffer: number     // raw buffer 上限，超過截斷舊資料（不觸發 flush）
}

const DEFAULT_CONFIG: OutputProcessorConfig = {
  debounceMs: 1500,
  maxRawBuffer: 32768       // 32KB raw buffer
}

export class OutputProcessor {
  private rawBuffer: string = ''           // 累積 raw output
  private debounceTimer: ReturnType<typeof setTimeout> | null = null
  private lastSentContent: string = ''     // 上次送出的文字（去重用）
  private config: OutputProcessorConfig

  constructor(
    private sessionId: string,
    private onChunk: (chunk: TextChunk) => void,
    config?: Partial<OutputProcessorConfig>
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config }
  }

  /** 接收 raw PTY output，累積 + debounce */
  feed(rawData: string): void {
    this.rawBuffer += rawData

    // Buffer 過大時截斷前段（保留最新內容），但不觸發 flush
    if (this.rawBuffer.length > this.config.maxRawBuffer) {
      this.rawBuffer = this.rawBuffer.slice(-this.config.maxRawBuffer)
    }

    // Reset debounce — 每次有新 output 就重新計時
    if (this.debounceTimer) clearTimeout(this.debounceTimer)
    this.debounceTimer = setTimeout(() => this.flush(), this.config.debounceMs)
  }

  /** 靜默期到 → strip + 去重 + 送出 */
  flush(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer)
      this.debounceTimer = null
    }

    if (!this.rawBuffer) return

    const raw = this.rawBuffer
    this.rawBuffer = ''

    // Strip ANSI + 清理
    const cleaned = this.stripAndClean(raw)
    if (!cleaned) return

    // 去重：與上次送出的內容比對，只送出新增部分
    const newContent = this.extractNewContent(cleaned)
    if (!newContent) return

    this.lastSentContent = cleaned

    this.onChunk({
      content: newContent,
      contentType: this.classifyContent(newContent),
      timestamp: new Date().toISOString()
    })
  }

  dispose(): void {
    this.flush()
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer)
      this.debounceTimer = null
    }
  }

  /**
   * 比對新舊內容，萃取真正新增的部分。
   * TUI 重繪時整個畫面會重送，但只有尾部是新內容。
   */
  private extractNewContent(current: string): string {
    if (!this.lastSentContent) return current

    // 找上次內容在新內容中的位置
    // TUI 重繪後，舊內容可能出現在新內容的前半段
    const lastLines = this.lastSentContent.split('\n')
    const currentLines = current.split('\n')

    // 策略：從新內容尾部往前找，看有多少行是上次已經送過的
    // 用最後 N 行做指紋比對
    const fingerprint = lastLines.slice(-5).join('\n').trim()
    if (!fingerprint) return current

    const idx = current.lastIndexOf(fingerprint)
    if (idx >= 0) {
      const after = current.slice(idx + fingerprint.length).trim()
      return after || ''
    }

    // 若完全找不到舊內容（場景完全切換），送出全部
    // 但如果新舊相似度 >80% 就跳過（同一個 TUI frame 的重複渲染）
    if (this.similarity(this.lastSentContent, current) > 0.8) {
      return ''
    }

    return current
  }

  /** 簡單相似度：共同行數 / 總行數 */
  private similarity(a: string, b: string): number {
    const aLines = new Set(a.split('\n').map(l => l.trim()).filter(Boolean))
    const bLines = b.split('\n').map(l => l.trim()).filter(Boolean)
    if (aLines.size === 0 || bLines.length === 0) return 0
    let common = 0
    for (const line of bLines) {
      if (aLines.has(line)) common++
    }
    return common / Math.max(aLines.size, bLines.length)
  }

  /**
   * Strip ANSI + 清理 TUI 殘留
   */
  private stripAndClean(raw: string): string {
    let text = stripAnsi(raw)

    // 處理 \r 覆寫：每行只保留最後一個 \r 後的內容
    text = text.split('\n').map(line => {
      const parts = line.split('\r')
      return parts[parts.length - 1]
    }).join('\n')

    // 移除控制字元（保留 \n \t）
    text = text.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')

    // 壓縮 3+ 連續空行為 2 行
    text = text.replace(/\n{3,}/g, '\n\n')

    // 移除前後空白
    text = text.trim()

    // 過濾太短的雜訊（<10 字元的 TUI 殘片）
    if (text.length < 10) return ''

    return text
  }

  // Claude Code TUI 暫態狀態 patterns（Thinking、Reading、spinner 等）
  private static readonly STATUS_PATTERNS = [
    /^[\s⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏⣾⣽⣻⢿⡿⣟⣯⣷●○◐◑◒◓\|\/\-\\]*$/,   // 純 spinner 字元
    /^\s*(Thinking|Reading|Writing|Searching|Analyzing|Planning|Processing|Executing|Running|Loading|Compiling|Building|Generating|Streaming|Waiting)/i,
    /^\s*(\.{2,}|…)\s*$/,                             // 純省略號
    /^\s*\d+(\.\d+)?%\s*$/,                            // 純百分比
    /^\s*\d+\/\d+\s*$/,                                // 進度 n/m
  ]

  /**
   * 判斷是否為暫態狀態文字（Thinking...、spinner、進度等）
   * 條件：3 行以內且匹配 status patterns
   */
  private isTransientStatus(text: string): boolean {
    const lines = text.split('\n').filter(l => l.trim().length > 0)
    if (lines.length === 0 || lines.length > 3) return false
    return lines.every(line =>
      OutputProcessor.STATUS_PATTERNS.some(p => p.test(line.trim()))
    )
  }

  /**
   * 分類內容類型
   */
  private classifyContent(text: string): OutputContentType {
    // 先檢查是否為暫態狀態
    if (this.isTransientStatus(text)) return 'status'

    const lines = text.split('\n').filter(l => l.trim().length > 0)
    if (lines.length === 0) return 'text'

    let codeLines = 0
    let inCodeFence = false

    for (const line of lines) {
      const trimmed = line.trim()

      if (trimmed.startsWith('```')) {
        inCodeFence = !inCodeFence
        codeLines++
        continue
      }

      if (inCodeFence) {
        codeLines++
        continue
      }

      // Diff patterns
      if (/^[+-]\s/.test(trimmed) || /^@@\s/.test(trimmed)) {
        codeLines++
        continue
      }

      // Indented code (4+ spaces or tab)
      if (/^(\s{4,}|\t)/.test(line) && !trimmed.startsWith('-') && !trimmed.startsWith('*')) {
        codeLines++
      }
    }

    const codeRatio = codeLines / lines.length
    if (codeRatio > 0.5) return 'code'
    if (codeRatio < 0.2) return 'text'
    return 'mixed'
  }
}
