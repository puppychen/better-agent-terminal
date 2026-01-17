import type { CodeAgentType } from '../types'

interface CodeAgentSelectDialogProps {
  onSelect: (type: CodeAgentType) => void
  onCancel: () => void
}

export function CodeAgentSelectDialog({ onSelect, onCancel }: CodeAgentSelectDialogProps) {
  return (
    <div className="dialog-overlay" onClick={onCancel}>
      <div className="dialog-content" onClick={(e) => e.stopPropagation()}>
        <div className="dialog-header">
          <h3>Select Code Agent</h3>
        </div>
        <div className="dialog-body">
          <button
            className="dialog-btn agent-btn"
            onClick={() => onSelect('happy')}
          >
            Happy
          </button>
          <button
            className="dialog-btn agent-btn"
            onClick={() => onSelect('claude')}
          >
            Claude Code
          </button>
          <button
            className="dialog-btn agent-btn"
            onClick={() => onSelect('claude-chrome')}
          >
            Claude + Chrome
          </button>
        </div>
        <div className="dialog-footer">
          <button className="dialog-btn cancel-btn" onClick={onCancel}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  )
}
