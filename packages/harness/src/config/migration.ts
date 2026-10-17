import { ConfigReferenceMigration } from "./reference-migration"
import { ConfigSource } from "./source"
import fs from "fs/promises"
import path from "path"
import { applyEdits, modify, parse as parseJsonc } from "jsonc-parser"
import type { Migration } from "../migration"
import { MigrationRegistry } from "../migration/registry"
import { Filesystem } from "../util/filesystem"
import { Global } from "../global"
import { Flag } from "../flag/flag"
import { Log } from "../util/log"
import { ConfigDomain } from "./domain"
import { Storage } from "../storage/storage"
import { StoragePath } from "../storage/path"
import { Identifier } from "../id/id"
import { Auth } from "../provider/api-key"
import { registerBuiltinProviderProfiles } from "../provider/builtin"
import { ProviderProfile } from "../provider/profile"
import { LegacyExecutionConfig } from "./legacy-execution"

const log = Log.create({ service: "config.migration" })

async function findConfigFiles(): Promise<string[]> {
  const files = new Set<string>()
  const workingDirectory = Flag.SYNERGY_CWD || process.cwd()

  files.add(path.join(Global.Path.config, "synergy.jsonc"))
  files.add(path.join(Global.Path.config, "synergy.json"))

  const configSetsRoot = path.join(Global.Path.config, "config-sets")
  const configSets = await fs.readdir(configSetsRoot, { withFileTypes: true }).catch(() => [])
  for (const entry of configSets) {
    if (!entry.isDirectory()) continue
    files.add(path.join(configSetsRoot, entry.name, "synergy.jsonc"))
    files.add(path.join(configSetsRoot, entry.name, "synergy.json"))
  }

  for (const file of ["synergy.jsonc", "synergy.json"]) {
    const found = await Filesystem.findUp(file, workingDirectory, workingDirectory).catch(() => [])
    for (const resolved of found) {
      files.add(resolved)
    }
  }

  for (const file of ["synergy.jsonc", "synergy.json"]) {
    const found = await Filesystem.findUp(file, Global.Path.home, Global.Path.home).catch(() => [])
    for (const resolved of found) {
      files.add(resolved)
    }
  }

  return [...files]
}

async function migrateSchemaUrl(filepath: string): Promise<boolean> {
  const file = Bun.file(filepath)
  if (!(await file.exists())) return false

  const raw = await file.text()
  if (!raw.trim()) return false

  const parsed = parseJsonc(raw)
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false

  const config = parsed as Record<string, unknown>
  const schema = config.$schema
  if (typeof schema !== "string" || !schema.startsWith("https://")) return false

  const formattingOptions = { tabSize: 2, insertSpaces: true, eol: "\n" } as const
  const text = applyEdits(raw, modify(raw, ["$schema"], Global.Path.configSchemaUrl, { formattingOptions }))

  await Bun.write(filepath, text)
  log.info("migrated $schema from remote URL to local file:// path", {
    path: filepath,
    from: schema,
    to: Global.Path.configSchemaUrl,
  })
  return true
}

export async function removeTopLevelConfigKeys(filepath: string, keys: string[]): Promise<boolean> {
  const file = Bun.file(filepath)
  if (!(await file.exists())) return false

  const raw = await file.text()
  if (!raw.trim()) return false

  const parsed = parseJsonc(raw)
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false

  const config = parsed as Record<string, unknown>
  const present = keys.filter((key) => key in config)
  if (present.length === 0) return false

  let text = raw
  const formattingOptions = { tabSize: 2, insertSpaces: true, eol: "\n" } as const
  for (const key of present) {
    text = applyEdits(text, modify(text, [key], undefined, { formattingOptions }))
  }

  await fs.mkdir(path.dirname(filepath), { recursive: true })
  await Bun.write(filepath, text.endsWith("\n") ? text : text + "\n")
  log.info("removed deprecated top-level config keys", { path: filepath, keys: present })
  return true
}

function addAncestorPermissionDomainFiles(files: Set<string>, start: string) {
  let current = path.resolve(start)
  while (true) {
    files.add(ConfigDomain.filepath("permissions", path.join(current, ".synergy")))
    const parent = path.dirname(current)
    if (parent === current) break
    current = parent
  }
}

async function findSmartAllowConfigFiles(): Promise<string[]> {
  const files = new Set(await findConfigFiles())
  const workingDirectory = Flag.SYNERGY_CWD || process.cwd()

  files.add(ConfigDomain.filepath("permissions", Global.Path.config))
  addAncestorPermissionDomainFiles(files, workingDirectory)

  if (Flag.SYNERGY_CONFIG_DIR) {
    files.add(ConfigDomain.filepath("permissions", Flag.SYNERGY_CONFIG_DIR))
  }

  return [...files]
}

async function migrateAutoClassifierToSmartAllow(filepath: string): Promise<boolean> {
  const file = Bun.file(filepath)
  if (!(await file.exists())) return false

  const raw = await file.text()
  if (!raw.trim()) return false

  const parsed = parseJsonc(raw)
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false

  const config = parsed as Record<string, unknown>
  if (!("auto_classifier" in config)) return false

  let text = raw
  const formattingOptions = { tabSize: 2, insertSpaces: true, eol: "\n" } as const

  if (config.smartAllow === undefined && typeof config.auto_classifier === "boolean") {
    text = applyEdits(text, modify(text, ["smartAllow"], config.auto_classifier, { formattingOptions }))
  }

  text = applyEdits(text, modify(text, ["auto_classifier"], undefined, { formattingOptions }))

  await fs.mkdir(path.dirname(filepath), { recursive: true })
  await Bun.write(filepath, text.endsWith("\n") ? text : text + "\n")
  log.info("migrated auto_classifier config to smartAllow", { path: filepath })
  return true
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value))
}

function mergeMissing(existing: unknown, migrated: unknown): unknown {
  if (!isRecord(existing) || !isRecord(migrated)) return existing ?? migrated

  const result: Record<string, unknown> = { ...existing }
  for (const [key, value] of Object.entries(migrated)) {
    result[key] = key in result ? mergeMissing(result[key], value) : value
  }
  return result
}

async function readConfigObject(
  filepath: string,
): Promise<{ raw: string; config: Record<string, unknown> } | undefined> {
  const file = Bun.file(filepath)
  if (!(await file.exists())) return undefined

  const raw = await file.text()
  if (!raw.trim()) return undefined

  const parsed = parseJsonc(raw)
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined
  return { raw, config: parsed as Record<string, unknown> }
}

async function findConfigDomainDirs(): Promise<string[]> {
  const roots = new Set<string>()
  const workingDirectory = Flag.SYNERGY_CWD || process.cwd()

  roots.add(Global.Path.config)
  roots.add(path.join(workingDirectory, ".synergy"))
  roots.add(path.join(Global.Path.home, ".synergy", "config"))
  if (Flag.SYNERGY_CONFIG_DIR) roots.add(Flag.SYNERGY_CONFIG_DIR)

  const configSetsRoot = path.join(Global.Path.config, "config-sets")
  const configSets = await fs.readdir(configSetsRoot, { withFileTypes: true }).catch(() => [])
  for (const entry of configSets) {
    if (entry.isDirectory()) roots.add(path.join(configSetsRoot, entry.name))
  }

  const dirs = new Set<string>()
  for (const root of roots) {
    const dir = path.join(root, "synergy.d")
    const exists = await fs
      .access(dir)
      .then(() => true)
      .catch(() => false)
    if (exists) dirs.add(dir)
  }
  return [...dirs]
}

async function findRetiredLinkConfigFiles(): Promise<string[]> {
  const files = new Set(await findConfigFiles())
  if (Flag.SYNERGY_CONFIG) files.add(Flag.SYNERGY_CONFIG)
  const domainDirs = new Set(await findConfigDomainDirs())

  for (const rawID of await Storage.scan(StoragePath.scopeRoot())) {
    const scope = await Storage.read<unknown>(StoragePath.scope(Identifier.asScopeID(rawID)))
    if (!isRecord(scope)) continue
    const local = isRecord(scope.local) ? scope.local : undefined
    for (const location of [local?.directory, local?.worktree, scope.directory, scope.worktree]) {
      if (typeof location !== "string" || !path.isAbsolute(location)) continue
      let current = path.resolve(location)
      while (true) {
        const configRoot = path.join(current, ".synergy")
        files.add(path.join(configRoot, "synergy.jsonc"))
        files.add(path.join(configRoot, "synergy.json"))
        domainDirs.add(path.join(configRoot, "synergy.d"))
        const parent = path.dirname(current)
        if (parent === current) break
        current = parent
      }
    }
  }

  for (const dir of domainDirs) {
    for (const entry of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
      if (entry.isFile() && /\.jsonc?$/.test(entry.name)) files.add(path.join(dir, entry.name))
    }
  }
  return [...files]
}

async function migrateRetiredLinkConfigFile(filepath: string): Promise<boolean> {
  const file = Bun.file(filepath)
  if (!(await file.exists())) return false
  const raw = await file.text()
  const config = parseJsonc(raw)
  if (!isRecord(config)) return false

  const paths: string[][] = []
  if (isRecord(config.execution) && isRecord(config.execution.toolExecutorConcurrency)) {
    if (Object.hasOwn(config.execution.toolExecutorConcurrency, "link"))
      paths.push(["execution", "toolExecutorConcurrency", "link"])
  }
  if (isRecord(config.permission) && Object.hasOwn(config.permission, "shell_remote_execute")) {
    paths.push(["permission", "shell_remote_execute"])
  }
  if (isRecord(config.agent)) {
    for (const [name, agent] of Object.entries(config.agent)) {
      if (isRecord(agent) && isRecord(agent.permission) && Object.hasOwn(agent.permission, "shell_remote_execute"))
        paths.push(["agent", name, "permission", "shell_remote_execute"])
    }
  }
  if (paths.length === 0) return false

  const formattingOptions = { tabSize: 2, insertSpaces: true, eol: "\n" } as const
  let text = raw
  for (const key of paths) text = applyEdits(text, modify(text, key, undefined, { formattingOptions }))
  await Bun.write(filepath, text)
  log.info("removed retired Link config", { path: filepath, count: paths.length })
  return true
}

async function removeDeprecatedAutoupdateConfig(): Promise<number> {
  let changed = 0

  for (const filepath of await findConfigFiles()) {
    if (await removeTopLevelConfigKeys(filepath, ["autoupdate"])) changed++
  }

  for (const dir of await findConfigDomainDirs()) {
    const generalFile = path.join(dir, "00-general.jsonc")
    if (await removeTopLevelConfigKeys(generalFile, ["autoupdate"])) changed++
  }

  return changed
}

async function removeDeprecatedProviderCatalogConfig(): Promise<number> {
  let changed = 0

  for (const filepath of await findConfigFiles()) {
    if (await removeTopLevelConfigKeys(filepath, ["providerCatalog"])) changed++
  }

  for (const dir of await findConfigDomainDirs()) {
    const providersFile = path.join(dir, "20-providers.jsonc")
    if (await removeTopLevelConfigKeys(providersFile, ["providerCatalog"])) changed++
  }

  for (const scopeID of await Storage.scan(StoragePath.scopeRoot())) {
    const record = await Storage.read<{ worktree?: string }>(StoragePath.scope(Identifier.asScopeID(scopeID)), {
      silentNotFound: true,
    }).catch(() => undefined)
    const worktree = record?.worktree
    if (!worktree) continue
    const providersFile = path.join(ConfigDomain.directory(path.join(worktree, ".synergy")), "20-providers.jsonc")
    if (await removeTopLevelConfigKeys(providersFile, ["providerCatalog"])) changed++
  }

  return changed
}

function providerAliasMap() {
  registerBuiltinProviderProfiles()
  const aliases = ["copilot", "github-models", "mimo", "xiaomi-mimo"]
  const result = new Map<string, string>()
  for (const alias of aliases) {
    const canonical = ProviderProfile.canonicalID(alias)
    if (canonical !== alias) result.set(alias, canonical)
  }
  return result
}

function normalizeProviderID(providerID: unknown, aliases: Map<string, string>) {
  return typeof providerID === "string" ? (aliases.get(providerID) ?? providerID) : providerID
}

function normalizeProviderMap(input: unknown, aliases: Map<string, string>) {
  if (!isRecord(input)) return input
  const result: Record<string, unknown> = {}
  let changed = false
  for (const [providerID, value] of Object.entries(input)) {
    const canonical = aliases.get(providerID) ?? providerID
    changed ||= canonical !== providerID
    result[canonical] = canonical in result ? mergeMissing(result[canonical], value) : value
  }
  return changed ? result : input
}

function normalizeProviderList(input: unknown, aliases: Map<string, string>) {
  if (!Array.isArray(input)) return input
  let changed = false
  const seen = new Set<string>()
  const result: string[] = []
  for (const item of input) {
    if (typeof item !== "string") {
      result.push(item as string)
      continue
    }
    const canonical = aliases.get(item) ?? item
    changed ||= canonical !== item
    if (seen.has(canonical)) {
      changed = true
      continue
    }
    seen.add(canonical)
    result.push(canonical)
  }
  return changed ? result : input
}

function normalizeModelRef(input: unknown, aliases: Map<string, string>) {
  if (typeof input !== "string") return input
  const [providerID, ...rest] = input.split("/")
  if (!providerID || rest.length === 0) return input
  const canonical = aliases.get(providerID)
  return canonical ? `${canonical}/${rest.join("/")}` : input
}

function normalizeModelRefs(input: unknown, aliases: Map<string, string>): unknown {
  if (Array.isArray(input)) {
    let changed = false
    const result = input.map((item) => {
      const normalized = normalizeModelRefs(item, aliases)
      changed ||= normalized !== item
      return normalized
    })
    return changed ? result : input
  }
  if (!isRecord(input)) return input
  let changed = false
  const result: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(input)) {
    const normalized =
      key === "model" || key.endsWith("_model") ? normalizeModelRef(value, aliases) : normalizeModelRefs(value, aliases)
    changed ||= normalized !== value
    result[key] = normalized
  }
  return changed ? result : input
}

async function normalizeProviderProfileConfig(filepath: string): Promise<boolean> {
  const current = await readConfigObject(filepath)
  if (!current) return false
  const aliases = providerAliasMap()
  if (aliases.size === 0) return false

  const formattingOptions = { tabSize: 2, insertSpaces: true, eol: "\n" } as const
  let text = current.raw
  let changed = false

  const provider = normalizeProviderMap(current.config.provider, aliases)
  if (provider !== current.config.provider) {
    text = applyEdits(text, modify(text, ["provider"], provider, { formattingOptions }))
    changed = true
  }

  for (const key of ["enabled_providers", "disabled_providers"]) {
    const normalized = normalizeProviderList(current.config[key], aliases)
    if (normalized !== current.config[key]) {
      text = applyEdits(text, modify(text, [key], normalized, { formattingOptions }))
      changed = true
    }
  }

  for (const key of [
    "model",
    "nano_model",
    "mini_model",
    "mid_model",
    "thinking_model",
    "long_context_model",
    "creative_model",
    "vision_model",
  ]) {
    const normalized = normalizeModelRef(current.config[key], aliases)
    if (normalized !== current.config[key]) {
      text = applyEdits(text, modify(text, [key], normalized, { formattingOptions }))
      changed = true
    }
  }

  for (const key of ["agent", "subagent"]) {
    const normalized = normalizeModelRefs(current.config[key], aliases)
    if (normalized !== current.config[key]) {
      text = applyEdits(text, modify(text, [key], normalized, { formattingOptions }))
      changed = true
    }
  }

  if (!changed) return false
  await Bun.write(filepath, text.endsWith("\n") ? text : text + "\n")
  log.info("normalized provider profile aliases", { path: filepath })
  return true
}

async function normalizeProviderProfileConfigs(): Promise<number> {
  let changed = 0
  const files = new Set(await findConfigFiles())
  for (const dir of await findConfigDomainDirs()) {
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.match(/\.jsonc?$/)) continue
      files.add(path.join(dir, entry.name))
    }
  }
  for (const filepath of files) {
    if (await normalizeProviderProfileConfig(filepath)) changed++
  }
  return changed
}

export async function migrateExecutionConfigFile(filepath: string): Promise<boolean> {
  return LegacyExecutionConfig.file(filepath)
}

export const migrations: Migration[] = [
  {
    scope: "global",
    execution: "startup",
    id: "20260929-config-retire-synergy-link",
    description: "Remove retired Link concurrency and permission settings",
    async up(progress) {
      const files = await findRetiredLinkConfigFiles()
      for (const [index, filepath] of files.entries()) {
        await migrateRetiredLinkConfigFile(filepath)
        progress(index + 1, files.length)
      }
    },
  },
  {
    scope: "global",
    id: "20260907-config-execution-domains",
    description: "Move legacy experiment toggles to their owning configuration domains",
    async up(progress) {
      const files = new Set(await findConfigFiles())
      if (Flag.SYNERGY_CONFIG) files.add(Flag.SYNERGY_CONFIG)
      for (const dir of await findConfigDomainDirs()) {
        for (const entry of await fs.readdir(dir, { withFileTypes: true }))
          if (entry.isFile() && /\.jsonc?$/.test(entry.name)) files.add(path.join(dir, entry.name))
      }
      let done = 0
      for (const filepath of files) {
        await migrateExecutionConfigFile(filepath)
        progress(++done, Math.max(1, files.size))
      }
    },
  },
  {
    scope: "global",
    id: "20260410-config-holos-top-level",
    description: "Migrate Holos config from channel.holos to top-level holos",
    async up(progress) {
      progress(1, 1)
    },
  },
  {
    scope: "global",
    id: "20260413-config-holos-legacy-cleanup",
    description: "Remove legacy channel.holos config when top-level holos already exists",
    async up(progress) {
      progress(1, 1)
    },
  },
  {
    scope: "global",
    id: "20260414-config-schema-local",
    description: "Migrate $schema from remote URL to local file:// path",
    async up(progress) {
      const files = await findConfigFiles()
      if (files.length === 0) return

      let done = 0
      for (const filepath of files) {
        await migrateSchemaUrl(filepath)
        done++
        progress(done, files.length)
      }
    },
  },
  {
    scope: "global",
    id: "20260422-config-sii-to-plugin",
    description: "Migrate sii config, auth, and cache to inspire plugin",
    async up(progress) {
      progress(1, 1)
    },
  },
  {
    scope: "global",
    id: "20260422-config-inspire-remove-deprecated-keys",
    description: "Remove deprecated defaultSpecId and defaultComputeGroup from pluginConfig.inspire",
    async up(progress) {
      progress(1, 1)
    },
  },

  {
    scope: "global",
    id: "20260617-config-identity-to-library",
    description: "Preserve the historical receipt; Library upgrades its configuration when selected",
    async up(progress) {
      progress(0, 0)
    },
  },

  {
    scope: "global",
    id: "20260618-config-repair-legacy-library-shapes",
    description: "Preserve the historical receipt; Library upgrades its configuration when selected",
    async up(progress) {
      progress(0, 0)
    },
  },

  {
    scope: "global",
    id: "20260619-config-remove-holos-friend-reply-model",
    description: "Remove deprecated Holos friend reply model config",
    async up(progress) {
      progress(1, 1)
    },
  },
  {
    scope: "global",
    id: "20260625-config-smart-allow",
    description: "Migrate auto_classifier config to smartAllow",
    async up(progress) {
      const files = await findSmartAllowConfigFiles()
      if (files.length === 0) return

      let done = 0
      for (const filepath of files) {
        await migrateAutoClassifierToSmartAllow(filepath)
        done++
        progress(done, files.length)
      }
    },
  },
  {
    scope: "global",
    id: "20260625-config-engram-to-library",
    description: "Preserve the historical receipt; Library upgrades its configuration when selected",
    async up(progress) {
      progress(0, 0)
    },
  },

  {
    scope: "global",
    id: "20260628-config-remove-autoupdate",
    description: "Remove deprecated product update config",
    async up(progress) {
      progress(0, 1)
      await removeDeprecatedAutoupdateConfig()
      progress(1, 1)
    },
  },
  {
    scope: "global",
    id: "20260801-config-remove-plugin-approval-policy",
    description: "Remove retired plugin risk approval policy config",
    async up(progress) {
      progress(1, 1)
    },
  },
  {
    scope: "global",
    id: "20260625-provider-auth-v2",
    description: "Migrate provider credentials to the v2 provider auth store",
    async up(progress) {
      progress(0, 1)
      const result = await Auth.migrateLegacy({ backup: true })
      if (result.migrated) log.info("migrated provider credentials to v2 auth store", { count: result.count })
      progress(1, 1)
    },
  },
  {
    scope: "global",
    id: "20260905-config-remove-provider-catalog",
    description: "Remove retired signed provider catalog config",
    async up(progress) {
      progress(0, 1)
      await removeDeprecatedProviderCatalogConfig()
      progress(1, 1)
    },
  },
  {
    scope: "global",
    id: "20260625-provider-profile-normalize",
    description: "Normalize provider profile aliases in config",
    async up(progress) {
      progress(0, 1)
      await normalizeProviderProfileConfigs()
      progress(1, 1)
    },
  },
  {
    id: "20261002-config-primary-agent-identities",
    description: "Upgrade primary agent references in stored configuration and Markdown definitions",
    scope: "global",
    upgradeConfig: ConfigReferenceMigration.upgradeConfig,
    up: ConfigReferenceMigration.up,
  },
]
// An exclusive configuration source replaces files, not provider credentials.
// Retain the credential upgrade under its existing durable domain and ID.
const hostSourceMigrations = migrations.filter((migration) => migration.id === "20260625-provider-auth-v2")

export function registerConfigMigrations() {
  if (ConfigSource.get()) {
    MigrationRegistry.unregister("config")
    MigrationRegistry.register("config", hostSourceMigrations)
  } else MigrationRegistry.register("config", migrations)
}
