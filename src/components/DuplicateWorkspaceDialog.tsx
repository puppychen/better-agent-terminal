interface DuplicateWorkspaceDialogProps {
  folderPath: string
  existingName: string
  existingTabName: string
  onGoToExisting: () => void
  onAddAnyway: () => void
  onCancel: () => void
}

export function DuplicateWorkspaceDialog({
  folderPath,
  existingName,
  existingTabName,
  onGoToExisting,
  onAddAnyway,
  onCancel
}: DuplicateWorkspaceDialogProps) {
  return (
    <div className="dialog-overlay" onClick={onCancel}>
      <div className="dialog-content" onClick={(e) => e.stopPropagation()}>
        <div className="dialog-header">
          <h3>Workspace 已存在</h3>
        </div>
        <div className="dialog-body">
          <p className="duplicate-dialog-path">{folderPath}</p>
          <p className="duplicate-dialog-info">
            已存在於 <strong>{existingTabName}</strong> 分頁，名稱為 <strong>{existingName}</strong>
          </p>
        </div>
        <div className="dialog-footer">
          <button className="dialog-btn primary-btn" onClick={onGoToExisting}>
            跳轉到既有
          </button>
          <button className="dialog-btn secondary-btn" onClick={onAddAnyway}>
            仍然新增
          </button>
          <button className="dialog-btn cancel-btn" onClick={onCancel}>
            取消
          </button>
        </div>
      </div>
    </div>
  )
}
