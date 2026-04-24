import { useEffect, useLayoutEffect, useMemo, useRef, useState, useCallback } from 'react'
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

const MAX_OPEN_FILES = 10

const WRAP_PREF_KEY = 'baw.filesTab.lineWrap'
const readWrapPref = (): boolean => {
  const v = typeof localStorage !== 'undefined' ? localStorage.getItem(WRAP_PREF_KEY) : null
  return v === null ? true : v === '1'
}
const writeWrapPref = (wrap: boolean): void => {
  try { localStorage.setItem(WRAP_PREF_KEY, wrap ? '1' : '0') } catch { /* ignore */ }
}

const TREE_WIDTH_KEY = 'baw.filesTab.treeWidth'
const readTreeWidthPref = (): number => {
  const v = typeof localStorage !== 'undefined' ? localStorage.getItem(TREE_WIDTH_KEY) : null
  if (!v) return 240
  const n = Number(v)
  return Number.isFinite(n) ? Math.max(150, Math.min(600, n)) : 240
}
const writeTreeWidthPref = (w: number): void => {
  try { localStorage.setItem(TREE_WIDTH_KEY, String(Math.round(w))) } catch { /* ignore */ }
}

interface FilesTabProps {
  workspaceCwd: string
  isActive: boolean
  request?: { path: string; nonce: number }
}

interface OpenFileState {
  path: string
  content: string
  mtime: number
  size: number
  dirty: boolean
  externallyChanged?: boolean
}

interface ConflictState {
  path: string
  newContent: string
  currentMtime: number
}

interface VisibleItem {
  path: string
  name: string
  isDirectory: boolean
  isSymlink: boolean
  depth: number
  isExpanded: boolean
}

function joinPath(dir: string, name: string): string {
  if (!dir) return name
  return dir.endsWith('/') ? dir + name : dir + '/' + name
}

function basename(p: string): string {
  const i = p.lastIndexOf('/')
  return i === -1 ? p : p.slice(i + 1)
}

const FILE_ERR: Record<string, string> = {
  TOO_LARGE: '檔案超過 5MB',
  BINARY: '不支援二進位檔',
  NOT_FILE: '不是檔案',
  NOT_FOUND: '檔案不存在',
  OUT_OF_SCOPE: '路徑超出 workspace 範圍',
  IO_ERROR: 'IO 錯誤',
  CONFLICT: '檔案衝突'
}

export function FilesTab({ workspaceCwd, isActive, request }: FilesTabProps) {
  // === Tree state ===
  const [dirCache, setDirCache] = useState<Map<string, FsDirEntry[]>>(new Map())
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [gitStatuses, setGitStatuses] = useState<Record<string, GitFileStatus>>({})

  // === Open files ===
  const [openFiles, setOpenFiles] = useState<OpenFileState[]>([])
  const [activeFilePath, setActiveFilePath] = useState<string | null>(null)

  // === Splitter ===
  const [treeWidth, setTreeWidth] = useState<number>(readTreeWidthPref)

  // === Editor pref / state ===
  const [wrap, setWrap] = useState<boolean>(readWrapPref)
  const [conflict, setConflict] = useState<ConflictState | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [entryMenu, setEntryMenu] = useState<{ path: string; x: number; y: number; isDirectory: boolean } | null>(null)

  const { showToast } = useToast()

  // === Refs ===
  const containerRef = useRef<HTMLDivElement | null>(null)
  const editorRuntimeRef = useRef<EditorRuntime | null>(null)
  const editorViewsRef = useRef<Map<string, { view: any; wrapCompartment: any }>>(new Map())
  const editorContainerRefs = useRef<Map<string, HTMLDivElement>>(new Map())
  const openFilesRef = useRef<OpenFileState[]>([])
  const activeFilePathRef = useRef<string | null>(null)
  const saveRef = useRef<() => void>(() => {})
  const isDraggingRef = useRef(false)
  const pendingDraggedWidthRef = useRef<number>(treeWidth)

  useEffect(() => { openFilesRef.current = openFiles }, [openFiles])
  useEffect(() => { activeFilePathRef.current = activeFilePath }, [activeFilePath])

  // === Directory loading ===
  const loadDir = useCallback(async (dir: string): Promise<void> => {
    const result = await window.electronAPI.fs.listDir(workspaceCwd, dir)
    if (result.ok) {
      setDirCache(prev => {
        const next = new Map(prev)
        next.set(dir, result.entries)
        return next
      })
    }
  }, [workspaceCwd])

  const toggleDir = useCallback(async (dir: string): Promise<void> => {
    if (expanded.has(dir)) {
      setExpanded(prev => {
        const next = new Set(prev)
        next.delete(dir)
        return next
      })
    } else {
      if (!dirCache.has(dir)) await loadDir(dir)
      setExpanded(prev => new Set(prev).add(dir))
    }
  }, [expanded, dirCache, loadDir])

  // Root 初始
  useEffect(() => {
    loadDir('')
  }, [loadDir])

  // === Git status ===
  const refreshGitStatuses = useCallback(async (): Promise<void> => {
    const result = await window.electronAPI.git.getFileStatus(workspaceCwd)
    if (result.ok) setGitStatuses(result.statuses)
    else setGitStatuses({})
  }, [workspaceCwd])

  useEffect(() => { refreshGitStatuses() }, [refreshGitStatuses])
  useEffect(() => { if (isActive) refreshGitStatuses() }, [isActive, refreshGitStatuses])

  // === Open / close file ===
  const openFileAt = useCallback(async (relativePath: string): Promise<void> => {
    // 若已開，直接切
    const existing = openFilesRef.current.find(f => f.path === relativePath)
    if (existing) {
      setActiveFilePath(relativePath)
      return
    }
    // 讀檔
    const result = await window.electronAPI.fs.readFile(workspaceCwd, relativePath)
    if (!result.ok) {
      showToast(FILE_ERR[result.error] ?? result.error, 'error')
      return
    }
    // LRU 檢查
    if (openFilesRef.current.length >= MAX_OPEN_FILES) {
      const cleanest = openFilesRef.current.find(f => !f.dirty)
      if (!cleanest) {
        showToast(`已開啟 ${MAX_OPEN_FILES} 個檔，全部未儲存；請先儲存或關閉`, 'error')
        return
      }
      setOpenFiles(prev => prev.filter(f => f.path !== cleanest.path))
    }
    const newFile: OpenFileState = {
      path: relativePath,
      content: result.content,
      mtime: result.mtime,
      size: result.size,
      dirty: false
    }
    setOpenFiles(prev => [...prev, newFile])
    setActiveFilePath(relativePath)
  }, [workspaceCwd, showToast])

  const closeFile = useCallback((relativePath: string): void => {
    const f = openFilesRef.current.find(x => x.path === relativePath)
    if (f?.dirty && !window.confirm(`「${relativePath}」有未儲存變更，確定關閉？`)) return
    const idx = openFilesRef.current.findIndex(x => x.path === relativePath)
    const next = openFilesRef.current[idx + 1] || openFilesRef.current[idx - 1]
    setOpenFiles(prev => prev.filter(x => x.path !== relativePath))
    if (activeFilePathRef.current === relativePath) {
      setActiveFilePath(next?.path ?? null)
    }
  }, [])

  // 響應 request (cmd+click)
  useEffect(() => {
    if (!request) return
    openFileAt(request.path)
  }, [request?.nonce, request?.path, openFileAt])

  // === Editor lifecycle ===
  // 每個 open file 對應一個 EditorView；render 產生 container 後 useLayoutEffect 建 view
  useLayoutEffect(() => {
    let cancelled = false
    const setup = async () => {
      const runtime = editorRuntimeRef.current ?? (editorRuntimeRef.current = await loadEditorRuntime())
      if (cancelled) return
      const {
        EditorState, Compartment, EditorView, lineNumbers, highlightActiveLine,
        keymap, defaultKeymap, history, historyKeymap, oneDark, searchKeymap, search
      } = runtime

      // 新增 view
      for (const f of openFiles) {
        if (editorViewsRef.current.has(f.path)) continue
        const container = editorContainerRefs.current.get(f.path)
        if (!container) continue
        const wrapCompartment = new Compartment()
        const langExt = await loadLanguageExtension(f.path)
        if (cancelled) return
        const updateListener = EditorView.updateListener.of((update: any) => {
          if (!update.docChanged) return
          const cur = openFilesRef.current.find(x => x.path === f.path)
          if (!cur) return
          const nowDirty = update.state.doc.toString() !== cur.content
          if (cur.dirty !== nowDirty) {
            setOpenFiles(prev => prev.map(x => x.path === f.path ? { ...x, dirty: nowDirty } : x))
          }
        })
        const saveBinding = keymap.of([{
          key: 'Mod-s',
          preventDefault: true,
          run: () => { saveRef.current(); return true }
        }])
        const state = EditorState.create({
          doc: f.content,
          extensions: [
            lineNumbers(),
            highlightActiveLine(),
            history(),
            search(),
            oneDark,
            wrapCompartment.of(wrap ? EditorView.lineWrapping : []),
            saveBinding,
            keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap]),
            updateListener,
            EditorView.theme({
              '&': { height: '100%', fontSize: '13px' },
              '.cm-scroller': { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }
            }),
            ...(langExt as any[])
          ]
        })
        const view = new EditorView({ state, parent: container })
        editorViewsRef.current.set(f.path, { view, wrapCompartment })
      }

      // 移除已 close 的 view
      const openPathsSet = new Set(openFiles.map(f => f.path))
      for (const [p, entry] of Array.from(editorViewsRef.current.entries())) {
        if (!openPathsSet.has(p)) {
          try { entry.view.destroy() } catch { /* already */ }
          editorViewsRef.current.delete(p)
          editorContainerRefs.current.delete(p)
        }
      }
    }
    setup()
    return () => { cancelled = true }
  }, [openFiles, wrap])

  // wrap 切換 → 對所有已存在的 view 做 reconfigure
  useEffect(() => {
    const runtime = editorRuntimeRef.current
    if (!runtime) return
    for (const [, { view, wrapCompartment }] of editorViewsRef.current) {
      view.dispatch({ effects: wrapCompartment.reconfigure(wrap ? runtime.EditorView.lineWrapping : []) })
    }
  }, [wrap])

  // 元件卸載 dispose all views
  useEffect(() => {
    return () => {
      for (const [, { view }] of editorViewsRef.current) {
        try { view.destroy() } catch { /* ignore */ }
      }
      editorViewsRef.current.clear()
      editorContainerRefs.current.clear()
    }
  }, [])

  // === on-focus mtime check（只對 active file） ===
  useEffect(() => {
    if (!isActive || !activeFilePath) return
    const file = openFilesRef.current.find(f => f.path === activeFilePath)
    if (!file) return
    let cancelled = false
    window.electronAPI.fs.stat(workspaceCwd, activeFilePath).then((s) => {
      if (cancelled) return
      if (s.ok && Math.abs(s.mtime - file.mtime) > 1) {
        setOpenFiles(prev => prev.map(x => x.path === activeFilePath ? { ...x, externallyChanged: true } : x))
      }
    })
    return () => { cancelled = true }
  }, [isActive, activeFilePath, workspaceCwd])

  // === Save ===
  const performSave = useCallback(async (forceOverwrite = false): Promise<void> => {
    const path = activeFilePathRef.current
    if (!path) return
    const file = openFilesRef.current.find(f => f.path === path)
    const entry = editorViewsRef.current.get(path)
    if (!file || !entry) return
    const newContent = entry.view.state.doc.toString()
    setSaveError(null)
    const result = await window.electronAPI.fs.writeFile(
      workspaceCwd, path, newContent, forceOverwrite ? undefined : file.mtime
    )
    if (result.ok) {
      setOpenFiles(prev => prev.map(f => f.path === path
        ? { ...f, content: newContent, mtime: result.mtime, size: result.size, dirty: false, externallyChanged: false }
        : f))
      setConflict(null)
      refreshGitStatuses()
      return
    }
    if (result.error === 'CONFLICT') {
      setConflict({ path, newContent, currentMtime: result.currentMtime ?? 0 })
      return
    }
    setSaveError(FILE_ERR[result.error] ?? result.error)
  }, [workspaceCwd, refreshGitStatuses])

  useEffect(() => { saveRef.current = () => { performSave() } }, [performSave])

  const handleReload = useCallback(async (): Promise<void> => {
    const path = activeFilePathRef.current
    if (!path) return
    const result = await window.electronAPI.fs.readFile(workspaceCwd, path)
    if (!result.ok) {
      showToast(FILE_ERR[result.error] ?? result.error, 'error')
      return
    }
    setOpenFiles(prev => prev.map(f => f.path === path
      ? { ...f, content: result.content, mtime: result.mtime, size: result.size, dirty: false, externallyChanged: false }
      : f))
    // 重灌 editor content
    const entry = editorViewsRef.current.get(path)
    const runtime = editorRuntimeRef.current
    if (entry && runtime) {
      const { EditorView } = runtime
      entry.view.dispatch({
        changes: { from: 0, to: entry.view.state.doc.length, insert: result.content },
        selection: { anchor: 0 }
      })
      void EditorView  // 避免 unused warning
    }
  }, [workspaceCwd, showToast])

  // === Splitter drag ===
  useEffect(() => {
    const handleMove = (e: MouseEvent) => {
      if (!isDraggingRef.current || !containerRef.current) return
      const rect = containerRef.current.getBoundingClientRect()
      const w = Math.max(150, Math.min(600, e.clientX - rect.left))
      pendingDraggedWidthRef.current = w
      setTreeWidth(w)
    }
    const handleUp = () => {
      if (!isDraggingRef.current) return
      isDraggingRef.current = false
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      writeTreeWidthPref(pendingDraggedWidthRef.current)
    }
    document.addEventListener('mousemove', handleMove)
    document.addEventListener('mouseup', handleUp)
    return () => {
      document.removeEventListener('mousemove', handleMove)
      document.removeEventListener('mouseup', handleUp)
    }
  }, [])

  const startDragSplitter = () => {
    isDraggingRef.current = true
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
  }

  // === Visible tree items（flatten） ===
  const visibleItems = useMemo(() => {
    const items: VisibleItem[] = []
    const walk = (dir: string, depth: number) => {
      const entries = dirCache.get(dir)
      if (!entries) return
      for (const e of entries) {
        const fullPath = joinPath(dir, e.name)
        items.push({
          path: fullPath,
          name: e.name,
          isDirectory: e.isDirectory,
          isSymlink: e.isSymlink,
          depth,
          isExpanded: e.isDirectory && expanded.has(fullPath)
        })
        if (e.isDirectory && expanded.has(fullPath)) walk(fullPath, depth + 1)
      }
    }
    walk('', 0)
    return items
  }, [dirCache, expanded])

  const activeFile = useMemo(
    () => openFiles.find(f => f.path === activeFilePath) ?? null,
    [openFiles, activeFilePath]
  )

  // === Context menu ===
  const handleEntryContextMenu = (e: React.MouseEvent, item: VisibleItem) => {
    e.preventDefault()
    e.stopPropagation()
    setEntryMenu({ path: item.path, x: e.clientX, y: e.clientY, isDirectory: item.isDirectory })
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
  const handleCopyRelative = () => { if (entryMenu) copyToClipboard(entryMenu.path, '相對路徑') }
  const handleCopyAbsolute = () => {
    if (!entryMenu) return
    const absolute = workspaceCwd.replace(/\/$/, '') + '/' + entryMenu.path
    copyToClipboard(absolute, '絕對路徑')
  }
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

  // === Tree item click ===
  const handleItemClick = (item: VisibleItem) => {
    if (item.isDirectory) toggleDir(item.path)
    else openFileAt(item.path)
  }

  // === Editor actions ===
  const handleToggleWrap = () => {
    setWrap(prev => {
      const next = !prev
      writeWrapPref(next)
      return next
    })
  }
  const handleOpenInIDE = () => {
    if (!activeFile) return
    const absolute = workspaceCwd.replace(/\/$/, '') + '/' + activeFile.path
    window.electronAPI.shell.openPath(absolute)
  }
  const handleConflictOverwrite = () => performSave(true)
  const handleConflictReload = async () => {
    if (!conflict) return
    setConflict(null)
    await handleReload()
  }
  const handleConflictCancel = () => setConflict(null)

  return (
    <div className="files-tab" ref={containerRef}>
      {/* === LEFT：file tree === */}
      <div className="files-tab-tree" style={{ width: treeWidth }}>
        <div className="files-tab-tree-header">
          <span className="files-tab-tree-path">{workspaceCwd.split('/').pop()}</span>
        </div>
        <div className="files-tab-tree-list">
          {visibleItems.map(item => {
            const status = !item.isDirectory ? gitStatuses[item.path] : undefined
            const isSelected = item.path === activeFilePath
            return (
              <div
                key={item.path}
                className={`files-tab-entry ${item.isDirectory ? 'is-dir' : ''} ${isSelected ? 'active' : ''}`}
                style={{ paddingLeft: 6 + item.depth * 14 }}
                onClick={() => handleItemClick(item)}
                onContextMenu={(e) => handleEntryContextMenu(e, item)}
                title={item.name}
              >
                <span className="files-tab-entry-caret">
                  {item.isDirectory ? (item.isExpanded ? '▼' : '▶') : ''}
                </span>
                <span className="files-tab-entry-icon">{item.isDirectory ? '📁' : '📄'}</span>
                <span className="files-tab-entry-name">{item.name}{item.isSymlink ? ' ↗' : ''}</span>
                {status && (
                  <span
                    className={`files-tab-entry-status status-${status}`}
                    title={STATUS_LABEL[status]}
                  />
                )}
              </div>
            )
          })}
          {visibleItems.length === 0 && (
            <div className="files-tab-empty">(載入中或空目錄)</div>
          )}
        </div>
      </div>

      {/* === SPLITTER === */}
      <div
        className="files-tab-splitter"
        onMouseDown={startDragSplitter}
        title="拖移調整寬度"
      />

      {/* === RIGHT：files bar + viewer === */}
      <div className="files-tab-right">
        {/* 多檔 tab bar */}
        {openFiles.length > 0 && (
          <div className="files-tab-files-bar">
            {openFiles.map(f => (
              <div
                key={f.path}
                className={`files-tab-file-tab ${f.path === activeFilePath ? 'active' : ''}`}
                onClick={() => setActiveFilePath(f.path)}
                title={f.path}
              >
                <span className="files-tab-file-tab-name">
                  {f.dirty && <span className="files-tab-dirty-mark">● </span>}
                  {basename(f.path)}
                </span>
                <button
                  className="files-tab-file-tab-close"
                  onClick={(e) => { e.stopPropagation(); closeFile(f.path) }}
                  title="關閉"
                >×</button>
              </div>
            ))}
          </div>
        )}

        {/* Viewer：多個 editor container，CSS show/hide */}
        <div className="files-tab-viewer">
          {!activeFile && (
            <div className="files-tab-placeholder">
              點選左側檔案以開啟（Cmd+S 儲存 / 最多 {MAX_OPEN_FILES} 檔）
            </div>
          )}
          {activeFile && (
            <div className="files-tab-viewer-header">
              <span className="files-tab-viewer-path" title={activeFile.path}>{activeFile.path}</span>
              <span className="files-tab-viewer-meta">{(activeFile.size / 1024).toFixed(1)} KB</span>
              <button
                className="files-tab-viewer-action"
                onClick={() => performSave()}
                title="儲存 (Cmd+S)"
                disabled={!activeFile.dirty}
              >💾</button>
              <button
                className={`files-tab-viewer-action ${wrap ? 'active' : ''}`}
                onClick={handleToggleWrap}
                title={wrap ? '關閉自動換行' : '開啟自動換行'}
              >↩</button>
              <button className="files-tab-viewer-action" onClick={handleReload} title="重新載入（捨棄變更）">↻</button>
              <button className="files-tab-viewer-action" onClick={handleOpenInIDE} title="以系統預設應用程式開啟">↗</button>
            </div>
          )}
          {activeFile?.externallyChanged && (
            <div className="files-tab-conflict-banner">
              檔案已被外部修改。
              <button className="files-tab-conflict-reload" onClick={handleReload}>重新載入</button>
            </div>
          )}
          {saveError && (
            <div className="files-tab-conflict-banner">儲存失敗：{saveError}</div>
          )}
          {/* 所有 open file 的 container 都 render，用 class 控制顯示 */}
          <div className="files-tab-editor-area">
            {openFiles.map(f => (
              <div
                key={f.path}
                ref={(el) => {
                  if (el) editorContainerRefs.current.set(f.path, el)
                  else editorContainerRefs.current.delete(f.path)
                }}
                className={`files-tab-editor-container ${f.path === activeFilePath ? 'active' : ''}`}
              />
            ))}
          </div>
        </div>
      </div>

      {conflict && (
        <FileConflictDialog
          filePath={conflict.path}
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
