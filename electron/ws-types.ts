/**
 * WebSocket Session Manager — Protocol Types
 * Based on ws-protocol-spec.md v0.1.0-draft
 *
 * Desktop App 只送 raw output + permission 事件。
 * 結構化處理（ANSI 剝離、chunk 分類）由各 Client 自行負責。
 */

// ===================================================================
// Server → Client Events
// ===================================================================

export type ServerEvent =
  | ServerHelloEvent
  | SessionListEvent
  | SessionStatusEvent
  | SessionOutputRawEvent
  | SessionOutputTextEvent
  | SessionPermissionEvent
  | SessionPermissionResolvedEvent
  | SessionInputEchoEvent
  | ErrorEvent

export interface ServerHelloEvent {
  type: 'server:hello'
  version: string
  serverName: string
  capabilities: string[]
  timestamp: string
}

export interface SessionListEvent {
  type: 'session:list'
  id?: string
  sessions: SessionInfo[]
  timestamp: string
}

export interface SessionStatusEvent {
  type: 'session:status'
  id?: string
  sessionId: string
  status: SessionStatus
  previousStatus?: SessionStatus    // Query response 時省略；push event 時提供
  reason?: string
  timestamp: string
}

export interface SessionOutputRawEvent {
  type: 'session:output:raw'
  sessionId: string
  data: string
  timestamp: string
}

export interface SessionOutputTextEvent {
  type: 'session:output:text'
  sessionId: string
  content: string                           // 乾淨文字，無 ANSI
  contentType: 'text' | 'code' | 'mixed' | 'status'
  timestamp: string
}

export interface SessionPermissionEvent {
  type: 'session:permission'
  sessionId: string
  permission: PermissionPrompt
  timestamp: string
}

export interface SessionPermissionResolvedEvent {
  type: 'session:permission:resolved'
  sessionId: string
  permission: PermissionResolution
  timestamp: string
}

export interface SessionInputEchoEvent {
  type: 'session:input:echo'
  sessionId: string
  data: string
  sourceClientId: string
  sourceClientType: string
  timestamp: string
}

export interface ErrorEvent {
  type: 'error'
  id?: string
  error: ErrorPayload
  timestamp: string
}

// ===================================================================
// Client → Server Commands
// ===================================================================

export type ClientCommand =
  | SessionListRequestCommand
  | SessionSubscribeCommand
  | SessionUnsubscribeCommand
  | SessionInputCommand
  | SessionStatusRequestCommand
  | PermissionApproveCommand
  | PermissionDenyCommand

export interface SessionListRequestCommand {
  type: 'session:list:request'
  id: string
}

export interface SessionSubscribeCommand {
  type: 'session:subscribe'
  id: string
  sessionId: string
  mode: SubscribeMode
}

export interface SessionUnsubscribeCommand {
  type: 'session:unsubscribe'
  id: string
  sessionId: string
}

export interface SessionInputCommand {
  type: 'session:input'
  id: string
  sessionId: string
  data: string
  source?: InputSource
}

export interface SessionStatusRequestCommand {
  type: 'session:status:request'
  id: string
  sessionId: string
}

export interface PermissionApproveCommand {
  type: 'permission:approve'
  id: string
  sessionId: string
  promptId: string
}

export interface PermissionDenyCommand {
  type: 'permission:deny'
  id: string
  sessionId: string
  promptId: string
}

// ===================================================================
// Shared Types
// ===================================================================

export type SessionStatus = 'running' | 'idle' | 'waiting_permission' | 'stopped' | 'error'
export type SubscribeMode = 'raw' | 'text' | 'events_only'
export type RiskLevel = 'low' | 'medium' | 'high'

export interface SessionInfo {
  sessionId: string
  projectName: string
  projectPath: string
  type: 'shell' | 'agent'       // terminal 類型
  label: string                  // 可辨識的顯示名稱，如 "my-project [agent]"
  status: SessionStatus
  startedAt: string
  pid: number
  metadata?: Record<string, string>
}

export interface PermissionPrompt {
  promptId: string
  description: string
  command?: string
  tool?: string
  filePath?: string
  riskLevel: RiskLevel
  detectedAt: string
  detectedBy: 'pty_parser' | 'hook' | 'both'
}

export interface PermissionResolution {
  promptId: string
  resolution: 'approved' | 'denied'
  resolvedBy: 'local' | 'remote'
  resolvedByClientId?: string
  resolvedAt: string
}

export interface InputSource {
  clientType: string
  userId: string
  displayName?: string
}

export interface ErrorPayload {
  code: string
  message: string
  details?: Record<string, unknown>
}

// ===================================================================
// Config
// ===================================================================

export interface WsServerConfig {
  enabled: boolean       // 預設 false（關閉），需手動啟用
  port: number           // 預設 19836
  host: string           // 預設 '127.0.0.1'，可設 '0.0.0.0' 對外
  tokenPath: string      // ~/.claude/better-agent/ws-auth.json
}

export interface WsStatusInfo {
  running: boolean
  port: number | null
  token: string | null
  clientCount: number
  host: string
}
