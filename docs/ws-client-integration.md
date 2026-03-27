# WebSocket Client Integration Guide

> **Protocol Version**: 0.1.0
> **Server**: Better Agent Workspace (Electron)
> **Target**: Telegram Bot 及其他外部 Client

---

## 1. 連線前置作業

### 1.1 啟用 WS Server

Desktop App 的 WS Server **預設關閉**，需手動啟用：

1. 開啟 Better Agent Workspace
2. 點擊 Sidebar 底部 **Settings**
3. 開啟 **WebSocket Server** toggle
4. 記下顯示的 port 和 token

### 1.2 Token 檔案

啟用後，Server 會將連線資訊寫入：

```
~/.claude/better-agent/ws-auth.json
```

格式：

```json
{
  "port": 19836,
  "token": "a1b2c3d4e5f6...（64 hex chars）",
  "host": "127.0.0.1",
  "createdAt": "2026-03-21T10:00:00.000Z"
}
```

- 權限 `0600`，僅 owner 可讀
- 每次 Server 啟動重新產生 token
- Server 關閉時自動刪除此檔案

**Telegram Bot 啟動流程**：讀取此檔案 → 取得 port + token → 建立 WS 連線。

---

## 2. 連線建立

### 2.1 WebSocket Handshake

```
GET ws://localhost:{port}
Headers:
  Authorization: Bearer {token}
  X-Client-Id: {uuid}           # 可選，限 UUID 格式，否則 Server 自動產生
  X-Client-Type: telegram        # 識別 Client 類型
```

### 2.2 連線成功

Server 回傳 `server:hello`：

```json
{
  "type": "server:hello",
  "version": "0.1.0",
  "serverName": "better-agent-workspace",
  "capabilities": ["output:raw", "permission:interactive"],
  "timestamp": "2026-03-21T10:00:01.000Z"
}
```

### 2.3 認證失敗

Server 以 WebSocket close code `4001` 關閉連線。

### 2.4 Node.js 連線範例

```typescript
import WebSocket from 'ws'
import { readFileSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'

// 讀取 token
const authPath = join(homedir(), '.claude', 'better-agent', 'ws-auth.json')
const { port, token } = JSON.parse(readFileSync(authPath, 'utf-8'))

// 建立連線
const ws = new WebSocket(`ws://localhost:${port}`, {
  headers: {
    'Authorization': `Bearer ${token}`,
    'X-Client-Type': 'telegram'
  }
})

ws.on('open', () => console.log('Connected'))
ws.on('message', (raw) => {
  const msg = JSON.parse(raw.toString())
  console.log(msg.type, msg)
})
ws.on('close', (code, reason) => {
  console.log(`Disconnected: ${code} ${reason}`)
})
```

---

## 3. 心跳

```
Server 每 30 秒送 WebSocket ping frame
Client 必須在 10 秒內回 pong（ws library 自動處理）
超時 → Server 主動斷開
```

大多數 WebSocket library（如 `ws`）會自動回覆 pong，不需額外處理。

---

## 4. 重連策略

Client 斷線後應自動重連：

```
間隔: 1s → 2s → 4s → 8s → 16s → 30s（上限）
重連後: 重新認證 + 重新 subscribe
Server 不保留離線期間的訊息
```

```typescript
let retryDelay = 1000
function reconnect() {
  setTimeout(() => {
    connect()
    retryDelay = Math.min(retryDelay * 2, 30000)
  }, retryDelay)
}
// 連線成功後 reset
ws.on('open', () => { retryDelay = 1000 })
ws.on('close', reconnect)
```

---

## 5. Client → Server 指令

所有指令為 JSON，透過 `ws.send(JSON.stringify(msg))` 發送。

### 5.1 查詢 Session 列表

```json
{
  "type": "session:list:request",
  "id": "req-001"
}
```

回傳：

```json
{
  "type": "session:list",
  "id": "req-001",
  "sessions": [
    {
      "sessionId": "uuid-1",
      "projectName": "my-project",
      "projectPath": "/Users/x/my-project",
      "type": "agent",
      "label": "my-project [agent]",
      "status": "running",
      "startedAt": "2026-03-21T09:00:00.000Z",
      "pid": 12345,
      "metadata": { "type": "agent" }
    },
    {
      "sessionId": "uuid-2",
      "projectName": "my-project",
      "projectPath": "/Users/x/my-project",
      "type": "shell",
      "label": "my-project [shell]",
      "status": "running",
      "startedAt": "2026-03-21T09:05:00.000Z",
      "pid": 12346,
      "metadata": { "type": "shell" }
    }
  ],
  "timestamp": "..."
}
```

**Session 辨識**：
- `type`：`agent`（Claude Code）或 `shell`，用來區分同專案的不同 terminal
- `label`：可直接顯示的名稱，格式 `{projectName} [{type}]`
- `projectPath` / `projectName`：對應 Telegram chat 路由表
- 同一個專案可能有多個 session（例如 1 agent + 1 shell），用 `type` 或 `sessionId` 區分

### 5.2 訂閱 Session

```json
{
  "type": "session:subscribe",
  "id": "req-002",
  "sessionId": "uuid-1",
  "mode": "raw"
}
```

**模式**：

| mode | 收到的事件 | 適用場景 |
|------|-----------|---------|
| `raw` | `session:output:raw` + `session:permission` + `session:status` | 需要完整 terminal 輸出 |
| `events_only` | `session:permission` + `session:status` | 只需通知，不要 output |

訂閱成功回傳 `session:subscribe:ack`。

### 5.3 取消訂閱

```json
{
  "type": "session:unsubscribe",
  "id": "req-003",
  "sessionId": "uuid-1"
}
```

### 5.4 發送指令到 Session

```json
{
  "type": "session:input",
  "id": "req-004",
  "sessionId": "uuid-1",
  "data": "help me refactor the auth module\n",
  "source": {
    "clientType": "telegram",
    "userId": "jake",
    "displayName": "@jake"
  }
}
```

- `data` 會原樣寫入 pty stdin（含 `\n` 換行）
- 上限 10,000 字元
- 成功回傳 `session:input:ack`
- 所有訂閱者會收到 `session:input:echo`

### 5.5 核准/拒絕 Permission

```json
{
  "type": "permission:approve",
  "id": "req-005",
  "sessionId": "uuid-1",
  "promptId": "perm-xxx"
}
```

```json
{
  "type": "permission:deny",
  "id": "req-006",
  "sessionId": "uuid-1",
  "promptId": "perm-xxx"
}
```

### 5.6 查詢 Session 狀態

```json
{
  "type": "session:status:request",
  "id": "req-007",
  "sessionId": "uuid-1"
}
```

---

## 6. Server → Client 事件

訂閱後 Server 會主動推送以下事件。

### 6.1 Raw Output

```json
{
  "type": "session:output:raw",
  "sessionId": "uuid-1",
  "data": "\u001b[1;32m✓\u001b[0m All tests passed\r\n",
  "timestamp": "..."
}
```

**注意**：`data` 包含 raw ANSI escape codes。Client 需自行 strip ANSI 再顯示。

推薦套件：`strip-ansi`（Node.js）

### 6.2 Session 列表變化

Terminal 新增/關閉時自動推送：

```json
{
  "type": "session:list",
  "sessions": [ ... ],
  "timestamp": "..."
}
```

### 6.3 Session 狀態變化

```json
{
  "type": "session:status",
  "sessionId": "uuid-1",
  "status": "stopped",
  "previousStatus": "running",
  "reason": "Process exited with code 0",
  "timestamp": "..."
}
```

### 6.4 Permission Prompt

Claude Code 要求核准操作時推送：

```json
{
  "type": "session:permission",
  "sessionId": "uuid-1",
  "permission": {
    "promptId": "perm-20260321-001",
    "description": "Edit file: src/auth/login.ts",
    "tool": "Write",
    "filePath": "src/auth/login.ts",
    "riskLevel": "medium",
    "detectedAt": "2026-03-21T09:00:20.456Z",
    "detectedBy": "pty_parser"
  },
  "timestamp": "..."
}
```

**riskLevel**：

| Level | 觸發條件 |
|-------|---------|
| `low` | Read, search, analysis |
| `medium` | Write, Edit, npm install |
| `high` | Bash, delete, git push, deploy |

### 6.5 Permission 解決通知

不論從本地或遠端核准，所有訂閱者都收到：

```json
{
  "type": "session:permission:resolved",
  "sessionId": "uuid-1",
  "permission": {
    "promptId": "perm-20260321-001",
    "resolution": "approved",
    "resolvedBy": "remote",
    "resolvedByClientId": "telegram-bot-1",
    "resolvedAt": "2026-03-21T09:00:25.789Z"
  },
  "timestamp": "..."
}
```

`resolvedBy: "local"` 表示使用者在 Desktop App 的 xterm 中直接按了 y/n。

### 6.6 Input Echo

其他 Client 送入指令時通知：

```json
{
  "type": "session:input:echo",
  "sessionId": "uuid-1",
  "data": "npm test\n",
  "sourceClientId": "telegram-bot-1",
  "sourceClientType": "telegram",
  "timestamp": "..."
}
```

### 6.7 Error

```json
{
  "type": "error",
  "id": "req-004",
  "error": {
    "code": "SESSION_NOT_FOUND",
    "message": "Session uuid-xyz does not exist"
  },
  "timestamp": "..."
}
```

**錯誤碼**：

| Code | 說明 |
|------|------|
| `AUTH_FAILED` | 認證失敗（通常直接 close 4001） |
| `SESSION_NOT_FOUND` | sessionId 不存在 |
| `SESSION_STOPPED` | Session 已結束 |
| `PERMISSION_NOT_FOUND` | promptId 不存在 |
| `PERMISSION_ALREADY_RESOLVED` | Permission 已被處理 |
| `PTY_WRITE_ERROR` | 寫入 pty stdin 失敗 |
| `SUBSCRIBE_FAILED` | 訂閱失敗（超過上限） |
| `INVALID_MESSAGE` | 訊息格式錯誤 |
| `RATE_LIMITED` | 發送過於頻繁 |

---

## 7. 速率限制

| 限制 | 值 |
|------|-----|
| 每分鐘訊息數 | 60 msg/min per client |
| session:input 頻率 | 20 msg/min per session |
| 同時訂閱數 | 10 sessions per client |
| input 長度上限 | 10,000 字元 |
| 最大連線數 | 20 clients |

---

## 8. Telegram Bot 整合範例

### 8.1 完整流程

```
1. Bot 啟動 → 讀取 ws-auth.json → 連線 WS
2. Bot 收到 server:hello → 發送 session:list:request
3. 用 projectPath 匹配路由表 → 決定哪個 session 對應哪個 Telegram chat
4. 對匹配的 session 發送 session:subscribe (mode: raw)
5. 收到 session:output:raw → strip ANSI → 發送到對應 Telegram chat
6. 收到 session:permission → 發送 inline keyboard 到 Telegram chat
7. 使用者按下 Approve → 發送 permission:approve
8. Telegram chat 收到使用者訊息 → 發送 session:input
```

### 8.2 路由表設計建議

```typescript
// Telegram chat_id → project 匹配
const routes = [
  { chatId: -100111, pattern: 'my-project*' },
  { chatId: -100222, pattern: 'other-project*' },
]

function findRoute(projectName: string): number | null {
  const route = routes.find(r =>
    minimatch(projectName, r.pattern)
  )
  return route?.chatId ?? null
}
```

### 8.3 Output 處理建議

Server 送出的是 raw pty output（含 ANSI），Telegram 需要：

1. **Strip ANSI**：`strip-ansi` 套件
2. **Debounce**：Claude agent 每秒輸出數百個小 chunk，建議累積 500ms-1s 再發送
3. **長度截斷**：Telegram 訊息上限 4096 字元，超長需分段或摘要
4. **洪水控制**：設定每分鐘最大訊息數（建議 15-20），超過時 buffer + 摘要

```typescript
import stripAnsi from 'strip-ansi'

let outputBuffer = ''
let flushTimer: NodeJS.Timeout | null = null

function handleOutput(data: string) {
  outputBuffer += stripAnsi(data)

  if (!flushTimer) {
    flushTimer = setTimeout(() => {
      if (outputBuffer.length > 0) {
        sendToTelegram(outputBuffer.slice(0, 4000))
        outputBuffer = ''
      }
      flushTimer = null
    }, 800)
  }
}
```

### 8.4 Permission Inline Keyboard

```typescript
function handlePermission(sessionId: string, perm: PermissionPrompt, chatId: number) {
  const riskIcon = { low: '\u{1F7E2}', medium: '\u{1F7E1}', high: '\u{1F534}' }
  bot.sendMessage(chatId, [
    `\u{1F510} Permission Request`,
    `Tool: ${perm.tool || 'unknown'}`,
    perm.description,
    perm.filePath ? `File: ${perm.filePath}` : '',
    `Risk: ${riskIcon[perm.riskLevel]} ${perm.riskLevel}`
  ].filter(Boolean).join('\n'), {
    reply_markup: {
      inline_keyboard: [[
        { text: '\u2705 Approve', callback_data: `approve:${sessionId}:${perm.promptId}` },
        { text: '\u274C Deny', callback_data: `deny:${sessionId}:${perm.promptId}` }
      ]]
    }
  })
}

// callback handler
bot.on('callback_query', (query) => {
  const [action, sessionId, promptId] = query.data.split(':')
  ws.send(JSON.stringify({
    type: action === 'approve' ? 'permission:approve' : 'permission:deny',
    id: `perm-${Date.now()}`,
    sessionId,
    promptId
  }))
})
```

---

## 9. 連線狀態檢測

```typescript
// 檢查 ws-auth.json 是否存在 = Server 是否開啟
import { existsSync } from 'fs'

function isServerAvailable(): boolean {
  return existsSync(join(homedir(), '.claude', 'better-agent', 'ws-auth.json'))
}
```

若檔案不存在，表示 Server 未啟用或 App 未開啟，Bot 應等待檔案出現再嘗試連線。

---

## 10. TypeScript 型別

完整型別定義見 `electron/ws-types.ts`，可直接複製到 Bot 專案使用。

核心型別：

```typescript
type SessionStatus = 'running' | 'idle' | 'waiting_permission' | 'stopped' | 'error'
type SubscribeMode = 'raw' | 'events_only'
type RiskLevel = 'low' | 'medium' | 'high'

interface SessionInfo {
  sessionId: string
  projectName: string      // path.basename(cwd)
  projectPath: string      // 完整工作目錄路徑
  type: 'shell' | 'agent'  // terminal 類型
  label: string            // 顯示名稱，如 "my-project [agent]"
  status: SessionStatus
  startedAt: string        // ISO 8601
  pid: number
  metadata?: Record<string, string>
}
```
