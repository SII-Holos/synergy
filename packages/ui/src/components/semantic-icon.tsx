// Product UI semantic icon token layer.
// Maps semantic token names to Lucide icon keys so that business components
// reference a token ("workspace.main") instead of a raw Lucide name ("folder").
// This gives us a single place to manage icon semantics and prevents the same
// Lucide icon being used for unrelated concepts.

import type { IconName } from "./icon"

export const SemanticIconToken = {
  // Workspace
  "workspace.main": "home",
  "workspace.worktree": "git-fork",
  "workspace.branch": "git-branch",

  // Session runtime
  "session.idle": "circle",
  "session.running": "loader-circle",
  "session.retry": "octagon-alert",
  "session.waiting": "help-circle",
  "session.child": "arrow-down-from-line",
  "session.background": "calendar-days",
  "session.channel": "message-circle", // channel session
  "session.default": "message-square",

  // Prompt composer
  "prompt.attach": "paperclip",
  "prompt.plan": "list-checks",

  // Connection state
  "connection.holos": "satellite",
  "connection.lsp": "braces", // language server
  "connection.mcp": "cable",
  "connection.cortex": "workflow", // background orchestration tasks

  // Orchestration
  "orchestration.blueprint": "clipboard-list",
  "orchestration.dag": "route",
  "orchestration.holos-branch": "git-merge", // Holos conversation branch (no longer git-branch)

  // Settings
  "settings.account": "user",
  "settings.profile": "user-round-pen",
  "settings.holos": "satellite",
  "settings.general": "sliders-horizontal",
  "settings.appearance": "sun",
  "settings.colorSystem": "monitor",
  "settings.colorLight": "sun",
  "settings.colorDark": "moon",
  "settings.models": "cpu",
  "settings.providers": "server",
  "settings.usage": "gauge",
  "settings.learning": "book-open",
  "settings.memory": "brain",
  "settings.experience": "lightbulb",
  "settings.agents": "bot",
  "settings.commands": "terminal",
  "settings.instructions": "file-text",
  "settings.mcp": "cable",
  "settings.channels": "globe",
  "settings.email": "mail",
  "settings.permissions": "shield-check",
  "settings.sandbox": "lock-keyhole",
  "settings.controlProfile": "scale",
  "settings.questions": "help-circle",
  "settings.compaction": "list-collapse",
  "settings.timeouts": "clock",
  "settings.formatter": "file-pen",
  "settings.lsp": "braces",
  "settings.observability": "stethoscope",
  "settings.diagnostics": "activity",
  "settings.import": "upload",
  "settings.configFiles": "folder",

  // App shell and navigation
  "app.sidebar": "panel-left",
  "app.sideWorkspace": "panel-right",
  "app.bottomSpace": "panel-bottom",
  "app.statusBar": "panel-bottom",
  "app.statusBar.toggle": "panel-bottom-open",
  "app.plugins": "package",
  "product.update": "download",
  "product.update.install": "rotate-cw",
  "window.minimize": "minimize",
  "window.maximize": "maximize",
  "window.restore": "shrink",
  "window.close": "x",
  "navigation.back": "arrow-left",
  "navigation.expand": "chevron-right",
  "navigation.collapse": "chevron-down",

  // Notes
  "notes.main": "notebook-pen",
  "notes.create": "square-pen",
  "notes.search": "scan-search",

  // Browser
  "browser.main": "globe",
  "browser.back": "arrow-left",
  "browser.forward": "arrow-right",
  "browser.refresh": "refresh-ccw",
  "browser.stop": "circle-stop",

  // Generic actions and state
  "action.add": "plus",
  "action.close": "x",
  "action.copy": "copy",
  "action.open": "arrow-up-right",
  "action.more": "ellipsis",
  "action.info": "help-circle",
  "action.search": "search",
  "action.remove": "trash-2",
  "action.refresh": "refresh-ccw",
  "account.create": "user-plus",
  "account.import": "key-round",
  "account.logout": "arrow-left",
  "account.repository": "github",
  "state.success": "check",
  "state.empty": "circle",
  "state.warning": "octagon-alert",
  "state.error": "ban",
} as const satisfies Record<string, IconName>

export type SemanticIconTokenName = keyof typeof SemanticIconToken

export function getSemanticIcon(token: SemanticIconTokenName): IconName {
  return SemanticIconToken[token] as IconName
}
