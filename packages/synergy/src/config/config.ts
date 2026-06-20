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
import { loadFragments } from "./fragment"
import { RuntimeSchema } from "../runtime/schema"
import * as Schema from "./schema"

export namespace Config {
  const log = Log.create({ service: "config" })
  const CONFIG_SCHEMA = Global.Path.configSchemaUrl
  const formattingOptions = {
    tabSize: 2,
    insertSpaces: true,
    eol: "\n",
  } as const

  // ── Schema re-exports from ./schema.ts ──

  export const McpLocal = Schema.McpLocal
  export const McpRetry = Schema.McpRetry
  export type McpRetry = Schema.McpRetry
  export const McpToolFilter = Schema.McpToolFilter
  export type McpToolFilter = Schema.McpToolFilter
  export const McpTools = Schema.McpTools
  export type McpTools = Schema.McpTools
  export const McpToolCache = Schema.McpToolCache
  export type McpToolCache = Schema.McpToolCache
  export const McpOAuth = Schema.McpOAuth
  export type McpOAuth = Schema.McpOAuth
  export const McpRemote = Schema.McpRemote
  export const Mcp = Schema.Mcp
  export type Mcp = Schema.Mcp
  export const McpDefaults = Schema.McpDefaults
  export type McpDefaults = Schema.McpDefaults
  export const FeishuGroupSessionScope = Schema.FeishuGroupSessionScope
  export type FeishuGroupSessionScope = Schema.FeishuGroupSessionScope
  export const ChannelFeishuAccount = Schema.ChannelFeishuAccount
  export type ChannelFeishuAccount = Schema.ChannelFeishuAccount
  export const ChannelFeishu = Schema.ChannelFeishu
  export type ChannelFeishu = Schema.ChannelFeishu
  export const Holos = Schema.Holos
  export type Holos = Schema.Holos
  export const SandboxConfig = Schema.SandboxConfig
  export type SandboxConfig = Schema.SandboxConfig
  export const Channel = Schema.Channel
  export type Channel = Schema.Channel
  export const EmailSmtp = Schema.EmailSmtp
  export type EmailSmtp = Schema.EmailSmtp
  export const EmailImap = Schema.EmailImap
  export type EmailImap = Schema.EmailImap
  export const EmailFrom = Schema.EmailFrom
  export type EmailFrom = Schema.EmailFrom
  export const Email = Schema.Email
  export type Email = Schema.Email
  export const PermissionAction = Schema.PermissionAction
  export type PermissionAction = Schema.PermissionAction
  export const PermissionObject = Schema.PermissionObject
  export type PermissionObject = Schema.PermissionObject
  export const PermissionRule = Schema.PermissionRule
  export type PermissionRule = Schema.PermissionRule
  export const ControlProfileId = Schema.ControlProfileId
  export type ControlProfileId = Schema.ControlProfileId

  export const Permission = Schema.Permission
  export type Permission = Schema.Permission
  export const Command = Schema.Command
  export type Command = Schema.Command
  export const Agent = Schema.Agent
  export type Agent = Schema.Agent
  export const ExternalAgentConfig = Schema.ExternalAgentConfig
  export type ExternalAgentConfig = Schema.ExternalAgentConfig
  export const Keybinds = Schema.Keybinds
  export const Server = Schema.Server
  export const CategoryConfig = Schema.CategoryConfig
  export type CategoryConfig = Schema.CategoryConfig
  export const Layout = Schema.Layout
  export type Layout = Schema.Layout
  export const Learning = Schema.Learning
  export type Learning = Schema.Learning
  export const PassiveRetrieval = Schema.PassiveRetrieval
  export type PassiveRetrieval = Schema.PassiveRetrieval
  export const REWARD_WEIGHT_DEFAULTS = Schema.REWARD_WEIGHT_DEFAULTS
  export const LEARNING_DEFAULTS = Schema.LEARNING_DEFAULTS
  export const PASSIVE_RETRIEVAL_DEFAULTS = Schema.PASSIVE_RETRIEVAL_DEFAULTS
  export const MEMORY_CATEGORIES = Schema.MEMORY_CATEGORIES
  export type MemoryCategory = Schema.MemoryCategory
  export const EmbeddingConfig = Schema.EmbeddingConfig
  export type EmbeddingConfig = Schema.EmbeddingConfig
  export const RerankConfig = Schema.RerankConfig
  export type RerankConfig = Schema.RerankConfig
  export const MemoryConfig = Schema.MemoryConfig
  export type MemoryConfig = Schema.MemoryConfig
  export const ExperienceConfig = Schema.ExperienceConfig
  export type ExperienceConfig = Schema.ExperienceConfig
  export const EngramConfig = Schema.EngramConfig
  export type EngramConfig = Schema.EngramConfig
  export const Provider = Schema.Provider
  export type Provider = Schema.Provider
  export const Info = Schema.Info
  export type Info = Schema.Info

  /**
   * Normalize an MCP server config by applying defaults and legacy timeout
   * compatibility. Callers should pass `config.experimental?.mcp_timeout` and
   * `config.mcpDefaults` to fill missing timeouts.
   */
  export function normalizeMcp(server: Mcp, defaults?: McpDefaults, defaultCallTimeoutMs?: number): Mcp {
    const result = { ...server }
    const legacyTimeout = result.timeout

    if (legacyTimeout !== undefined) {
      if (result.connectTimeout === undefined) result.connectTimeout = legacyTimeout
      if (result.listTimeout === undefined) result.listTimeout = legacyTimeout
      if (result.callTimeout === undefined) result.callTimeout = legacyTimeout
    }

    if (defaultCallTimeoutMs !== undefined && result.callTimeout === undefined) {
      result.callTimeout = defaultCallTimeoutMs
    }

    if (defaults) {
      if (result.startup === undefined) result.startup = defaults.startup
      if (result.required === undefined) result.required = defaults.required
      if (result.connectTimeout === undefined) result.connectTimeout = defaults.connectTimeout
      if (result.listTimeout === undefined) result.listTimeout = defaults.listTimeout
      if (result.callTimeout === undefined) result.callTimeout = defaults.callTimeout
      if (result.idleShutdownMs === undefined) result.idleShutdownMs = defaults.idleShutdownMs
      if (result.retry === undefined) result.retry = defaults.retry
      if (result.toolFilter === undefined) result.toolFilter = defaults.toolFilter
      if (result.tools === undefined) result.tools = defaults.tools
      if (result.toolCache === undefined) result.toolCache = defaults.toolCache
    }

    result.startup ??= "eager"
    return result
  }

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
  const wellKnownCache = new Map<string, { data: Info; timestamp: number }>()
  const WELL_KNOWN_TTL_MS = 10 * 60 * 1000 // 10 minutes

  export const state = Instance.state(async () => {
    const auth = await Auth.all()

    // Load remote/well-known config first as the base layer (lowest precedence)
    // This allows organizations to provide default configs that users can override
    let result: Info = {}

    // Inject env vars synchronously (before any fetch/await)
    for (const [key, value] of Object.entries(auth)) {
      if (value.type !== "wellknown") continue
      process.env[value.key] = value.token
    }

    // Fetch well-known configs in parallel with TTL caching
    const wellKnownEntries = Object.entries(auth).filter(([, v]) => v.type === "wellknown")
    const fetchedConfigs = await Promise.all(
      wellKnownEntries.map(async ([key]) => {
        const cached = wellKnownCache.get(key)
        if (cached && Date.now() - cached.timestamp < WELL_KNOWN_TTL_MS) {
          log.debug("using cached remote config", { url: key })
          return cached.data
        }

        log.debug("fetching remote config", { url: `${key}/.well-known/synergy` })

        const remoteConfig = await fetch(`${key}/.well-known/synergy`, {
          signal: AbortSignal.timeout(5000),
        })
          .then(async (response) => {
            if (!response.ok) {
              log.warn("failed to fetch remote config, skipping", {
                url: `${key}/.well-known/synergy`,
                status: response.status,
              })
              return null
            }
            const wellknown = (await response.json()) as any
            return wellknown.config ?? {}
          })
          .catch((err) => {
            log.warn("failed to fetch remote config, skipping", {
              url: `${key}/.well-known/synergy`,
              error: err instanceof Error ? err.message : String(err),
            })
            return null
          })

        if (!remoteConfig) return null

        if (!remoteConfig.$schema) remoteConfig.$schema = Global.Path.configSchemaUrl
        const loaded = await load(JSON.stringify(remoteConfig), `${key}/.well-known/synergy`)
        wellKnownCache.set(key, { data: loaded, timestamp: Date.now() })
        log.debug("loaded remote config from well-known", { url: key })
        return loaded
      }),
    )

    // Merge fetched configs as base layer (lowest precedence)
    for (const cfg of fetchedConfigs) {
      if (cfg) result = mergeConfigConcatArrays(result, cfg)
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
        // Load synergy.d/ fragments
        const fragmentDir = path.join(dir, "synergy.d")
        const fragments = await loadFragments(fragmentDir)
        for (const fragment of fragments) {
          result = mergeConfigConcatArrays(result, fragment as Info) as Info
        }
        // Re-apply defaults after fragment merge (fragment widens result type)
        result.agent ??= {}
        result.plugin ??= []
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

    // Apply centralized defaults for fields shown in Settings UI.
    // These fill undefined values only — user-set values are preserved.
    if (result.autoupdate === undefined) result.autoupdate = true
    if (result.snapshot === undefined) result.snapshot = true
    if (result.default_agent === undefined) result.default_agent = "synergy"
    if (result.question === undefined) result.question = { timeout: 1800 }
    else if (result.question.timeout === undefined) result.question.timeout = 1800
    if (result.compaction === undefined) {
      result.compaction = { auto: true, prune: true, overflowThreshold: 0.85, maxHistoryImages: 8 }
    } else {
      if (result.compaction.auto === undefined) result.compaction.auto = true
      if (result.compaction.prune === undefined) result.compaction.prune = true
      if (result.compaction.overflowThreshold === undefined) result.compaction.overflowThreshold = 0.85
      if (result.compaction.maxHistoryImages === undefined) result.compaction.maxHistoryImages = 8
    }
    if (result.engram) {
      if (result.engram.memory === undefined) result.engram.memory = { enabled: true }
      if (result.engram.memory && !result.engram.memory.retrieval) {
        result.engram.memory.retrieval = { simThreshold: 0.7, topK: 3 }
      }
      if (result.engram.memory && !result.engram.memory.dedup) {
        result.engram.memory.dedup = { threshold: 0.75 }
      }
      if (result.engram.experience === undefined) {
        result.engram.experience = { encode: true, retrieve: true, learning: { ...LEARNING_DEFAULTS } }
      }
      if (result.engram.autonomy === undefined) result.engram.autonomy = true
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
    const pkgPath = path.join(dir, "package.json")

    if (!(await Bun.file(pkgPath).exists())) {
      await Bun.write(pkgPath, "{}")
    }

    const gitignore = path.join(dir, ".gitignore")
    const hasGitIgnore = await Bun.file(gitignore).exists()
    if (!hasGitIgnore) await Bun.write(gitignore, ["node_modules", "package.json", "bun.lock", ".gitignore"].join("\n"))

    const pluginPkg = "@ericsanchezok/synergy-plugin"
    const pluginVersion = Installation.isLocal() ? "latest" : Installation.VERSION
    const pluginInstalled = existsSync(path.join(dir, "node_modules", pluginPkg))

    // Only run bun add if the plugin is not already installed to avoid
    // repeatedly modifying bun.lock, which triggers the file watcher and
    // causes an auto-reload loop.
    if (!pluginInstalled) {
      await BunProc.run(["add", `${pluginPkg}@${pluginVersion}`, "--exact"], { cwd: dir }).catch(() => {})
    }

    // Install any additional dependencies defined in the package.json
    // This allows local plugins and custom tools to use external packages
    if (!existsSync(path.join(dir, "node_modules"))) {
      await BunProc.run(["install"], { cwd: dir }).catch(() => {})
    }
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
      log.warn("skipping invalid command definition", { path: item, issues: parsed.error.issues })
      continue
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
      log.warn("skipping invalid agent definition", { path: item, issues: parsed.error.issues })
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

  export const global = lazy(async () => {
    const activeSet = await ConfigSet.activeName()
    const result: Info = pipe({}, mergeDeep(await loadFile(ConfigSet.filePath(activeSet))))
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
      const value = process.env[varName]
      if (value === undefined) {
        log.warn("environment variable not set for config reference", {
          var: varName,
          path: configFilepath,
        })
      }
      return value || ""
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
        let fileContent: string
        try {
          fileContent = (await Bun.file(resolvedPath).text()).trim()
        } catch (error: any) {
          log.warn("failed to resolve file reference", {
            path: configFilepath,
            reference: match,
            resolvedPath,
            error: error.code ?? error.message,
          })
          const placeholder = `(file not resolved: ${path.basename(resolvedPath)})`
          text = text.replace(match, JSON.stringify(placeholder).slice(1, -1))
          continue
        }
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
      const result = parsed.data
      if (result.plugin) {
        for (let i = 0; i < result.plugin.length; i++) {
          const plugin = result.plugin[i]
          try {
            result.plugin[i] = import.meta.resolve!(plugin, configFilepath)
          } catch (err) {}
        }
      }
      return result
    }

    // Partial recovery: remove invalid sections / section entries and retry.
    // This allows Synergy to start with usable config even when individual
    // providers, agents, MCP servers, or channels have schema errors.
    const stripKeys = new Set<string>()
    for (const issue of parsed.error.issues) {
      if (issue.path.length === 0 && issue.code === "invalid_type") {
        // Root-level type error (e.g. data is not an object) — unrecoverable
        throw new InvalidError({
          path: configFilepath,
          issues: parsed.error.issues,
        })
      }
      const section = String(issue.path[0])
      stripKeys.add(section)
    }

    if (stripKeys.size === 0) {
      throw new InvalidError({
        path: configFilepath,
        issues: parsed.error.issues,
      })
    }

    log.warn("skipping invalid config sections (will use defaults)", {
      path: configFilepath,
      sections: [...stripKeys],
    })

    for (const key of stripKeys) {
      delete (data as Record<string, unknown>)[key]
    }

    const retried = Info.safeParse(data)
    if (retried.success) {
      if (!retried.data.$schema) {
        retried.data.$schema = CONFIG_SCHEMA
      }
      const result = retried.data
      if (result.plugin) {
        for (let i = 0; i < result.plugin.length; i++) {
          const plugin = result.plugin[i]
          try {
            result.plugin[i] = import.meta.resolve!(plugin, configFilepath)
          } catch (err) {}
        }
      }
      return result
    }

    throw new InvalidError({
      path: configFilepath,
      issues: retried.error.issues,
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
  /**
   * Sentinel value used by clients to indicate that a redacted password
   * field has not changed. When the server receives this value, it merges
   * the currently stored secret instead of overwriting it with the placeholder.
   */
  export const REDACTED_SENTINEL = "__REDACTED__"

  /** Deep-clone config and replace secrets with REDACTED_SENTINEL for safe client exposure. */
  export function redactForClient(config: Info): Info {
    const result = structuredClone(config) as Record<string, any>
    if (result.email?.smtp?.password) result.email.smtp.password = REDACTED_SENTINEL
    if (result.email?.imap?.password) result.email.imap.password = REDACTED_SENTINEL
    if (result.channel?.feishu?.accounts) {
      for (const account of Object.values(result.channel.feishu.accounts) as any[]) {
        if (account?.appSecret) account.appSecret = REDACTED_SENTINEL
      }
    }
    if (result.embedding?.apiKey) result.embedding.apiKey = REDACTED_SENTINEL
    if (result.rerank?.apiKey) result.rerank.apiKey = REDACTED_SENTINEL
    if (result.provider) {
      for (const provider of Object.values(result.provider) as any[]) {
        if (provider?.options?.apiKey) provider.options.apiKey = REDACTED_SENTINEL
      }
    }
    if (result.mcp) {
      for (const server of Object.values(result.mcp) as any[]) {
        if (server?.oauth?.clientSecret) server.oauth.clientSecret = REDACTED_SENTINEL
      }
    }
    return result as Info
  }

  /**
   * When an incoming PATCH payload has REDACTED_SENTINEL for any password
   * field, replace it with the currently stored value so the real secret
   * is not overwritten with the placeholder.
   */
  export function mergeRedactedSecrets(incoming: Info, stored: Info): Info {
    const result = structuredClone(incoming) as Record<string, any>
    if (result.email?.smtp?.password === REDACTED_SENTINEL && stored.email?.smtp?.password) {
      result.email.smtp.password = stored.email.smtp.password
    }
    if (result.email?.imap?.password === REDACTED_SENTINEL && stored.email?.imap?.password) {
      result.email.imap.password = stored.email.imap.password
    }
    if (result.channel?.feishu?.accounts && stored.channel?.feishu?.accounts) {
      for (const [key, account] of Object.entries(result.channel.feishu.accounts) as [string, any][]) {
        if (account?.appSecret === REDACTED_SENTINEL) {
          const storedAccount = (stored.channel.feishu.accounts as Record<string, any>)[key]
          if (storedAccount?.appSecret) account.appSecret = storedAccount.appSecret
        }
      }
    }
    if (result.embedding?.apiKey === REDACTED_SENTINEL && stored.embedding?.apiKey) {
      result.embedding.apiKey = stored.embedding.apiKey
    }
    if (result.rerank?.apiKey === REDACTED_SENTINEL && stored.rerank?.apiKey) {
      result.rerank.apiKey = stored.rerank.apiKey
    }
    if (result.provider && stored.provider) {
      for (const [key, provider] of Object.entries(result.provider) as [string, any][]) {
        if (provider?.options?.apiKey === REDACTED_SENTINEL) {
          const storedProvider = (stored.provider as Record<string, any>)[key]
          if (storedProvider?.options?.apiKey) provider.options.apiKey = storedProvider.options.apiKey
        }
      }
    }
    if (result.mcp && stored.mcp) {
      for (const [key, server] of Object.entries(result.mcp) as [string, any][]) {
        if (server?.oauth?.clientSecret === REDACTED_SENTINEL) {
          const storedServer = (stored.mcp as Record<string, any>)[key]
          if (storedServer?.oauth?.clientSecret) server.oauth.clientSecret = storedServer.oauth.clientSecret
        }
      }
    }
    return result as Info
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
      config: redactForClient(await loadFile(ConfigSet.filePath(name))),
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
    const stored = await loadFile(ConfigSet.filePath(parsed))
    const merged = mergeRedactedSecrets(config, stored)
    await fs.mkdir(path.dirname(ConfigSet.filePath(parsed)), { recursive: true })
    await patchFile(ConfigSet.filePath(parsed), merged)
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
