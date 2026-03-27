import WebSocket, { WebSocketServer } from 'ws'
import type { IncomingMessage } from 'http'
import { v4 as uuidv4 } from 'uuid'
import { WsAuth } from './ws-auth'
import { OutputProcessor } from './ws-output-processor'
import type { OutputContentType } from './ws-output-processor'
import type { PtyManager } from './pty-manager'
import type {
  WsServerConfig, ServerEvent, ClientCommand, SubscribeMode,
  SessionInfo, PermissionPrompt, PermissionResolution
} from './ws-types'

const PROTOCOL_VERSION = '0.1.0'
const HEARTBEAT_INTERVAL = 30_000   // 30s ping
const PONG_TIMEOUT = 10_000         // 10s pong deadline
const MAX_CLIENTS = 20
const MAX_MSG_PER_MIN = 60
const MAX_INPUT_PER_MIN = 20
const MAX_SUBSCRIPTIONS = 10
const MAX_INPUT_LENGTH = 10_000

interface WsClient {
  id: string
  type: string
  ws: WebSocket
  subscriptions: Map<string, SubscribeMode>  // sessionId → mode
  connectedAt: string
  lastPong: number
  msgCount: number
  inputCount: number
  msgResetTimer: ReturnType<typeof setInterval> | null
}

export class WsServer {
  private wss: WebSocketServer | null = null
  private auth: WsAuth
  private clients: Map<string, WsClient> = new Map()
  private outputProcessors: Map<string, OutputProcessor> = new Map()
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null

  constructor(
    private config: WsServerConfig,
    private ptyManager: PtyManager
  ) {
    this.auth = new WsAuth(config.tokenPath)
  }

  // === Lifecycle ===

  start(): void {
    if (this.wss) return

    this.auth.generate(this.config.port)

    this.wss = new WebSocketServer({
      host: this.config.host,
      port: this.config.port,
      maxPayload: 64 * 1024  // 64KB max message
    })

    this.wss.on('connection', (ws, req) => this.onConnection(ws, req))
    this.wss.on('error', (err) => {
      console.error('[ws-server] Server error:', err.message)
    })

    // Heartbeat: ping all clients every 30s
    this.heartbeatTimer = setInterval(() => this.checkHeartbeats(), HEARTBEAT_INTERVAL)

    console.log(`[ws-server] Listening on ${this.config.host}:${this.config.port}`)
  }

  stop(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
    }

    // Close all clients
    for (const [, client] of this.clients) {
      this.cleanupClient(client)
      client.ws.close(1001, 'Server shutting down')
    }
    this.clients.clear()

    // Dispose output processors
    for (const [, proc] of this.outputProcessors) proc.dispose()
    this.outputProcessors.clear()

    if (this.wss) {
      this.wss.close()
      this.wss = null
    }

    this.auth.dispose()
    console.log('[ws-server] Stopped')
  }

  isRunning(): boolean {
    return this.wss !== null
  }

  getPort(): number {
    return this.config.port
  }

  getToken(): string {
    return this.auth.getToken()
  }

  getClientCount(): number {
    return this.clients.size
  }

  // === PtyManager hooks ===

  broadcastOutput(sessionId: string, data: string): void {
    // Raw output → raw subscribers
    this.broadcastToSubscribers(sessionId, {
      type: 'session:output:raw',
      sessionId,
      data,
      timestamp: new Date().toISOString()
    }, 'raw')

    // Feed text output processor → text subscribers (debounced)
    this.outputProcessors.get(sessionId)?.feed(data)
  }

  broadcastTextOutput(sessionId: string, content: string, contentType: OutputContentType): void {
    this.broadcastToSubscribers(sessionId, {
      type: 'session:output:text',
      sessionId,
      content,
      contentType,
      timestamp: new Date().toISOString()
    }, 'text')
  }

  broadcastSessionList(): void {
    const sessions = this.ptyManager.getSessionList()
    const event: ServerEvent = {
      type: 'session:list',
      sessions,
      timestamp: new Date().toISOString()
    }
    // Broadcast to ALL connected clients (not subscription-based)
    for (const [, client] of this.clients) {
      this.sendToClient(client, event)
    }
  }

  broadcastExit(sessionId: string, code: number): void {
    // Status change: → stopped
    this.broadcastToSubscribers(sessionId, {
      type: 'session:status',
      sessionId,
      status: 'stopped',
      previousStatus: 'running',
      reason: `Process exited with code ${code}`,
      timestamp: new Date().toISOString()
    })

    // Also broadcast updated session list
    this.broadcastSessionList()
  }

  broadcastPermission(sessionId: string, permission: PermissionPrompt): void {
    this.broadcastToSubscribers(sessionId, {
      type: 'session:permission',
      sessionId,
      permission,
      timestamp: new Date().toISOString()
    })
  }

  broadcastPermissionResolved(sessionId: string, permission: PermissionResolution): void {
    this.broadcastToSubscribers(sessionId, {
      type: 'session:permission:resolved',
      sessionId,
      permission,
      timestamp: new Date().toISOString()
    })
  }

  // Notify renderer of client count changes
  private notifyClientChange(): void {
    const mainWindow = this.ptyManager.getMainWindow()
    if (mainWindow && !mainWindow.isDestroyed()) {
      try {
        mainWindow.webContents.send('ws:client-change', this.clients.size)
      } catch { /* window may be closing */ }
    }
  }

  // === Connection management ===

  private onConnection(ws: WebSocket, req: IncomingMessage): void {
    // Auth check
    const authHeader = req.headers['authorization'] || ''
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : ''

    if (!this.auth.validate(token)) {
      console.warn('[ws-server] Auth failed from', req.socket.remoteAddress)
      ws.close(4001, 'Authentication failed')
      return
    }

    if (this.clients.size >= MAX_CLIENTS) {
      ws.close(4002, 'Too many clients')
      return
    }

    // Build client
    // Client ID: 使用 header hint（限 UUID 格式），否則 server 產生
    const headerClientId = (req.headers['x-client-id'] as string) || ''
    const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
    const clientId = uuidPattern.test(headerClientId) ? headerClientId : uuidv4()
    const clientType = (req.headers['x-client-type'] as string)?.slice(0, 32) || 'unknown'

    // If same clientId reconnects, close old connection
    const existing = this.clients.get(clientId)
    if (existing) {
      this.cleanupClient(existing)
      existing.ws.close(4003, 'Replaced by new connection')
    }

    const client: WsClient = {
      id: clientId,
      type: clientType,
      ws,
      subscriptions: new Map(),
      connectedAt: new Date().toISOString(),
      lastPong: Date.now(),
      msgCount: 0,
      inputCount: 0,
      msgResetTimer: setInterval(() => {
        client.msgCount = 0
        client.inputCount = 0
      }, 60_000)
    }

    this.clients.set(clientId, client)
    console.log(`[ws-server] Client connected: ${clientId} (${clientType})`)

    // Send server:hello
    this.sendToClient(client, {
      type: 'server:hello',
      version: PROTOCOL_VERSION,
      serverName: 'better-agent-workspace',
      capabilities: ['output:raw', 'output:text', 'permission:interactive'],
      timestamp: new Date().toISOString()
    })

    // Wire up events
    ws.on('pong', () => { client.lastPong = Date.now() })

    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString())
        this.handleMessage(clientId, msg)
      } catch {
        this.sendToClient(client, {
          type: 'error',
          error: { code: 'INVALID_MESSAGE', message: 'Invalid JSON' },
          timestamp: new Date().toISOString()
        })
      }
    })

    ws.on('close', () => {
      this.cleanupClient(client)
      this.clients.delete(clientId)
      console.log(`[ws-server] Client disconnected: ${clientId}`)
      this.notifyClientChange()
    })

    ws.on('error', (err) => {
      console.error(`[ws-server] Client ${clientId} error:`, err.message)
    })

    this.notifyClientChange()
  }

  private cleanupClient(client: WsClient): void {
    if (client.msgResetTimer) {
      clearInterval(client.msgResetTimer)
      client.msgResetTimer = null
    }
    client.subscriptions.clear()
  }

  // === Heartbeat ===

  private checkHeartbeats(): void {
    const now = Date.now()
    // 先收集要移除的 clientId，避免迭代中修改 Map
    const toRemove: string[] = []
    for (const [clientId, client] of this.clients) {
      if (now - client.lastPong > HEARTBEAT_INTERVAL + PONG_TIMEOUT) {
        toRemove.push(clientId)
      } else {
        client.ws.ping()
      }
    }
    for (const clientId of toRemove) {
      const client = this.clients.get(clientId)
      if (!client) continue
      console.warn(`[ws-server] Client ${clientId} pong timeout, disconnecting`)
      client.ws.terminate()
      this.cleanupClient(client)
      this.clients.delete(clientId)
    }
    if (toRemove.length > 0) this.notifyClientChange()
  }

  // === Message routing ===

  private handleMessage(clientId: string, msg: ClientCommand): void {
    const client = this.clients.get(clientId)
    if (!client) return

    // Rate limit
    client.msgCount++
    if (client.msgCount > MAX_MSG_PER_MIN) {
      this.sendToClient(client, {
        type: 'error',
        id: (msg as any).id,
        error: { code: 'RATE_LIMITED', message: 'Too many messages' },
        timestamp: new Date().toISOString()
      })
      return
    }

    switch (msg.type) {
      case 'session:list:request':
        this.handleSessionList(client, msg.id)
        break
      case 'session:subscribe':
        this.handleSubscribe(client, msg)
        break
      case 'session:unsubscribe':
        this.handleUnsubscribe(client, msg)
        break
      case 'session:input':
        this.handleInput(client, msg)
        break
      case 'session:status:request':
        this.handleStatusRequest(client, msg)
        break
      case 'permission:approve':
        this.handlePermissionResolve(client, msg, 'approved')
        break
      case 'permission:deny':
        this.handlePermissionResolve(client, msg, 'denied')
        break
      default:
        this.sendToClient(client, {
          type: 'error',
          id: (msg as any).id,
          error: { code: 'INVALID_MESSAGE', message: `Unknown type: ${(msg as any).type}` },
          timestamp: new Date().toISOString()
        })
    }
  }

  private handleSessionList(client: WsClient, reqId: string): void {
    const sessions = this.ptyManager.getSessionList()
    this.sendToClient(client, {
      type: 'session:list',
      id: reqId,
      sessions,
      timestamp: new Date().toISOString()
    })
  }

  private handleSubscribe(client: WsClient, msg: ClientCommand & { type: 'session:subscribe' }): void {
    const { id: reqId, sessionId, mode } = msg

    // Validate mode
    if (mode !== 'raw' && mode !== 'text' && mode !== 'events_only') {
      this.sendToClient(client, {
        type: 'error',
        id: reqId,
        error: { code: 'INVALID_MESSAGE', message: `Unsupported mode: ${mode}. Use "raw", "text", or "events_only".` },
        timestamp: new Date().toISOString()
      })
      return
    }

    // Check subscription limit
    if (client.subscriptions.size >= MAX_SUBSCRIPTIONS && !client.subscriptions.has(sessionId)) {
      this.sendToClient(client, {
        type: 'error',
        id: reqId,
        error: { code: 'SUBSCRIBE_FAILED', message: `Max ${MAX_SUBSCRIPTIONS} subscriptions per client` },
        timestamp: new Date().toISOString()
      })
      return
    }

    // Verify session exists
    if (!this.ptyManager.hasSession(sessionId)) {
      this.sendToClient(client, {
        type: 'error',
        id: reqId,
        error: { code: 'SESSION_NOT_FOUND', message: `Session ${sessionId} does not exist` },
        timestamp: new Date().toISOString()
      })
      return
    }

    client.subscriptions.set(sessionId, mode)

    // text 模式 → 確保有 OutputProcessor
    if (mode === 'text') {
      this.ensureOutputProcessor(sessionId)
    }

    this.sendToClient(client, {
      type: 'session:subscribe:ack' as any,
      id: reqId,
      success: true,
      sessionId,
      mode,
      timestamp: new Date().toISOString()
    })
  }

  private handleUnsubscribe(client: WsClient, msg: ClientCommand & { type: 'session:unsubscribe' }): void {
    client.subscriptions.delete(msg.sessionId)
    this.maybeDisposeOutputProcessor(msg.sessionId)

    this.sendToClient(client, {
      type: 'session:unsubscribe:ack' as any,
      id: msg.id,
      success: true,
      sessionId: msg.sessionId,
      timestamp: new Date().toISOString()
    })
  }

  private handleInput(client: WsClient, msg: ClientCommand & { type: 'session:input' }): void {
    const { id: reqId, sessionId, data, source } = msg

    // Rate limit for input
    client.inputCount++
    if (client.inputCount > MAX_INPUT_PER_MIN) {
      this.sendToClient(client, {
        type: 'error',
        id: reqId,
        error: { code: 'RATE_LIMITED', message: 'Too many input commands' },
        timestamp: new Date().toISOString()
      })
      return
    }

    // Length limit
    if (data.length > MAX_INPUT_LENGTH) {
      this.sendToClient(client, {
        type: 'error',
        id: reqId,
        error: { code: 'INVALID_MESSAGE', message: `Input exceeds ${MAX_INPUT_LENGTH} chars` },
        timestamp: new Date().toISOString()
      })
      return
    }

    const result = this.ptyManager.writeFromRemote(sessionId, data)

    // Ack
    this.sendToClient(client, {
      type: 'session:input:ack' as any,
      id: reqId,
      success: result.success,
      bytesWritten: result.bytesWritten,
      ...(result.error ? { error: { code: result.error, message: `Session ${sessionId}: ${result.error}` } } : {}),
      timestamp: new Date().toISOString()
    })

    // Echo to all subscribers
    if (result.success) {
      this.broadcastToSubscribers(sessionId, {
        type: 'session:input:echo',
        sessionId,
        data,
        sourceClientId: client.id,
        sourceClientType: source?.clientType || client.type,
        timestamp: new Date().toISOString()
      })
    }
  }

  private handleStatusRequest(client: WsClient, msg: ClientCommand & { type: 'session:status:request' }): void {
    const sessions = this.ptyManager.getSessionList()
    const session = sessions.find(s => s.sessionId === msg.sessionId)

    if (!session) {
      this.sendToClient(client, {
        type: 'error',
        id: msg.id,
        error: { code: 'SESSION_NOT_FOUND', message: `Session ${msg.sessionId} does not exist` },
        timestamp: new Date().toISOString()
      })
      return
    }

    // Query response: previousStatus 未知時省略（與 push event 區別）
    this.sendToClient(client, {
      type: 'session:status',
      id: msg.id,
      sessionId: session.sessionId,
      status: session.status,
      timestamp: new Date().toISOString()
    })
  }

  private handlePermissionResolve(
    client: WsClient,
    msg: PermissionApproveCommand | PermissionDenyCommand,
    resolution: 'approved' | 'denied'
  ): void {
    const reqId = msg.id
    const sessionId = msg.sessionId
    const promptId = msg.promptId

    const detector = this.ptyManager.getPermissionDetector(sessionId)
    if (!detector) {
      this.sendToClient(client, {
        type: 'error',
        id: reqId,
        error: { code: 'SESSION_NOT_FOUND', message: `Session ${sessionId} not found or no detector` },
        timestamp: new Date().toISOString()
      })
      return
    }

    const result = detector.resolveRemote(promptId, resolution, client.id)
    if (result.success) {
      // Write to pty stdin
      // 新版 Claude Code 用數字選項：1=Yes, 3=No（node-pty 用 \r 當 Enter）
      this.ptyManager.writeFromRemote(sessionId, resolution === 'approved' ? '1\r' : '3\r')
    }

    const ackType = resolution === 'approved' ? 'permission:approve:ack' : 'permission:deny:ack'
    this.sendToClient(client, {
      type: ackType as any,
      id: reqId,
      success: result.success,
      promptId,
      ...(result.error ? { error: { code: result.error, message: result.message || '' } } : {}),
      timestamp: new Date().toISOString()
    })
  }

  // === Broadcast helpers ===

  private sendToClient(client: WsClient, event: ServerEvent | Record<string, any>): void {
    if (client.ws.readyState === WebSocket.OPEN) {
      try {
        client.ws.send(JSON.stringify(event))
      } catch { /* client may be disconnecting */ }
    }
  }

  /**
   * Broadcast event to all clients subscribed to the given session.
   * @param modeFilter If provided, only send to clients with this subscribe mode.
   *                   Permission/status events go to all subscribers regardless.
   */
  private broadcastToSubscribers(
    sessionId: string,
    event: ServerEvent,
    modeFilter?: SubscribeMode
  ): void {
    for (const [, client] of this.clients) {
      const subMode = client.subscriptions.get(sessionId)
      if (!subMode) continue

      // 有 modeFilter → 嚴格匹配；無 modeFilter（permission/status）→ 所有訂閱者
      if (modeFilter && subMode !== modeFilter) continue

      this.sendToClient(client, event)
    }
  }

  // === OutputProcessor lifecycle ===

  private ensureOutputProcessor(sessionId: string): void {
    if (this.outputProcessors.has(sessionId)) return
    const processor = new OutputProcessor(sessionId, (chunk) => {
      this.broadcastTextOutput(sessionId, chunk.content, chunk.contentType)
    })
    this.outputProcessors.set(sessionId, processor)
  }

  private maybeDisposeOutputProcessor(sessionId: string): void {
    // 檢查是否還有 text 訂閱者
    for (const [, client] of this.clients) {
      if (client.subscriptions.get(sessionId) === 'text') return
    }
    this.outputProcessors.get(sessionId)?.dispose()
    this.outputProcessors.delete(sessionId)
  }
}

// Re-export for convenience
import type { PermissionApproveCommand, PermissionDenyCommand } from './ws-types'
