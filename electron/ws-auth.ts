import { randomBytes, timingSafeEqual } from 'crypto'
import { mkdirSync, writeFileSync, unlinkSync, existsSync } from 'fs'
import { dirname } from 'path'

/**
 * WS Token 認證管理
 *
 * 每次 WS Server 啟動時產生新 token，寫入固定路徑供外部 Client 讀取。
 * 檔案權限 0600（僅 owner 可讀）。App 關閉時清除。
 */
export class WsAuth {
  private token: string = ''
  private port: number = 0

  constructor(private configPath: string) {}

  /** 產生新 token 並寫入檔案 */
  generate(port: number): void {
    this.token = randomBytes(32).toString('hex')
    this.port = port

    const dir = dirname(this.configPath)
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true, mode: 0o700 })
    }

    const payload = JSON.stringify({
      port: this.port,
      token: this.token,
      host: '127.0.0.1',
      createdAt: new Date().toISOString()
    }, null, 2)

    writeFileSync(this.configPath, payload, { mode: 0o600 })
    console.log(`[ws-auth] Token written to ${this.configPath}`)
  }

  /** 驗證 Bearer token（constant-time 比對，防止 timing attack） */
  validate(bearer: string): boolean {
    if (this.token.length === 0 || bearer.length !== this.token.length) return false
    return timingSafeEqual(Buffer.from(bearer), Buffer.from(this.token))
  }

  /** 供 UI 顯示/複製 */
  getToken(): string {
    return this.token
  }

  /** App 關閉時清除 token 檔案 */
  dispose(): void {
    try {
      if (existsSync(this.configPath)) {
        unlinkSync(this.configPath)
        console.log('[ws-auth] Token file removed')
      }
    } catch { /* ignore cleanup errors */ }
    this.token = ''
  }
}
