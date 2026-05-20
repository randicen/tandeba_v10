export type MessageRole = "system" | "user" | "assistant" | "tool";

export interface AgentMessage {
  id: string;
  role: MessageRole;
  content: string | Array<{ type: string; text?: string; image_url?: { url: string } }> | null;
  name?: string;
  reasoning_content?: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  isHumanIntervention?: boolean;
}

export interface ToolCall {
  id: string;
  function?: {
    name: string;
    arguments: string;
  };
}

export interface AgentSession {
  id: string;
  name: string;
  messages: AgentMessage[];
  status: "idle" | "running" | "waiting_human" | "error";
  createdAt: number;
  updatedAt: number;
}

export interface SessionSummary {
  id: string;
  name: string;
  status: string;
  createdAt: number;
  updatedAt: number;
}

export interface WorkspaceFile {
  name: string;
  isDirectory: boolean;
  path: string;
  updatedAt: number;
}

export interface ToolResult {
  success: boolean;
  data?: string;
  message?: string;
}

export interface DocComment {
  id: string;
  text: string;
  replies: string[];
  author: string;
  timestamp: Date;
  resolved?: boolean;
  liked?: boolean;
}

export interface SelectionBox {
  top: number;
  left: number;
  text: string;
  range: Range;
  context?: string;
}

export interface PromptConfig {
  type: 'create' | 'rename' | 'delete';
  target?: string;
  inputValue: string;
  isOpen: boolean;
}

export interface FormattingSettings {
  margins?: {
    top?: number;
    right?: number;
    bottom?: number;
    left?: number;
  };
  pageSize?: {
    width?: number;
    height?: number;
  };
}
