import fs from 'fs'
import path from 'path'
import os from 'os'

const SUPPORTED_INDEX_VERSION = 1

export interface ClaudeSessionEntry {
  sessionId: string
  fullPath: string
  fileMtime: number
  firstPrompt: string
  summary?: string
  messageCount: number
  created: string
  modified: string
  gitBranch?: string
  projectPath: string
  isSidechain: boolean
}

interface SessionsIndex {
  version: number
  entries: ClaudeSessionEntry[]
}

export type ListResult =
  | { ok: true; entries: ClaudeSessionEntry[] }
  | { ok: false; error: 'NO_INDEX' | 'PARSE_ERROR' | 'UNSUPPORTED_VERSION'; message?: string }

export type DeleteResult =
  | { ok: true }
  | { ok: false; error: 'NO_INDEX' | 'UNSUPPORTED_VERSION' | 'NOT_FOUND' | 'IO_ERROR'; message?: string }

/** 把 cwd 轉成 ~/.claude/projects/ 下的目錄名（/ → -） */
export function encodeProjectDir(cwd: string): string {
  return cwd.replace(/\//g, '-')
}

export function getProjectDir(cwd: string): string {
  return path.join(os.homedir(), '.claude', 'projects', encodeProjectDir(cwd))
}

export function getIndexPath(cwd: string): string {
  return path.join(getProjectDir(cwd), 'sessions-index.json')
}

function readIndex(cwd: string): SessionsIndex | { error: ListResult['error']; message?: string } {
  const indexPath = getIndexPath(cwd)
  if (!fs.existsSync(indexPath)) return { error: 'NO_INDEX' as const }
  try {
    const raw = fs.readFileSync(indexPath, 'utf-8')
    const parsed = JSON.parse(raw) as SessionsIndex
    if (parsed.version !== SUPPORTED_INDEX_VERSION) {
      return { error: 'UNSUPPORTED_VERSION' as const, message: `Expected v${SUPPORTED_INDEX_VERSION}, got v${parsed.version}` }
    }
    return parsed
  } catch (e: any) {
    return { error: 'PARSE_ERROR' as const, message: e?.message }
  }
}

/** 列出 cwd 對應的所有非 sidechain session，按 modified 倒序 */
export function listSessions(cwd: string): ListResult {
  const result = readIndex(cwd)
  if ('error' in result) return { ok: false, error: result.error, message: result.message }

  const entries = result.entries
    .filter(e => !e.isSidechain)
    .sort((a, b) => new Date(b.modified).getTime() - new Date(a.modified).getTime())

  return { ok: true, entries }
}

/** 三步驟刪除：jsonl 檔 + index entry + subagent 子目錄 */
export function deleteSession(cwd: string, sessionId: string): DeleteResult {
  const result = readIndex(cwd)
  if ('error' in result) {
    if (result.error === 'NO_INDEX') return { ok: false, error: 'NO_INDEX' }
    if (result.error === 'UNSUPPORTED_VERSION') return { ok: false, error: 'UNSUPPORTED_VERSION', message: result.message }
    return { ok: false, error: 'IO_ERROR', message: result.message }
  }

  const entry = result.entries.find(e => e.sessionId === sessionId)
  if (!entry) return { ok: false, error: 'NOT_FOUND' }

  const projectDir = getProjectDir(cwd)
  const jsonlPath = entry.fullPath || path.join(projectDir, `${sessionId}.jsonl`)
  const subagentDir = path.join(projectDir, sessionId)
  const indexPath = getIndexPath(cwd)

  try {
    if (fs.existsSync(jsonlPath)) fs.unlinkSync(jsonlPath)
    if (fs.existsSync(subagentDir)) fs.rmSync(subagentDir, { recursive: true, force: true })

    const updated: SessionsIndex = {
      version: result.version,
      entries: result.entries.filter(e => e.sessionId !== sessionId)
    }
    fs.writeFileSync(indexPath, JSON.stringify(updated, null, 2))

    return { ok: true }
  } catch (e: any) {
    return { ok: false, error: 'IO_ERROR', message: e?.message }
  }
}

/** 監聽 cwd 對應的 sessions-index.json 變動。回傳 dispose 函式。 */
export function watchSessions(cwd: string, onChange: () => void): () => void {
  const projectDir = getProjectDir(cwd)
  const indexPath = getIndexPath(cwd)

  // 確保目錄存在才能 watch；不存在時用 setInterval 輪詢直到出現
  let watcher: fs.FSWatcher | null = null
  let pollTimer: NodeJS.Timeout | null = null
  let disposed = false

  const startWatch = () => {
    if (disposed) return
    try {
      watcher = fs.watch(projectDir, (_eventType, filename) => {
        // macOS fsevents 在 rename / 壓縮事件時 filename 可能為 null；放寬條件確保不漏觸發
        if (!filename || filename === 'sessions-index.json') onChange()
      })
    } catch {
      // ignore — 目錄可能剛好被刪除，下次 poll 會重試
    }
  }

  if (fs.existsSync(projectDir)) {
    startWatch()
  } else {
    pollTimer = setInterval(() => {
      if (disposed) return
      if (fs.existsSync(projectDir)) {
        if (pollTimer) { clearInterval(pollTimer); pollTimer = null }
        startWatch()
        if (fs.existsSync(indexPath)) onChange()
      }
    }, 1000)
  }

  return () => {
    disposed = true
    if (watcher) { try { watcher.close() } catch { /* ignore */ } watcher = null }
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null }
  }
}
