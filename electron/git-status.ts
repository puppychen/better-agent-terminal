import { execFile } from 'child_process'
import { promisify } from 'util'

const execFileAsync = promisify(execFile)

export type GitFileStatus = 'modified' | 'staged' | 'untracked' | 'deleted' | 'unmerged'

export type GitFileStatusResult =
  | { ok: true; statuses: Record<string, GitFileStatus> }
  | { ok: false; error: 'NOT_GIT_REPO' | 'GIT_NOT_FOUND' | 'TIMEOUT' | 'TOO_LARGE' | 'IO_ERROR'; message?: string }

/**
 * 將 `git status --porcelain=v1` 的兩字元 XY 碼轉為單一語意分類。
 * X = index (staged) status, Y = worktree (unstaged) status
 */
function decodeStatus(xy: string): GitFileStatus | null {
  if (xy.length < 2) return null
  const x = xy[0]
  const y = xy[1]
  if (x === 'U' || y === 'U' || (x === 'D' && y === 'D') || (x === 'A' && y === 'A')) return 'unmerged'
  if (xy === '??') return 'untracked'
  if (x === 'D' || y === 'D') return 'deleted'
  // 有 unstaged 變動 → modified；否則純 staged
  if (y !== ' ' && y !== '?') return 'modified'
  if (x !== ' ' && x !== '?') return 'staged'
  return null
}

export async function getFileStatuses(workspaceCwd: string): Promise<GitFileStatusResult> {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['status', '--porcelain=v1', '-z'],
      {
        cwd: workspaceCwd,
        timeout: 5000,
        maxBuffer: 2 * 1024 * 1024,
        encoding: 'utf-8'
      }
    )
    // -z 模式：每筆以 NUL 分隔，rename 為「new\0old」兩段，但格式仍是 "XY filename"
    const statuses: Record<string, GitFileStatus> = {}
    const items = stdout.split('\0')
    for (let i = 0; i < items.length; i++) {
      const item = items[i]
      if (!item || item.length < 4) continue
      const xy = item.slice(0, 2)
      const space = item[2]
      if (space !== ' ') continue
      const name = item.slice(3)
      const status = decodeStatus(xy)
      if (status) statuses[name] = status
      // R / C 變動會多一個跟隨 entry 表示原檔名，跳過
      if (xy[0] === 'R' || xy[0] === 'C') i++
    }
    return { ok: true, statuses }
  } catch (e: any) {
    const msg: string = e?.message ?? ''
    if (e?.code === 'ENOENT') return { ok: false, error: 'GIT_NOT_FOUND', message: msg }
    if (e?.killed && e?.signal === 'SIGTERM') return { ok: false, error: 'TIMEOUT', message: msg }
    if (msg.includes('maxBuffer')) return { ok: false, error: 'TOO_LARGE', message: msg }
    if (msg.includes('not a git repository')) return { ok: true, statuses: {} }
    return { ok: false, error: 'IO_ERROR', message: msg }
  }
}
