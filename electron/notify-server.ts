import { createServer, Server, IncomingMessage, ServerResponse } from 'http'
import { NotifyAuth } from './notify-auth'

export interface NotifyConfig {
  enabled: boolean
  port: number
  tokenPath: string
}

export interface NotifyEvent {
  cwd: string
  event: 'stop' | 'wait'
  /** Claude/Codex session UUID（hook 從 stdin JSON 解析的 session_id；舊版 hook 可能為空） */
  sessionId?: string
  agentType?: 'claude' | 'codex'
  meta?: { tool?: string; description?: string }
}

const MAX_BODY_SIZE = 4096          // 4KB body 上限
const RATE_LIMIT_WINDOW = 1000      // 1 秒
const RATE_LIMIT_MAX = 10           // 1 秒最多 10 次

/**
 * 通知 HTTP Server
 *
 * 監聽 127.0.0.1:{port}，唯一 endpoint POST /notify。
 * Hook script 透過 curl 觸發，server 驗證 token 後呼叫 onNotify callback。
 * 完全獨立於 WS Server。
 */
export class NotifyServer {
  private server: Server | null = null
  private auth: NotifyAuth
  private requestTimes: number[] = []  // 速率限制 sliding window

  constructor(
    private config: NotifyConfig,
    private onNotify: (event: NotifyEvent) => void
  ) {
    this.auth = new NotifyAuth(config.tokenPath)
  }

  start(): void {
    if (this.server) return

    this.auth.generate(this.config.port)

    this.server = createServer((req, res) => this.handleRequest(req, res))
    this.server.on('error', (err) => {
      console.error('[notify-server] Server error:', err.message)
    })
    this.server.listen(this.config.port, '127.0.0.1', () => {
      console.log(`[notify-server] Listening on 127.0.0.1:${this.config.port}`)
    })
  }

  stop(): void {
    if (this.server) {
      this.server.close()
      this.server = null
    }
    this.auth.dispose()
    this.requestTimes = []
    console.log('[notify-server] Stopped')
  }

  isRunning(): boolean {
    return this.server !== null
  }

  getPort(): number {
    return this.config.port
  }

  getToken(): string {
    return this.auth.getToken()
  }

  // === Internal ===

  private handleRequest(req: IncomingMessage, res: ServerResponse): void {
    // 速率限制
    const now = Date.now()
    this.requestTimes = this.requestTimes.filter(t => now - t < RATE_LIMIT_WINDOW)
    if (this.requestTimes.length >= RATE_LIMIT_MAX) {
      this.respond(res, 429, 'Too Many Requests')
      return
    }
    this.requestTimes.push(now)

    // 只接受 POST /notify
    if (req.method !== 'POST' || req.url !== '/notify') {
      this.respond(res, 404, 'Not Found')
      return
    }

    // 認證
    const authHeader = req.headers['authorization'] || ''
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : ''
    if (!this.auth.validate(token)) {
      this.respond(res, 401, 'Unauthorized')
      return
    }

    // 讀 body（有 size 上限）
    let body = ''
    let aborted = false
    req.on('data', (chunk: Buffer) => {
      if (aborted) return
      body += chunk.toString('utf-8')
      if (body.length > MAX_BODY_SIZE) {
        aborted = true
        this.respond(res, 413, 'Payload Too Large')
        req.destroy()
      }
    })
    req.on('end', () => {
      if (aborted) return
      try {
        const parsed = JSON.parse(body)
        if (typeof parsed.cwd !== 'string' || typeof parsed.event !== 'string') {
          this.respond(res, 400, 'Invalid payload')
          return
        }
        if (parsed.event !== 'stop' && parsed.event !== 'wait') {
          this.respond(res, 400, 'Invalid event type')
          return
        }
        const event: NotifyEvent = {
          cwd: parsed.cwd,
          event: parsed.event,
          sessionId: typeof parsed.sessionId === 'string' && parsed.sessionId.length > 0 ? parsed.sessionId : undefined,
          agentType: parsed.agentType === 'claude' || parsed.agentType === 'codex' ? parsed.agentType : undefined,
          meta: parsed.meta && typeof parsed.meta === 'object' ? parsed.meta : undefined
        }
        try {
          this.onNotify(event)
        } catch (e) {
          console.error('[notify-server] onNotify callback error:', e)
        }
        this.respond(res, 200, 'OK')
      } catch {
        this.respond(res, 400, 'Invalid JSON')
      }
    })
  }

  private respond(res: ServerResponse, status: number, message: string): void {
    res.writeHead(status, { 'Content-Type': 'text/plain' })
    res.end(message)
  }
}
