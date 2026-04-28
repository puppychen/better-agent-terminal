/**
 * CodeMirror 6 lazy runtime
 *
 * 動態載入 CodeMirror core + 對應副檔名的 language package。
 * 第一次呼叫時觸發 lazy chunk，之後 cache 命中。
 */

export interface EditorRuntime {
  EditorState: typeof import('@codemirror/state').EditorState
  Compartment: typeof import('@codemirror/state').Compartment
  EditorView: typeof import('@codemirror/view').EditorView
  lineNumbers: typeof import('@codemirror/view').lineNumbers
  highlightActiveLine: typeof import('@codemirror/view').highlightActiveLine
  keymap: typeof import('@codemirror/view').keymap
  defaultKeymap: typeof import('@codemirror/commands').defaultKeymap
  history: typeof import('@codemirror/commands').history
  historyKeymap: typeof import('@codemirror/commands').historyKeymap
  oneDark: typeof import('@codemirror/theme-one-dark').oneDark
  searchKeymap: typeof import('@codemirror/search').searchKeymap
  search: typeof import('@codemirror/search').search
  SearchQuery: typeof import('@codemirror/search').SearchQuery
  setSearchQuery: typeof import('@codemirror/search').setSearchQuery
  findNext: typeof import('@codemirror/search').findNext
  findPrevious: typeof import('@codemirror/search').findPrevious
}

let runtimePromise: Promise<EditorRuntime> | null = null

export function loadEditorRuntime(): Promise<EditorRuntime> {
  if (runtimePromise) return runtimePromise
  runtimePromise = Promise.all([
    import('@codemirror/state'),
    import('@codemirror/view'),
    import('@codemirror/commands'),
    import('@codemirror/theme-one-dark'),
    import('@codemirror/search')
  ]).then(([state, view, commands, oneDark, searchMod]) => ({
    EditorState: state.EditorState,
    Compartment: state.Compartment,
    EditorView: view.EditorView,
    lineNumbers: view.lineNumbers,
    highlightActiveLine: view.highlightActiveLine,
    keymap: view.keymap,
    defaultKeymap: commands.defaultKeymap,
    history: commands.history,
    historyKeymap: commands.historyKeymap,
    oneDark: oneDark.oneDark,
    searchKeymap: searchMod.searchKeymap,
    search: searchMod.search,
    SearchQuery: searchMod.SearchQuery,
    setSearchQuery: searchMod.setSearchQuery,
    findNext: searchMod.findNext,
    findPrevious: searchMod.findPrevious
  }))
  return runtimePromise
}

/** 依副檔名 lazy 載對應語言 extension，回傳 CM extension array（或空） */
export async function loadLanguageExtension(filename: string): Promise<unknown[]> {
  const ext = filename.split('.').pop()?.toLowerCase()
  if (!ext) return []
  switch (ext) {
    case 'ts':
    case 'tsx':
    case 'js':
    case 'jsx':
    case 'mjs':
    case 'cjs': {
      const m = await import('@codemirror/lang-javascript')
      return [m.javascript({ jsx: ext.endsWith('x'), typescript: ext === 'ts' || ext === 'tsx' })]
    }
    case 'json': {
      const m = await import('@codemirror/lang-json')
      return [m.json()]
    }
    case 'md':
    case 'markdown': {
      const m = await import('@codemirror/lang-markdown')
      return [m.markdown()]
    }
    case 'yml':
    case 'yaml': {
      const m = await import('@codemirror/lang-yaml')
      return [m.yaml()]
    }
    case 'py': {
      const m = await import('@codemirror/lang-python')
      return [m.python()]
    }
    case 'go': {
      const m = await import('@codemirror/lang-go')
      return [m.go()]
    }
    case 'php': {
      const m = await import('@codemirror/lang-php')
      return [m.php()]
    }
    case 'html':
    case 'htm': {
      const m = await import('@codemirror/lang-html')
      return [m.html()]
    }
    // C# 暫無官方 lang package，純文字呈現
    case 'cs':
    default:
      return []
  }
}
