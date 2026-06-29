import { Log } from "../util/log"
import z from "zod"
import { DEFAULT_PLUGIN_MARKETPLACE_CONFIG } from "@ericsanchezok/synergy-plugin/market"
import { DEFAULT_PLUGIN_RUNTIME_LIMITS, DEFAULT_PLUGIN_RUNTIME_POLICY } from "@ericsanchezok/synergy-plugin/policy"
import { ModelsDev } from "../provider/models"
import { LSPServer } from "../lsp/server"
import { ModelRole } from "../provider/model-role"

export const McpRetry = z
  .object({
    maxAttempts: z.number().int().positive().optional().describe("Maximum connection attempts before giving up"),
    backoffMs: z.number().int().positive().optional().describe("Initial backoff delay in ms between retries"),
    backoffMultiplier: z.number().positive().optional().describe("Multiplier applied to backoff on each retry"),
    cooldownMs: z.number().int().nonnegative().optional().describe("Cooldown period in ms before a retry cycle resets"),
  })
  .strict()
  .meta({ ref: "McpRetryConfig" })
export type McpRetry = z.infer<typeof McpRetry>

export const McpToolFilter = z
  .object({
    include: z.array(z.string()).optional().describe("Tool names to include (allowlist)"),
    exclude: z.array(z.string()).optional().describe("Tool names to exclude (blocklist)"),
  })
  .strict()
  .meta({ ref: "McpToolFilterConfig" })
export type McpToolFilter = z.infer<typeof McpToolFilter>

export const McpTools = z
  .object({
    approval: z.enum(["auto", "always", "per_session"]).optional().describe("Tool approval mode"),
    maxOutputBytes: z.number().int().positive().optional().describe("Maximum tool output size in bytes"),
  })
  .strict()
  .meta({ ref: "McpToolsConfig" })
export type McpTools = z.infer<typeof McpTools>

export const McpToolCache = z
  .object({
    mode: z.enum(["disabled", "session", "persistent"]).optional().describe("Tool list caching mode"),
    ttlMs: z.number().int().positive().optional().describe("Time-to-live for cached tool list in ms"),
  })
  .strict()
  .meta({ ref: "McpToolCacheConfig" })
export type McpToolCache = z.infer<typeof McpToolCache>

const McpLifecycleFields = {
  startup: z.enum(["eager", "lazy", "manual"]).optional().describe("MCP startup mode"),
  required: z.boolean().optional().describe("If true, this MCP server is required for the configured workflow"),
  connectTimeout: z.number().int().positive().optional().describe("Timeout in ms for initial connection handshake"),
  listTimeout: z.number().int().positive().optional().describe("Timeout in ms for listing tools"),
  callTimeout: z.number().int().positive().optional().describe("Timeout in ms for tool call execution"),
  retry: McpRetry.optional().describe("Retry policy for connecting to this server"),
  idleShutdownMs: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Idle time in ms after which the server is shut down"),
  toolFilter: McpToolFilter.optional().describe("Filter which tools are exposed from this server"),
  tools: McpTools.optional().describe("Tool execution behavior config"),
  toolCache: McpToolCache.optional().describe("Tool list caching behavior"),
} satisfies z.core.$ZodLooseShape

export const McpLocal = z
  .object({
    type: z.literal("local").describe("Type of MCP server connection"),
    command: z.string().array().describe("Command and arguments to run the MCP server"),
    cwd: z.string().optional().describe("Working directory for local MCP servers"),
    environment: z
      .record(z.string(), z.string())
      .optional()
      .describe("Environment variables to set when running the MCP server"),
    enabled: z.boolean().optional().describe("Enable or disable the MCP server on startup"),
    timeout: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("Deprecated legacy timeout in ms for MCP operations. Prefer connectTimeout/listTimeout/callTimeout."),
    ...McpLifecycleFields,
  })
  .strict()
  .meta({
    ref: "McpLocalConfig",
  })

export const McpOAuth = z
  .object({
    clientId: z
      .string()
      .optional()
      .describe("OAuth client ID. If not provided, dynamic client registration (RFC 7591) will be attempted."),
    clientSecret: z.string().optional().describe("OAuth client secret (if required by the authorization server)"),
    scope: z.string().optional().describe("OAuth scopes to request during authorization"),
  })
  .strict()
  .meta({
    ref: "McpOAuthConfig",
  })
export type McpOAuth = z.infer<typeof McpOAuth>

export const McpRemote = z
  .object({
    type: z.literal("remote").describe("Type of MCP server connection"),
    url: z.string().describe("URL of the remote MCP server"),
    enabled: z.boolean().optional().describe("Enable or disable the MCP server on startup"),
    headers: z.record(z.string(), z.string()).optional().describe("Headers to send with the request"),
    oauth: z
      .union([McpOAuth, z.literal(false)])
      .optional()
      .describe("OAuth authentication configuration for the MCP server. Set to false to disable OAuth auto-detection."),
    timeout: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("Deprecated legacy timeout in ms for MCP operations. Prefer connectTimeout/listTimeout/callTimeout."),
    ...McpLifecycleFields,
  })
  .strict()
  .meta({
    ref: "McpRemoteConfig",
  })

export const Mcp = z.discriminatedUnion("type", [McpLocal, McpRemote])
export type Mcp = z.infer<typeof Mcp>

export const McpDefaults = z.object(McpLifecycleFields).strict().meta({ ref: "McpDefaultsConfig" })
export type McpDefaults = z.infer<typeof McpDefaults>

export const FeishuGroupSessionScope = z
  .enum(["group", "group_sender", "group_topic", "group_topic_sender"])
  .describe(
    "How group chat sessions are scoped: group = shared, group_sender = per sender, group_topic = per thread/topic, group_topic_sender = per thread+sender",
  )
export type FeishuGroupSessionScope = z.infer<typeof FeishuGroupSessionScope>

export const ChannelFeishuAccount = z
  .object({
    enabled: z.boolean().optional().default(true),
    appId: z.string().describe("Feishu app ID"),
    appSecret: z.string().describe("Feishu app secret"),
    domain: z.enum(["feishu", "lark"]).optional().describe("Feishu domain (feishu for China, lark for international)"),
    allowDM: z.boolean().optional().default(true).describe("Allow direct messages"),
    allowGroup: z.boolean().optional().default(true).describe("Allow group messages"),
    requireMention: z.boolean().optional().default(true).describe("Require @mention in group chats"),
    botOpenId: z.string().optional().describe("Bot open_id used to verify real @mentions in group chats"),
    streaming: z.boolean().optional().default(true).describe("Enable streaming card updates"),
    streamingThrottleMs: z
      .number()
      .int()
      .positive()
      .optional()
      .default(100)
      .describe("Minimum interval between streaming card updates in ms"),
    groupSessionScope: FeishuGroupSessionScope.optional()
      .default("group")
      .describe("Session scoping strategy for group chats"),
    inboundDebounceMs: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .default(0)
      .describe("Debounce rapid-fire messages from the same sender in the same chat (0 = disabled)"),
    resolveSenderNames: z
      .boolean()
      .optional()
      .default(true)
      .describe("Resolve sender display names via Feishu contact API"),
    replyInThread: z.boolean().optional().default(false).describe("Reply in thread when message is part of a topic"),
  })
  .strict()
  .meta({ ref: "ChannelFeishuAccountConfig" })
export type ChannelFeishuAccount = z.infer<typeof ChannelFeishuAccount>

export const ChannelFeishu = z
  .object({
    type: z.literal("feishu"),
    accounts: z.record(z.string(), ChannelFeishuAccount),
    domain: z.enum(["feishu", "lark"]).optional().describe("Default domain for all accounts"),
    streaming: z.boolean().optional().default(true).describe("Default streaming setting for all accounts"),
  })
  .strict()
  .meta({ ref: "ChannelFeishuConfig" })
export type ChannelFeishu = z.infer<typeof ChannelFeishu>

export const Holos = z
  .object({
    enabled: z.boolean().optional().default(true).describe("Enable the Holos runtime connection"),
    apiUrl: z.string().optional().default("https://api.holosai.io").describe("Holos API base URL"),
    wsUrl: z.string().optional().default("wss://api.holosai.io").describe("Holos WebSocket base URL"),
    portalUrl: z
      .string()
      .optional()
      .default("https://www.holosai.io")
      .describe("Holos portal URL for browser-facing pages (bind/start)"),
  })
  .strict()
  .meta({ ref: "HolosConfig" })
export type Holos = z.infer<typeof Holos>

export const SandboxConfig = z
  .object({
    enabled: z.boolean().optional().describe("Enable the sandbox runtime when available (default: true)"),
    fallbackPolicy: z
      .enum(["warn", "allow", "deny"])
      .optional()
      .describe("How to proceed when the requested sandbox runtime is unavailable (default: 'warn')"),
    backend: z
      .enum([
        "auto",
        "seatbelt-deny-default",
        "seatbelt-legacy-allow-default",
        "synergy-sandbox-linux",
        "bwrap-inline-debug",
        "windows-restricted-token",
        "windows-elevated",
      ])
      .optional()
      .describe(
        "Force a specific sandbox backend. 'auto' (default) selects the platform-native backend. " +
          "Valid: 'auto' (platform default), 'seatbelt-deny-default' (macOS deny-default SBPL), " +
          "'seatbelt-legacy-allow-default' (macOS allow-default SBPL), " +
          "'synergy-sandbox-linux' (Linux bundled bwrap), 'bwrap-inline-debug' (Linux in-tree bwrap debug), " +
          "'windows-restricted-token' (Windows MVP), 'windows-elevated' (Windows full, future).",
      ),
    network: z
      .object({
        mode: z
          .enum(["restricted", "proxy_only", "full"])
          .optional()
          .describe("Network access mode within the sandbox (default: 'restricted')"),
      })
      .strict()
      .optional()
      .describe("Network configuration for sandbox enforcement"),
    macos: z
      .object({
        denialLogger: z.boolean().optional().describe("Log sandbox denials via macOS Seatbelt (default: true)"),
      })
      .strict()
      .optional()
      .describe("macOS-specific sandbox settings"),
    linux: z
      .object({
        bundledBwrap: z
          .boolean()
          .optional()
          .describe("Use the bundled bwrap binary instead of system bwrap (default: true)"),
        landlockFallback: z
          .boolean()
          .optional()
          .describe("Fall back to Landlock LSM when bwrap is unavailable (default: true)"),
      })
      .strict()
      .optional()
      .describe("Linux-specific sandbox settings"),
    windows: z
      .object({
        level: z
          .enum(["disabled", "restricted-token", "elevated"])
          .optional()
          .describe("Windows sandbox level (default: 'restricted-token')"),
        helperPath: z.string().optional().describe("Path to the synergy-sandbox-windows.exe helper binary"),
        verifyHelperHash: z
          .boolean()
          .optional()
          .describe("Verify the helper binary SHA-256 hash before use (default: true)"),
        privateDesktop: z
          .boolean()
          .optional()
          .describe("Create a private desktop for the sandboxed process (default: true)"),
        conpty: z.boolean().optional().describe("Use ConPTY for pseudo-terminal support (default: true)"),
      })
      .strict()
      .optional()
      .describe("Windows-specific sandbox settings"),
  })
  .strict()
  .meta({ ref: "SandboxConfig" })
export type SandboxConfig = z.infer<typeof SandboxConfig>

export const ObservabilityConfig = z
  .object({
    enabled: z.boolean().optional().describe("Enable local observability trace JSONL events (default: true)"),
    retentionDays: z.number().int().positive().optional().describe("Days to retain local trace files (default: 7)"),
    maxBytes: z.number().int().positive().optional().describe("Maximum total trace storage in bytes (default: 250MB)"),
    stalledToolMs: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("Milliseconds without tool activity before emitting a stalled-tool trace event"),
  })
  .strict()
  .meta({ ref: "ObservabilityConfig" })
export type ObservabilityConfig = z.infer<typeof ObservabilityConfig>

export const Channel = z.discriminatedUnion("type", [ChannelFeishu])
export type Channel = z.infer<typeof Channel>

export const EmailSmtp = z
  .object({
    host: z.string().optional().describe("SMTP server hostname"),
    port: z.number().int().positive().optional().describe("SMTP server port"),
    secure: z.boolean().optional().describe("Use TLS/SSL for the SMTP connection"),
    username: z.string().optional().describe("SMTP username"),
    password: z.string().optional().describe("SMTP password or app token"),
  })
  .strict()
  .meta({ ref: "EmailSmtpConfig" })
export type EmailSmtp = z.infer<typeof EmailSmtp>

export const EmailImap = z
  .object({
    host: z.string().optional().describe("IMAP server hostname"),
    port: z.number().int().positive().optional().describe("IMAP server port"),
    secure: z.boolean().optional().describe("Use TLS/SSL for the IMAP connection"),
    username: z.string().optional().describe("IMAP username"),
    password: z.string().optional().describe("IMAP password or app token"),
  })
  .strict()
  .meta({ ref: "EmailImapConfig" })
export type EmailImap = z.infer<typeof EmailImap>

export const EmailFrom = z
  .object({
    address: z.string().optional().describe("Sender email address"),
    name: z.string().optional().describe("Sender display name"),
  })
  .strict()
  .meta({ ref: "EmailFromConfig" })
export type EmailFrom = z.infer<typeof EmailFrom>

export const Email = z
  .object({
    enabled: z.boolean().optional().describe("Enable email features"),
    from: EmailFrom.optional().describe("Sender identity for outgoing emails"),
    smtp: EmailSmtp.optional().describe("SMTP transport settings for outgoing emails"),
    imap: EmailImap.optional().describe("IMAP settings for reading emails"),
  })
  .strict()
  .meta({ ref: "EmailConfig" })
export type Email = z.infer<typeof Email>

export const PermissionAction = z.enum(["ask", "allow", "deny"]).meta({
  ref: "PermissionActionConfig",
})
export type PermissionAction = z.infer<typeof PermissionAction>

export const ControlProfileId = z.enum(["guarded", "autonomous", "full_access"]).meta({ ref: "ControlProfileId" })
export type ControlProfileId = z.infer<typeof ControlProfileId>

export const PermissionObject = z.record(z.string(), PermissionAction).meta({
  ref: "PermissionObjectConfig",
})
export type PermissionObject = z.infer<typeof PermissionObject>

export const PermissionRule = z.union([PermissionAction, PermissionObject]).meta({
  ref: "PermissionRuleConfig",
})
export type PermissionRule = z.infer<typeof PermissionRule>

// Capture original key order before zod reorders, then rebuild in original order
const permissionPreprocess = (val: unknown) => {
  if (typeof val === "object" && val !== null && !Array.isArray(val)) {
    return { __originalKeys: Object.keys(val), ...val }
  }
  return val
}

const permissionTransform = (x: unknown): Record<string, PermissionRule> => {
  if (typeof x === "string") return { "*": x as PermissionAction }
  const obj = x as { __originalKeys?: string[] } & Record<string, unknown>
  const { __originalKeys, ...rest } = obj
  if (!__originalKeys) return rest as Record<string, PermissionRule>
  const result: Record<string, PermissionRule> = {}
  for (const key of __originalKeys) {
    if (key in rest) result[key] = rest[key] as PermissionRule
  }
  return result
}

export const Permission = z
  .preprocess(
    permissionPreprocess,
    z
      .object({
        __originalKeys: z.string().array().optional(),
        read: PermissionRule.optional(),
        edit: PermissionRule.optional(),
        glob: PermissionRule.optional(),
        grep: PermissionRule.optional(),
        list: PermissionRule.optional(),
        bash: PermissionRule.optional(),
        task: PermissionRule.optional(),
        external_directory: PermissionRule.optional(),
        todowrite: PermissionAction.optional(),
        todoread: PermissionAction.optional(),
        dagwrite: PermissionAction.optional(),
        dagread: PermissionAction.optional(),
        question: PermissionAction.optional(),
        webfetch: PermissionAction.optional(),
        websearch: PermissionAction.optional(),
        download: PermissionAction.optional(),
        lsp: PermissionRule.optional(),
        doom_loop: PermissionAction.optional(),
      })
      .catchall(PermissionRule)
      .or(PermissionAction),
  )
  .transform(permissionTransform)
  .meta({
    ref: "PermissionConfig",
  })
export type Permission = z.infer<typeof Permission>

export const Command = z.object({
  template: z.string(),
  description: z.string().optional(),
  agent: z.string().optional(),
  model: z.string().optional(),
})
export type Command = z.infer<typeof Command>

export const Agent = z
  .object({
    model: z.string().optional(),
    modelRole: ModelRole.optional().describe("Model role to resolve for this agent when model is not set"),
    temperature: z.number().optional(),
    top_p: z.number().optional(),
    prompt: z.string().optional(),
    tools: z.record(z.string(), z.boolean()).optional().describe("@deprecated Use 'permission' field instead"),
    disable: z.boolean().optional(),
    description: z.string().optional().describe("Description of when to use the agent"),
    mode: z.enum(["subagent", "primary", "all"]).optional(),
    hidden: z
      .boolean()
      .optional()
      .describe("Hide this subagent from the @ autocomplete menu (default: false, only applies to mode: subagent)"),
    options: z.record(z.string(), z.any()).optional(),
    color: z
      .string()
      .regex(/^#[0-9a-fA-F]{6}$/, "Invalid hex color format")
      .optional()
      .describe("Hex color code for the agent (e.g., #FF5733)"),
    steps: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("Maximum number of agentic iterations before forcing text-only response"),
    maxSteps: z.number().int().positive().optional().describe("@deprecated Use 'steps' field instead."),
    permission: Permission.optional(),
    controlProfile: ControlProfileId.optional().describe("Control profile for this agent's enforcement gate"),
  })
  .catchall(z.any())
  .transform((agent, ctx) => {
    const knownKeys = new Set([
      "name",
      "model",
      "modelRole",
      "prompt",
      "description",
      "temperature",
      "top_p",
      "mode",
      "hidden",
      "color",
      "steps",
      "maxSteps",
      "options",
      "permission",
      "disable",
      "tools",
      "controlProfile",
    ])

    // Extract unknown properties into options
    const options: Record<string, unknown> = { ...agent.options }
    for (const [key, value] of Object.entries(agent)) {
      if (!knownKeys.has(key)) options[key] = value
    }

    // Convert legacy tools config to permissions
    const permission: Permission = {}
    for (const [tool, enabled] of Object.entries(agent.tools ?? {})) {
      const action = enabled ? "allow" : "deny"
      // write, edit, patch, multiedit all map to edit permission
      if (tool === "write" || tool === "edit" || tool === "patch" || tool === "multiedit") {
        permission.edit = action
      } else {
        permission[tool] = action
      }
    }
    Object.assign(permission, agent.permission)

    // Convert legacy maxSteps to steps
    const steps = agent.steps ?? agent.maxSteps

    return { ...agent, options, permission, steps } as typeof agent & {
      options?: Record<string, unknown>
      permission?: Permission
      steps?: number
    }
  })
  .meta({
    ref: "AgentConfig",
  })
export type Agent = z.infer<typeof Agent>

export const ExternalAgentConfig = z
  .object({
    disabled: z.boolean().optional().describe("Disable this external agent"),
    path: z.string().optional().describe("Override path to the external agent binary"),
    model: z.string().optional().describe("Default model for this external agent"),
    auto_discover: z.boolean().optional().describe("Whether to auto-discover this agent on startup (default: true)"),
  })
  .catchall(z.unknown())
  .meta({
    ref: "ExternalAgentConfig",
  })
export type ExternalAgentConfig = z.infer<typeof ExternalAgentConfig>

export const Keybinds = z
  .object({
    leader: z.string().optional().default("ctrl+x").describe("Leader key for keybind combinations"),
    app_exit: z.string().optional().default("ctrl+c,ctrl+d,<leader>q").describe("Exit the application"),
    editor_open: z.string().optional().default("<leader>e").describe("Open external editor"),
    theme_list: z.string().optional().default("<leader>t").describe("List available themes"),
    sidebar_toggle: z.string().optional().default("<leader>b").describe("Toggle sidebar"),
    scrollbar_toggle: z.string().optional().default("none").describe("Toggle session scrollbar"),
    username_toggle: z.string().optional().default("none").describe("Toggle username visibility"),
    status_view: z.string().optional().default("<leader>s").describe("View status"),
    session_export: z.string().optional().default("<leader>x").describe("Export session to editor"),
    session_new: z.string().optional().default("<leader>n").describe("Create a new session"),
    session_list: z.string().optional().default("<leader>l").describe("List all sessions"),
    session_timeline: z.string().optional().default("<leader>g").describe("Show session timeline"),
    session_fork: z.string().optional().default("none").describe("Fork session from message"),
    session_rename: z.string().optional().default("none").describe("Rename session"),
    session_interrupt: z.string().optional().default("escape").describe("Interrupt current session"),
    session_compact: z.string().optional().default("<leader>c").describe("Compact the session"),
    messages_page_up: z.string().optional().default("pageup").describe("Scroll messages up by one page"),
    messages_page_down: z.string().optional().default("pagedown").describe("Scroll messages down by one page"),
    messages_half_page_up: z.string().optional().default("ctrl+alt+u").describe("Scroll messages up by half page"),
    messages_half_page_down: z.string().optional().default("ctrl+alt+d").describe("Scroll messages down by half page"),
    messages_first: z.string().optional().default("ctrl+g,home").describe("Navigate to first message"),
    messages_last: z.string().optional().default("ctrl+alt+g,end").describe("Navigate to last message"),
    messages_next: z.string().optional().default("none").describe("Navigate to next message"),
    messages_previous: z.string().optional().default("none").describe("Navigate to previous message"),
    messages_last_user: z.string().optional().default("none").describe("Navigate to last user message"),
    messages_copy: z.string().optional().default("<leader>y").describe("Copy message"),
    messages_undo: z.string().optional().default("<leader>u").describe("Undo message history only"),
    messages_redo: z.string().optional().default("<leader>r").describe("Redo message history only"),
    messages_toggle_conceal: z
      .string()
      .optional()
      .default("<leader>h")
      .describe("Toggle code block concealment in messages"),
    tool_details: z.string().optional().default("none").describe("Toggle tool details visibility"),
    model_list: z.string().optional().default("<leader>m").describe("List available models"),
    model_cycle_recent: z.string().optional().default("f2").describe("Next recently used model"),
    model_cycle_recent_reverse: z.string().optional().default("shift+f2").describe("Previous recently used model"),
    model_cycle_favorite: z.string().optional().default("none").describe("Next favorite model"),
    model_cycle_favorite_reverse: z.string().optional().default("none").describe("Previous favorite model"),
    command_list: z.string().optional().default("ctrl+p").describe("List available commands"),
    agent_list: z.string().optional().default("<leader>a").describe("List agents"),
    agent_cycle: z.string().optional().default("tab").describe("Next agent"),
    agent_cycle_reverse: z.string().optional().default("shift+tab").describe("Previous agent"),
    variant_cycle: z.string().optional().default("ctrl+t").describe("Cycle model variants"),
    input_clear: z.string().optional().default("ctrl+c").describe("Clear input field"),
    input_paste: z.string().optional().default("ctrl+v").describe("Paste from clipboard"),
    input_submit: z.string().optional().default("return").describe("Submit input"),
    input_newline: z
      .string()
      .optional()
      .default("shift+return,ctrl+return,alt+return,ctrl+j")
      .describe("Insert newline in input"),
    input_move_left: z.string().optional().default("left,ctrl+b").describe("Move cursor left in input"),
    input_move_right: z.string().optional().default("right,ctrl+f").describe("Move cursor right in input"),
    input_move_up: z.string().optional().default("up").describe("Move cursor up in input"),
    input_move_down: z.string().optional().default("down").describe("Move cursor down in input"),
    input_select_left: z.string().optional().default("shift+left").describe("Select left in input"),
    input_select_right: z.string().optional().default("shift+right").describe("Select right in input"),
    input_select_up: z.string().optional().default("shift+up").describe("Select up in input"),
    input_select_down: z.string().optional().default("shift+down").describe("Select down in input"),
    input_line_home: z.string().optional().default("ctrl+a").describe("Move to start of line in input"),
    input_line_end: z.string().optional().default("ctrl+e").describe("Move to end of line in input"),
    input_select_line_home: z.string().optional().default("ctrl+shift+a").describe("Select to start of line in input"),
    input_select_line_end: z.string().optional().default("ctrl+shift+e").describe("Select to end of line in input"),
    input_visual_line_home: z.string().optional().default("alt+a").describe("Move to start of visual line in input"),
    input_visual_line_end: z.string().optional().default("alt+e").describe("Move to end of visual line in input"),
    input_select_visual_line_home: z
      .string()
      .optional()
      .default("alt+shift+a")
      .describe("Select to start of visual line in input"),
    input_select_visual_line_end: z
      .string()
      .optional()
      .default("alt+shift+e")
      .describe("Select to end of visual line in input"),
    input_buffer_home: z.string().optional().default("home").describe("Move to start of buffer in input"),
    input_buffer_end: z.string().optional().default("end").describe("Move to end of buffer in input"),
    input_select_buffer_home: z
      .string()
      .optional()
      .default("shift+home")
      .describe("Select to start of buffer in input"),
    input_select_buffer_end: z.string().optional().default("shift+end").describe("Select to end of buffer in input"),
    input_delete_line: z.string().optional().default("ctrl+shift+d").describe("Delete line in input"),
    input_delete_to_line_end: z.string().optional().default("ctrl+k").describe("Delete to end of line in input"),
    input_delete_to_line_start: z.string().optional().default("ctrl+u").describe("Delete to start of line in input"),
    input_backspace: z.string().optional().default("backspace,shift+backspace").describe("Backspace in input"),
    input_delete: z.string().optional().default("ctrl+d,delete,shift+delete").describe("Delete character in input"),
    input_undo: z.string().optional().default("ctrl+-,super+z").describe("Undo in input"),
    input_redo: z.string().optional().default("ctrl+.,super+shift+z").describe("Redo in input"),
    input_word_forward: z
      .string()
      .optional()
      .default("alt+f,alt+right,ctrl+right")
      .describe("Move word forward in input"),
    input_word_backward: z
      .string()
      .optional()
      .default("alt+b,alt+left,ctrl+left")
      .describe("Move word backward in input"),
    input_select_word_forward: z
      .string()
      .optional()
      .default("alt+shift+f,alt+shift+right")
      .describe("Select word forward in input"),
    input_select_word_backward: z
      .string()
      .optional()
      .default("alt+shift+b,alt+shift+left")
      .describe("Select word backward in input"),
    input_delete_word_forward: z
      .string()
      .optional()
      .default("alt+d,alt+delete,ctrl+delete")
      .describe("Delete word forward in input"),
    input_delete_word_backward: z
      .string()
      .optional()
      .default("ctrl+w,ctrl+backspace,alt+backspace")
      .describe("Delete word backward in input"),
    history_previous: z.string().optional().default("up").describe("Previous history item"),
    history_next: z.string().optional().default("down").describe("Next history item"),
    session_child_cycle: z.string().optional().default("<leader>right").describe("Next child session"),
    session_child_cycle_reverse: z.string().optional().default("<leader>left").describe("Previous child session"),
    session_parent: z.string().optional().default("<leader>up").describe("Go to parent session"),
    terminal_suspend: z.string().optional().default("ctrl+z").describe("Suspend terminal"),
    terminal_title_toggle: z.string().optional().default("none").describe("Toggle terminal title"),
    tips_toggle: z.string().optional().default("<leader>h").describe("Toggle tips on home screen"),
  })
  .strict()
  .meta({
    ref: "KeybindsConfig",
  })

export const Server = z
  .object({
    port: z.number().int().positive().optional().describe("Port to listen on"),
    hostname: z.string().optional().describe("Hostname to listen on"),
    mdns: z.boolean().optional().describe("Enable mDNS service discovery"),
    cors: z.array(z.string()).optional().describe("Additional domains to allow for CORS"),
  })
  .strict()
  .meta({
    ref: "ServerConfig",
  })

export const CategoryConfig = z
  .object({
    model: z.string().optional().describe("Model to use for this category (e.g., 'sii-openai/GPT-5.2')"),
    temperature: z.number().optional().describe("Temperature override for this category"),
    promptAppend: z.string().optional().describe("Additional prompt context to inject for this category"),
    description: z.string().optional().describe("Description of when to use this category"),
  })
  .strict()
  .meta({
    ref: "CategoryConfig",
  })
export type CategoryConfig = z.infer<typeof CategoryConfig>

export const Layout = z.enum(["auto", "stretch"]).meta({
  ref: "LayoutConfig",
})
export type Layout = z.infer<typeof Layout>

export const Learning = z
  .object({
    alpha: z.number().min(0).max(1).optional().describe("Q-learning step size / learning rate (default: 0.3)"),
    qInit: z.number().optional().describe("Optimistic Q-value initialization per reward dimension (default: 1.0)"),
    dedupIntentThreshold: z
      .number()
      .min(0)
      .max(1)
      .optional()
      .describe("Intent cosine similarity threshold for deduplicating experiences (default: 0.85)"),
    dedupScriptThreshold: z
      .number()
      .min(0)
      .max(1)
      .optional()
      .describe("Script cosine similarity threshold for deduplicating experiences (default: 0.8)"),
    qHistorySize: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe("Maximum Q-value history entries per experience (default: 50)"),
    snapThreshold: z
      .number()
      .min(0)
      .max(1)
      .optional()
      .describe("Threshold for snapping reward dimensions to discrete {-1, 0, 1} (default: 0.5)"),
    legacyRewardConfidence: z
      .number()
      .min(0)
      .max(1)
      .optional()
      .describe("Default confidence for legacy scalar reward format (default: 0.3)"),
    encoderRetries: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe("LLM retry count for intent/script/reward generation (default: 3)"),
    digestToolOutputBudget: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe("Max estimated tokens for tool output in turn digest (default: 800)"),
    encoderToolFieldBudget: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe("Max chars per tool input field in encoder context (default: 500)"),
    encoderToolOutputBudget: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe("Max chars for tool output in encoder context (default: 300)"),
    rewardWeights: z
      .object({
        outcome: z.number().optional().describe("Weight for outcome dimension (default: 0.35)"),
        intent: z.number().optional().describe("Weight for intent dimension (default: 0.25)"),
        execution: z.number().optional().describe("Weight for execution dimension (default: 0.2)"),
        orchestration: z.number().optional().describe("Weight for orchestration dimension (default: 0.1)"),
        expression: z.number().optional().describe("Weight for expression dimension (default: 0.1)"),
      })
      .strict()
      .optional()
      .describe(
        "Weights for multi-dimensional reward composition (default: outcome=0.35, intent=0.25, execution=0.2, orchestration=0.1, expression=0.1)",
      ),
    rewardDelay: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe("Number of subsequent turns to wait before evaluating reward (default: 2)"),
  })
  .strict()
  .meta({ ref: "LearningConfig" })
export type Learning = z.infer<typeof Learning>

export const PassiveRetrieval = z
  .object({
    simThreshold: z
      .number()
      .min(0)
      .max(1)
      .optional()
      .describe("Minimum cosine similarity for retrieval candidates (default: 0.7)"),
    topK: z.number().int().min(1).optional().describe("Number of experiences to retrieve (default: 8)"),
    epsilon: z.number().min(0).max(1).optional().describe("ε-greedy exploration probability (default: 0.1)"),
    wSim: z.number().min(0).max(1).optional().describe("Weight for similarity in hybrid score (default: 0.5)"),
    wQ: z.number().min(0).max(1).optional().describe("Weight for Q-value in hybrid score (default: 0.5)"),
    explorationConstant: z
      .number()
      .min(0)
      .optional()
      .describe("UCB1 exploration constant — scales √(ln(N)/n) visit-decay bonus (default: 0.5)"),
  })
  .strict()
  .meta({ ref: "PassiveRetrievalConfig" })
export type PassiveRetrieval = z.infer<typeof PassiveRetrieval>

export const REWARD_WEIGHT_DEFAULTS = {
  outcome: 0.35,
  intent: 0.25,
  execution: 0.2,
  orchestration: 0.1,
  expression: 0.1,
} as const

export const LEARNING_DEFAULTS = {
  alpha: 0.3,
  qInit: 0.5,
  dedupIntentThreshold: 0.85,
  dedupScriptThreshold: 0.8,
  qHistorySize: 50,
  snapThreshold: 0.5,
  legacyRewardConfidence: 0.3,
  encoderRetries: 3,
  digestToolOutputBudget: 800,
  encoderToolFieldBudget: 500,
  encoderToolOutputBudget: 300,
  rewardWeights: { ...REWARD_WEIGHT_DEFAULTS },
  rewardDelay: 5,
} as const satisfies Required<Learning>

export const PASSIVE_RETRIEVAL_DEFAULTS = {
  simThreshold: 0.7,
  topK: 8,
  epsilon: 0.1,
  wSim: 0.5,
  wQ: 0.5,
  explorationConstant: 0.5,
} as const satisfies Required<PassiveRetrieval>

export const MEMORY_CATEGORIES = [
  "user",
  "self",
  "relationship",
  "interaction",
  "workflow",
  "coding",
  "writing",
  "asset",
  "insight",
  "knowledge",
  "personal",
  "general",
] as const
export type MemoryCategory = (typeof MEMORY_CATEGORIES)[number]

const CategoryRetrieveConfig = z
  .object({
    simThreshold: z.number().optional().describe("Minimum similarity for contextual retrieval"),
    topK: z.number().optional().describe("Maximum contextual entries to retrieve"),
  })
  .strict()

export const EmbeddingConfig = z
  .object({
    baseURL: z.string().optional().describe("Base URL for the embedding API"),
    apiKey: z.string().optional().describe("API key for the embedding service"),
    model: z.string().optional().describe("Embedding model name"),
  })
  .strict()
  .optional()
  .meta({ ref: "EmbeddingConfig" })
  .describe("Embedding model configuration. When absent, a local model is used automatically.")
export type EmbeddingConfig = z.infer<typeof EmbeddingConfig>

export const RerankConfig = z
  .object({
    baseURL: z.string().optional().describe("Base URL for the rerank API"),
    apiKey: z.string().optional().describe("API key for the rerank service"),
    model: z.string().optional().describe("Rerank model name"),
  })
  .strict()
  .optional()
  .meta({ ref: "RerankConfig" })
  .describe("Rerank model for memory retrieval refinement. Disabled when not configured.")
export type RerankConfig = z.infer<typeof RerankConfig>

export const MemoryConfig = z
  .object({
    enabled: z.boolean().optional().describe("Enable agent-initiated memory curation via chronicler (default: true)"),
    retrieval: z
      .object({
        simThreshold: z
          .number()
          .min(0)
          .max(1)
          .optional()
          .describe("Minimum similarity for auto-injection (default: 0.7)"),
        topK: z.number().int().min(1).optional().describe("Max entries per category to retrieve (default: 3)"),
        categories: z
          .record(z.enum(MEMORY_CATEGORIES), CategoryRetrieveConfig)
          .optional()
          .describe("Per-category retrieval overrides"),
      })
      .strict()
      .optional()
      .describe("Semantic memory retrieval settings"),
    dedup: z
      .object({
        threshold: z
          .number()
          .min(0)
          .max(1)
          .optional()
          .describe("Cosine similarity threshold for duplicate detection (default: 0.75)"),
      })
      .strict()
      .optional()
      .describe("Memory deduplication settings"),
  })
  .strict()
  .meta({ ref: "MemoryConfig" })
export type MemoryConfig = z.infer<typeof MemoryConfig>

export const ExperienceConfig = z
  .object({
    encode: z.boolean().optional().describe("Auto-encode conversation patterns into experiences (default: true)"),
    retrieve: z
      .union([z.boolean(), PassiveRetrieval])
      .optional()
      .describe("Inject relevant past experiences into prompts (default: true)"),
    learning: Learning.optional().describe("Q-learning hyperparameters for experience evaluation"),
  })
  .strict()
  .meta({ ref: "ExperienceConfig" })
export type ExperienceConfig = z.infer<typeof ExperienceConfig>

export const LibraryConfig = z
  .object({
    memory: MemoryConfig.optional(),
    experience: ExperienceConfig.optional(),
    autonomy: z
      .boolean()
      .optional()
      .describe("Enable autonomous background routines like anima daily wake (default: true)"),
  })
  .strict()
  .optional()
  .meta({ ref: "LibraryConfig" })
export type LibraryConfig = z.infer<typeof LibraryConfig>

export const Provider = ModelsDev.Provider.partial()
  .extend({
    whitelist: z.array(z.string()).optional(),
    blacklist: z.array(z.string()).optional(),
    models: z
      .record(
        z.string(),
        ModelsDev.Model.partial().extend({
          variants: z
            .record(
              z.string(),
              z
                .object({
                  disabled: z.boolean().optional().describe("Disable this variant for the model"),
                })
                .catchall(z.any()),
            )
            .optional()
            .describe("Variant-specific configuration"),
        }),
      )
      .optional(),
    options: z
      .object({
        apiKey: z.string().optional(),
        baseURL: z.string().optional(),
        enterpriseUrl: z.string().optional().describe("GitHub Enterprise URL for copilot authentication"),
        setCacheKey: z.boolean().optional().describe("Enable promptCacheKey for this provider (default false)"),
        timeout: z
          .union([
            z
              .number()
              .int()
              .positive()
              .describe(
                "Timeout in milliseconds for requests to this provider. Default is 900000 (15 minutes). Set to false to disable timeout.",
              ),
            z.literal(false).describe("Disable timeout for this provider entirely."),
          ])
          .optional()
          .describe(
            "Timeout in milliseconds for requests to this provider. Default is 900000 (15 minutes). Set to false to disable timeout.",
          ),
      })
      .catchall(z.any())
      .optional(),
  })
  .strict()
  .meta({
    ref: "ProviderConfig",
  })
export type Provider = z.infer<typeof Provider>

export const ProviderCatalog = z
  .object({
    enabled: z.boolean().optional().describe("Enable signed remote provider catalog updates"),
    registryUrl: z
      .string()
      .url()
      .optional()
      .describe("Signed provider catalog URL. The signature is fetched from the same URL plus .sig."),
    publicKey: z.string().optional().describe("Base64 Ed25519 public key used to verify provider catalog signatures"),
    cacheTtlMs: z.number().int().positive().optional().describe("Provider catalog cache TTL in milliseconds"),
    offlineCache: z.boolean().optional().describe("Use the last verified provider catalog when offline"),
  })
  .strict()
  .meta({ ref: "ProviderCatalogConfig" })
export type ProviderCatalog = z.infer<typeof ProviderCatalog>

export const PluginApprovalPolicy = z
  .object({
    allowUnsignedLocal: z.boolean().optional().default(true).describe("Allow unsigned local plugins with user consent"),
    autoApproveBuiltin: z
      .boolean()
      .optional()
      .default(true)
      .describe("Auto-approve builtin plugins without user consent"),
    denyHighRiskThirdParty: z
      .boolean()
      .optional()
      .default(true)
      .describe("Block third-party plugins with high-risk capabilities"),
    requireSignatureForMarketplace: z
      .boolean()
      .optional()
      .default(false)
      .describe("Require cryptographic signature for non-local plugins"),
  })
  .strict()
  .meta({ ref: "PluginApprovalPolicyConfig" })
export type PluginApprovalPolicy = z.infer<typeof PluginApprovalPolicy>

export const PLUGIN_APPROVAL_POLICY_DEFAULTS = {
  allowUnsignedLocal: true,
  autoApproveBuiltin: true,
  denyHighRiskThirdParty: true,
  requireSignatureForMarketplace: false,
} as const satisfies Required<PluginApprovalPolicy>

export const PluginRuntimeLimits = z
  .object({
    startupTimeoutMs: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("Maximum milliseconds for plugin runtime startup"),
    requestTimeoutMs: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("Maximum milliseconds for one plugin runtime request"),
    shutdownGraceMs: z.number().int().positive().optional().describe("Graceful shutdown window before force kill"),
    maxConcurrentRequests: z.number().int().positive().optional().describe("Maximum concurrent bridge requests"),
    maxLogBytesPerMinute: z.number().int().positive().optional().describe("Maximum plugin log bytes per minute"),
    memoryMb: z.number().int().positive().optional().describe("Maximum process runtime RSS in MB"),
    memoryPollIntervalMs: z.number().int().positive().optional().describe("Memory polling interval in milliseconds"),
    heartbeatIntervalMs: z.number().int().positive().optional().describe("Heartbeat interval in milliseconds"),
    heartbeatMissesBeforeKill: z.number().int().positive().optional().describe("Missed heartbeats before process kill"),
  })
  .strict()
  .meta({ ref: "PluginRuntimeLimitsConfig" })
export type PluginRuntimeLimits = z.infer<typeof PluginRuntimeLimits>

export const PluginRuntimePolicy = z
  .object({
    thirdPartyDefaultMode: z
      .enum(["process", "worker"])
      .optional()
      .default(DEFAULT_PLUGIN_RUNTIME_POLICY.thirdPartyDefaultMode)
      .describe("Default isolation mode for third-party plugins (npm, git, url)"),
    highRiskRequiresProcess: z
      .boolean()
      .optional()
      .default(DEFAULT_PLUGIN_RUNTIME_POLICY.highRiskRequiresProcess)
      .describe("Require process isolation for high-risk plugins regardless of source"),
    allowThirdPartyInProcess: z
      .boolean()
      .optional()
      .default(DEFAULT_PLUGIN_RUNTIME_POLICY.allowThirdPartyInProcess)
      .describe("Allow third-party plugins to request in-process mode (not recommended)"),
    allowWorkerMode: z
      .boolean()
      .optional()
      .default(DEFAULT_PLUGIN_RUNTIME_POLICY.allowWorkerMode)
      .describe("Allow plugins to request worker thread isolation"),
    allowLocalInProcess: z
      .boolean()
      .optional()
      .default(DEFAULT_PLUGIN_RUNTIME_POLICY.allowLocalInProcess)
      .describe("Allow local plugins to run in-process"),
    limits: PluginRuntimeLimits.optional()
      .default(DEFAULT_PLUGIN_RUNTIME_LIMITS)
      .describe("Default plugin runtime resource and request limits"),
  })
  .strict()
  .meta({ ref: "PluginRuntimePolicyConfig" })
export type PluginRuntimePolicy = z.infer<typeof PluginRuntimePolicy>

export const PLUGIN_RUNTIME_POLICY_DEFAULTS = {
  ...DEFAULT_PLUGIN_RUNTIME_POLICY,
  limits: DEFAULT_PLUGIN_RUNTIME_LIMITS,
} as const satisfies Required<PluginRuntimePolicy>

export const PluginMarketplace = z
  .object({
    enabled: z.boolean().optional().default(true).describe("Enable the public GitHub-backed plugin marketplace"),
    registryUrl: z
      .string()
      .url()
      .optional()
      .default(DEFAULT_PLUGIN_MARKETPLACE_CONFIG.registryUrl)
      .describe("URL of the official plugin registry.json index"),
    includeLocalRegistry: z
      .boolean()
      .optional()
      .default(true)
      .describe("Include the local development registry in marketplace search and detail routes"),
    cacheTtlMs: z
      .number()
      .int()
      .positive()
      .optional()
      .default(DEFAULT_PLUGIN_MARKETPLACE_CONFIG.cacheTtlMs)
      .describe("Remote marketplace cache TTL in milliseconds"),
    offlineCache: z
      .boolean()
      .optional()
      .default(true)
      .describe("Use stale marketplace cache for browsing when the remote registry cannot be reached"),
    requestTimeoutMs: z
      .number()
      .int()
      .positive()
      .optional()
      .default(DEFAULT_PLUGIN_MARKETPLACE_CONFIG.requestTimeoutMs)
      .describe("Timeout in milliseconds for registry and entry metadata requests"),
    artifactDownloadTimeoutMs: z
      .number()
      .int()
      .positive()
      .optional()
      .default(DEFAULT_PLUGIN_MARKETPLACE_CONFIG.artifactDownloadTimeoutMs)
      .describe("Timeout in milliseconds for plugin artifact and signature downloads"),
    cliRequestTimeoutMs: z
      .number()
      .int()
      .positive()
      .optional()
      .default(DEFAULT_PLUGIN_MARKETPLACE_CONFIG.cliRequestTimeoutMs)
      .describe("Timeout in milliseconds for Synergy CLI plugin commands waiting on the local server"),
  })
  .strict()
  .meta({ ref: "PluginMarketplaceConfig" })
export type PluginMarketplace = z.infer<typeof PluginMarketplace>

export const PLUGIN_MARKETPLACE_DEFAULTS = DEFAULT_PLUGIN_MARKETPLACE_CONFIG as Required<PluginMarketplace>
export const Info = z
  .object({
    $schema: z.string().optional().describe("JSON schema reference for configuration validation"),
    theme: z.string().optional().describe("Theme name to use for the interface"),
    keybinds: Keybinds.optional().describe("Custom keybind configurations"),
    logLevel: Log.Level.optional().describe("Log level"),
    server: Server.optional().describe("Server configuration for synergy serve and web commands"),
    command: z.record(z.string(), Command).optional().describe("Command configuration"),
    timeout: z
      .object({
        invoke_sec: z
          .number()
          .positive()
          .optional()
          .describe("Max wall-clock seconds for one agent turn (default: 900 = 15min)"),
        provider: z
          .object({
            ttfb_sec: z
              .number()
              .positive()
              .optional()
              .describe(
                "Max seconds to wait for first byte (TTFB) from provider. " +
                  "Accommodates reasoning/thinking models (e.g. o1-pro, deepseek-r1). " +
                  "Default: 600 = 10min",
              ),
            idle_sec: z
              .number()
              .min(0)
              .optional()
              .describe("Idle timeout in seconds (0 = disable, default: 180 = 3min). Resets on each data chunk."),
            wall_sec: z
              .number()
              .min(0)
              .optional()
              .describe(
                "Hard wall-clock timeout per HTTP request in seconds " +
                  "(0 = disabled, default: 0). CAUTION: conflicts with streaming — " +
                  "will interrupt normal token output. Only enable if you need a " +
                  "hard cap beyond idle+TTFB",
              ),
          })
          .optional(),
        tool: z
          .object({
            default_sec: z
              .number()
              .positive()
              .optional()
              .describe("Default timeout per tool execution in seconds (default: 300 = 5min)"),
            overrides: z
              .record(z.string(), z.number().positive())
              .optional()
              .describe("Per-tool timeout overrides by tool name, e.g. { bash: 600, webfetch: 120 }"),
          })
          .optional(),
      })
      .optional()
      .describe("Timeout configuration for agent turns, provider requests, and tool execution"),
    watcher: z
      .object({
        ignore: z.array(z.string()).optional(),
      })
      .optional(),
    plugin: z.string().array().optional(),
    pluginApprovalPolicy: PluginApprovalPolicy.optional().describe("Plugin approval policy configuration"),
    pluginRuntimePolicy: PluginRuntimePolicy.optional().describe("Plugin runtime isolation policy configuration"),
    pluginMarketplace: PluginMarketplace.optional().describe("Public plugin marketplace registry configuration"),
    snapshot: z.boolean().optional(),
    autoupdate: z
      .union([z.boolean(), z.literal("notify")])
      .optional()
      .describe(
        "Automatically update to the latest version. Set to true to auto-update, false to disable, or 'notify' to show update notifications",
      ),
    disabled_providers: z.array(z.string()).optional().describe("Disable providers that are loaded automatically"),
    enabled_providers: z
      .array(z.string())
      .optional()
      .describe("When set, ONLY these providers will be enabled. All other providers will be ignored"),
    providerCatalog: ProviderCatalog.optional().describe("Signed remote provider catalog configuration"),
    model: z
      .string()
      .describe("Default model in the format of provider/model, eg anthropic/claude-sonnet-4-5")
      .optional(),
    nano_model: z
      .string()
      .describe(
        "Cheapest model for trivial extraction tasks like title generation, in the format of provider/model. Falls back to mini_model → mid_model → model.",
      )
      .optional(),
    mini_model: z
      .string()
      .describe(
        "Lightweight model for simple tasks like intent extraction, in the format of provider/model. Falls back to mid_model → model.",
      )
      .optional(),
    mid_model: z
      .string()
      .describe(
        "Mid-tier model for internal agents that need moderate reasoning (script extraction, reward evaluation, code exploration), in the format of provider/model. Falls back to the default model.",
      )
      .optional(),
    thinking_model: z
      .string()
      .describe(
        "Deep thinking model for complex reasoning and architecture tasks, in the format of provider/model. Falls back to the default model if not set.",
      )
      .optional(),
    long_context_model: z
      .string()
      .describe(
        "Model with extra-large context window for processing very long inputs, in the format of provider/model. Falls back to the default model if not set.",
      )
      .optional(),
    creative_model: z
      .string()
      .describe(
        "Model for creative and visual tasks (UI design, writing, artistry), in the format of provider/model. Falls back to the default model if not set.",
      )
      .optional(),
    vision_model: z
      .string()
      .describe(
        "Model for image analysis via the look_at tool, in the format of provider/model. If not set, look_at is disabled.",
      )
      .optional(),
    default_agent: z
      .string()
      .optional()
      .describe(
        "Default agent to use when none is specified. Must be a primary agent. Falls back to 'synergy' if not set or if the specified agent is invalid.",
      ),
    username: z.string().optional().describe("Custom username to display in conversations instead of system username"),
    agent: z
      .object({
        // primary
        synergy: Agent.optional(),
        "synergy-max": Agent.optional(),
        // classic subagents
        developer: Agent.optional(),
        // subagent
        general: Agent.optional(),
        explore: Agent.optional(),
        // specialized
        title: Agent.optional(),
        summary: Agent.optional(),
        compaction: Agent.optional(),
      })
      .catchall(Agent)
      .optional()
      .describe("Agent configuration"),
    external_agent: z
      .record(z.string(), ExternalAgentConfig)
      .optional()
      .describe("External agent configurations (e.g. codex, claude-code)"),
    provider: z.record(z.string(), Provider).optional().describe("Custom provider configurations and model overrides"),
    embedding: EmbeddingConfig,
    rerank: RerankConfig,
    library: LibraryConfig,
    mcp: z
      .record(
        z.string(),
        z.union([
          Mcp,
          z
            .object({
              enabled: z.boolean(),
            })
            .strict(),
        ]),
      )
      .optional()
      .describe("MCP (Model Context Protocol) server configurations"),
    mcpDefaults: McpDefaults.optional().describe(
      "Default settings applied to all MCP servers that don't override them",
    ),
    channel: z
      .record(z.string(), Channel)
      .optional()
      .describe("Channel configurations for messaging platform integrations"),
    sandbox: SandboxConfig.optional().describe("Sandbox configuration for workspace boundary enforcement"),
    observability: ObservabilityConfig.optional().describe("Local logs, traces, and diagnostics settings"),
    controlProfile: ControlProfileId.optional().describe("Default control profile applied to all agents"),
    holos: Holos.optional().describe("Holos platform configuration"),
    email: Email.optional().describe("Outgoing email configuration"),
    formatter: z
      .union([
        z.literal(false),
        z.record(
          z.string(),
          z.object({
            disabled: z.boolean().optional(),
            command: z.array(z.string()).optional(),
            environment: z.record(z.string(), z.string()).optional(),
            extensions: z.array(z.string()).optional(),
          }),
        ),
      ])
      .optional(),
    lsp: z
      .union([
        z.literal(false),
        z.record(
          z.string(),
          z.union([
            z.object({
              disabled: z.literal(true),
            }),
            z.object({
              command: z.array(z.string()),
              extensions: z.array(z.string()).optional(),
              disabled: z.boolean().optional(),
              env: z.record(z.string(), z.string()).optional(),
              initialization: z.record(z.string(), z.any()).optional(),
            }),
          ]),
        ),
      ])
      .optional()
      .refine(
        (data) => {
          if (!data) return true
          if (typeof data === "boolean") return true
          const serverIds = new Set(Object.values(LSPServer).map((s) => s.id))

          return Object.entries(data).every(([id, config]) => {
            if (config.disabled) return true
            if (serverIds.has(id)) return true
            return Boolean(config.extensions)
          })
        },
        {
          error: "For custom LSP servers, 'extensions' array is required.",
        },
      ),
    instructions: z.array(z.string()).optional().describe("Additional instruction files or patterns to include"),
    project_doc_fallback_filenames: z
      .array(z.string())
      .optional()
      .describe("Ordered fallback instruction filenames to try when AGENTS.md is missing in a directory"),
    project_doc_max_bytes: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe(
        "Maximum bytes to include from each automatically discovered instruction file (default: 32768; 0 disables automatic discovery)",
      ),
    layout: Layout.optional().describe("@deprecated Always uses stretch layout."),
    permission: Permission.optional(),
    smartAllow: z
      .boolean()
      .optional()
      .describe("Use the Smart allow internal agent to auto-allow safe asks and soft denies"),
    tools: z.record(z.string(), z.boolean()).optional(),
    enterprise: z
      .object({
        url: z.string().optional().describe("Enterprise URL"),
      })
      .optional(),
    //     agora: z
    //       .object({
    //         url: z.string().optional().describe("Agora API base URL (defaults to https://agora.holosai.io)"),
    //         tokenUrl: z
    //           .string()
    //           .optional()
    //           .describe("Holos API URL for Agora token exchange (defaults to https://www.holosai.io)"),
    //         giteaSSHHost: z.string().optional().describe("Override SSH hostname used for Agora's Gitea remote"),
    //       })
    //       .optional()
    //       .describe("Agora Q&A platform configuration"),
    question: z
      .object({
        timeout: z
          .number()
          .min(0)
          .optional()
          .describe("Seconds before unanswered questions auto-expire (0 = no timeout, default 1800 = 30min)"),
      })
      .optional(),
    compaction: z
      .object({
        auto: z.boolean().optional().describe("Enable automatic compaction when context is full (default: true)"),
        prune: z.boolean().optional().describe("Enable pruning of old tool outputs (default: true)"),
        overflowThreshold: z
          .number()
          .min(0.5)
          .max(1)
          .optional()
          .describe("Fraction of usable context that triggers auto-compaction (default: 0.85)"),
        maxHistoryImages: z
          .number()
          .int()
          .optional()
          .describe(
            "Maximum number of historical images to send as base64 per request (older images replaced with text placeholders). Default: 8.",
          ),
      })
      .optional(),
    experimental: z
      .object({
        batch_tool: z.boolean().optional().describe("Enable the batch tool"),
        openTelemetry: z
          .boolean()
          .optional()
          .describe("Enable OpenTelemetry spans for AI SDK calls (using the 'experimental_telemetry' flag)"),
        primary_tools: z
          .array(z.string())
          .optional()
          .describe("Tools that should only be available to primary agents."),
        continue_loop_on_deny: z.boolean().optional().describe("Continue the agent loop when a tool call is denied"),
        mcp_timeout: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Timeout in milliseconds for model context protocol (MCP) requests"),
      })
      .optional(),
    pluginConfig: z
      .record(z.string(), z.record(z.string(), z.any()))
      .optional()
      .describe("Per-plugin configuration namespaces. Keys are plugin IDs, values are plugin-specific config."),
    category: z
      .record(z.string(), CategoryConfig)
      .optional()
      .describe("Custom category configurations for background tasks. Categories define model and prompt presets."),
    toast: z
      .object({
        muted: z
          .array(z.enum(["info", "success", "warning", "error"]))
          .optional()
          .describe("Toast types to suppress. The underlying logic still runs but the visual card is not rendered."),
        durationOverrides: z
          .record(z.enum(["info", "success", "warning", "error"]), z.number().int().positive().max(30000))
          .optional()
          .describe("Override auto-dismiss duration in ms per toast type (max 30s)."),
      })
      .strict()
      .optional()
      .describe("Toast notification preferences"),
  })
  .strict()
  .meta({
    ref: "Config",
  })

export type Info = z.output<typeof Info>
