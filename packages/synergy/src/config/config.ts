import { Log } from "../util/log"
import path from "path"
import { pathToFileURL } from "url"
import os from "os"
import z from "zod"
import { Filesystem } from "../util/filesystem"
import { ModelsDev } from "../provider/models"
import { mergeDeep, pipe, unique } from "remeda"
import { Global } from "../global"
import fs from "fs/promises"
import { lazy } from "../util/lazy"
import { NamedError } from "@ericsanchezok/synergy-util/error"
import { Flag } from "../flag/flag"
import { Auth } from "../provider/api-key"
import {
  type ParseError as JsoncParseError,
  parse as parseJsonc,
  printParseErrorCode,
  modify,
  applyEdits,
} from "jsonc-parser"
import { Instance } from "../scope/instance"
import { BusEvent } from "../bus/bus-event"
import { GlobalBus } from "../bus/global"
import { LSPServer } from "../lsp/server"
import { BunProc } from "@/util/bun"
import { Installation } from "@/global/installation"
import { ConfigMarkdown } from "./markdown"
import { existsSync } from "fs"
import { ConfigSet } from "./set"
import { RuntimeSchema } from "../runtime/schema"

export namespace Config {
  const log = Log.create({ service: "config" })
  const CONFIG_SCHEMA = Global.Path.configSchemaUrl
  const formattingOptions = {
    tabSize: 2,
    insertSpaces: true,
    eol: "\n",
  } as const

  // Custom merge function that concatenates array fields instead of replacing them
  function mergeConfigConcatArrays(target: Info, source: Info): Info {
    const merged = mergeDeep(target, source)
    if (target.plugin && source.plugin) {
      merged.plugin = Array.from(new Set([...target.plugin, ...source.plugin]))
    }
    if (target.instructions && source.instructions) {
      merged.instructions = Array.from(new Set([...target.instructions, ...source.instructions]))
    }
    return merged
  }

  export const state = Instance.state(async () => {
    const auth = await Auth.all()

    // Load remote/well-known config first as the base layer (lowest precedence)
    // This allows organizations to provide default configs that users can override
    let result: Info = {}
    for (const [key, value] of Object.entries(auth)) {
      if (value.type === "wellknown") {
        process.env[value.key] = value.token
        log.debug("fetching remote config", { url: `${key}/.well-known/synergy` })
        const response = await fetch(`${key}/.well-known/synergy`)
        if (!response.ok) {
          throw new Error(`failed to fetch remote config from ${key}: ${response.status}`)
        }
        const wellknown = (await response.json()) as any
        const remoteConfig = wellknown.config ?? {}
        // Add $schema to prevent load() from trying to write back to a non-existent file
        if (!remoteConfig.$schema) remoteConfig.$schema = Global.Path.configSchemaUrl
        result = mergeConfigConcatArrays(result, await load(JSON.stringify(remoteConfig), `${key}/.well-known/synergy`))
        log.debug("loaded remote config from well-known", { url: key })
      }
    }

    // Global user config overrides remote config
    result = mergeConfigConcatArrays(result, await global())

    // Custom config path overrides global
    if (Flag.SYNERGY_CONFIG) {
      result = mergeConfigConcatArrays(result, await loadFile(Flag.SYNERGY_CONFIG))
      log.debug("loaded custom config", { path: Flag.SYNERGY_CONFIG })
    }

    // Project config has highest precedence (overrides global and remote)
    // .json files take precedence over .jsonc when both exist
    for (const file of ["synergy.jsonc", "synergy.json"]) {
      const found = await Filesystem.findUp(file, Instance.directory, Instance.directory)
      for (const resolved of found.toReversed()) {
        result = mergeConfigConcatArrays(result, await loadFile(resolved))
      }
    }

    // Inline config content has highest precedence
    if (Flag.SYNERGY_CONFIG_CONTENT) {
      result = mergeConfigConcatArrays(result, JSON.parse(Flag.SYNERGY_CONFIG_CONTENT))
      log.debug("loaded custom config from SYNERGY_CONFIG_CONTENT")
    }

    result.agent = result.agent || {}
    result.plugin = result.plugin || []

    const directories = [
      Global.Path.config,
      ...(await Array.fromAsync(
        Filesystem.up({
          targets: [".synergy"],
          start: Instance.directory,
          stop: Instance.directory,
        }),
      )),
      ...(await Array.fromAsync(
        Filesystem.up({
          targets: [".synergy"],
          start: Global.Path.home,
          stop: Global.Path.home,
        }),
      )),
    ]

    if (Flag.SYNERGY_CONFIG_DIR) {
      directories.push(Flag.SYNERGY_CONFIG_DIR)
      log.debug("loading config from SYNERGY_CONFIG_DIR", { path: Flag.SYNERGY_CONFIG_DIR })
    }

    for (const dir of unique(directories)) {
      if (dir.endsWith(".synergy") || dir === Flag.SYNERGY_CONFIG_DIR) {
        for (const file of ["synergy.jsonc", "synergy.json"]) {
          log.debug(`loading config from ${path.join(dir, file)}`)
          result = mergeConfigConcatArrays(result, await loadFile(path.join(dir, file)))
          // to satisfy the type checker
          result.agent ??= {}
          result.plugin ??= []
        }
      }

      const exists = existsSync(path.join(dir, "node_modules"))
      const installing = installDependencies(dir)
      if (!exists) await installing

      result.command = mergeDeep(result.command ?? {}, await loadCommand(dir))
      result.agent = mergeDeep(result.agent, await loadAgent(dir))
      result.plugin.push(...(await loadPlugin(dir)))
    }

    if (Flag.SYNERGY_PERMISSION) {
      result.permission = mergeDeep(result.permission ?? {}, JSON.parse(Flag.SYNERGY_PERMISSION))
    }

    // Backwards compatibility: legacy top-level `tools` config
    if (result.tools) {
      const perms: Record<string, Config.PermissionAction> = {}
      for (const [tool, enabled] of Object.entries(result.tools)) {
        const action: Config.PermissionAction = enabled ? "allow" : "deny"
        if (tool === "write" || tool === "edit" || tool === "patch" || tool === "multiedit") {
          perms.edit = action
          continue
        }
        perms[tool] = action
      }
      result.permission = mergeDeep(perms, result.permission ?? {})
    }

    if (!result.username) result.username = os.userInfo().username

    if (!result.keybinds) result.keybinds = Info.shape.keybinds.parse({})

    // Apply flag overrides for compaction settings
    if (Flag.SYNERGY_DISABLE_AUTOCOMPACT) {
      result.compaction = { ...result.compaction, auto: false }
    }
    if (Flag.SYNERGY_DISABLE_PRUNE) {
      result.compaction = { ...result.compaction, prune: false }
    }

    return {
      config: result,
      directories,
    }
  })

  export async function installDependencies(dir: string) {
    const pkg = path.join(dir, "package.json")

    if (!(await Bun.file(pkg).exists())) {
      await Bun.write(pkg, "{}")
    }

    const gitignore = path.join(dir, ".gitignore")
    const hasGitIgnore = await Bun.file(gitignore).exists()
    if (!hasGitIgnore) await Bun.write(gitignore, ["node_modules", "package.json", "bun.lock", ".gitignore"].join("\n"))

    await BunProc.run(
      ["add", "@ericsanchezok/synergy-plugin@" + (Installation.isLocal() ? "latest" : Installation.VERSION), "--exact"],
      {
        cwd: dir,
      },
    ).catch(() => {})

    // Install any additional dependencies defined in the package.json
    // This allows local plugins and custom tools to use external packages
    await BunProc.run(["install"], { cwd: dir }).catch(() => {})
  }

  const COMMAND_GLOB = new Bun.Glob("{command,commands}/**/*.md")
  async function loadCommand(dir: string) {
    const result: Record<string, Command> = {}
    for await (const item of COMMAND_GLOB.scan({
      absolute: true,
      followSymlinks: true,
      dot: true,
      cwd: dir,
    })) {
      const md = await ConfigMarkdown.parse(item)
      if (!md.data) continue

      const name = (() => {
        const patterns = ["/.synergy/command/", "/command/"]
        const pattern = patterns.find((p) => item.includes(p))

        if (pattern) {
          const index = item.indexOf(pattern)
          return item.slice(index + pattern.length, -3)
        }
        return path.basename(item, ".md")
      })()

      const config = {
        name,
        ...md.data,
        template: md.content.trim(),
      }
      const parsed = Command.safeParse(config)
      if (parsed.success) {
        result[config.name] = parsed.data
        continue
      }
      throw new InvalidError({ path: item, issues: parsed.error.issues }, { cause: parsed.error })
    }
    return result
  }

  const AGENT_GLOB = new Bun.Glob("{agent,agents}/**/*.md")
  async function loadAgent(dir: string) {
    const result: Record<string, Agent> = {}

    for await (const item of AGENT_GLOB.scan({
      absolute: true,
      followSymlinks: true,
      dot: true,
      cwd: dir,
    })) {
      const md = await ConfigMarkdown.parse(item)
      if (!md.data) continue

      // Extract relative path from agent folder for nested agents
      let agentName = path.basename(item, ".md")
      const agentFolderPath = item.includes("/.synergy/agent/")
        ? item.split("/.synergy/agent/")[1]
        : item.includes("/agent/")
          ? item.split("/agent/")[1]
          : agentName + ".md"

      // If agent is in a subfolder, include folder path in name
      if (agentFolderPath.includes("/")) {
        const relativePath = agentFolderPath.replace(".md", "")
        const pathParts = relativePath.split("/")
        agentName = pathParts.slice(0, -1).join("/") + "/" + pathParts[pathParts.length - 1]
      }

      const config = {
        name: agentName,
        ...md.data,
        prompt: md.content.trim(),
      }
      const parsed = Agent.safeParse(config)
      if (parsed.success) {
        result[config.name] = parsed.data
        continue
      }
      throw new InvalidError({ path: item, issues: parsed.error.issues }, { cause: parsed.error })
    }
    return result
  }

  const PLUGIN_GLOB = new Bun.Glob("{plugin,plugins}/*.{ts,js}")
  async function loadPlugin(dir: string) {
    const plugins: string[] = []

    for await (const item of PLUGIN_GLOB.scan({
      absolute: true,
      followSymlinks: true,
      dot: true,
      cwd: dir,
    })) {
      plugins.push(pathToFileURL(item).href)
    }
    return plugins
  }

  export const McpLocal = z
    .object({
      type: z.literal("local").describe("Type of MCP server connection"),
      command: z.string().array().describe("Command and arguments to run the MCP server"),
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
        .describe(
          "Timeout in ms for fetching tools from the MCP server. Defaults to 5000 (5 seconds) if not specified.",
        ),
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
        .describe(
          "OAuth authentication configuration for the MCP server. Set to false to disable OAuth auto-detection.",
        ),
      timeout: z
        .number()
        .int()
        .positive()
        .optional()
        .describe(
          "Timeout in ms for fetching tools from the MCP server. Defaults to 5000 (5 seconds) if not specified.",
        ),
    })
    .strict()
    .meta({
      ref: "McpRemoteConfig",
    })

  export const Mcp = z.discriminatedUnion("type", [McpLocal, McpRemote])
  export type Mcp = z.infer<typeof Mcp>

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
      domain: z
        .enum(["feishu", "lark"])
        .optional()
        .describe("Feishu domain (feishu for China, lark for international)"),
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
    })
    .catchall(z.any())
    .transform((agent, ctx) => {
      const knownKeys = new Set([
        "name",
        "model",
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
      messages_half_page_down: z
        .string()
        .optional()
        .default("ctrl+alt+d")
        .describe("Scroll messages down by half page"),
      messages_first: z.string().optional().default("ctrl+g,home").describe("Navigate to first message"),
      messages_last: z.string().optional().default("ctrl+alt+g,end").describe("Navigate to last message"),
      messages_next: z.string().optional().default("none").describe("Navigate to next message"),
      messages_previous: z.string().optional().default("none").describe("Navigate to previous message"),
      messages_last_user: z.string().optional().default("none").describe("Navigate to last user message"),
      messages_copy: z.string().optional().default("<leader>y").describe("Copy message"),
      messages_undo: z.string().optional().default("<leader>u").describe("Undo message"),
      messages_redo: z.string().optional().default("<leader>r").describe("Redo message"),
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
      input_select_line_home: z
        .string()
        .optional()
        .default("ctrl+shift+a")
        .describe("Select to start of line in input"),
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

  export const EvolutionPassive = z
    .object({
      encode: z
        .boolean()
        .optional()
        .describe("Learn from conversations — extract intent, reward, and scripts (default: true)"),
      retrieve: z
        .union([z.boolean(), PassiveRetrieval])
        .optional()
        .describe("Inject relevant past experiences into new conversations (default: true)"),
      learning: Learning.optional().describe("Hyperparameters for the experience learning pipeline"),
    })
    .strict()
    .meta({ ref: "EvolutionPassive" })

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

  export const EvolutionActive = z
    .object({
      retrieve: z
        .union([
          z.boolean(),
          z
            .object({
              simThreshold: z
                .number()
                .optional()
                .describe("Default minimum similarity for auto-injection (default: 0.7)"),
              topK: z
                .number()
                .optional()
                .describe("Default maximum entries per category to contextually retrieve (default: 3)"),
              categories: z
                .record(z.enum(MEMORY_CATEGORIES), CategoryRetrieveConfig)
                .optional()
                .describe("Per-category contextual retrieval overrides"),
            })
            .strict(),
        ])
        .optional()
        .describe("Auto-inject relevant memories into new conversations (default: true)"),
      memoryDedupThreshold: z
        .number()
        .min(0)
        .max(1)
        .optional()
        .describe("Cosine similarity threshold for blocking duplicate memory writes (default: 0.75)"),
    })
    .strict()
    .meta({ ref: "EvolutionActive" })

  export const EvolutionConfig = z
    .object({
      passive: z
        .union([z.boolean(), EvolutionPassive])
        .optional()
        .describe("RL-enhanced passive experience learning (default: true)"),
      active: z
        .union([z.boolean(), EvolutionActive])
        .optional()
        .describe("Agent-initiated active memory curation via memory tools (default: true)"),
    })
    .strict()
    .meta({ ref: "EvolutionConfig" })

  export const Evolution = z
    .union([z.boolean(), EvolutionConfig])
    .optional()
    .describe("Dual-mode evolution system: passive experience learning + active memory curation (default: true)")

  export const ACTIVE_RETRIEVAL_DEFAULTS = {
    simThreshold: 0.7,
    topK: 3,
  } as const

  export interface CategoryRetrieval {
    simThreshold: number
    topK: number
  }

  export interface ActiveRetrieval {
    enabled: boolean
    categories: Record<MemoryCategory, CategoryRetrieval>
  }

  export interface ResolvedEvolution {
    encode: boolean
    retrieve: boolean
    active: boolean
    activeRetrieval: ActiveRetrieval
    passiveRetrieval: Required<PassiveRetrieval>
    memoryDedupThreshold: number
    learning: Required<Learning>
  }

  export function resolveEvolution(raw?: z.infer<typeof Evolution>): ResolvedEvolution {
    function buildCategoryRetrieval(
      globalSimThreshold?: number,
      globalTopK?: number,
      overrides?: Partial<Record<MemoryCategory, { simThreshold?: number; topK?: number }>>,
    ): Record<MemoryCategory, CategoryRetrieval> {
      const simThreshold = globalSimThreshold ?? ACTIVE_RETRIEVAL_DEFAULTS.simThreshold
      const topK = globalTopK ?? ACTIVE_RETRIEVAL_DEFAULTS.topK
      const result = {} as Record<MemoryCategory, CategoryRetrieval>
      for (const category of MEMORY_CATEGORIES) {
        const override = overrides?.[category]
        result[category] = {
          simThreshold: override?.simThreshold ?? simThreshold,
          topK: override?.topK ?? topK,
        }
      }
      return result
    }

    const defaultCategories = buildCategoryRetrieval()
    const defaultActiveRetrieval: ActiveRetrieval = { enabled: true, categories: defaultCategories }
    const disabledActiveRetrieval: ActiveRetrieval = { enabled: false, categories: defaultCategories }

    const MEMORY_DEDUP_THRESHOLD_DEFAULT = 0.75

    if (raw === false)
      return {
        encode: false,
        retrieve: false,
        active: false,
        activeRetrieval: disabledActiveRetrieval,
        passiveRetrieval: { ...PASSIVE_RETRIEVAL_DEFAULTS },
        memoryDedupThreshold: MEMORY_DEDUP_THRESHOLD_DEFAULT,
        learning: { ...LEARNING_DEFAULTS },
      }
    if (raw === true || raw === undefined)
      return {
        encode: true,
        retrieve: true,
        active: true,
        activeRetrieval: defaultActiveRetrieval,
        passiveRetrieval: { ...PASSIVE_RETRIEVAL_DEFAULTS },
        memoryDedupThreshold: MEMORY_DEDUP_THRESHOLD_DEFAULT,
        learning: { ...LEARNING_DEFAULTS },
      }

    const passive = raw.passive
    let encode: boolean
    let retrieve: boolean
    let learning: Required<Learning>
    let passiveRetrieval: Required<PassiveRetrieval>
    if (passive === false) {
      encode = false
      retrieve = false
      learning = { ...LEARNING_DEFAULTS }
      passiveRetrieval = { ...PASSIVE_RETRIEVAL_DEFAULTS }
    } else if (passive === true || passive === undefined) {
      encode = true
      retrieve = true
      learning = { ...LEARNING_DEFAULTS }
      passiveRetrieval = { ...PASSIVE_RETRIEVAL_DEFAULTS }
    } else {
      encode = passive.encode ?? true
      const rawRetrieve = passive.retrieve
      if (rawRetrieve === false) {
        retrieve = false
        passiveRetrieval = { ...PASSIVE_RETRIEVAL_DEFAULTS }
      } else if (rawRetrieve === true || rawRetrieve === undefined) {
        retrieve = true
        passiveRetrieval = { ...PASSIVE_RETRIEVAL_DEFAULTS }
      } else {
        retrieve = true
        passiveRetrieval = { ...PASSIVE_RETRIEVAL_DEFAULTS, ...rawRetrieve }
      }
      const rawLearning = passive.learning
      learning = {
        ...LEARNING_DEFAULTS,
        ...rawLearning,
        rewardWeights: { ...REWARD_WEIGHT_DEFAULTS, ...rawLearning?.rewardWeights },
      }
    }

    const activeRaw = raw.active
    let active: boolean
    let activeRetrieval: ActiveRetrieval
    let memoryDedupThreshold = MEMORY_DEDUP_THRESHOLD_DEFAULT
    if (activeRaw === false) {
      active = false
      activeRetrieval = disabledActiveRetrieval
    } else if (activeRaw === true || activeRaw === undefined) {
      active = true
      activeRetrieval = defaultActiveRetrieval
    } else {
      active = true
      memoryDedupThreshold = activeRaw.memoryDedupThreshold ?? MEMORY_DEDUP_THRESHOLD_DEFAULT
      const r = activeRaw.retrieve
      if (r === false) {
        activeRetrieval = disabledActiveRetrieval
      } else if (r === true || r === undefined) {
        activeRetrieval = defaultActiveRetrieval
      } else {
        activeRetrieval = {
          enabled: true,
          categories: buildCategoryRetrieval(r.simThreshold, r.topK, r.categories),
        }
      }
    }

    return { encode, retrieve, active, activeRetrieval, passiveRetrieval, memoryDedupThreshold, learning }
  }

  export const Identity = z
    .object({
      embedding: z
        .object({
          baseURL: z.string().optional().describe("Base URL for the embedding API"),
          apiKey: z.string().optional().describe("API key for the embedding service"),
          model: z.string().optional().describe("Embedding model name (e.g., 'Qwen/Qwen3-Embedding-8B')"),
        })
        .optional()
        .describe("Embedding model configuration for memory and retrieval"),
      rerank: z
        .object({
          baseURL: z.string().optional().describe("Base URL for the rerank API"),
          apiKey: z.string().optional().describe("API key for the rerank service (falls back to embedding.apiKey)"),
          model: z.string().optional().describe("Rerank model name (e.g., 'Qwen/Qwen3-Reranker-8B')"),
        })
        .optional()
        .describe("Rerank model configuration for memory retrieval refinement"),
      evolution: Evolution,
      autonomy: z
        .boolean()
        .optional()
        .describe("Enable autonomous background routines like anima daily wake (default: true)"),
    })
    .strict()
    .meta({
      ref: "IdentityConfig",
    })
  export type Identity = z.infer<typeof Identity>

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
                  "Timeout in milliseconds for requests to this provider. Default is 300000 (5 minutes). Set to false to disable timeout.",
                ),
              z.literal(false).describe("Disable timeout for this provider entirely."),
            ])
            .optional()
            .describe(
              "Timeout in milliseconds for requests to this provider. Default is 300000 (5 minutes). Set to false to disable timeout.",
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

  export const Info = z
    .object({
      $schema: z.string().optional().describe("JSON schema reference for configuration validation"),
      theme: z.string().optional().describe("Theme name to use for the interface"),
      keybinds: Keybinds.optional().describe("Custom keybind configurations"),
      logLevel: Log.Level.optional().describe("Log level"),
      server: Server.optional().describe("Server configuration for synergy serve and web commands"),
      command: z.record(z.string(), Command).optional().describe("Command configuration"),
      watcher: z
        .object({
          ignore: z.array(z.string()).optional(),
        })
        .optional(),
      plugin: z.string().array().optional(),
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
      holos_friend_reply_model: z
        .string()
        .describe(
          "Model for Holos automatic friend replies, in the format of provider/model. Falls back to the default model if not set.",
        )
        .optional(),
      vision_model: z
        .string()
        .describe(
          "Model for vision tasks (image/PDF/video analysis), in the format of provider/model. Required for the look_at tool to work. If not set, vision capabilities are disabled.",
        )
        .optional(),
      default_agent: z
        .string()
        .optional()
        .describe(
          "Default agent to use when none is specified. Must be a primary agent. Falls back to 'synergy' if not set or if the specified agent is invalid.",
        ),
      username: z
        .string()
        .optional()
        .describe("Custom username to display in conversations instead of system username"),
      agent: z
        .object({
          // primary
          master: Agent.optional(),
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
      provider: z
        .record(z.string(), Provider)
        .optional()
        .describe("Custom provider configurations and model overrides"),
      identity: Identity.optional().describe("Identity configuration for embedding and evolution"),
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
      channel: z
        .record(z.string(), Channel)
        .optional()
        .describe("Channel configurations for messaging platform integrations"),
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
      layout: Layout.optional().describe("@deprecated Always uses stretch layout."),
      permission: Permission.optional(),
      tools: z.record(z.string(), z.boolean()).optional(),
      enterprise: z
        .object({
          url: z.string().optional().describe("Enterprise URL"),
        })
        .optional(),
      agora: z
        .object({
          url: z.string().optional().describe("Agora API base URL (defaults to https://agora.holosai.io)"),
          tokenUrl: z
            .string()
            .optional()
            .describe("Holos API URL for Agora token exchange (defaults to https://www.holosai.io)"),
          giteaSSHHost: z.string().optional().describe("Override SSH hostname used for Agora's Gitea remote"),
        })

        .optional()
        .describe("Agora Q&A platform configuration"),
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
    })
    .strict()
    .meta({
      ref: "Config",
    })

  export type Info = z.output<typeof Info>

  export const global = lazy(async () => {
    const activeSet = await ConfigSet.activeName()
    let result: Info = pipe({}, mergeDeep(await loadFile(ConfigSet.filePath(activeSet))))

    // Legacy: migrate from TOML config if it exists
    await import(path.join(Global.Path.config, "config"), {
      with: {
        type: "toml",
      },
    })
      .then(async (mod) => {
        const { provider, model, ...rest } = mod.default
        if (provider && model) result.model = `${provider}/${model}`
        result["$schema"] = Global.Path.configSchemaUrl
        result = mergeDeep(result, rest)
        await Bun.write(ConfigSet.defaultFilePath(), JSON.stringify(result, null, 2))
        await fs.unlink(path.join(Global.Path.config, "config"))
      })
      .catch(() => {})

    return result
  })

  async function loadFile(filepath: string): Promise<Info> {
    log.info("loading", { path: filepath })
    let text = await Bun.file(filepath)
      .text()
      .catch((err) => {
        if (err.code === "ENOENT") return
        throw new JsonError({ path: filepath }, { cause: err })
      })
    if (!text) return {}
    return load(text, filepath)
  }

  async function load(text: string, configFilepath: string) {
    text = text.replace(/\{env:([^}]+)\}/g, (_, varName) => {
      return process.env[varName] || ""
    })

    const fileMatches = text.match(/\{file:[^}]+\}/g)
    if (fileMatches) {
      const configDir = path.dirname(configFilepath)
      const lines = text.split("\n")

      for (const match of fileMatches) {
        const lineIndex = lines.findIndex((line) => line.includes(match))
        if (lineIndex !== -1 && lines[lineIndex].trim().startsWith("//")) {
          continue // Skip if line is commented
        }
        let filePath = match.replace(/^\{file:/, "").replace(/\}$/, "")
        if (filePath.startsWith("~/")) {
          filePath = path.join(os.homedir(), filePath.slice(2))
        }
        const resolvedPath = path.isAbsolute(filePath) ? filePath : path.resolve(configDir, filePath)
        const fileContent = (
          await Bun.file(resolvedPath)
            .text()
            .catch((error) => {
              const errMsg = `bad file reference: "${match}"`
              if (error.code === "ENOENT") {
                throw new InvalidError(
                  {
                    path: configFilepath,
                    message: errMsg + ` ${resolvedPath} does not exist`,
                  },
                  { cause: error },
                )
              }
              throw new InvalidError({ path: configFilepath, message: errMsg }, { cause: error })
            })
        ).trim()
        // escape newlines/quotes, strip outer quotes
        text = text.replace(match, JSON.stringify(fileContent).slice(1, -1))
      }
    }

    const errors: JsoncParseError[] = []
    const data = parseJsonc(text, errors, { allowTrailingComma: true })
    if (errors.length) {
      const lines = text.split("\n")
      const errorDetails = errors
        .map((e) => {
          const beforeOffset = text.substring(0, e.offset).split("\n")
          const line = beforeOffset.length
          const column = beforeOffset[beforeOffset.length - 1].length + 1
          const problemLine = lines[line - 1]

          const error = `${printParseErrorCode(e.error)} at line ${line}, column ${column}`
          if (!problemLine) return error

          return `${error}\n   Line ${line}: ${problemLine}\n${"".padStart(column + 9)}^`
        })
        .join("\n")

      throw new JsonError({
        path: configFilepath,
        message: `\n--- JSONC Input ---\n${text}\n--- Errors ---\n${errorDetails}\n--- End ---`,
      })
    }

    const parsed = Info.safeParse(data)
    if (parsed.success) {
      if (!parsed.data.$schema) {
        parsed.data.$schema = CONFIG_SCHEMA
      }
      const data = parsed.data
      if (data.plugin) {
        for (let i = 0; i < data.plugin.length; i++) {
          const plugin = data.plugin[i]
          try {
            data.plugin[i] = import.meta.resolve!(plugin, configFilepath)
          } catch (err) {}
        }
      }
      return data
    }

    throw new InvalidError({
      path: configFilepath,
      issues: parsed.error.issues,
    })
  }
  export const JsonError = NamedError.create(
    "ConfigJsonError",
    z.object({
      path: z.string(),
      message: z.string().optional(),
    }),
  )

  export const ConfigDirectoryTypoError = NamedError.create(
    "ConfigDirectoryTypoError",
    z.object({
      path: z.string(),
      dir: z.string(),
      suggestion: z.string(),
    }),
  )

  export const InvalidError = NamedError.create(
    "ConfigInvalidError",
    z.object({
      path: z.string(),
      issues: z.custom<z.core.$ZodIssue[]>().optional(),
      message: z.string().optional(),
    }),
  )

  export async function get() {
    return state().then((x) => x.config)
  }

  export const Event = {
    Updated: BusEvent.define(
      "config.updated",
      z.object({
        scope: z.enum(["global", "project"]),
        changedFields: z.string().array(),
      }),
    ),
    SetActivated: BusEvent.define(
      "config.set.activated",
      z.object({
        previous: ConfigSet.Name,
        active: ConfigSet.Name,
      }),
    ),
  }

  export function diff(oldConfig: Info, newConfig: Info): string[] {
    const allKeys = new Set([...Object.keys(oldConfig), ...Object.keys(newConfig)])
    const changed: string[] = []
    for (const key of allKeys) {
      if (key === "$schema") continue
      const oldVal = (oldConfig as any)[key]
      const newVal = (newConfig as any)[key]
      if (oldVal === newVal) continue
      try {
        if (JSON.stringify(oldVal) === JSON.stringify(newVal)) continue
      } catch {}
      changed.push(key)
    }
    return changed
  }

  export async function reload(scope: "global" | "project" = "global") {
    const oldConfig = await state()
      .then((x) => x.config)
      .catch(() => ({}) as Info)

    global.reset()
    if (scope === "global") {
      await state.resetAll()
    } else {
      await state.reset()
    }

    const newConfig = await state().then((x) => x.config)
    const changedFields = diff(oldConfig, newConfig)

    if (changedFields.length > 0) {
      log.info("config reloaded", { scope, changedFields })
    } else {
      log.info("config reloaded, no changes detected")
    }

    return { config: newConfig, changedFields, oldConfig }
  }

  async function patchFile(filepath: string, config: Info) {
    let text = await Bun.file(filepath)
      .text()
      .catch(() => "{}")

    for (const [key, value] of Object.entries(config)) {
      if (value !== null && typeof value === "object" && !Array.isArray(value)) {
        for (const [subKey, subValue] of Object.entries(value)) {
          const edits = modify(text, [key, subKey], subValue, { formattingOptions })
          text = applyEdits(text, edits)
        }
      } else {
        const edits = modify(text, [key], value, { formattingOptions })
        text = applyEdits(text, edits)
      }
    }

    await Bun.write(filepath, text)
  }

  export async function update(config: Info) {
    const synergyDir = path.join(Instance.directory, ".synergy")
    const filepath = path.join(synergyDir, "synergy.jsonc")
    await patchFile(filepath, config)
    await Instance.dispose()
  }

  export async function updateGlobal(config: Info) {
    const filepath = await globalPath()
    await fs.mkdir(path.dirname(filepath), { recursive: true })
    await patchFile(filepath, config)
  }

  export async function globalPath() {
    return ConfigSet.filePath(await ConfigSet.activeName())
  }

  export const RawValidationResult = z
    .object({
      valid: z.boolean(),
      config: Info.optional(),
      errors: z.array(z.string()),
      warnings: z.array(z.string()),
    })
    .meta({ ref: "ConfigRawValidationResult" })
  export type RawValidationResult = z.infer<typeof RawValidationResult>

  export const RawSet = z
    .object({
      name: ConfigSet.Name,
      path: z.string(),
      raw: z.string(),
      config: Info.optional(),
      active: z.boolean(),
      isDefault: z.boolean(),
    })
    .meta({ ref: "ConfigSetRaw" })
  export type RawSet = z.infer<typeof RawSet>

  export const RawSaveResult = z
    .object({
      configSet: RawSet,
      validation: RawValidationResult,
      saved: z.boolean(),
      runtimeReload: RuntimeSchema.ReloadResult.optional(),
    })
    .meta({ ref: "ConfigSetRawSaveResult" })
  export type RawSaveResult = z.infer<typeof RawSaveResult>

  export async function readRawFile(filepath: string) {
    const text = await Bun.file(filepath)
      .text()
      .catch((err) => {
        if (err.code === "ENOENT") return "{}\n"
        throw new JsonError({ path: filepath }, { cause: err })
      })
    return text && text.length > 0 ? text : "{}\n"
  }

  export async function validateRaw(text: string, filepath: string): Promise<RawValidationResult> {
    const warnings: string[] = []

    try {
      const config = await load(text, filepath)
      if (!config.model) {
        warnings.push("No default model specified — you may need to set one before using this Config Set.")
      }
      return {
        valid: true,
        config,
        errors: [],
        warnings,
      }
    } catch (error) {
      if (JsonError.isInstance(error) || InvalidError.isInstance(error)) {
        const issues =
          InvalidError.isInstance(error) && error.data.issues?.length
            ? error.data.issues.map((issue) => {
                const location = issue.path.length > 0 ? `${issue.path.join(".")}: ` : ""
                return `${location}${issue.message}`
              })
            : []
        const details = [error.data.message, ...issues].filter((item): item is string => Boolean(item))
        return {
          valid: false,
          errors: details.length > 0 ? details : ["Invalid config"],
          warnings,
        }
      }
      throw error
    }
  }

  export async function configSetGetRaw(name: string): Promise<RawSet> {
    await ConfigSet.assertExists(name)
    const summary = await ConfigSet.summary(name)
    const filepath = ConfigSet.filePath(name)
    const raw = await readRawFile(filepath)
    const validation = await validateRaw(raw, filepath)
    return {
      ...summary,
      path: filepath,
      raw,
      config: validation.config,
    }
  }

  export async function configSetSaveRaw(name: string, raw: string, reload = true): Promise<RawSaveResult> {
    const parsed = await ConfigSet.assertExists(name)
    const filepath = ConfigSet.filePath(parsed)
    const validation = await validateRaw(raw, filepath)
    if (!validation.valid) {
      throw new InvalidError({
        path: filepath,
        message: validation.errors.join("\n\n"),
      })
    }

    await fs.mkdir(path.dirname(filepath), { recursive: true })
    await Bun.write(filepath, raw.endsWith("\n") ? raw : raw + "\n")

    const configSet = await configSetGetRaw(parsed)
    const shouldReload = reload && configSet.active
    const runtimeReload = shouldReload
      ? await import("../runtime/reload").then((mod) =>
          mod.RuntimeReload.reload({
            targets: ["config"],
            scope: "global",
            reason: `config.set.raw.save:${parsed}`,
          }),
        )
      : undefined

    return {
      configSet,
      validation,
      saved: true,
      runtimeReload,
    }
  }

  export async function globalRaw() {
    return loadFile(await globalPath())
  }

  export async function configSetList() {
    return ConfigSet.list()
  }

  export async function configSetGet(name: string) {
    await ConfigSet.assertExists(name)
    return {
      ...(await ConfigSet.summary(name)),
      config: await loadFile(ConfigSet.filePath(name)),
    }
  }

  export async function configSetCreate(name: string, config?: Info) {
    const filepath = await ConfigSet.create(name)
    const initialConfig = config ?? (await globalRaw())
    if (Object.keys(initialConfig).length > 0) {
      await patchFile(filepath, initialConfig)
    }
    return configSetGet(name)
  }

  export async function configSetUpdate(name: string, config: Info) {
    const parsed = await ConfigSet.assertExists(name)
    await fs.mkdir(path.dirname(ConfigSet.filePath(parsed)), { recursive: true })
    await patchFile(ConfigSet.filePath(parsed), config)
    return configSetGet(parsed)
  }

  export async function configSetDelete(name: string) {
    const summary = await ConfigSet.summary(name)
    await ConfigSet.remove(name)
    return summary
  }

  export async function configSetActivate(name: string) {
    const result = await ConfigSet.activate(name)
    if (result.changed) {
      GlobalBus.emit("event", {
        directory: Instance.directory,
        payload: {
          type: Event.SetActivated.type,
          properties: {
            previous: result.previous,
            active: result.active,
          },
        },
      })
    }
    return result
  }

  export async function directories() {
    return state().then((x) => x.directories)
  }
}
