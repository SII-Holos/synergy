import fs from "fs/promises"
import path from "path"
import { applyEdits, modify, parse as parseJsonc } from "jsonc-parser"
import type { Migration } from "../migration"
import { MigrationRegistry } from "../migration/registry"
import { Filesystem } from "../util/filesystem"
import { Global } from "../global"
import { Flag } from "../flag/flag"
import { Log } from "../util/log"
import { MEMORY_CATEGORIES } from "./schema"
import { ConfigDomain } from "./domain"
import { Auth } from "../provider/api-key"

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

function normalizeLegacyHolosConfig(input: Record<string, unknown>) {
  const accounts =
    input.accounts && typeof input.accounts === "object" && !Array.isArray(input.accounts)
      ? (input.accounts as Record<string, unknown>)
      : undefined
  const defaultAccount =
    accounts?.default && typeof accounts.default === "object" && !Array.isArray(accounts.default)
      ? (accounts.default as Record<string, unknown>)
      : undefined

  return {
    enabled:
      typeof input.enabled === "boolean"
        ? input.enabled
        : typeof defaultAccount?.enabled === "boolean"
          ? defaultAccount.enabled
          : true,
    apiUrl: typeof input.apiUrl === "string" ? input.apiUrl : "https://api.holosai.io",
    wsUrl: typeof input.wsUrl === "string" ? input.wsUrl : "wss://api.holosai.io",
    portalUrl: typeof input.portalUrl === "string" ? input.portalUrl : "https://www.holosai.io",
  }
}

async function migrateFile(filepath: string): Promise<boolean> {
  const file = Bun.file(filepath)
  if (!(await file.exists())) return false

  const raw = await file.text()
  if (!raw.trim()) return false

  const parsed = parseJsonc(raw)
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false

  const config = parsed as Record<string, unknown>
  const channel =
    config.channel && typeof config.channel === "object" && !Array.isArray(config.channel)
      ? (config.channel as Record<string, unknown>)
      : undefined
  const legacyHolos =
    channel?.holos && typeof channel.holos === "object" && !Array.isArray(channel.holos)
      ? (channel.holos as Record<string, unknown>)
      : undefined

  if (!legacyHolos) return false

  let text = raw
  const hasTopLevelHolos = config.holos !== undefined

  if (!hasTopLevelHolos) {
    text = applyEdits(
      text,
      modify(text, ["holos"], normalizeLegacyHolosConfig(legacyHolos), {
        formattingOptions: { tabSize: 2, insertSpaces: true },
      }),
    )
  }

  text = applyEdits(
    text,
    modify(text, ["channel", "holos"], undefined, { formattingOptions: { tabSize: 2, insertSpaces: true } }),
  )

  const reparsed = parseJsonc(text) as Record<string, unknown>
  const migratedChannel =
    reparsed.channel && typeof reparsed.channel === "object" && !Array.isArray(reparsed.channel)
      ? (reparsed.channel as Record<string, unknown>)
      : undefined
  if (migratedChannel && Object.keys(migratedChannel).length === 0) {
    text = applyEdits(
      text,
      modify(text, ["channel"], undefined, { formattingOptions: { tabSize: 2, insertSpaces: true } }),
    )
  }

  await fs.mkdir(path.dirname(filepath), { recursive: true })
  await Bun.write(filepath, text)
  log.info(hasTopLevelHolos ? "removed legacy channel.holos config" : "migrated legacy channel.holos config", {
    path: filepath,
  })
  return true
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

async function removeTopLevelConfigKeys(filepath: string, keys: string[]): Promise<boolean> {
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

async function migrateSiiAuthToPlugin(): Promise<boolean> {
  const home = process.env.HOME || process.env.USERPROFILE || "~"
  const oldInspirePath = path.join(home, ".synergy", "data", "auth", "inspire.json")
  const oldHarborPath = path.join(home, ".synergy", "data", "auth", "harbor.json")
  const pluginAuthPath = path.join(home, ".synergy", "data", "plugin", "inspire", "auth.json")

  const pluginAuthExists = await Bun.file(pluginAuthPath).exists()
  if (pluginAuthExists) return false

  const inspireExists = await Bun.file(oldInspirePath).exists()
  const harborExists = await Bun.file(oldHarborPath).exists()
  if (!inspireExists && !harborExists) return false

  const auth: Record<string, string> = {}

  if (inspireExists) {
    try {
      const data = JSON.parse(await Bun.file(oldInspirePath).text())
      if (data.username) auth["inspire-username"] = data.username
      if (data.password) auth["inspire-password"] = data.password
    } catch {}
  }

  if (harborExists) {
    try {
      const data = JSON.parse(await Bun.file(oldHarborPath).text())
      if (data.username) auth["harbor-username"] = data.username
      if (data.password) auth["harbor-password"] = data.password
    } catch {}
  }

  if (Object.keys(auth).length === 0) return false

  await fs.mkdir(path.dirname(pluginAuthPath), { recursive: true })
  await Bun.write(pluginAuthPath, JSON.stringify(auth, null, 2))
  log.info("migrated inspire/harbor auth to plugin auth store", { keys: Object.keys(auth) })
  return true
}

async function migrateSiiCacheToPlugin(): Promise<boolean> {
  const home = process.env.HOME || process.env.USERPROFILE || "~"
  const oldTokenPath = path.join(home, ".synergy", "cache", "inspire-token.json")
  const oldResourcesPath = path.join(home, ".synergy", "cache", "inspire-resources.json")
  const pluginCacheDir = path.join(home, ".synergy", "cache", "plugin", "inspire")

  let migrated = false

  for (const [oldPath, key] of [
    [oldTokenPath, "inspire-token"],
    [oldResourcesPath, "resources"],
  ] as const) {
    if (!(await Bun.file(oldPath).exists())) continue
    const targetPath = path.join(pluginCacheDir, `${key}.json`)
    if (await Bun.file(targetPath).exists()) continue
    try {
      const data = JSON.parse(await Bun.file(oldPath).text())
      await fs.mkdir(pluginCacheDir, { recursive: true })
      await Bun.write(targetPath, JSON.stringify({ value: data }))
      migrated = true
    } catch {}
  }

  if (migrated) log.info("migrated inspire cache to plugin cache store")
  return migrated
}

async function migrateSiiToPluginConfig(filepath: string): Promise<boolean> {
  const file = Bun.file(filepath)
  if (!(await file.exists())) return false

  const raw = await file.text()
  if (!raw.trim()) return false

  const parsed = parseJsonc(raw)
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false

  const config = parsed as Record<string, unknown>
  const sii =
    config.sii && typeof config.sii === "object" && !Array.isArray(config.sii)
      ? (config.sii as Record<string, unknown>)
      : undefined

  if (!sii) return false

  const formattingOptions = { tabSize: 2, insertSpaces: true } as const

  const { enable, defaultSpecId, defaultComputeGroup, ...defaults } = sii as Record<string, unknown>
  const hasDefaults = Object.keys(defaults).length > 0

  let text = raw

  if (hasDefaults) {
    const existing =
      config.pluginConfig && typeof config.pluginConfig === "object" && !Array.isArray(config.pluginConfig)
        ? ((config.pluginConfig as Record<string, unknown>).inspire as Record<string, unknown> | undefined)
        : undefined

    if (!existing) {
      text = applyEdits(text, modify(text, ["pluginConfig", "inspire"], defaults, { formattingOptions }))
    }
  }

  text = applyEdits(text, modify(text, ["sii"], undefined, { formattingOptions }))

  await Bun.write(filepath, text)
  log.info("migrated sii config to pluginConfig.inspire", {
    path: filepath,
    movedKeys: Object.keys(defaults),
  })
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

async function writeJsonc(filepath: string, value: Record<string, unknown>) {
  await fs.mkdir(path.dirname(filepath), { recursive: true })
  await Bun.write(filepath, JSON.stringify(value, null, 2) + "\n")
}

async function mergeTopLevelKey(filepath: string, key: string, value: unknown): Promise<boolean> {
  const current = await readConfigObject(filepath)
  if (!current) {
    await writeJsonc(filepath, { [key]: value })
    return true
  }

  const merged = mergeMissing(current.config[key], value)
  if (JSON.stringify(merged) === JSON.stringify(current.config[key])) return false

  const formattingOptions = { tabSize: 2, insertSpaces: true, eol: "\n" } as const
  const text = applyEdits(current.raw, modify(current.raw, [key], merged, { formattingOptions }))
  await Bun.write(filepath, text.endsWith("\n") ? text : text + "\n")
  return true
}

function sanitizeRetrieval(input: Record<string, unknown>): Record<string, unknown> {
  const retrieval: Record<string, unknown> = {}
  if (typeof input.simThreshold === "number") retrieval.simThreshold = input.simThreshold
  if (typeof input.topK === "number") retrieval.topK = input.topK
  if (isRecord(input.categories)) {
    const categories: Record<string, unknown> = {}
    for (const category of MEMORY_CATEGORIES) {
      const value = input.categories[category]
      const sanitized: Record<string, unknown> = {}
      if (isRecord(value)) {
        if (typeof value.simThreshold === "number") sanitized.simThreshold = value.simThreshold
        if (typeof value.topK === "number") sanitized.topK = value.topK
      }
      categories[category] = sanitized
    }
    retrieval.categories = categories
  }
  return retrieval
}

function libraryFromLegacyEvolution(evolution: unknown): Record<string, unknown> {
  if (typeof evolution === "boolean") {
    return {
      memory: { enabled: evolution },
      experience: { encode: evolution, retrieve: evolution },
    }
  }

  if (!isRecord(evolution)) return {}

  const library: Record<string, unknown> = {}
  const memory: Record<string, unknown> = {}
  const experience: Record<string, unknown> = {}

  const active = evolution.active
  if (typeof active === "boolean") {
    memory.enabled = active
  } else if (isRecord(active)) {
    const retrieve = active.retrieve
    if (retrieve === false) {
      memory.enabled = false
    } else if (isRecord(retrieve)) {
      const sanitized = sanitizeRetrieval(retrieve)
      if (Object.keys(sanitized).length > 0) memory.retrieval = sanitized
    }
    if (typeof active.memoryDedupThreshold === "number") {
      memory.dedup = { threshold: active.memoryDedupThreshold }
    }
  }

  const passive = evolution.passive
  if (typeof passive === "boolean") {
    experience.encode = passive
    experience.retrieve = passive
  } else if (isRecord(passive)) {
    if (typeof passive.encode === "boolean") experience.encode = passive.encode
    if (typeof passive.retrieve === "boolean" || isRecord(passive.retrieve)) {
      experience.retrieve = passive.retrieve
    }
    if (isRecord(passive.learning)) experience.learning = passive.learning
  }

  if (Object.keys(memory).length > 0) library.memory = memory
  if (Object.keys(experience).length > 0) library.experience = experience
  return library
}

function libraryFromLegacyConfig(config: Record<string, unknown>): Record<string, unknown> {
  let migrated: Record<string, unknown> = {}

  if (isRecord(config.engram)) {
    migrated = mergeMissing(migrated, config.engram) as Record<string, unknown>
  }

  const directLibrary: Record<string, unknown> = {}
  if (isRecord(config.memory)) directLibrary.memory = config.memory
  if (isRecord(config.experience)) directLibrary.experience = config.experience
  if (typeof config.autonomy === "boolean") directLibrary.autonomy = config.autonomy
  if (Object.keys(directLibrary).length > 0) {
    migrated = mergeMissing(migrated, directLibrary) as Record<string, unknown>
  }

  const identity = isRecord(config.identity) ? config.identity : undefined
  if (identity?.evolution !== undefined) {
    migrated = mergeMissing(migrated, libraryFromLegacyEvolution(identity.evolution)) as Record<string, unknown>
  }
  if (identity?.autonomy !== undefined) {
    migrated = mergeMissing(migrated, { autonomy: identity.autonomy }) as Record<string, unknown>
  }

  return migrated
}

async function migrateInlineLibraryConfig(filepath: string): Promise<boolean> {
  const current = await readConfigObject(filepath)
  if (!current) return false

  const { raw, config } = current
  const identity = isRecord(config.identity) ? config.identity : undefined
  let text = raw
  let changed = false
  const formattingOptions = { tabSize: 2, insertSpaces: true, eol: "\n" } as const

  if (identity) {
    if (isRecord(identity.embedding) && config.embedding === undefined) {
      text = applyEdits(text, modify(text, ["embedding"], identity.embedding, { formattingOptions }))
      changed = true
    }

    if (isRecord(identity.rerank) && config.rerank === undefined) {
      text = applyEdits(text, modify(text, ["rerank"], identity.rerank, { formattingOptions }))
      changed = true
    }
  }

  const migratedLibrary = libraryFromLegacyConfig(config)
  if (Object.keys(migratedLibrary).length > 0) {
    text = applyEdits(
      text,
      modify(text, ["library"], mergeMissing(config.library, migratedLibrary), { formattingOptions }),
    )
    changed = true
  }

  for (const key of ["identity", "engram"]) {
    if (key in config) {
      text = applyEdits(text, modify(text, [key], undefined, { formattingOptions }))
      changed = true
    }
  }

  if (!changed) return false

  await fs.mkdir(path.dirname(filepath), { recursive: true })
  await Bun.write(filepath, text.endsWith("\n") ? text : text + "\n")
  log.info("migrated legacy identity/engram config to library", { path: filepath })
  return true
}

async function migrateIdentityToLibrary(filepath: string): Promise<boolean> {
  const file = Bun.file(filepath)
  if (!(await file.exists())) return false

  const raw = await file.text()
  if (!raw.trim()) return false

  const parsed = parseJsonc(raw)
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false

  const config = parsed as Record<string, unknown>
  const identity = isRecord(config.identity) ? config.identity : undefined

  if (!identity) return false

  let text = raw
  const formattingOptions = { tabSize: 2, insertSpaces: true, eol: "\n" } as const

  if (isRecord(identity.embedding) && config.embedding === undefined) {
    text = applyEdits(text, modify(text, ["embedding"], identity.embedding, { formattingOptions }))
  }

  if (isRecord(identity.rerank) && config.rerank === undefined) {
    text = applyEdits(text, modify(text, ["rerank"], identity.rerank, { formattingOptions }))
  }

  let migratedLibrary: Record<string, unknown> = {}
  if (identity.evolution !== undefined) {
    migratedLibrary = mergeMissing(migratedLibrary, libraryFromLegacyEvolution(identity.evolution)) as Record<
      string,
      unknown
    >
  }

  if (identity.autonomy !== undefined) {
    migratedLibrary = mergeMissing(migratedLibrary, { autonomy: identity.autonomy }) as Record<string, unknown>
  }

  if (Object.keys(migratedLibrary).length > 0) {
    text = applyEdits(
      text,
      modify(text, ["library"], mergeMissing(config.library, migratedLibrary), { formattingOptions }),
    )
  }

  text = applyEdits(text, modify(text, ["identity"], undefined, { formattingOptions }))

  await fs.mkdir(path.dirname(filepath), { recursive: true })
  await Bun.write(filepath, text.endsWith("\n") ? text : text + "\n")
  log.info("migrated identity config to embedding/rerank/library", { path: filepath })
  return true
}

async function repairLibraryLegacyShapes(filepath: string): Promise<boolean> {
  const file = Bun.file(filepath)
  if (!(await file.exists())) return false

  const raw = await file.text()
  if (!raw.trim()) return false

  const parsed = parseJsonc(raw)
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false

  const config = parsed as Record<string, unknown>
  const library = isRecord(config.library) ? config.library : undefined
  const memory = isRecord(library?.memory) ? library.memory : undefined
  const experience = isRecord(library?.experience) ? library.experience : undefined
  if (!memory && !experience) return false

  let text = raw
  let changed = false
  const formattingOptions = { tabSize: 2, insertSpaces: true, eol: "\n" } as const

  if (typeof memory?.retrieval === "boolean") {
    if (memory.retrieval === false && memory.enabled === undefined) {
      text = applyEdits(text, modify(text, ["library", "memory", "enabled"], false, { formattingOptions }))
    }
    text = applyEdits(text, modify(text, ["library", "memory", "retrieval"], undefined, { formattingOptions }))
    changed = true
  }

  const retrieval = isRecord(memory?.retrieval) ? memory.retrieval : undefined
  const categories = isRecord(retrieval?.categories) ? retrieval.categories : undefined
  if (categories) {
    const repairedCategories: Record<string, unknown> = {}
    let needsCategoryRepair = false
    for (const category of MEMORY_CATEGORIES) {
      const value = categories[category]
      if (!isRecord(value)) needsCategoryRepair = true
      const sanitized: Record<string, unknown> = {}
      if (isRecord(value)) {
        if (typeof value.simThreshold === "number") sanitized.simThreshold = value.simThreshold
        if (typeof value.topK === "number") sanitized.topK = value.topK
      }
      repairedCategories[category] = sanitized
    }
    if (needsCategoryRepair) {
      text = applyEdits(
        text,
        modify(text, ["library", "memory", "retrieval", "categories"], repairedCategories, { formattingOptions }),
      )
      changed = true
    }
  }

  if (typeof experience?.learning === "boolean") {
    text = applyEdits(text, modify(text, ["library", "experience", "learning"], undefined, { formattingOptions }))
    changed = true
  }

  if (!changed) return false

  await Bun.write(filepath, text.endsWith("\n") ? text : text + "\n")
  log.info("repaired legacy library config shapes", { path: filepath })
  return true
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

async function migrateLibraryDomainFile(libraryFile: string, generalFile: string): Promise<boolean> {
  const current = await readConfigObject(libraryFile)
  if (!current) return false

  let { raw: text } = current
  const { config } = current
  let changed = false
  const formattingOptions = { tabSize: 2, insertSpaces: true, eol: "\n" } as const

  for (const key of ["embedding", "rerank"]) {
    if (isRecord(config[key])) {
      await mergeTopLevelKey(generalFile, key, config[key])
      text = applyEdits(text, modify(text, [key], undefined, { formattingOptions }))
      changed = true
    }
  }

  const migratedLibrary = libraryFromLegacyConfig(config)
  if (Object.keys(migratedLibrary).length > 0) {
    text = applyEdits(
      text,
      modify(text, ["library"], mergeMissing(config.library, migratedLibrary), { formattingOptions }),
    )
    changed = true
  }

  for (const key of ["identity", "engram", "memory", "experience", "autonomy"]) {
    if (key in config) {
      text = applyEdits(text, modify(text, [key], undefined, { formattingOptions }))
      changed = true
    }
  }

  if (!changed) return false
  await Bun.write(libraryFile, text.endsWith("\n") ? text : text + "\n")
  log.info("migrated library domain config", { path: libraryFile })
  return true
}

async function migrateLegacyLibraryDomainFile(dir: string): Promise<boolean> {
  const oldFile = path.join(dir, "30-engram.jsonc")
  const current = await readConfigObject(oldFile)
  if (!current) return false

  const generalFile = path.join(dir, "00-general.jsonc")
  const libraryFile = path.join(dir, "30-library.jsonc")
  const { config } = current
  let changed = false

  for (const key of ["embedding", "rerank"]) {
    if (isRecord(config[key])) {
      await mergeTopLevelKey(generalFile, key, config[key])
      changed = true
    }
  }

  const migratedLibrary = libraryFromLegacyConfig(config)
  if (Object.keys(migratedLibrary).length > 0) {
    await mergeTopLevelKey(libraryFile, "library", migratedLibrary)
    changed = true
  }

  await fs.rm(oldFile, { force: true })
  log.info("migrated legacy 30-engram.jsonc to library/general domain files", { path: oldFile })
  return changed
}

async function migrateLegacyLibraryConfig(): Promise<number> {
  let changed = 0

  for (const filepath of await findConfigFiles()) {
    if (await migrateInlineLibraryConfig(filepath)) changed++
    if (await repairLibraryLegacyShapes(filepath)) changed++
  }

  for (const dir of await findConfigDomainDirs()) {
    if (await migrateLegacyLibraryDomainFile(dir)) changed++
    const libraryFile = path.join(dir, "30-library.jsonc")
    const generalFile = path.join(dir, "00-general.jsonc")
    if (await migrateLibraryDomainFile(libraryFile, generalFile)) changed++
    if (await repairLibraryLegacyShapes(libraryFile)) changed++
  }

  return changed
}

async function ensureProviderCatalogConfig(): Promise<boolean> {
  const providersFile = ConfigDomain.filepath("providers", Global.Path.config)
  return mergeTopLevelKey(providersFile, "providerCatalog", {
    enabled: true,
    registryUrl: "https://raw.githubusercontent.com/SII-Holos/synergy-provider-registry/main/catalog.v1.json",
    offlineCache: true,
    cacheTtlMs: 3600000,
  })
}

export const migrations: Migration[] = [
  {
    id: "20260410-config-holos-top-level",
    description: "Migrate Holos config from channel.holos to top-level holos",
    async up(progress) {
      const files = await findConfigFiles()
      if (files.length === 0) return

      let done = 0
      for (const filepath of files) {
        await migrateFile(filepath)
        done++
        progress(done, files.length)
      }
    },
  },
  {
    id: "20260413-config-holos-legacy-cleanup",
    description: "Remove legacy channel.holos config when top-level holos already exists",
    async up(progress) {
      const files = await findConfigFiles()
      if (files.length === 0) return

      let done = 0
      for (const filepath of files) {
        await migrateFile(filepath)
        done++
        progress(done, files.length)
      }
    },
  },
  {
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
    id: "20260422-config-sii-to-plugin",
    description: "Migrate sii config, auth, and cache to inspire plugin",
    async up(progress) {
      const files = await findConfigFiles()
      const total = files.length + 2

      let done = 0
      for (const filepath of files) {
        await migrateSiiToPluginConfig(filepath)
        done++
        progress(done, total)
      }

      await migrateSiiAuthToPlugin()
      done++
      progress(done, total)

      await migrateSiiCacheToPlugin()
      done++
      progress(done, total)
    },
  },
  {
    id: "20260422-config-inspire-remove-deprecated-keys",
    description: "Remove deprecated defaultSpecId and defaultComputeGroup from pluginConfig.inspire",
    async up(progress) {
      const files = await findConfigFiles()
      if (files.length === 0) return

      const formattingOptions = { tabSize: 2, insertSpaces: true } as const
      let done = 0
      for (const filepath of files) {
        const file = Bun.file(filepath)
        if (!(await file.exists())) {
          done++
          progress(done, files.length)
          continue
        }

        const raw = await file.text()
        if (!raw.trim()) {
          done++
          progress(done, files.length)
          continue
        }

        const parsed = parseJsonc(raw)
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          done++
          progress(done, files.length)
          continue
        }

        const config = parsed as Record<string, unknown>
        const pluginCfg = config.pluginConfig as Record<string, unknown> | undefined
        const inspire = pluginCfg?.inspire as Record<string, unknown> | undefined
        if (!inspire) {
          done++
          progress(done, files.length)
          continue
        }

        const hasSpecId = "defaultSpecId" in inspire
        const hasComputeGroup = "defaultComputeGroup" in inspire
        if (!hasSpecId && !hasComputeGroup) {
          done++
          progress(done, files.length)
          continue
        }

        let text = raw
        if (hasSpecId) {
          text = applyEdits(
            text,
            modify(text, ["pluginConfig", "inspire", "defaultSpecId"], undefined, { formattingOptions }),
          )
        }
        if (hasComputeGroup) {
          text = applyEdits(
            text,
            modify(text, ["pluginConfig", "inspire", "defaultComputeGroup"], undefined, { formattingOptions }),
          )
        }

        await Bun.write(filepath, text)
        log.info("removed deprecated keys from pluginConfig.inspire", { path: filepath })
        done++
        progress(done, files.length)
      }
    },
  },

  {
    id: "20260617-config-identity-to-library",
    description: "Migrate identity config to embedding/rerank/library fields",
    async up(progress) {
      const files = await findConfigFiles()
      if (files.length === 0) return

      let done = 0
      for (const filepath of files) {
        try {
          await migrateIdentityToLibrary(filepath)
        } catch (err) {
          log.warn("failed to migrate identity config", {
            path: filepath,
            error: err instanceof Error ? err.message : String(err),
          })
        }
        done++
        progress(done, files.length)
      }
    },
  },
  {
    id: "20260618-config-repair-legacy-library-shapes",
    description: "Repair invalid library config shapes from legacy identity migration",
    async up(progress) {
      const files = await findConfigFiles()
      if (files.length === 0) return

      let done = 0
      for (const filepath of files) {
        await repairLibraryLegacyShapes(filepath)
        done++
        progress(done, files.length)
      }
    },
  },
  {
    id: "20260619-config-remove-holos-friend-reply-model",
    description: "Remove deprecated Holos friend reply model config",
    async up(progress) {
      const files = await findConfigFiles()
      if (files.length === 0) return

      let done = 0
      for (const filepath of files) {
        await removeTopLevelConfigKeys(filepath, ["holos_friend_reply_model"])
        done++
        progress(done, files.length)
      }
    },
  },
  {
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
    id: "20260625-config-engram-to-library",
    description: "Migrate legacy engram config domains and keys to library/general",
    async up(progress) {
      progress(0, 1)
      await migrateLegacyLibraryConfig()
      progress(1, 1)
    },
  },
  {
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
    id: "20260625-provider-catalog-config",
    description: "Add signed provider catalog configuration",
    async up(progress) {
      progress(0, 1)
      await ensureProviderCatalogConfig()
      progress(1, 1)
    },
  },
]
MigrationRegistry.register("config", migrations)
