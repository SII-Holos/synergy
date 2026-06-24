// Product UI semantic icon token layer.
// Maps semantic token names to Lucide icon keys so that business components
// reference a token ("workspace.main") instead of a raw Lucide name ("folder").
// This gives us a single place to manage icon semantics and prevents the same
// Lucide icon being used for unrelated concepts.

import type { IconName } from "./icon"

export const SemanticIconToken = {
  // === Workspace 类型 ===
  "workspace.main": "home", // main checkout — home is the root / primary workspace
  "workspace.worktree": "git-fork", // git worktree — fork = parallel checkout, independent branch
  "workspace.branch": "git-branch", // git branch name — reserved for real git branch

  // === Session 运行时 ===
  "session.idle": "circle", // idle — empty circle, neutral rest state
  "session.running": "loader-circle", // running — partial arc indicates in-progress
  "session.waiting": "help-circle", // waiting for user — question circle, expects input
  "session.child": "arrow-down-from-line", // child session — derived from parent, vertical lineage
  "session.background": "calendar-days", // background / agenda session
  "session.channel": "message-circle", // channel session
  "session.default": "message-square", // default session — it's a conversation

  // === 连接状态 ===
  "connection.holos": "satellite", // Holos identity / connection — satellite node in orbit, distinct from auto-orbit
  "connection.lsp": "braces", // language server
  "connection.mcp": "cable", // MCP connection — protocol cable, consistent with settings/navigation
  "connection.cortex": "workflow", // background orchestration tasks

  // === 编排 ===
  "orchestration.blueprint": "scroll-text", // Blueprint design document — distinct from Cortex workflow runtime
  "orchestration.dag": "route", // DAG execution path
  "orchestration.holos-branch": "git-merge", // Holos conversation branch (no longer git-branch)
} as const satisfies Record<string, IconName>

export type SemanticIconTokenName = keyof typeof SemanticIconToken

export function getSemanticIcon(token: SemanticIconTokenName): IconName {
  return SemanticIconToken[token] as IconName
}
