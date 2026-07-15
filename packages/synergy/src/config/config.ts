import { Log } from "../util/log"
import path from "path"
import os from "os"
import z from "zod"
import { Filesystem } from "../util/filesystem"
import { ModelsDev } from "../provider/models"
import { mergeDeep, unique } from "remeda"
import { Global } from "../global"
import fs from "fs/promises"
import { lazy } from "../util/lazy"
import { NamedError } from "@ericsanchezok/synergy-util/error"
import { Flag } from "../flag/flag"
import { Auth } from "../provider/api-key"
import { type ParseError as JsoncParseError, parse as parseJsonc, printParseErrorCode } from "jsonc-parser"
import { ScopeContext } from "../scope/context"
import { ScopedState } from "../scope/scoped-state"
import { ScopeRuntime } from "../scope/runtime"
import { Scope } from "../scope"
import { BusEvent } from "../bus/bus-event"
import { LSPServer } from "../lsp/server"
import { ConfigMarkdown } from "./markdown"
import { existsSync } from "fs"
import { loadFragments } from "./fragment"
import * as Schema from "./schema"
import { ConfigDomain } from "./domain"
import { PluginSpec } from "../util/plugin-spec"

export namespace Config {
  const log = Log.create({ service: "config" })
  const CONFIG_SCHEMA = Global.Path.configSchemaUrl
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
  export const ObservabilityConfig = Schema.ObservabilityConfig
  export type ObservabilityConfig = Schema.ObservabilityConfig
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
  export const PluginMarketplace = Schema.PluginMarketplace
  export type PluginMarketplace = Schema.PluginMarketplace
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
  export const LibraryConfig = Schema.LibraryConfig
  export type LibraryConfig = Schema.LibraryConfig
  export const Provider = Schema.Provider
  export type Provider = Schema.Provider
  export const ProviderCatalog = Schema.ProviderCatalog
  export type ProviderCatalog = Schema.ProviderCatalog
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
      merged.plugin = mergePluginSpecList(target.plugin, source.plugin)
    }
    if (target.instructions && source.instructions) {
      merged.instructions = Array.from(new Set([...target.instructions, ...source.instructions]))
    }
    if (target.project_doc_fallback_filenames && source.project_doc_fallback_filenames) {
      merged.project_doc_fallback_filenames = Array.from(
        new Set([...target.project_doc_fallback_filenames, ...source.project_doc_fallback_filenames]),
      )
    }
    return merged
  }
  const wellKnownCache = new Map<string, { data: Info; timestamp: number }>()
  const WELL_KNOWN_TTL_MS = 10 * 60 * 1000 // 10 minutes

  ConfigDomain.assertRegistryComplete()

  export const state = ScopedState.create(async () => {
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

    // Inline config content has highest precedence
    if (Flag.SYNERGY_CONFIG_CONTENT) {
      result = mergeConfigConcatArrays(result, JSON.parse(Flag.SYNERGY_CONFIG_CONTENT))
      log.debug("loaded custom config from SYNERGY_CONFIG_CONTENT")
    }

    result.agent = result.agent || {}
    result.plugin = result.plugin || []
    const scope = ScopeContext.current.scope
    const projectDirectories =
      scope.type === "project"
        ? await Array.fromAsync(
            Filesystem.up({
              targets: [".synergy"],
              start: ScopeContext.current.directory,
              stop: ScopeContext.current.directory,
            }),
          )
        : []
    const directories = [Global.Path.config, ...projectDirectories]

    if (Flag.SYNERGY_CONFIG_DIR) {
      directories.push(Flag.SYNERGY_CONFIG_DIR)
      log.debug("loading config from SYNERGY_CONFIG_DIR", { path: Flag.SYNERGY_CONFIG_DIR })
    }

    if (scope.type === "project") {
      await migrateLegacyProjectConfig(ScopeContext.current.directory)
    }

    for (const dir of unique(directories)) {
      if (dir.endsWith(".synergy") || dir === Flag.SYNERGY_CONFIG_DIR) {
        const fragmentDir = path.join(dir, "synergy.d")
        const fragments = await loadFragments(fragmentDir)
        for (const fragment of fragments) {
          result = mergeConfigConcatArrays(result, fragment as Info) as Info
        }
        // Re-apply defaults after fragment merge (fragment widens result type)
        result.agent ??= {}
        result.plugin ??= []
      }

      result.command = mergeDeep(result.command ?? {}, await loadCommand(dir))
      result.agent = mergeDeep(result.agent, await loadAgent(dir))
    }

    result.agent ??= {}
    result.plugin ??= []

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
    if (result.snapshot === undefined) result.snapshot = true
    if (result.default_agent === undefined) result.default_agent = "synergy"
    if (result.project_doc_fallback_filenames === undefined) result.project_doc_fallback_filenames = []
    if (result.project_doc_max_bytes === undefined) result.project_doc_max_bytes = 32 * 1024
    if (result.question === undefined) result.question = { timeout: 3600 }
    else if (result.question.timeout === undefined) result.question.timeout = 3600
    if (result.compaction === undefined) {
      result.compaction = { auto: true, prune: true, overflowThreshold: 0.85, maxHistoryImages: 8 }
    } else {
      if (result.compaction.auto === undefined) result.compaction.auto = true
      if (result.compaction.prune === undefined) result.compaction.prune = true
      if (result.compaction.overflowThreshold === undefined) result.compaction.overflowThreshold = 0.85
      if (result.compaction.maxHistoryImages === undefined) result.compaction.maxHistoryImages = 8
    }
    if (result.library) {
      if (result.library.memory === undefined) result.library.memory = { enabled: true }
      if (result.library.memory && !result.library.memory.retrieval) {
        result.library.memory.retrieval = { simThreshold: 0.7, topK: 3 }
      }
      if (result.library.memory && !result.library.memory.dedup) {
        result.library.memory.dedup = { threshold: 0.75 }
      }
      if (result.library.experience === undefined) {
        result.library.experience = { encode: true, retrieve: true, learning: { ...LEARNING_DEFAULTS } }
      }
      if (result.library.autonomy === undefined) result.library.autonomy = true
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

    const config = Info.parse(result)

    return {
      config,
      directories,
    }
  })

  const COMMAND_GLOB = new Bun.Glob("{command,commands}/**/*.md")
  async function loadCommand(dir: string) {
    const result: Record<string, Command> = {}
    if (!existsSync(dir)) return result

    for await (const item of COMMAND_GLOB.scan({
      absolute: true,
      followSymlinks: true,
      dot: true,
      cwd: dir,
    })) {
      const normalized = item.replaceAll("\\", "/")
      const md = await ConfigMarkdown.parse(item)
      if (!md.data) continue

      const name = (() => {
        const patterns = ["/.synergy/command/", "/command/"]
        const pattern = patterns.find((p) => normalized.includes(p))

        if (pattern) {
          const index = normalized.indexOf(pattern)
          return normalized.slice(index + pattern.length, -3)
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
    if (!existsSync(dir)) return result

    for await (const item of AGENT_GLOB.scan({
      absolute: true,
      followSymlinks: true,
      dot: true,
      cwd: dir,
    })) {
      const normalized = item.replaceAll("\\", "/")
      const md = await ConfigMarkdown.parse(item)
      if (!md.data) continue

      // Extract relative path from agent folder for nested agents
      let agentName = path.basename(item, ".md")
      const agentFolderPath = normalized.includes("/.synergy/agent/")
        ? normalized.split("/.synergy/agent/")[1]
        : normalized.includes("/agent/")
          ? normalized.split("/agent/")[1]
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

  export const global = lazy(async () => {
    await migrateLegacyGlobalConfig()
    return loadDomainDirectory(Global.Path.config)
  })

  async function loadDomainDirectory(root: string): Promise<Info> {
    let result: Info = {}
    for (const domain of ConfigDomain.definitions) {
      const filepath = ConfigDomain.filepath(domain.id, root)
      const fragment = await loadFile(filepath, { addSchema: false })
      ConfigDomain.validateKeys(fragment as Record<string, unknown>, domain.id)
      result = mergeConfigConcatArrays(result, fragment as Info)
    }
    return Info.parse(result)
  }

  async function migrateLegacyGlobalConfig() {
    const domainDir = ConfigDomain.directory()
    const existingDomainFiles = await fs
      .readdir(domainDir)
      .then((entries) => entries.some((entry) => ConfigDomain.domainForFile(entry)))
      .catch(() => false)

    const legacy = await findLegacyGlobalConfig()
    if (!legacy) {
      if (!existingDomainFiles) await ConfigDomain.ensureDir()
      return
    }

    log.info("migrating legacy global config to domain fragments", { source: legacy.source })
    const config = await loadFile(legacy.source)
    const split = ConfigDomain.split(config)
    const tempDir = `${domainDir}.tmp-${process.pid}-${Date.now()}`
    await fs.rm(tempDir, { recursive: true, force: true })
    await fs.mkdir(tempDir, { recursive: true })

    try {
      if (existingDomainFiles) {
        await fs.cp(domainDir, tempDir, { recursive: true, force: true })
      }

      for (const domain of ConfigDomain.definitions) {
        const filepath = path.join(tempDir, domain.filename)
        const existing = await loadFile(filepath, { addSchema: false })
        const fragment = split.get(domain.id) ?? {}
        await Bun.write(filepath, serializeConfig(mergeConfigConcatArrays(existing, fragment as Info)))
      }

      await fs.mkdir(path.dirname(domainDir), { recursive: true })
      await fs.rm(domainDir, { recursive: true, force: true })
      await fs.rename(tempDir, domainDir).catch(async (err) => {
        if (err?.code !== "EXDEV") throw err
        await fs.cp(tempDir, domainDir, { recursive: true, force: true })
        await fs.rm(tempDir, { recursive: true, force: true })
      })

      await archiveLegacyConfigSets()
      await archiveLegacyGlobalFile(legacy.source)
      await fs.rm(path.join(Global.Path.config, "config-set.json"), { force: true }).catch(() => {})
      log.info("migrated legacy global config", { source: legacy.source, target: domainDir })
    } catch (err) {
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {})
      throw err
    }
  }

  async function findLegacyGlobalConfig(): Promise<{ source: string } | undefined> {
    const metadataPath = path.join(Global.Path.config, "config-set.json")
    const activeName = await Bun.file(metadataPath)
      .json()
      .then((data) => (typeof data?.active === "string" ? data.active : "default"))
      .catch(() => "default")

    const activeSetPath =
      activeName && activeName !== "default"
        ? path.join(Global.Path.config, "config-sets", activeName, "synergy.jsonc")
        : undefined
    const candidates = [
      activeSetPath,
      path.join(Global.Path.config, "synergy.jsonc"),
      path.join(Global.Path.config, "synergy.json"),
      path.join(Global.Path.config, "config-sets", "default", "synergy.jsonc"),
    ].filter((item): item is string => Boolean(item))

    for (const candidate of candidates) {
      if (await Bun.file(candidate).exists()) return { source: candidate }
    }
    return undefined
  }

  async function archiveLegacyConfigSets() {
    const source = path.join(Global.Path.config, "config-sets")
    if (!(await Bun.file(source).exists())) return
    const target = path.join(Global.Path.config, "archive", "config-sets")
    await fs.mkdir(path.dirname(target), { recursive: true })
    await fs.cp(source, target, { recursive: true, force: true }).catch((err) => {
      log.warn("failed to archive legacy config sets", {
        source,
        target,
        error: err instanceof Error ? err.message : err,
      })
    })
  }

  async function archiveLegacyGlobalFile(filepath: string) {
    if (!filepath.startsWith(Global.Path.config)) return
    const archiveDir = path.join(Global.Path.config, "archive")
    await fs.mkdir(archiveDir, { recursive: true })
    const target = path.join(archiveDir, path.basename(filepath))
    await fs.rename(filepath, target).catch((err) => {
      log.warn("failed to archive legacy global config file", {
        source: filepath,
        target,
        error: err instanceof Error ? err.message : err,
      })
    })
  }

  async function migrateLegacyProjectConfig(projectRoot: string) {
    const synergyDir = path.join(projectRoot, ".synergy")
    const domainDir = ConfigDomain.directory(synergyDir)
    const existingDomainFiles = await fs
      .readdir(domainDir)
      .then((entries) => entries.some((entry) => ConfigDomain.domainForFile(entry)))
      .catch(() => false)
    if (existingDomainFiles) return

    const candidates = [
      path.join(projectRoot, "synergy.jsonc"),
      path.join(projectRoot, "synergy.json"),
      path.join(synergyDir, "synergy.jsonc"),
      path.join(synergyDir, "synergy.json"),
    ]

    let migrated: Info = {}
    const sources: string[] = []
    for (const candidate of candidates) {
      if (!(await Bun.file(candidate).exists())) continue
      migrated = mergeConfigConcatArrays(migrated, await loadFile(candidate))
      sources.push(candidate)
    }
    if (sources.length === 0) return

    log.info("migrating legacy project config to domain fragments", { sources, target: domainDir })
    for (const [id, fragment] of ConfigDomain.split(migrated)) {
      await writeDomainFile(id, fragment, synergyDir)
    }
    const archiveDir = path.join(synergyDir, "archive")
    await fs.mkdir(archiveDir, { recursive: true })
    for (const source of sources) {
      const target = path.join(archiveDir, path.basename(source))
      await fs.rename(source, target).catch((err) => {
        log.warn("failed to archive legacy project config file", {
          source,
          target,
          error: err instanceof Error ? err.message : err,
        })
      })
    }
  }

  async function loadFile(filepath: string, options: { addSchema?: boolean } = {}): Promise<Info> {
    log.info("loading", { path: filepath })
    let text = await Bun.file(filepath)
      .text()
      .catch((err) => {
        if (err.code === "ENOENT") return
        throw new JsonError({ path: filepath }, { cause: err })
      })
    if (!text) return {}
    return load(text, filepath, options)
  }

  async function load(text: string, configFilepath: string, options: { addSchema?: boolean } = {}) {
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
      if (options.addSchema !== false && !parsed.data.$schema) {
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
      if (options.addSchema !== false && !retried.data.$schema) {
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

  export async function current() {
    return state().then((x) => x.config)
  }

  export async function forScope(scope: Scope) {
    return ScopeContext.provide({
      scope,
      fn: current,
    })
  }

  export async function globalResolved() {
    return forScope(Scope.home())
  }

  export const Event = {
    Updated: BusEvent.define(
      "config.updated",
      z.object({
        scope: z.enum(["global", "project"]),
        changedFields: z.string().array(),
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
        for (const model of Object.values(provider?.models ?? {}) as any[]) {
          if (model?.options?.apiKey) model.options.apiKey = REDACTED_SENTINEL
        }
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
        const storedProvider = (stored.provider as Record<string, any>)[key]
        if (provider?.options?.apiKey === REDACTED_SENTINEL) {
          if (storedProvider?.options?.apiKey) provider.options.apiKey = storedProvider.options.apiKey
        }
        for (const [modelKey, model] of Object.entries(provider?.models ?? {}) as [string, any][]) {
          if (model?.options?.apiKey === REDACTED_SENTINEL) {
            const storedModel = storedProvider?.models?.[modelKey]
            if (storedModel?.options?.apiKey) model.options.apiKey = storedModel.options.apiKey
          }
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

  export interface ReloadResult {
    config: Info
    changedFields: string[]
    oldConfig: Info
  }

  export async function reload(scope: "global" | "project" = "global"): Promise<ReloadResult> {
    if (!ScopeContext.tryScope()) {
      if (scope !== "global") {
        throw new Error("Config.reload('project') requires a ScopeContext")
      }
      return ScopeContext.provide<ReloadResult>({
        scope: Scope.home(),
        fn: () => reload(scope),
      })
    }

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

  export async function update(config: Info) {
    const synergyDir = path.join(ScopeContext.current.directory, ".synergy")
    for (const [id, fragment] of ConfigDomain.split(config)) {
      await writeDomainFile(id, fragment, synergyDir)
    }
    await ScopeRuntime.dispose()
  }

  export async function updateGlobal(config: Info) {
    for (const [id, fragment] of ConfigDomain.split(config)) {
      await domainUpdate(id, fragment)
    }
  }

  export async function globalPath() {
    return ConfigDomain.directory()
  }

  export async function globalRaw() {
    await migrateLegacyGlobalConfig()
    return loadDomainDirectory(Global.Path.config)
  }

  export const DomainSummary = z
    .object({
      id: ConfigDomain.Id,
      filename: z.string(),
      label: z.string(),
      path: z.string(),
      ownedKeys: z.array(z.string()),
      mergePolicy: ConfigDomain.MergeMode,
      reloadTargets: z.array(z.string()),
      uiSection: z.string(),
      importable: z.boolean(),
      config: Info.optional(),
    })
    .meta({ ref: "ConfigDomainSummary" })
  export type DomainSummary = z.infer<typeof DomainSummary>

  export async function domainList(): Promise<DomainSummary[]> {
    await migrateLegacyGlobalConfig()
    return Promise.all(
      ConfigDomain.definitions.map(async (domain) => ({
        ...domain,
        path: ConfigDomain.filepath(domain.id),
        ownedKeys: domain.ownedKeys.map(String),
        config: redactForClient(await domainGet(domain.id)),
      })),
    )
  }

  export async function domainGet(id: ConfigDomain.Id, root = Global.Path.config): Promise<Info> {
    const parsed = ConfigDomain.Id.parse(id)
    await migrateLegacyGlobalConfig()
    const filepath = ConfigDomain.filepath(parsed, root)
    const config = await loadFile(filepath, { addSchema: false })
    ConfigDomain.validateKeys(config as Record<string, unknown>, parsed)
    return config
  }

  export async function domainUpdate(
    id: ConfigDomain.Id,
    patch: Partial<Info>,
    options: { mode?: ConfigDomain.MergeMode; root?: string } = {},
  ) {
    const parsed = ConfigDomain.Id.parse(id)
    ConfigDomain.validateKeys(patch as Record<string, unknown>, parsed)
    const stored = await domainGet(parsed, options.root)
    const mergedPatch = mergeRedactedSecrets(patch as Info, stored)
    const next = mergeDomainConfig(stored, mergedPatch, options.mode ?? ConfigDomain.byId.get(parsed)!.mergePolicy)

    const aggregate = mergeConfigConcatArrays(await globalRaw(), next as Info)
    Info.parse(aggregate)
    await writeDomainFile(parsed, next, options.root)
    global.reset()
    await state.resetAll()
    return redactForClient(await domainGet(parsed, options.root))
  }

  export function mergeDomainConfig(current: Info, patch: Info, mode: ConfigDomain.MergeMode): Info {
    if (mode === "replace-domain") return patch
    if (mode === "append") return mergeAppendArrays(current, patch) as Info
    const merged = mergeDeep(current, patch) as Info
    if (current.plugin || patch.plugin) {
      merged.plugin = mergePluginSpecList(current.plugin ?? [], patch.plugin ?? [])
    }
    return merged
  }

  function mergeAppendArrays(current: unknown, patch: unknown): unknown {
    if (Array.isArray(current) && Array.isArray(patch)) return [...current, ...patch]
    if (!isConfigObject(current) || !isConfigObject(patch)) return patch

    const merged: Record<string, unknown> = { ...current }
    for (const [key, value] of Object.entries(patch)) {
      merged[key] = key in current ? mergeAppendArrays(current[key], value) : value
    }
    return merged
  }

  function isConfigObject(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value)
  }

  function mergePluginSpecList(current: string[], patch: string[]): string[] {
    const result: string[] = []
    const indexByKey = new Map<string, number>()

    const push = (spec: string) => {
      const key = pluginSpecMergeKey(spec)
      const index = indexByKey.get(key)
      if (index === undefined) {
        indexByKey.set(key, result.length)
        result.push(spec)
        return
      }
      result[index] = spec
    }

    for (const spec of current) push(spec)
    for (const spec of patch) push(spec)
    return result
  }

  function pluginSpecMergeKey(spec: string): string {
    const trimmed = spec.trim()
    if (trimmed.startsWith("file://")) return `file:${path.resolve(trimmed.slice("file://".length))}`
    const parsed = PluginSpec.parse(trimmed)
    return parsed.nonRegistry ? `source:${parsed.pkg.replace(/#.*$/, "")}` : `npm:${parsed.pkg}`
  }

  async function writeDomainFile(id: ConfigDomain.Id, config: Partial<Info>, root = Global.Path.config) {
    const filepath = ConfigDomain.filepath(id, root)
    await fs.mkdir(path.dirname(filepath), { recursive: true })
    await Bun.write(filepath, serializeConfig(config))
  }

  export function serializeConfig(config: Partial<Info>) {
    return `${JSON.stringify(sortConfigKeys(config), null, 2)}\n`
  }

  function sortConfigKeys(config: Partial<Info>) {
    const result: Record<string, unknown> = {}
    for (const domain of ConfigDomain.definitions) {
      for (const key of domain.ownedKeys) {
        if ((config as Record<string, unknown>)[key] !== undefined) {
          result[String(key)] = (config as Record<string, unknown>)[key]
        }
      }
    }
    return result
  }

  export async function directories() {
    return state().then((x) => x.directories)
  }
}
