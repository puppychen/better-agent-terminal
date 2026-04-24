import { execFile } from 'child_process'
import { promisify } from 'util'
import fs from 'fs'
import path from 'path'

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
  if (y !== ' ' && y !== '?') return 'modified'
  if (x !== ' ' && x !== '?') return 'staged'
  return null
}

const STATUS_ARGS = ['status', '--porcelain=v1', '-z', '--untracked-files=all']
const EXEC_OPTS = { timeout: 5000, maxBuffer: 2 * 1024 * 1024, encoding: 'utf-8' as const }

/**
 * 解析 porcelain -z 輸出，將 entry path 加上 pathPrefix 後寫入 statuses。
 * pathPrefix 用於 sub-repo 場景（轉成相對 workspace）或 workspace 在 git repo 子目錄時剝除。
 *
 * mode='strip' (workspace 在 git repo 內)：path 須以 prefix 開頭，去掉 prefix
 * mode='prepend' (sub-repo)：直接 prepend prefix 到 path
 */
function parsePorcelain(
  stdout: string,
  prefix: string,
  mode: 'strip' | 'prepend',
  out: Record<string, GitFileStatus>
): void {
  const items = stdout.split('\0')
  for (let i = 0; i < items.length; i++) {
    const item = items[i]
    if (!item || item.length < 4) continue
    const xy = item.slice(0, 2)
    if (item[2] !== ' ') continue
    let name = item.slice(3)
    if (mode === 'strip' && prefix) {
      if (!name.startsWith(prefix)) {
        if (xy[0] === 'R' || xy[0] === 'C') i++
        continue
      }
      name = name.slice(prefix.length)
    } else if (mode === 'prepend' && prefix) {
      name = prefix + name
    }
    const status = decodeStatus(xy)
    if (status) out[name] = status
    if (xy[0] === 'R' || xy[0] === 'C') i++
  }
}

/** 檢查 path 是否為 git repo（含 .git 目錄或檔案，後者為 worktree / submodule） */
function hasGitDir(p: string): boolean {
  try {
    return fs.existsSync(path.join(p, '.git'))
  } catch {
    return false
  }
}

/** 列出 cwd 下 1 層的 sub-repo 名稱（只看含 .git 的子目錄） */
function listSubRepos(cwd: string): string[] {
  try {
    const items = fs.readdirSync(cwd, { withFileTypes: true })
    return items
      .filter(it => it.isDirectory() && hasGitDir(path.join(cwd, it.name)))
      .map(it => it.name)
  } catch {
    return []
  }
}

export async function getFileStatuses(workspaceCwd: string): Promise<GitFileStatusResult> {
  const statuses: Record<string, GitFileStatus> = {}

  // 情境 A：workspaceCwd 本身在 git repo 內（含子目錄）
  // 用 rev-parse 偵測 + 拿 prefix 對 porcelain path 做剝除
  if (hasGitDir(workspaceCwd) || await isInsideGitRepo(workspaceCwd)) {
    try {
      const { stdout: prefixOut } = await execFileAsync(
        'git',
        ['rev-parse', '--show-prefix'],
        { cwd: workspaceCwd, timeout: 3000, encoding: 'utf-8' }
      )
      const prefix = prefixOut.trim()
      const { stdout } = await execFileAsync('git', STATUS_ARGS, { ...EXEC_OPTS, cwd: workspaceCwd })
      parsePorcelain(stdout, prefix, 'strip', statuses)
      return { ok: true, statuses }
    } catch (e: any) {
      return classifyError(e)
    }
  }

  // 情境 B：workspaceCwd 不在 git repo 內，但下層有 sub-repo（1 層深）
  // 對每個 sub-repo 跑 git status，path 前面接 sub-repo name
  const subRepos = listSubRepos(workspaceCwd)
  if (subRepos.length === 0) {
    // 既不在 git repo 內，下層也沒 sub-repo → 空（graceful，無錯）
    return { ok: true, statuses: {} }
  }

  await Promise.all(
    subRepos.map(async (name) => {
      try {
        const subCwd = path.join(workspaceCwd, name)
        const { stdout } = await execFileAsync('git', STATUS_ARGS, { ...EXEC_OPTS, cwd: subCwd })
        parsePorcelain(stdout, name + '/', 'prepend', statuses)
      } catch {
        // 個別 sub-repo 失敗不影響其他
      }
    })
  )

  return { ok: true, statuses }
}

/** 以 git rev-parse 確認 path 是否在某個 git repo 內（含父目錄）*/
async function isInsideGitRepo(p: string): Promise<boolean> {
  try {
    await execFileAsync('git', ['rev-parse', '--git-dir'], { cwd: p, timeout: 2000, encoding: 'utf-8' })
    return true
  } catch {
    return false
  }
}

function classifyError(e: any): GitFileStatusResult {
  const msg: string = e?.message ?? ''
  if (e?.code === 'ENOENT') return { ok: false, error: 'GIT_NOT_FOUND', message: msg }
  if (e?.killed && e?.signal === 'SIGTERM') return { ok: false, error: 'TIMEOUT', message: msg }
  if (msg.includes('maxBuffer')) return { ok: false, error: 'TOO_LARGE', message: msg }
  if (msg.includes('not a git repository')) return { ok: true, statuses: {} }
  return { ok: false, error: 'IO_ERROR', message: msg }
}
