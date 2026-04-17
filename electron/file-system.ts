import fs from 'fs'
import path from 'path'

/**
 * 安全地將 workspace 內的相對路徑解析為絕對路徑，並驗證未越界。
 * 任何指向 workspace folder 之外的路徑都會回傳 null。
 */
function safeResolve(workspaceCwd: string, relativePath: string): string | null {
  const root = path.resolve(workspaceCwd)
  const resolved = path.resolve(root, relativePath)
  if (resolved === root) return resolved
  const rel = path.relative(root, resolved)
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null
  return resolved
}

export interface DirEntry {
  name: string
  isDirectory: boolean
  isSymlink: boolean
}

export type ListDirResult =
  | { ok: true; entries: DirEntry[] }
  | { ok: false; error: 'OUT_OF_SCOPE' | 'NOT_FOUND' | 'NOT_DIRECTORY' | 'IO_ERROR'; message?: string }

export type ReadFileResult =
  | { ok: true; content: string; mtime: number; size: number }
  | { ok: false; error: 'OUT_OF_SCOPE' | 'NOT_FOUND' | 'NOT_FILE' | 'TOO_LARGE' | 'BINARY' | 'IO_ERROR'; message?: string }

export type StatResult =
  | { ok: true; mtime: number; size: number; isDirectory: boolean }
  | { ok: false; error: 'OUT_OF_SCOPE' | 'NOT_FOUND' | 'IO_ERROR'; message?: string }

const MAX_FILE_SIZE = 5 * 1024 * 1024  // 5MB 上限，避免讀大檔
const BINARY_PROBE_BYTES = 512          // 取前 512 byte 偵測二進位

/** 簡單的 binary 偵測：檢查前 N byte 是否含 NUL */
function looksBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, BINARY_PROBE_BYTES)
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true
  return false
}

export function listDir(workspaceCwd: string, relativePath: string): ListDirResult {
  const target = safeResolve(workspaceCwd, relativePath)
  if (!target) return { ok: false, error: 'OUT_OF_SCOPE' }
  try {
    const stat = fs.statSync(target)
    if (!stat.isDirectory()) return { ok: false, error: 'NOT_DIRECTORY' }
    const items = fs.readdirSync(target, { withFileTypes: true })
    const entries: DirEntry[] = items
      .map(item => ({
        name: item.name,
        isDirectory: item.isDirectory(),
        isSymlink: item.isSymbolicLink()
      }))
      .sort((a, b) => {
        if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1
        return a.name.localeCompare(b.name)
      })
    return { ok: true, entries }
  } catch (e: any) {
    if (e?.code === 'ENOENT') return { ok: false, error: 'NOT_FOUND' }
    return { ok: false, error: 'IO_ERROR', message: e?.message }
  }
}

export function readFile(workspaceCwd: string, relativePath: string): ReadFileResult {
  const target = safeResolve(workspaceCwd, relativePath)
  if (!target) return { ok: false, error: 'OUT_OF_SCOPE' }
  try {
    const stat = fs.statSync(target)
    if (!stat.isFile()) return { ok: false, error: 'NOT_FILE' }
    if (stat.size > MAX_FILE_SIZE) return { ok: false, error: 'TOO_LARGE' }
    const buf = fs.readFileSync(target)
    if (looksBinary(buf)) return { ok: false, error: 'BINARY' }
    return { ok: true, content: buf.toString('utf-8'), mtime: stat.mtimeMs, size: stat.size }
  } catch (e: any) {
    if (e?.code === 'ENOENT') return { ok: false, error: 'NOT_FOUND' }
    return { ok: false, error: 'IO_ERROR', message: e?.message }
  }
}

export function stat(workspaceCwd: string, relativePath: string): StatResult {
  const target = safeResolve(workspaceCwd, relativePath)
  if (!target) return { ok: false, error: 'OUT_OF_SCOPE' }
  try {
    const s = fs.statSync(target)
    return { ok: true, mtime: s.mtimeMs, size: s.size, isDirectory: s.isDirectory() }
  } catch (e: any) {
    if (e?.code === 'ENOENT') return { ok: false, error: 'NOT_FOUND' }
    return { ok: false, error: 'IO_ERROR', message: e?.message }
  }
}
