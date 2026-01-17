import type { CodeAgentType } from '../types'

interface CodeAgentSelectDialogProps {
  onSelect: (type: CodeAgentType) => void
  onCancel: () => void
}

export function CodeAgentSelectDialog({ onSelect, onCancel }: CodeAgentSelectDialogProps) {
  return (
    <div className="dialog-overlay" onClick={onCancel}>
      <div className="dialog code-agent-select" onClick={e => e.stopPropagation()}>
        <h3>Select Code Agent</h3>
        <p>Choose your AI programming assistant:</p>

        <div className="agent-options">
          <button className="agent-option" onClick={() => onSelect('happy')}>
            <div className="agent-icon">H</div>
            <div className="agent-info">
              <div className="agent-name">Happy</div>
              <div className="agent-desc">Connect via happy.engineering</div>
            </div>
          </button>

          <button className="agent-option" onClick={() => onSelect('claude')}>
            <div className="agent-icon">C</div>
            <div className="agent-info">
              <div className="agent-name">Claude</div>
              <div className="agent-desc">Run local claude CLI directly</div>
            </div>
          </button>

          <button className="agent-option" onClick={() => onSelect('claude-chrome')}>
            <div className="agent-icon">CC</div>
            <div className="agent-info">
              <div className="agent-name">Claude with Chrome</div>
              <div className="agent-desc">Claude CLI with Chrome MCP integration</div>
            </div>
          </button>
        </div>

        <div className="dialog-actions">
          <button className="dialog-btn cancel" onClick={onCancel}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  )
}
