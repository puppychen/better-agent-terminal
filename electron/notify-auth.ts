import { randomBytes, timingSafeEqual } from 'crypto'
import { mkdirSync, writeFileSync, unlinkSync, existsSync } from 'fs'
import { dirname } from 'path'

/**
 * Notify Token 認證管理
 *
 * 獨立於 WS server 的 token 系統。每次 NotifyServer 啟動時產生新 token，
 * 寫入純文字檔案（格式：`{port}:{token}`），供 hook script 用 bash split 讀取。
 * 檔案權限 0600（僅 owner 可讀）。
 */
export class NotifyAuth {
  private token: string = ''
  private port: number = 0

  constructor(private tokenPath: string) {}

  /** 產生新 token 並寫入檔案 */
  generate(port: number): void {
    this.token = randomBytes(32).toString('hex')
    this.port = port

    const dir = dirname(this.tokenPath)
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true, mode: 0o700 })
    }

    // 純文字格式 — hook script 用 bash 解析（無 jq 依賴）
    const payload = `${this.port}:${this.token}\n`
    writeFileSync(this.tokenPath, payload, { mode: 0o600 })
    console.log(`[notify-auth] Token written to ${this.tokenPath}`)
  }

  /** 驗證 Bearer token（constant-time 比對，防止 timing attack） */
  validate(bearer: string): boolean {
    if (this.token.length === 0 || bearer.length !== this.token.length) return false
    return timingSafeEqual(Buffer.from(bearer), Buffer.from(this.token))
  }

  getToken(): string {
    return this.token
  }

  getPort(): number {
    return this.port
  }

  /** App 關閉時清除 token 檔案 */
  dispose(): void {
    try {
      if (existsSync(this.tokenPath)) {
        unlinkSync(this.tokenPath)
        console.log('[notify-auth] Token file removed')
      }
    } catch { /* ignore cleanup errors */ }
    this.token = ''
  }
}
