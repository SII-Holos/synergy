export type SynergyCapabilityRisk = "low" | "medium" | "high"

export const SYNERGY_CAPABILITY_CATEGORIES = [
  "tools",
  "files",
  "network",
  "data",
  "ui",
  "runtime",
  "hooks",
  "session",
  "browser",
  "identity",
  "communication",
  "platform",
] as const

export type SynergyCapabilityCategory = (typeof SYNERGY_CAPABILITY_CATEGORIES)[number]

export interface SynergyCapabilityDefinition {
  category: SynergyCapabilityCategory
  severity: SynergyCapabilityRisk
  title: string
  description: string
  technical?: string
  nonBypassable?: boolean
}

export const SYNERGY_CAPABILITY_DETAILS: Record<string, SynergyCapabilityDefinition> = {
  shell_read: {
    category: "runtime",
    severity: "low",
    title: "Run read-only shell commands",
    description: "Can run shell commands classified as read-only.",
  },
  shell: {
    category: "runtime",
    severity: "medium",
    title: "Run shell commands",
    description: "Can execute non-destructive shell commands in the current workspace.",
  },
  shell_branch_mutation: {
    category: "runtime",
    severity: "medium",
    title: "Change active branch in workspace",
    description:
      "Can run git checkout / git switch to change the active branch, which is safe in worktrees but can corrupt concurrent sessions on the main checkout.",
  },
  shell_remote_write: {
    category: "runtime",
    severity: "medium",
    title: "Run remote-write shell commands",
    description: "Can modify existing remote state outside ordinary branch/PR publication workflows.",
  },
  shell_remote_execute: {
    category: "runtime",
    severity: "high",
    title: "Execute commands on remote host",
    description: "Can run bash/process commands on a remote Synergy Link host.",
    nonBypassable: true,
  },
  shell_remote_publish: {
    category: "runtime",
    severity: "medium",
    title: "Publish development changes",
    description:
      "Can push explicit non-protected branches, create pull requests, comment on PRs/issues, and create issues without destructive remote updates.",
  },
  shell_destructive: {
    category: "runtime",
    severity: "high",
    title: "Run destructive shell commands",
    description: "Can run commands that may delete, overwrite, or rewrite important local state.",
    nonBypassable: true,
  },
  shell_hardline: {
    category: "runtime",
    severity: "high",
    title: "Run forbidden shell commands",
    description: "Matches shell commands that Synergy treats as a hard safety boundary.",
    nonBypassable: true,
  },
  file_write: {
    category: "files",
    severity: "medium",
    title: "Write workspace files",
    description: "Can create, modify, or delete files in your workspace.",
  },
  file_read: {
    category: "files",
    severity: "low",
    title: "Read workspace files",
    description: "Can read files and directories in your workspace.",
  },
  file_external_read: {
    category: "files",
    severity: "low",
    title: "Read external files",
    description: "Can read files outside the active workspace.",
  },
  file_external_write: {
    category: "files",
    severity: "high",
    title: "Write external files",
    description: "Can create, modify, or delete files outside the active workspace.",
    nonBypassable: true,
  },
  network_read: {
    category: "network",
    severity: "low",
    title: "Read from network",
    description: "Can fetch or search public network resources without mutating remote state.",
  },
  network_request: {
    category: "network",
    severity: "medium",
    title: "Access network",
    description: "Can make outbound network requests.",
  },
  mcp_spawn: {
    category: "runtime",
    severity: "medium",
    title: "Spawn MCP servers",
    description: "Can start and manage MCP server processes.",
    nonBypassable: true,
  },
  mcp_invoke: {
    category: "tools",
    severity: "medium",
    title: "Invoke MCP tools",
    description: "Can call tools exposed by MCP servers.",
    nonBypassable: true,
  },
  session_data: {
    category: "data",
    severity: "low",
    title: "Read session data",
    description: "Can access session metadata and message history.",
  },
  workspace_data: {
    category: "data",
    severity: "low",
    title: "Read workspace metadata",
    description: "Can access workspace metadata and directory information.",
  },
  "config:write": {
    category: "data",
    severity: "medium",
    title: "Write configuration",
    description: "Can modify global Synergy configuration values.",
  },
  "config:read": {
    category: "data",
    severity: "low",
    title: "Read configuration",
    description: "Can read Synergy configuration values.",
  },
  secrets: {
    category: "data",
    severity: "high",
    title: "Access stored credentials",
    description: "Can read stored API keys, tokens, and other credentials.",
    nonBypassable: true,
  },
  task: {
    category: "tools",
    severity: "low",
    title: "Delegate tasks to subagents",
    description: "Runtime control-profile permission to launch an approved Synergy subagent.",
  },
  "blueprint.delegate": {
    category: "runtime",
    severity: "high",
    title: "Delegate Blueprint runs",
    description: "Can create and control BlueprintLoop executions in an existing Session.",
  },
  "lightloop.delegate": {
    category: "runtime",
    severity: "high",
    title: "Enable Light Loop",
    description: "Can enable the Light Loop workflow in an existing Session.",
  },
  prompt_transform: {
    category: "hooks",
    severity: "high",
    title: "Transform prompts",
    description: "Can modify the system prompt and message context sent to the LLM.",
  },
  compaction_transform: {
    category: "hooks",
    severity: "high",
    title: "Transform compaction",
    description: "Can modify session compaction inputs and outputs.",
  },
  tool_execution_hook: {
    category: "hooks",
    severity: "medium",
    title: "Intercept tool execution",
    description: "Can rewrite tool arguments or outputs within its declared hook scope.",
  },
  permission_hook: {
    category: "hooks",
    severity: "high",
    title: "Override permission decisions",
    description: "Can allow or deny permission requests within its declared hook scope.",
  },
  event_hook: {
    category: "hooks",
    severity: "medium",
    title: "Subscribe to Synergy events",
    description: "Can receive approved Synergy runtime events.",
  },
  config_hook: {
    category: "hooks",
    severity: "medium",
    title: "Observe runtime config",
    description: "Can receive redacted runtime configuration snapshots when Synergy starts or reloads config.",
  },
  session_state: {
    category: "session",
    severity: "low",
    title: "Update session state",
    description: "Can update local session coordination state.",
  },
  browser_interact: {
    category: "browser",
    severity: "medium",
    title: "Interact with browser",
    description: "Can click, type, scroll, or otherwise interact with the browser workspace.",
  },
  browser_inspect: {
    category: "browser",
    severity: "low",
    title: "Inspect browser",
    description: "Can inspect browser page state, screenshots, console, or network metadata.",
  },
  browser_eval_readonly: {
    category: "browser",
    severity: "medium",
    title: "Evaluate read-only browser code",
    description: "Can run read-only JavaScript inspection in the browser workspace.",
  },
  browser_eval_trusted: {
    category: "browser",
    severity: "high",
    title: "Evaluate trusted browser code",
    description: "Can run privileged JavaScript in the browser workspace.",
    nonBypassable: true,
  },
  browser_clipboard: {
    category: "browser",
    severity: "medium",
    title: "Use browser clipboard",
    description: "Can read from or write to browser clipboard state.",
  },
  browser_upload: {
    category: "browser",
    severity: "high",
    title: "Upload files to browser",
    description: "Can transfer approved workspace file content into the current browser page.",
    nonBypassable: true,
  },
  browser_coordinate: {
    category: "browser",
    severity: "medium",
    title: "Use browser coordinates",
    description: "Can interact with a browser page using visual coordinates instead of semantic locators.",
  },
  browser_download: {
    category: "browser",
    severity: "medium",
    title: "Download browser files",
    description: "Can download files through the browser workspace.",
  },
  browser_emulation: {
    category: "browser",
    severity: "low",
    title: "Emulate a browser environment",
    description: "Can change browser viewport, device, locale, media, CPU, and network emulation.",
  },
  identity_act: {
    category: "identity",
    severity: "high",
    title: "Act as an identity",
    description: "Can perform actions under a user or agent identity.",
    nonBypassable: true,
  },
  communication_email: {
    category: "communication",
    severity: "high",
    title: "Use email",
    description: "Can read or send email through configured accounts.",
    nonBypassable: true,
  },
  channel_outbound: {
    category: "communication",
    severity: "high",
    title: "Send outbound channel messages",
    description: "Can send messages through configured external channels.",
    nonBypassable: true,
  },
  platform_control: {
    category: "platform",
    severity: "high",
    title: "Control platform integrations",
    description: "Can modify or control platform-level integrations.",
    nonBypassable: true,
  },
  protected_op: {
    category: "platform",
    severity: "high",
    title: "Protected operation",
    description: "Touches a protected Synergy safety boundary.",
    nonBypassable: true,
  },
}

export const SYNERGY_PROFILE_CAPABILITIES = [
  "file_read",
  "file_write",
  "shell_read",
  "shell",
  "shell_branch_mutation",
  "shell_remote_execute",
  "shell_remote_publish",
  "shell_remote_write",
  "shell_destructive",
  "shell_hardline",
  "file_external_read",
  "file_external_write",
  "network_read",
  "network_request",
  "mcp_invoke",
  "mcp_spawn",
  "session_data",
  "workspace_data",
  "config:read",
  "config:write",
  "secrets",
  "task",
  "prompt_transform",
  "compaction_transform",
  "tool_execution_hook",
  "permission_hook",
  "event_hook",
  "config_hook",
  "identity_act",
  "communication_email",
  "channel_outbound",
  "platform_control",
  "protected_op",
  "session_state",
  "browser_interact",
  "browser_inspect",
  "browser_eval_readonly",
  "browser_eval_trusted",
  "browser_clipboard",
  "browser_upload",
  "browser_coordinate",
  "browser_download",
  "browser_emulation",
] as const

export const SYNERGY_PERMISSION_CAPABILITY: Record<string, string> = {
  read: "file_read",
  view_file: "file_read",
  scan_files: "file_read",
  parse_code: "file_read",
  grep: "file_read",
  file_search: "file_read",
  glob: "file_read",
  list: "file_read",
  edit: "file_write",
  write: "file_write",
  revise_file: "file_write",
  save_file: "file_write",
  bash: "shell",
  external_directory: "file_external_read",
  webfetch: "network_read",
  websearch: "network_read",
  arxiv_search: "network_read",
  arxiv_download: "network_read",
  download: "network_read",
  network_request: "network_request",
  scan_document: "file_read",
  look_at: "file_read",
  view_image: "file_read",
  attach: "file_read",
  ast_grep: "file_read",
  lsp: "file_read",
  dagread: "file_read",
  todoread: "file_read",
  task_list: "file_read",
  task_output: "file_read",
  question: "file_read",
  skill: "file_read",
  render: "file_read",
  diagram: "file_read",
  agenda_list: "file_read",
  agenda_logs: "file_read",
  session_list: "file_read",
  session_search: "file_read",
  session_read: "file_read",
  note_list: "file_read",
  note_search: "file_read",
  note_read: "file_read",
  memory_search: "file_read",
  memory_get: "file_read",
  worktree_list: "file_read",
  dagwrite: "session_state",
  dagpatch: "session_state",
  todowrite: "session_state",
  task_cancel: "session_state",
  batch: "session_state",
  doom_loop: "session_state",
  worktree_enter: "file_write",
  worktree_leave: "file_write",
  session_data: "session_data",
  workspace_data: "workspace_data",
  "config:read": "config:read",
  "config:write": "config:write",
  secrets: "secrets",
  email_read: "communication_email",
  email_send: "communication_email",
  communication_email: "communication_email",
  session_send: "identity_act",
  channel_outbound: "channel_outbound",
  identity_act: "identity_act",
  platform_control: "platform_control",
}

export function permissionCapability(permission: string): string {
  return SYNERGY_PERMISSION_CAPABILITY[permission] ?? permission
}

export function capabilityNonBypassable(capability: string): boolean {
  return SYNERGY_CAPABILITY_DETAILS[capability]?.nonBypassable === true
}

export function capabilityRisk(capability: string): SynergyCapabilityRisk {
  return SYNERGY_CAPABILITY_DETAILS[capability]?.severity ?? "high"
}

export function permissionCategoryForKey(key: string): SynergyCapabilityCategory {
  const details = SYNERGY_CAPABILITY_DETAILS[key]
  if (details) return details.category
  if (key.startsWith("ui.")) return "ui"
  if (key.startsWith("hooks.")) return "hooks"
  if (key.startsWith("data.")) return "data"
  if (key.startsWith("runtime.")) return "runtime"
  if (key.startsWith("session.")) return "session"
  if (key.startsWith("browser.")) return "browser"
  return "tools"
}
