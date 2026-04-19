import { useEffect } from 'react'

interface FileConflictDialogProps {
  filePath: string
  onOverwrite: () => void
  onReload: () => void
  onCancel: () => void
}

export function FileConflictDialog({ filePath, onOverwrite, onReload, onCancel }: FileConflictDialogProps) {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onCancel() }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [onCancel])

  return (
    <div className="dialog-overlay" onClick={onCancel}>
      <div className="confirm-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="confirm-dialog-header">
          <h3>檔案衝突</h3>
        </div>
        <div className="confirm-dialog-body">
          <p className="confirm-dialog-message">「{filePath}」已被外部修改。</p>
          <p className="confirm-dialog-detail">
            <strong>覆寫</strong>：用你的內容蓋過磁碟版本。<br />
            <strong>重載</strong>：捨棄你的編輯，讀取磁碟最新內容。
          </p>
        </div>
        <div className="confirm-dialog-footer file-conflict-footer">
          <button className="dialog-btn cancel-btn" onClick={onCancel}>取消</button>
          <button className="dialog-btn secondary-btn" onClick={onReload}>重載</button>
          <button className="dialog-btn danger-btn" onClick={onOverwrite}>覆寫</button>
        </div>
      </div>
    </div>
  )
}
