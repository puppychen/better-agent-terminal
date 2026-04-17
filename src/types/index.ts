// Code Agent type for external Terminal
export type CodeAgentType = 'claude';

export interface Workspace {
  id: string;
  name: string;
  alias?: string;
  role?: string;
  folderPath: string;
  createdAt: number;
  group?: string;
  claudeSessionId?: string;
  /** sessionId → user-given label。手動命名 agent terminal 後寫入；resume 同 sessionId 時自動套用 + 鎖定 */
  claudeSessionLabels?: Record<string, string>;
}

// Preset roles for quick selection
export const PRESET_ROLES = [
  { id: 'iris', name: 'Iris', color: '#7bbda4' },
  { id: 'irisgo-pm', name: 'IrisGo PM', color: '#8ab3b5' },
  { id: 'lucy', name: 'Lucy', color: '#a89bb9' },
  { id: 'veda', name: 'Veda', color: '#f4bc87' },
  { id: 'exia', name: 'Exia', color: '#cb6077' },
  { id: 'leo', name: 'Leo', color: '#beb55b' },
  { id: 'custom', name: 'Custom', color: '#dfdbc3' },
] as const;

export interface AppState {
  workspaces: Workspace[];
  activeWorkspaceId: string | null;
}

// === 嵌入式終端型別 ===

export interface TerminalInstance {
  id: string;
  workspaceId: string;
  label: string;
  type: 'shell' | 'agent';
  agentType?: CodeAgentType;
  cwd: string;
  createdAt: number;
  unread?: boolean;
  /** Claude session UUID — 對應 ~/.claude/projects/<encoded>/<id>.jsonl */
  claudeSessionId?: string;
  /** 用戶手動改過 label 後設 true，停止自動跟隨 sessions-index summary */
  labelLockedByUser?: boolean;
}

export interface CreatePtyOptions {
  id: string;
  cwd: string;
  type: 'shell' | 'agent';
  agentType?: CodeAgentType;
  shell?: string;
  initialCommand?: string;
}

export interface TerminalState {
  terminals: TerminalInstance[];
  activeTerminalId: string | null;
}
