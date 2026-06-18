// Product UI semantic icon token layer.
// Maps semantic token names to Lucide icon keys so that business components
// reference a token ("workspace.main") instead of a raw Lucide name ("folder").
// This gives us a single place to manage icon semantics and prevents the same
// Lucide icon being used for unrelated concepts.

import type { IconName } from "./icon"

export const SemanticIconToken = {
  // === Workspace 类型 ===
  "workspace.main": "folder", // main checkout — uses folder to avoid clashing with Home session's home
  "workspace.worktree": "layers", // git worktree — layers suggests multi-checkout structure
  "workspace.branch": "git-branch", // git branch name — reserved for real git branch

  // === Session 运行时 ===
  "session.idle": "circle-check", // idle — quiet completed state
  "session.running": "activity", // running — activity reads as "active now" rather than "reload"
  "session.waiting": "shield-alert", // waiting for user — high visibility, must be obvious
  "session.child": "corner-down-left", // child session
  "session.background": "calendar-days", // background / agenda session
  "session.channel": "message-circle", // channel session
  "session.default": "file-text", // default session icon (transitional)

  // === 连接状态 ===
  "connection.holos": "orbit", // Holos identity / connection
  "connection.lsp": "braces", // language server
  "connection.mcp": "server", // MCP / external tool server
  "connection.cortex": "workflow", // background orchestration tasks

  // === 编排 ===
  "orchestration.dag": "workflow", // DAG tools (no longer git-branch)
  "orchestration.holos-branch": "git-merge", // Holos conversation branch (no longer git-branch)
} as const satisfies Record<string, IconName>

export type SemanticIconTokenName = keyof typeof SemanticIconToken

export function getSemanticIcon(token: SemanticIconTokenName): IconName {
  return SemanticIconToken[token]
}
