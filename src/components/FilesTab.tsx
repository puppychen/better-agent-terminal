import { useEffect, useRef, useState, useCallback } from 'react'
import type { FsDirEntry, GitFileStatus } from '../types/electron'
import { loadEditorRuntime, loadLanguageExtension, type EditorRuntime } from './files-editor-runtime'
import { FileConflictDialog } from './FileConflictDialog'
import { useToast } from './Toast'

const STATUS_LABEL: Record<GitFileStatus, string> = {
  modified: 'M (已修改未 stage)',
  staged: 'A (已 stage)',
  untracked: '? (未追蹤)',
  deleted: 'D (已刪除)',
  unmerged: 'U (衝突)'
}

interface FilesTabProps {
  workspaceCwd: string
  isActive: boolean
  /** 來自 cmd+click 終端路徑的開檔請求；nonce 遞增以觸發重載 */
  request?: { path: string; nonce: number }
}

interface OpenFileState {
  relativePath: string
  content: string             // 最後一次從磁碟讀到的內容
  mtime: number               // 最後一次讀到的 mtime
  size: number
  dirty: boolean              // 編輯器內容與磁碟不同
  externallyChanged?: boolean // on-focus 偵測到外部變動
}

interface ConflictState {
  newContent: string          // 用戶想要寫入的內容
  currentMtime: number        // 磁碟上目前 mtime
}

function joinPath(dir: string, name: string): string {
  if (!dir) return name
  return dir.endsWith('/') ? dir + name : dir + '/' + name
}

function parentPath(p: string): string {
  if (!p || p === '.' || p === '') return ''
  const idx = p.lastIndexOf('/')
  return idx <= 0 ? '' : p.slice(0, idx)
}

const WRAP_PREF_KEY = 'baw.filesTab.lineWrap'
const readWrapPref = (): boolean => {
  const v = typeof localStorage !== 'undefined' ? localStorage.getItem(WRAP_PREF_KEY) : null
  return v === null ? true : v === '1'  // 預設 true
}
const writeWrapPref = (wrap: boolean): void => {
  try { localStorage.setItem(WRAP_PREF_KEY, wrap ? '1' : '0') } catch { /* ignore */ }
}

export function FilesTab({ workspaceCwd, isActive, request }: FilesTabProps) {
  const [currentDir, setCurrentDir] = useState<string>('')
  const [entries, setEntries] = useState<FsDirEntry[]>([])
  const [dirError, setDirError] = useState<string | null>(null)
  const [openFile, setOpenFile] = useState<OpenFileState | null>(null)
  const [fileError, setFileError] = useState<string | null>(null)
  const [conflict, setConflict] = useState<ConflictState | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [wrap, setWrap] = useState<boolean>(readWrapPref)
  const [gitStatuses, setGitStatuses] = useState<Record<string, GitFileStatus>>({})
  const [entryMenu, setEntryMenu] = useState<{ path: string; x: number; y: number } | null>(null)
  const { showToast } = useToast()

  const editorContainerRef = useRef<HTMLDivElement | null>(null)
  const editorRuntimeRef = useRef<EditorRuntime | null>(null)
  const editorViewRef = useRef<any>(null)
  const wrapCompartmentRef = useRef<any>(null)
  const openFileRef = useRef<OpenFileState | null>(null)
  const saveRef = useRef<() => void>(() => {})

  // 同步 openFile 到 ref（讓 CodeMirror keymap closure 可拿到最新值）
  useEffect(() => { openFileRef.current = openFile }, [openFile])

  // 取 git status（非 git repo / 失敗皆 graceful，不打擾用戶）
  const refreshGitStatuses = useCallback(async () => {
    const result = await window.electronAPI.git.getFileStatus(workspaceCwd)
    if (result.ok) {
      setGitStatuses(result.statuses)
    } else {
      setGitStatuses({})
    }
  }, [workspaceCwd])

  // 載入指定目錄
  const loadDir = useCallback(async (dir: string) => {
    setDirError(null)
    const result = await window.electronAPI.fs.listDir(workspaceCwd, dir)
    if (result.ok) {
      setEntries(result.entries)
      setCurrentDir(dir)
    } else {
      setDirError(`無法讀取目錄（${result.error}${result.message ? ': ' + result.message : ''}）`)
    }
  }, [workspaceCwd])

  // 開檔（讀檔 + 重設 dirty）
  const openFileAt = useCallback(async (relativePath: string) => {
    setFileError(null)
    setSaveError(null)
    setConflict(null)
    const result = await window.electronAPI.fs.readFile(workspaceCwd, relativePath)
    if (!result.ok) {
      const errMsg: Record<string, string> = {
        TOO_LARGE: '檔案超過 5MB 大小限制',
        BINARY: '不支援二進位檔',
        NOT_FILE: '不是檔案',
        NOT_FOUND: '檔案不存在',
        OUT_OF_SCOPE: '路徑超出 workspace 範圍',
        IO_ERROR: 'IO 錯誤'
      }
      setFileError(errMsg[result.error] ?? result.error)
      setOpenFile(null)
      return
    }
    setOpenFile({ relativePath, content: result.content, mtime: result.mtime, size: result.size, dirty: false })
  }, [workspaceCwd])

  // save 流程（共用：Cmd+S / 衝突對話框「覆寫」按鈕）
  const performSave = useCallback(async (forceOverwrite = false) => {
    const file = openFileRef.current
    if (!file) return
    const view = editorViewRef.current
    if (!view) return
    const newContent = view.state.doc.toString()

    setSaveError(null)
    const result = await window.electronAPI.fs.writeFile(
      workspaceCwd,
      file.relativePath,
      newContent,
      forceOverwrite ? undefined : file.mtime
    )

    if (result.ok) {
      setOpenFile(prev => prev && prev.relativePath === file.relativePath
        ? { ...prev, content: newContent, mtime: result.mtime, size: result.size, dirty: false, externallyChanged: false }
        : prev)
      setConflict(null)
      refreshGitStatuses()
      return
    }

    if (result.error === 'CONFLICT') {
      setConflict({ newContent, currentMtime: result.currentMtime ?? 0 })
      return
    }

    const errMsg: Record<string, string> = {
      OUT_OF_SCOPE: '路徑超出 workspace 範圍',
      NOT_FILE: '目標不是檔案',
      IO_ERROR: 'IO 錯誤'
    }
    setSaveError(errMsg[result.error] ?? result.error)
  }, [workspaceCwd, refreshGitStatuses])

  useEffect(() => { saveRef.current = () => { performSave() } }, [performSave])

  // 初始載入根目錄 + git status
  useEffect(() => {
    loadDir('')
    refreshGitStatuses()
  }, [loadDir, refreshGitStatuses])

  // tab 重新獲得焦點 → refresh git status（捕捉外部 commit / stage）
  useEffect(() => {
    if (isActive) refreshGitStatuses()
  }, [isActive, refreshGitStatuses])

  // 響應外部開檔請求（cmd+click）— 切到該檔所在目錄並開檔
  useEffect(() => {
    if (!request) return
    const dir = parentPath(request.path)
    loadDir(dir)
    openFileAt(request.path)
  }, [request?.nonce, request?.path, loadDir, openFileAt])

  // tab focus 時，對開啟中的檔案做 mtime 比對
  useEffect(() => {
    if (!isActive || !openFile) return
    let cancelled = false
    window.electronAPI.fs.stat(workspaceCwd, openFile.relativePath).then((s) => {
      if (cancelled) return
      if (s.ok && Math.abs(s.mtime - openFile.mtime) > 1) {
        setOpenFile(prev => prev && prev.relativePath === openFile.relativePath ? { ...prev, externallyChanged: true } : prev)
      }
    })
    return () => { cancelled = true }
  }, [isActive, openFile?.relativePath, openFile?.mtime, workspaceCwd])

  // 掛載 / 更新 CodeMirror editor（檔案切換時整個重建）
  useEffect(() => {
    if (!openFile) {
      if (editorViewRef.current) {
        editorViewRef.current.destroy()
        editorViewRef.current = null
      }
      return
    }

    let cancelled = false

    const setupEditor = async () => {
      const runtime = editorRuntimeRef.current ?? (editorRuntimeRef.current = await loadEditorRuntime())
      if (cancelled || !editorContainerRef.current) return

      const langExt = await loadLanguageExtension(openFile.relativePath)
      if (cancelled) return

      const { EditorState, Compartment, EditorView, lineNumbers, highlightActiveLine, keymap, defaultKeymap, history, historyKeymap, oneDark } = runtime
      const wrapCompartment = new Compartment()
      wrapCompartmentRef.current = wrapCompartment

      const updateListener = EditorView.updateListener.of((update) => {
        if (!update.docChanged) return
        const cur = openFileRef.current
        if (!cur) return
        const nowDirty = update.state.doc.toString() !== cur.content
        if (cur.dirty !== nowDirty) {
          setOpenFile(prev => prev && prev.relativePath === cur.relativePath ? { ...prev, dirty: nowDirty } : prev)
        }
      })

      const saveBinding = keymap.of([
        {
          key: 'Mod-s',
          preventDefault: true,
          run: () => { saveRef.current(); return true }
        }
      ])

      const state = EditorState.create({
        doc: openFile.content,
        extensions: [
          lineNumbers(),
          highlightActiveLine(),
          history(),
          oneDark,
          wrapCompartment.of(wrap ? EditorView.lineWrapping : []),
          saveBinding,
          keymap.of([...defaultKeymap, ...historyKeymap]),
          updateListener,
          EditorView.theme({
            '&': { height: '100%', fontSize: '13px' },
            '.cm-scroller': { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }
          }),
          ...(langExt as any[])
        ]
      })

      if (editorViewRef.current) {
        editorViewRef.current.destroy()
        editorViewRef.current = null
      }
      editorViewRef.current = new EditorView({ state, parent: editorContainerRef.current })
    }

    setupEditor()

    return () => { cancelled = true }
  }, [openFile?.relativePath, openFile?.content])

  // 元件卸載時銷毀 editor
  useEffect(() => {
    return () => {
      if (editorViewRef.current) {
        editorViewRef.current.destroy()
        editorViewRef.current = null
      }
    }
  }, [])

  // wrap 設定變化時動態 reconfigure（不重建 editor）
  useEffect(() => {
    const view = editorViewRef.current
    const compartment = wrapCompartmentRef.current
    const runtime = editorRuntimeRef.current
    if (!view || !compartment || !runtime) return
    view.dispatch({
      effects: compartment.reconfigure(wrap ? runtime.EditorView.lineWrapping : [])
    })
  }, [wrap])

  const handleToggleWrap = () => {
    setWrap(prev => {
      const next = !prev
      writeWrapPref(next)
      return next
    })
  }

  const handleEntryClick = (entry: FsDirEntry) => {
    const next = joinPath(currentDir, entry.name)
    if (entry.isDirectory) {
      loadDir(next)
    } else {
      openFileAt(next)
    }
  }

  const handleEntryContextMenu = (e: React.MouseEvent, entry: FsDirEntry) => {
    e.preventDefault()
    e.stopPropagation()
    setEntryMenu({ path: joinPath(currentDir, entry.name), x: e.clientX, y: e.clientY })
  }

  const closeEntryMenu = () => setEntryMenu(null)

  const copyToClipboard = async (text: string, label: string) => {
    try {
      await navigator.clipboard.writeText(text)
      showToast(`${label}已複製：${text}`, 'info')
    } catch {
      showToast('複製失敗', 'error')
    }
    closeEntryMenu()
  }

  const handleCopyRelative = () => {
    if (entryMenu) copyToClipboard(entryMenu.path, '相對路徑')
  }

  const handleCopyAbsolute = () => {
    if (!entryMenu) return
    const absolute = workspaceCwd.replace(/\/$/, '') + '/' + entryMenu.path
    copyToClipboard(absolute, '絕對路徑')
  }

  // 點外部關閉 menu
  useEffect(() => {
    if (!entryMenu) return
    const handler = () => closeEntryMenu()
    document.addEventListener('click', handler)
    document.addEventListener('contextmenu', handler)
    return () => {
      document.removeEventListener('click', handler)
      document.removeEventListener('contextmenu', handler)
    }
  }, [entryMenu])

  const handleGoUp = () => {
    if (!currentDir) return
    loadDir(parentPath(currentDir))
  }

  const handleReload = () => {
    if (openFile) openFileAt(openFile.relativePath)
  }

  const handleOpenInIDE = () => {
    if (!openFile) return
    const absolute = workspaceCwd.replace(/\/$/, '') + '/' + openFile.relativePath
    window.electronAPI.shell.openPath(absolute)
  }

  const handleSaveClick = () => performSave()

  const handleConflictOverwrite = async () => {
    await performSave(true)
  }

  const handleConflictReload = () => {
    setConflict(null)
    if (openFile) openFileAt(openFile.relativePath)
  }

  const handleConflictCancel = () => setConflict(null)

  return (
    <div className="files-tab">
      <div className="files-tab-tree">
        <div className="files-tab-tree-header">
          <span className="files-tab-tree-path" title={currentDir || '/'}>
            {currentDir || '(workspace root)'}
          </span>
        </div>
        <div className="files-tab-tree-list">
          {currentDir && (
            <div className="files-tab-entry files-tab-entry-up" onClick={handleGoUp}>
              <span className="files-tab-entry-icon">↰</span>
              <span className="files-tab-entry-name">..</span>
            </div>
          )}
          {dirError && <div className="files-tab-error">{dirError}</div>}
          {entries.map(e => {
            const entryPath = joinPath(currentDir, e.name)
            const status = !e.isDirectory ? gitStatuses[entryPath] : undefined
            return (
              <div
                key={e.name}
                className={`files-tab-entry ${e.isDirectory ? 'is-dir' : ''} ${openFile?.relativePath === entryPath ? 'active' : ''}`}
                onClick={() => handleEntryClick(e)}
                onContextMenu={(ev) => handleEntryContextMenu(ev, e)}
                title={e.name}
              >
                <span className="files-tab-entry-icon">{e.isDirectory ? '📁' : '📄'}</span>
                <span className="files-tab-entry-name">{e.name}{e.isSymlink ? ' ↗' : ''}</span>
                {status && (
                  <span
                    className={`files-tab-entry-status status-${status}`}
                    title={STATUS_LABEL[status]}
                  />
                )}
              </div>
            )
          })}
          {!dirError && entries.length === 0 && (
            <div className="files-tab-empty">(空目錄)</div>
          )}
        </div>
      </div>

      <div className="files-tab-viewer">
        {!openFile && !fileError && (
          <div className="files-tab-placeholder">點選左側檔案以開啟（Cmd+S 儲存）</div>
        )}
        {fileError && <div className="files-tab-error">{fileError}</div>}
        {openFile && (
          <>
            <div className="files-tab-viewer-header">
              <span className="files-tab-viewer-path" title={openFile.relativePath}>
                {openFile.relativePath}{openFile.dirty && <span className="files-tab-dirty-mark"> ●</span>}
              </span>
              <span className="files-tab-viewer-meta">{(openFile.size / 1024).toFixed(1)} KB</span>
              <button
                className="files-tab-viewer-action"
                onClick={handleSaveClick}
                title="儲存 (Cmd+S)"
                disabled={!openFile.dirty}
              >
                💾
              </button>
              <button
                className={`files-tab-viewer-action ${wrap ? 'active' : ''}`}
                onClick={handleToggleWrap}
                title={wrap ? '關閉自動換行' : '開啟自動換行'}
              >
                ↩
              </button>
              <button className="files-tab-viewer-action" onClick={handleReload} title="重新載入（捨棄變更）">↻</button>
              <button className="files-tab-viewer-action" onClick={handleOpenInIDE} title="以系統預設應用程式開啟">↗</button>
            </div>
            {openFile.externallyChanged && (
              <div className="files-tab-conflict-banner">
                檔案已被外部修改。<button className="files-tab-conflict-reload" onClick={handleReload}>重新載入</button>
              </div>
            )}
            {saveError && (
              <div className="files-tab-conflict-banner">
                儲存失敗：{saveError}
              </div>
            )}
            <div ref={editorContainerRef} className="files-tab-editor-container" />
          </>
        )}
      </div>

      {conflict && openFile && (
        <FileConflictDialog
          filePath={openFile.relativePath}
          onOverwrite={handleConflictOverwrite}
          onReload={handleConflictReload}
          onCancel={handleConflictCancel}
        />
      )}

      {entryMenu && (
        <div
          className="files-tab-context-menu"
          style={{ left: entryMenu.x, top: entryMenu.y }}
          onClick={(e) => e.stopPropagation()}
          onContextMenu={(e) => e.preventDefault()}
        >
          <button className="files-tab-context-menu-item" onClick={handleCopyRelative}>
            複製相對路徑
          </button>
          <button className="files-tab-context-menu-item" onClick={handleCopyAbsolute}>
            複製絕對路徑
          </button>
        </div>
      )}
    </div>
  )
}
