import { useEffect, useState, useRef, useCallback } from 'react'
import type { TerminalInstance } from '../types'
import { ActivityIndicator } from './ActivityIndicator'

// Global preview cache - persists across component unmounts
const previewCache = new Map<string, string>()

// Event emitter for preview updates (event-driven instead of polling)
const previewUpdateEmitter = new EventTarget()

// Global listener setup - only once
let globalListenerSetup = false
const setupGlobalListener = () => {
  if (globalListenerSetup) return
  globalListenerSetup = true

  window.electronAPI.pty.onOutput((id, data) => {
    const prev = previewCache.get(id) || ''
    const combined = prev + data
    // Keep last 8 lines, clean ANSI codes for readability
    const cleaned = combined.replace(/\x1b\[[0-9;]*m/g, '')
    const lines = cleaned.split('\n').slice(-8)
    previewCache.set(id, lines.join('\n'))
    // Emit update event for the specific terminal
    previewUpdateEmitter.dispatchEvent(new CustomEvent('preview-update', { detail: id }))
  })
}

interface TerminalThumbnailProps {
  terminal: TerminalInstance
  isActive: boolean
  onClick: () => void
}

export function TerminalThumbnail({ terminal, isActive, onClick }: TerminalThumbnailProps) {
  const [preview, setPreview] = useState<string>(previewCache.get(terminal.id) || '')
  const isClaudeCode = terminal.type === 'claude-code'
  const debounceTimeoutRef = useRef<NodeJS.Timeout | null>(null)

  // Debounced update function to prevent excessive re-renders
  const updatePreview = useCallback(() => {
    if (debounceTimeoutRef.current) {
      clearTimeout(debounceTimeoutRef.current)
    }
    debounceTimeoutRef.current = setTimeout(() => {
      const cached = previewCache.get(terminal.id) || ''
      setPreview(cached)
    }, 100)
  }, [terminal.id])

  useEffect(() => {
    setupGlobalListener()

    // Event-driven updates instead of polling
    const handlePreviewUpdate = (e: Event) => {
      const updatedId = (e as CustomEvent).detail
      if (updatedId === terminal.id) {
        updatePreview()
      }
    }

    previewUpdateEmitter.addEventListener('preview-update', handlePreviewUpdate)

    return () => {
      previewUpdateEmitter.removeEventListener('preview-update', handlePreviewUpdate)
      if (debounceTimeoutRef.current) {
        clearTimeout(debounceTimeoutRef.current)
      }
    }
  }, [terminal.id, updatePreview])

  return (
    <div
      className={`thumbnail ${isActive ? 'active' : ''} ${isClaudeCode ? 'claude-code' : ''}`}
      onClick={onClick}
    >
      <div className="thumbnail-header">
        <div className={`thumbnail-title ${isClaudeCode ? 'claude-code' : ''}`}>
          {isClaudeCode && <span>✦</span>}
          <span>{terminal.title}</span>
        </div>
        <ActivityIndicator terminalId={terminal.id} size="small" />
      </div>
      <div className="thumbnail-preview">
        {preview || '$ _'}
      </div>
    </div>
  )
}
