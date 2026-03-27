import type { PermissionPrompt, PermissionResolution, RiskLevel } from './ws-types'

// strip-ansi v6 CJS
const stripAnsi = require('strip-ansi') as (text: string) => string

/**
 * Permission Prompt 偵測器
 *
 * 從 PTY 輸出中偵測 Claude Code 的 permission prompt，
 * 透過 pattern match + silence confirmation 雙重確認。
 *
 * 每次偵測到新 prompt 時清空 buffer，確保 description 是當次的內容。
 */
export class PermissionDetector {
  pending: PermissionPrompt | null = null

  // 只保留「最近一次 pattern match 之後」的文字
  private recentText: string = ''
  private candidateMatch: {
    tool?: string
    description: string
    riskLevel: RiskLevel
    matchedAt: number         // Date.now() — 偵測到的時間
  } | null = null

  private silenceTimer: ReturnType<typeof setTimeout> | null = null
  private expiryTimer: ReturnType<typeof setTimeout> | null = null
  private promptCounter: number = 0

  private static readonly MAX_RECENT = 1024         // 保留最近 1KB
  private static readonly SILENCE_CONFIRM_MS = 1500  // 1.5s 靜默確認
  private static readonly PROMPT_EXPIRY_MS = 120_000 // 2min 逾時

  // Claude Code permission prompt patterns（新版格式）
  // 格式：
  //   <Tool> <type>
  //     <command/content>
  //     <description>
  //   Do you want to proceed?
  //   ❯ 1. Yes  2. Yes, and don't ask again...  3. No
  private static readonly TOOL_NAMES = 'Bash|Read|Write|Edit|MultiEdit|Glob|Grep|WebFetch|WebSearch|TodoRead|TodoWrite|NotebookEdit|Execute|Agent'

  private static readonly PATTERNS: Array<{
    regex: RegExp
    extractTool: (m: RegExpMatchArray, ctx: string) => string | undefined
    extractDesc: (m: RegExpMatchArray, ctx: string) => string
  }> = [
    {
      // 主要 pattern：「Do you want to proceed?」+ 前面有 tool 名稱
      regex: /Do you want to proceed\?/,
      extractTool: (_m, ctx) => {
        // 從 context 中回溯找 tool 名稱（如 "Bash command"、"Write file"、"Edit file"）
        const toolMatch = new RegExp(`(${PermissionDetector.TOOL_NAMES})\\s+(?:command|file|files|query|search|request|tool)`, 'i').exec(ctx)
        return toolMatch ? toolMatch[1] : undefined
      },
      extractDesc: (_m, ctx) => {
        // 取 "Do you want to proceed?" 前面的內容（最多 500 字元）作為描述
        const idx = ctx.lastIndexOf('Do you want to proceed?')
        if (idx < 0) return 'Permission requested'
        // 找 tool 行到 "Do you want to proceed?" 之間的內容
        const before = ctx.slice(Math.max(0, idx - 500), idx).trim()
        const lines = before.split('\n').filter(l => l.trim())
        // 取最後幾行（指令內容 + 描述），最多 300 字元
        const desc = lines.slice(-6).join('\n').trim()
        return desc.length > 300 ? desc.slice(-300) : desc || 'Permission requested'
      }
    },
    {
      // 備用 pattern：numbered menu 「1. Yes」
      regex: /[❯>]\s*1\.\s*Yes\b/,
      extractTool: (_m, ctx) => {
        const toolMatch = new RegExp(`(${PermissionDetector.TOOL_NAMES})\\s+(?:command|file|files|query|search|request|tool)`, 'i').exec(ctx)
        return toolMatch ? toolMatch[1] : undefined
      },
      extractDesc: (_m, ctx) => {
        const lines = ctx.split('\n').filter(l => l.trim())
        const desc = lines.slice(-8).join('\n').trim()
        return desc.length > 300 ? desc.slice(-300) : desc || 'Permission requested'
      }
    }
  ]

  constructor(
    private sessionId: string,
    private onDetected: (perm: PermissionPrompt) => void,
    private onResolved: (res: PermissionResolution) => void
  ) {}

  /** 接收 raw PTY output → strip ANSI → 偵測 permission patterns */
  feedOutput(rawData: string): void {
    const stripped = stripAnsi(rawData)
      .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
      .replace(/\r/g, '')

    if (!stripped.trim()) return

    // 累積最近文字（上限 1KB，從前端截斷）
    this.recentText += stripped
    if (this.recentText.length > PermissionDetector.MAX_RECENT) {
      this.recentText = this.recentText.slice(-PermissionDetector.MAX_RECENT)
    }

    // 有輸出 → 重置 silence timer
    if (this.candidateMatch) {
      this.resetSilenceTimer()
    }

    // 已有 pending prompt → 不偵測新的
    if (this.pending) return

    // Pattern matching — 只在沒有 candidate 時偵測
    // 取最後一個 match（TUI 重繪會在 buffer 前段留下舊 prompt 殘影）
    if (!this.candidateMatch) {
      for (const pattern of PermissionDetector.PATTERNS) {
        const allMatches = [...this.recentText.matchAll(new RegExp(pattern.regex.source, 'g'))]
        const match = allMatches.length > 0 ? allMatches[allMatches.length - 1] : null
        if (match) {
          const tool = pattern.extractTool(match, this.recentText)
          const desc = pattern.extractDesc(match, this.recentText)
          this.candidateMatch = {
            tool,
            description: desc,
            riskLevel: this.classifyRisk(tool),
            matchedAt: Date.now()
          }
          // 清空 buffer 避免下次重複 match 同一段
          this.recentText = ''
          this.startSilenceTimer()
          break
        }
      }
    }
  }

  /** 接收本地 stdin 寫入 → 偵測核准/拒絕 */
  feedStdin(data: string): void {
    if (!this.pending) return
    const trimmed = data.trim().toLowerCase()
    // 新版 Claude Code 用數字選項：1=Yes, 2=Yes+don't ask, 3=No
    // 舊版用 y/n
    if (trimmed === '1' || trimmed === '2' || trimmed === 'y' || trimmed === 'yes') {
      this.resolveLocal('approved')
    } else if (trimmed === '3' || trimmed === 'n' || trimmed === 'no') {
      this.resolveLocal('denied')
    }
  }

  /** WS Client 遠端核准/拒絕 */
  resolveRemote(
    promptId: string,
    resolution: 'approved' | 'denied',
    clientId: string
  ): { success: boolean; error?: string; message?: string } {
    if (!this.pending) {
      return { success: false, error: 'PERMISSION_NOT_FOUND', message: 'No pending permission' }
    }
    if (this.pending.promptId !== promptId) {
      return { success: false, error: 'PERMISSION_NOT_FOUND', message: `Prompt ${promptId} not found` }
    }

    const resolved: PermissionResolution = {
      promptId,
      resolution,
      resolvedBy: 'remote',
      resolvedByClientId: clientId,
      resolvedAt: new Date().toISOString()
    }

    this.clearAll()
    this.onResolved(resolved)
    return { success: true }
  }

  getPending(): PermissionPrompt | null {
    return this.pending
  }

  dispose(): void {
    this.clearAll()
  }

  // === Internal ===

  private resolveLocal(resolution: 'approved' | 'denied'): void {
    if (!this.pending) return
    const resolved: PermissionResolution = {
      promptId: this.pending.promptId,
      resolution,
      resolvedBy: 'local',
      resolvedAt: new Date().toISOString()
    }
    this.clearAll()
    this.onResolved(resolved)
  }

  private startSilenceTimer(): void {
    this.clearSilenceTimer()
    this.silenceTimer = setTimeout(() => {
      this.confirmPermission()
    }, PermissionDetector.SILENCE_CONFIRM_MS)
  }

  private resetSilenceTimer(): void {
    this.startSilenceTimer()
  }

  private confirmPermission(): void {
    if (!this.candidateMatch || this.pending) return

    this.promptCounter++
    const promptId = `perm-${this.sessionId.slice(0, 8)}-${Date.now()}-${this.promptCounter}`

    this.pending = {
      promptId,
      description: this.candidateMatch.description,
      tool: this.candidateMatch.tool,
      riskLevel: this.candidateMatch.riskLevel,
      detectedAt: new Date().toISOString(),
      detectedBy: 'pty_parser'
    }

    this.candidateMatch = null
    this.recentText = ''

    // 120s 逾時
    this.expiryTimer = setTimeout(() => {
      if (this.pending) {
        console.warn(`[ws-perm] Permission ${this.pending.promptId} expired`)
        this.clearAll()
      }
    }, PermissionDetector.PROMPT_EXPIRY_MS)

    this.onDetected(this.pending)
  }

  /** 清除所有狀態（解決、逾時、dispose 時呼叫） */
  private clearAll(): void {
    this.pending = null
    this.candidateMatch = null
    this.recentText = ''
    this.clearTimers()
  }

  private clearTimers(): void {
    if (this.silenceTimer) { clearTimeout(this.silenceTimer); this.silenceTimer = null }
    if (this.expiryTimer) { clearTimeout(this.expiryTimer); this.expiryTimer = null }
  }

  private clearSilenceTimer(): void {
    if (this.silenceTimer) { clearTimeout(this.silenceTimer); this.silenceTimer = null }
  }

  private classifyRisk(tool?: string): RiskLevel {
    if (!tool) return 'medium'
    const high = ['Bash', 'Execute']
    const low = ['Read', 'Glob', 'Grep', 'LS', 'TodoRead', 'WebSearch']
    if (high.includes(tool)) return 'high'
    if (low.includes(tool)) return 'low'
    return 'medium'
  }
}
