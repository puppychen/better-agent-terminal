import { useEffect, useRef, useState, useCallback } from 'react'
import type { FsDirEntry } from '../types/electron'
import { loadEditorRuntime, loadLanguageExtension, type EditorRuntime } from './files-editor-runtime'

interface FilesTabProps {
  workspaceCwd: string
  isActive: boolean
}

interface OpenFileState {
  relativePath: string
  content: string
  mtime: number
  size: number
  externallyChanged?: boolean  // PR-A 顯示「外部已變動」黃條，PR-B 接 reload 流程
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

export function FilesTab({ workspaceCwd, isActive }: FilesTabProps) {
  const [currentDir, setCurrentDir] = useState<string>('')
  const [entries, setEntries] = useState<FsDirEntry[]>([])
  const [dirError, setDirError] = useState<string | null>(null)
  const [openFile, setOpenFile] = useState<OpenFileState | null>(null)
  const [fileError, setFileError] = useState<string | null>(null)

  const editorContainerRef = useRef<HTMLDivElement | null>(null)
  const editorRuntimeRef = useRef<EditorRuntime | null>(null)
  const editorViewRef = useRef<any>(null)

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

  // 開檔
  const openFileAt = useCallback(async (relativePath: string) => {
    setFileError(null)
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
    setOpenFile({ relativePath, content: result.content, mtime: result.mtime, size: result.size })
  }, [workspaceCwd])

  // 初始載入根目錄
  useEffect(() => {
    loadDir('')
  }, [loadDir])

  // tab focus 時，對開啟中的檔案做 mtime 比對
  useEffect(() => {
    if (!isActive || !openFile) return
    let cancelled = false
    window.electronAPI.fs.stat(workspaceCwd, openFile.relativePath).then((s) => {
      if (cancelled) return
      if (s.ok && s.mtime !== openFile.mtime) {
        setOpenFile(prev => prev && prev.relativePath === openFile.relativePath ? { ...prev, externallyChanged: true } : prev)
      }
    })
    return () => { cancelled = true }
  }, [isActive, openFile?.relativePath, workspaceCwd])

  // 掛載 / 更新 CodeMirror editor
  useEffect(() => {
    if (!openFile) {
      // 清掉舊 editor
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

      const { EditorState, EditorView, lineNumbers, highlightActiveLine, keymap, defaultKeymap, history, historyKeymap, syntaxHighlighting, defaultHighlightStyle } = runtime

      // PR-A 為 read-only：editable=false
      const state = EditorState.create({
        doc: openFile.content,
        extensions: [
          lineNumbers(),
          highlightActiveLine(),
          history(),
          syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
          keymap.of([...defaultKeymap, ...historyKeymap]),
          EditorView.editable.of(false),
          EditorView.theme({
            '&': { height: '100%', fontSize: '13px' },
            '.cm-scroller': { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }
          }),
          ...(langExt as any[])
        ]
      })

      // 銷毀舊 view 並建新 view（檔案切換時整個重建較簡單）
      if (editorViewRef.current) {
        editorViewRef.current.destroy()
        editorViewRef.current = null
      }
      editorViewRef.current = new EditorView({ state, parent: editorContainerRef.current })
    }

    setupEditor()

    return () => {
      cancelled = true
    }
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

  const handleEntryClick = (entry: FsDirEntry) => {
    const next = joinPath(currentDir, entry.name)
    if (entry.isDirectory) {
      loadDir(next)
    } else {
      openFileAt(next)
    }
  }

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
          {entries.map(e => (
            <div
              key={e.name}
              className={`files-tab-entry ${e.isDirectory ? 'is-dir' : ''} ${openFile?.relativePath === joinPath(currentDir, e.name) ? 'active' : ''}`}
              onClick={() => handleEntryClick(e)}
              title={e.name}
            >
              <span className="files-tab-entry-icon">{e.isDirectory ? '📁' : '📄'}</span>
              <span className="files-tab-entry-name">{e.name}{e.isSymlink ? ' ↗' : ''}</span>
            </div>
          ))}
          {!dirError && entries.length === 0 && (
            <div className="files-tab-empty">(空目錄)</div>
          )}
        </div>
      </div>

      <div className="files-tab-viewer">
        {!openFile && !fileError && (
          <div className="files-tab-placeholder">點選左側檔案以預覽（read-only）</div>
        )}
        {fileError && <div className="files-tab-error">{fileError}</div>}
        {openFile && (
          <>
            <div className="files-tab-viewer-header">
              <span className="files-tab-viewer-path" title={openFile.relativePath}>{openFile.relativePath}</span>
              <span className="files-tab-viewer-meta">{(openFile.size / 1024).toFixed(1)} KB</span>
              <button className="files-tab-viewer-action" onClick={handleReload} title="重新載入">↻</button>
              <button className="files-tab-viewer-action" onClick={handleOpenInIDE} title="以系統預設應用程式開啟">↗</button>
            </div>
            {openFile.externallyChanged && (
              <div className="files-tab-conflict-banner">
                檔案已被外部修改。<button className="files-tab-conflict-reload" onClick={handleReload}>重新載入</button>
              </div>
            )}
            <div ref={editorContainerRef} className="files-tab-editor-container" />
          </>
        )}
      </div>
    </div>
  )
}
