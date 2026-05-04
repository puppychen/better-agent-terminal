/**
 * Markdown 渲染 lazy runtime
 *
 * 動態載入 markdown-it + inject-linenumbers plugin。
 * 第一次呼叫才下載 chunk，之後 cache 命中。
 * 渲染後的 HTML 會在 block 元素上掛 data-source-line 屬性，供雙向行級捲動同步使用。
 */

import type MarkdownIt from 'markdown-it'

export interface MarkdownRuntime {
  md: MarkdownIt
  render: (src: string) => string
}

let runtimePromise: Promise<MarkdownRuntime> | null = null

export function loadMarkdownRuntime(): Promise<MarkdownRuntime> {
  if (runtimePromise) return runtimePromise
  runtimePromise = Promise.all([
    import('markdown-it'),
    import('markdown-it-inject-linenumbers')
  ]).then(([MdMod, plugMod]) => {
    const MarkdownItCtor = (MdMod as any).default || MdMod
    const plugin = (plugMod as any).default || plugMod
    const md: MarkdownIt = new MarkdownItCtor({
      html: false,
      linkify: false,
      typographer: false,
      breaks: false
    }).use(plugin)
    return { md, render: (src: string) => md.render(src) }
  })
  return runtimePromise
}
