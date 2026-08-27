import {
  PluginArtifact,
  PluginManifest,
  PluginManifestEnvelope,
  normalizePluginArchiveEntry,
  type PluginManifest as PluginManifestType,
} from "@ericsanchezok/synergy-plugin"
import { computeManifestHash, computePermissionsHash } from "@ericsanchezok/synergy-plugin/integrity"
import { SYNERGY_CAPABILITY_DETAILS, permissionCategoryForKey } from "@ericsanchezok/synergy-util/capability"
import fs from "fs/promises"
import fsSync from "fs"
import os from "os"
import path from "path"
import z from "zod"
import { Config } from "../config/config"
import { PLUGIN_MARKETPLACE_DEFAULTS, PluginMarketplace as PluginMarketplaceConfig } from "../config/schema"
import { Global } from "../global"
import { Storage } from "../storage/storage"
import { sha256Content, sha256File } from "../util/crypto"
import { baseCapabilities } from "./capability"
import { readSignatureFile, verifySignatureWithPublicKey, type SignatureMetadata } from "./signature"
import { defaultPluginTrustDecision } from "./trust"
import { assertPluginCompatibility } from "./spec-resolver"

export namespace PluginMarketplaceRegistry {
  export const Source = z.enum(["official", "local"])
  export type Source = z.infer<typeof Source>

  export const DEFAULT_REGISTRY_URL: string = PLUGIN_MARKETPLACE_DEFAULTS.registryUrl

  export class ArtifactVerificationError extends Error {
    readonly code = "plugin_artifact_verification_failed"
  }

  function verificationError(message: string): ArtifactVerificationError {
    return new ArtifactVerificationError(message)
  }

  const RuntimeMode = z.literal("process")
  const Author = z.object({
    name: z.string(),
    email: z.string().optional(),
    url: z.string().optional(),
  })
  const Compatibility = z
    .object({
      synergy: z.string().min(1),
    })
    .strict()
  const RemotePermissionV1 = z.object({
    key: z.string(),
    description: z.string(),
    risk: z.enum(["low", "medium", "high"]),
    granted: z.boolean().optional(),
  })
  const RemotePermissionV2 = z.object({
    key: z.string(),
    description: z.string(),
    category: z.string().optional(),
    title: z.string().optional(),
    granted: z.boolean().optional(),
  })
  const RemoteFeatureV2 = z
    .object({
      key: z.string(),
      title: z.string(),
      description: z.string(),
    })
    .strict()
  const RemoteSignature = z.object({
    algorithm: z.literal("ed25519"),
    signer: z.string().regex(/^[a-f0-9]{64}$/i),
  })
  const RemoteIcon = z.discriminatedUnion("type", [
    z.object({ type: z.literal("lucide"), name: z.string().min(1) }),
    z.object({ type: z.literal("registry-svg"), path: z.string().min(1) }),
  ])
  const RemoteVersionBase = z.object({
    version: z.string(),
    downloadUrl: z.string().url(),
    signatureUrl: z.string().url(),
    signature: RemoteSignature,
    integrity: z.string().regex(/^sha256-[a-f0-9]{64}$/),
    manifestHash: z.string(),
    permissionsHash: z.string(),
    runtimeMode: RuntimeMode,
    tools: z.array(z.string()),
    uiSurfaces: z.array(z.string()),
    publishedAt: z.string(),
    changelog: z.string().optional(),
  })
  const RemoteVersionV1 = RemoteVersionBase.extend({
    risk: z.enum(["low", "medium", "high"]),
    permissionsSummary: z.array(RemotePermissionV1),
  }).strict()
  const RemoteVersionV2 = RemoteVersionBase.extend({
    apiVersion: z.string().min(1),
    compatibility: Compatibility,
    featuresSummary: z.array(RemoteFeatureV2).optional().default([]),
    permissionsSummary: z.array(RemotePermissionV2),
  }).strict()
  const RemoteEntryBase = z.object({
    id: z.string(),
    name: z.string(),
    description: z.string(),
    repo: z.string().url(),
    homepage: z.string().url().optional(),
    author: Author,
    icon: RemoteIcon.optional(),
    verified: z.boolean(),
    official: z.boolean(),
    keywords: z.array(z.string()),
    compatibility: Compatibility.optional(),
    yankedVersions: z.array(z.string()).optional().default([]),
  })
  const RemoteEntryV1 = RemoteEntryBase.extend({
    schemaVersion: z.literal(1),
    versions: z.array(RemoteVersionV1),
  }).strict()
  const RemoteEntryV2 = RemoteEntryBase.extend({
    schemaVersion: z.literal(2),
    versions: z.array(RemoteVersionV2),
  }).strict()
  const RemoteEntry = z.union([RemoteEntryV1, RemoteEntryV2])
  const RemoteSummaryBase = z.object({
    id: z.string(),
    name: z.string(),
    description: z.string(),
    repo: z.string().url(),
    entry: z.string(),
    author: Author,
    icon: RemoteIcon.optional(),
    verified: z.boolean(),
    official: z.boolean(),
    keywords: z.array(z.string()),
    updatedAt: z.string(),
    runtimeMode: RuntimeMode,
    tools: z.array(z.string()),
    uiSurfaces: z.array(z.string()),
  })
  const RemoteSummaryV1 = RemoteSummaryBase.extend({
    latestVersion: z.string(),
    risk: z.enum(["low", "medium", "high"]),
  })
  const RemoteSummaryV2 = RemoteSummaryBase.extend({
    latestVersion: z.string().optional(),
    apiVersion: z.string().optional(),
    compatibility: Compatibility.optional(),
  })
  const RemoteSummary = z.union([RemoteSummaryV1, RemoteSummaryV2])
  const RemoteRegistry = z.union([
    z.object({
      schemaVersion: z.literal(1),
      updatedAt: z.string(),
      plugins: z.array(RemoteSummaryV1),
    }),
    z.object({ schemaVersion: z.literal(2), updatedAt: z.string(), plugins: z.array(RemoteSummaryV2) }),
  ])

  export type RemoteEntry = z.infer<typeof RemoteEntry>
  export type RemoteVersion = z.infer<typeof RemoteVersionV1> | z.infer<typeof RemoteVersionV2>
  export type RemoteSummary = z.infer<typeof RemoteSummary>

  export type NormalizedIcon = { type: "lucide"; name: string } | { type: "image"; url: string; alt?: string }

  export interface NormalizedVersion {
    version: string
    apiVersion?: string
    compatibility?: { synergy: string }
    manifestHash: string
    permissionsHash: string
    signature?: { algorithm: "ed25519"; signer: string }
    signatureUrl?: string
    downloadUrl?: string
    integrity: string
    runtimeMode?: "process"
    featuresSummary: Array<{ key: string; title: string; description: string }>
    permissionsSummary: Array<{
      key: string
      description: string
      category?: string
      title?: string
      granted?: boolean
    }>
    tools?: string[]
    uiSurfaces?: string[]
    publishedAt: number
    changelog?: string
    source?: Source
  }

  export interface NormalizedEntry {
    id: string
    name: string
    description: string
    repo?: string
    homepage?: string
    author: { name: string; email?: string; url?: string }
    icon?: NormalizedIcon
    verified: boolean
    official: boolean
    keywords: string[]
    compatibility?: { synergy: string }
    versions: NormalizedVersion[]
    createdAt: number
    updatedAt: number
    trustTier: "declarative" | "trusted-import"
    runtimeMode: "process"
    featuresSummary: Array<{ key: string; title: string; description: string }>
    permissionsSummary: Array<{ key: string; category: string; title: string; description: string }>
    uiSurfaces: string[]
    tools: string[]
    downloads: number
    rating?: number
    ratingCount?: number
    changelog?: string
    source: Source
    entryUrl?: string
    yankedVersions?: string[]
  }

  export interface NormalizedSummary {
    id: string
    name: string
    description: string
    repo?: string
    author: { name: string; email?: string; url?: string }
    icon?: NormalizedIcon
    verified: boolean
    official: boolean
    keywords: string[]
    latestVersion?: string
    apiVersion?: string
    compatibility?: { synergy: string }
    updatedAt: number
    trustTier: "declarative" | "trusted-import"
    runtimeMode: "process"
    uiSurfaces: string[]
    tools: string[]
    downloads: number
    rating?: number
    source: Source
  }

  export interface VerifiedArtifact {
    entry: NormalizedEntry
    version: NormalizedVersion
    tarballPath: string
    signaturePath: string
    cacheKey: string
    manifest: PluginManifestType
    capabilities: string[]
    signature: SignatureMetadata
  }

  export interface RegistryCachePaths {
    root: string
    registry: string
    entries: string
    artifacts: string
  }

  export function cacheNamespace(registryUrl: string): string {
    return sha256Content(registryUrl).slice(0, 16)
  }

  export function cachePaths(registryUrl: string): RegistryCachePaths {
    const root = path.join(cacheRoot(), "registries", cacheNamespace(registryUrl))
    return {
      root,
      registry: path.join(root, "registry.json"),
      entries: path.join(root, "entries"),
      artifacts: path.join(root, "artifacts"),
    }
  }

  function cacheRoot() {
    return path.join(Global.Path.cache, "plugin-market")
  }

  function registryCachePath(registryUrl: string) {
    return cachePaths(registryUrl).registry
  }

  function entryCachePath(registryUrl: string, id: string) {
    return path.join(cachePaths(registryUrl).entries, `${id}.json`)
  }

  function artifactDir(registryUrl: string, id: string, version: string, integrity: string) {
    const integrityKey = integrity.replace(/^sha256-/, "").slice(0, 16)
    return path.join(cachePaths(registryUrl).artifacts, id, version, integrityKey)
  }

  function timestamp(input: string | number | undefined): number {
    if (typeof input === "number") return input
    if (!input) return 0
    const value = Date.parse(input)
    return Number.isFinite(value) ? value : 0
  }

  function trustTier(source: Source): NormalizedEntry["trustTier"] {
    return defaultPluginTrustDecision({ source }).tier
  }

  function normalizePermissionSummary(items: NormalizedVersion["permissionsSummary"]) {
    return items.map((item) => ({
      key: item.key,
      category: item.category ?? permissionCategoryForKey(item.key),
      title: item.title ?? SYNERGY_CAPABILITY_DETAILS[item.key]?.title ?? item.key,
      description: item.description,
    }))
  }

  function normalizeIcon(
    icon: z.infer<typeof RemoteIcon> | undefined,
    registryUrl: string,
  ): NormalizedIcon | undefined {
    if (!icon) return undefined
    if (icon.type === "lucide") return { type: "lucide", name: icon.name }
    return { type: "image", url: resolveEntryUrl(registryUrl, icon.path) }
  }

  function normalizeVersion(
    version: RemoteVersion,
    source: Source,
    entryCompatibility?: { synergy: string },
  ): NormalizedVersion {
    const permissionsSummary = version.permissionsSummary.map(({ key, description, granted, ...item }) => {
      const metadata = item as { category?: unknown; title?: unknown }
      return {
        key,
        description,
        ...(typeof metadata.category === "string" ? { category: metadata.category } : {}),
        ...(typeof metadata.title === "string" ? { title: metadata.title } : {}),
        ...(granted === undefined ? {} : { granted }),
      }
    })
    return {
      version: version.version,
      ...("apiVersion" in version ? { apiVersion: version.apiVersion } : {}),
      ...("compatibility" in version
        ? { compatibility: version.compatibility }
        : entryCompatibility
          ? { compatibility: entryCompatibility }
          : {}),
      manifestHash: version.manifestHash,
      permissionsHash: version.permissionsHash,
      signature: version.signature,
      signatureUrl: version.signatureUrl,
      downloadUrl: version.downloadUrl,
      integrity: version.integrity,
      runtimeMode: version.runtimeMode,
      featuresSummary: "featuresSummary" in version ? version.featuresSummary : [],
      permissionsSummary,
      tools: version.tools,
      uiSurfaces: version.uiSurfaces,
      publishedAt: timestamp(version.publishedAt),
      changelog: version.changelog,
      source,
    }
  }

  function normalizeEntry(
    entry: RemoteEntry,
    source: Source,
    entryUrl?: string,
    registryUrl: string = DEFAULT_REGISTRY_URL,
  ): NormalizedEntry {
    const versions = entry.versions.map((version) => normalizeVersion(version, source, entry.compatibility))
    const latest = [...versions].sort((a, b) => b.publishedAt - a.publishedAt)[0]
    return {
      id: entry.id,
      name: entry.name,
      description: entry.description,
      repo: entry.repo,
      homepage: entry.homepage,
      author: entry.author,
      icon: normalizeIcon(entry.icon, registryUrl),
      verified: entry.verified,
      official: entry.official,
      keywords: entry.keywords,
      ...(entry.compatibility ? { compatibility: entry.compatibility } : {}),
      versions,
      createdAt: versions.length ? Math.min(...versions.map((version) => version.publishedAt)) : 0,
      updatedAt: latest?.publishedAt ?? 0,
      trustTier: trustTier(source),
      runtimeMode: latest?.runtimeMode ?? "process",
      featuresSummary: latest?.featuresSummary ?? [],
      permissionsSummary: normalizePermissionSummary(latest?.permissionsSummary ?? []),
      uiSurfaces: latest?.uiSurfaces ?? [],
      tools: latest?.tools ?? [],
      downloads: 0,
      changelog: latest?.changelog,
      source,
      entryUrl,
      yankedVersions: entry.yankedVersions ?? [],
    }
  }

  function normalizeSummary(summary: RemoteSummary, registryUrl: string = DEFAULT_REGISTRY_URL): NormalizedSummary {
    return {
      id: summary.id,
      name: summary.name,
      description: summary.description,
      repo: summary.repo,
      author: summary.author,
      icon: normalizeIcon(summary.icon, registryUrl),
      verified: summary.verified,
      official: summary.official,
      keywords: summary.keywords,
      latestVersion: summary.latestVersion,
      ...("apiVersion" in summary && summary.apiVersion ? { apiVersion: summary.apiVersion } : {}),
      ...("compatibility" in summary && summary.compatibility ? { compatibility: summary.compatibility } : {}),
      updatedAt: timestamp(summary.updatedAt),
      trustTier: trustTier("official"),
      runtimeMode: summary.runtimeMode,
      uiSurfaces: summary.uiSurfaces,
      tools: summary.tools,
      downloads: 0,
      source: "official",
    }
  }

  export async function currentConfig() {
    const current = await Config.current()
    const config = PluginMarketplaceConfig.parse({
      ...PLUGIN_MARKETPLACE_DEFAULTS,
      ...(current.pluginMarketplace ?? {}),
    })
    const hasExplicitEnabled =
      current.pluginMarketplace && Object.prototype.hasOwnProperty.call(current.pluginMarketplace, "enabled")
    if (
      process.env.SYNERGY_TEST_HOME &&
      process.env.SYNERGY_ENABLE_REMOTE_PLUGIN_MARKET !== "1" &&
      !hasExplicitEnabled
    ) {
      return { ...config, enabled: false }
    }
    return config
  }

  async function readJsonFile<T>(filepath: string, schema: z.ZodType<T>): Promise<T | null> {
    try {
      const raw = await Bun.file(filepath).text()
      return schema.parse(JSON.parse(raw))
    } catch {
      return null
    }
  }

  async function writeJsonFile(filepath: string, value: unknown) {
    // Delegate to the shared atomic writer so concurrent writes to the same
    // registry file use unique temp names (pid+time+random) and retry on
    // transient IO, instead of clobbering each other on a fixed `.tmp`.
    await Storage.writeJsonAtomic(filepath, JSON.stringify(value, null, 2))
  }

  async function isFresh(filepath: string, ttlMs: number) {
    try {
      const stat = await fs.stat(filepath)
      return Date.now() - stat.mtimeMs < ttlMs
    } catch {
      return false
    }
  }

  async function fetchJson<T>(url: string, schema: z.ZodType<T>, timeoutMs: number): Promise<T> {
    const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
    if (!response.ok) throw new Error(`Failed to fetch ${url}: HTTP ${response.status}`)
    return schema.parse(await response.json())
  }

  export function resolveEntryUrl(registryUrl: string, entry: string): string {
    return new URL(entry, registryUrl).href
  }

  const pendingRefreshes = new Map<string, Promise<z.infer<typeof RemoteRegistry>>>()
  const pendingForcedRefreshes = new Map<string, Promise<{ refreshedAt: string | null }>>()

  async function backgroundRefreshRegistry(config: Awaited<ReturnType<typeof currentConfig>>) {
    const cachedPath = registryCachePath(config.registryUrl)
    const key = cachedPath
    const existing = pendingRefreshes.get(key)
    if (existing) return existing
    const promise = (async () => {
      try {
        const registry = await fetchJson(config.registryUrl, RemoteRegistry, config.requestTimeoutMs)
        await writeJsonFile(cachedPath, registry)
        return registry
      } catch {
        return null as unknown as z.infer<typeof RemoteRegistry>
      } finally {
        pendingRefreshes.delete(key)
      }
    })()
    pendingRefreshes.set(key, promise)
    return promise
  }

  async function remoteRegistry(inputConfig?: Awaited<ReturnType<typeof currentConfig>>) {
    const config = inputConfig ?? (await currentConfig())
    if (!config.enabled) return { schemaVersion: 1 as const, updatedAt: new Date(0).toISOString(), plugins: [] }
    const cachedPath = registryCachePath(config.registryUrl)
    const cached = await readJsonFile(cachedPath, RemoteRegistry)
    if (cached) {
      if (await isFresh(cachedPath, config.cacheTtlMs)) return cached
      backgroundRefreshRegistry(config)
      return cached
    }

    try {
      const registry = await fetchJson(config.registryUrl, RemoteRegistry, config.requestTimeoutMs)
      await writeJsonFile(cachedPath, registry)
      return registry
    } catch (err) {
      if (config.offlineCache) {
        const stale = await readJsonFile(cachedPath, RemoteRegistry)
        if (stale) return stale
      }
      throw err
    }
  }

  export async function prefetchRegistry() {
    const config = await currentConfig()
    if (!config.enabled) return
    const cachedPath = registryCachePath(config.registryUrl)
    if (await isFresh(cachedPath, config.cacheTtlMs)) return
    await backgroundRefreshRegistry(config)
  }

  /**
   * Force-refresh the remote registry cache immediately, bypassing the TTL.
   * On success the registry.json cache is rewritten and the entry cache is
   * dropped so detail reads re-fetch fresh entries; on failure the old caches
   * are preserved and the error propagates to the caller.
   */
  export async function refreshNow(
    inputConfig?: Awaited<ReturnType<typeof currentConfig>>,
  ): Promise<{ refreshedAt: string | null }> {
    const config = inputConfig ?? (await currentConfig())
    if (!config.enabled) return { refreshedAt: null }
    const cachedPath = registryCachePath(config.registryUrl)
    const key = cachedPath
    const existing = pendingForcedRefreshes.get(key)
    if (existing) return existing
    const promise = (async () => {
      try {
        const registry = await fetchJson(config.registryUrl, RemoteRegistry, config.requestTimeoutMs)
        await writeJsonFile(cachedPath, registry)
        const entriesRoot = cachePaths(config.registryUrl).entries
        await fs.rm(entriesRoot, { recursive: true, force: true })
        await fs.mkdir(entriesRoot, { recursive: true })
        return { refreshedAt: new Date().toISOString() }
      } finally {
        pendingForcedRefreshes.delete(key)
      }
    })()
    pendingForcedRefreshes.set(key, promise)
    return promise
  }

  export async function searchOfficial(input: { q?: string; offset?: number; limit?: number } = {}) {
    const { q = "", offset = 0, limit = 20 } = input
    const config = await currentConfig()
    const registry = await remoteRegistry(config)
    const query = q.toLowerCase().trim()
    let results = registry.plugins
    if (query) {
      results = registry.plugins.filter(
        (plugin) =>
          plugin.name.toLowerCase().includes(query) ||
          plugin.description.toLowerCase().includes(query) ||
          plugin.keywords.some((keyword) => keyword.toLowerCase().includes(query)),
      )
    }
    return {
      plugins: results.slice(offset, offset + limit).map((summary) => normalizeSummary(summary, config.registryUrl)),
      total: results.length,
    }
  }

  export async function getOfficialEntry(id: string): Promise<NormalizedEntry | null> {
    const config = await currentConfig()
    if (!config.enabled) return null
    let entryUrl: string | undefined
    try {
      const registry = await remoteRegistry(config)
      const summary = registry.plugins.find((plugin) => plugin.id === id)
      if (!summary) return null
      entryUrl = resolveEntryUrl(config.registryUrl, summary.entry)
    } catch (err) {
      if (!config.offlineCache) throw err
      const cached = await readJsonFile(entryCachePath(config.registryUrl, id), RemoteEntry)
      return cached ? normalizeEntry(cached, "official", undefined, config.registryUrl) : null
    }

    const cachedPath = entryCachePath(config.registryUrl, id)
    if (await isFresh(cachedPath, config.cacheTtlMs)) {
      const cached = await readJsonFile(cachedPath, RemoteEntry)
      if (cached) return normalizeEntry(cached, "official", entryUrl, config.registryUrl)
    }

    try {
      const entry = await fetchJson(entryUrl, RemoteEntry, config.requestTimeoutMs)
      if (entry.id !== id || entry.name !== id) {
        throw new Error(`Official plugin entry identity mismatch for ${id}`)
      }
      await writeJsonFile(cachedPath, entry)
      return normalizeEntry(entry, "official", entryUrl, config.registryUrl)
    } catch (err) {
      if (config.offlineCache) {
        const cached = await readJsonFile(cachedPath, RemoteEntry)
        if (cached) return normalizeEntry(cached, "official", entryUrl, config.registryUrl)
      }
      throw err
    }
  }

  function inspectTarballEntries(tarballPath: string): Set<string> {
    const result = Bun.spawnSync(["tar", "-tzf", tarballPath], { stdout: "pipe", stderr: "pipe" })
    if (result.exitCode !== 0) {
      const stderr = new TextDecoder().decode(result.stderr)
      throw new Error(`Failed to inspect plugin archive${stderr ? `: ${stderr}` : ""}`)
    }
    const files = new Set<string>()
    for (const line of new TextDecoder().decode(result.stdout).split("\n")) {
      let entry: string | undefined
      try {
        entry = normalizePluginArchiveEntry(line)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        throw new Error(`Remote plugin artifact contains unsafe path: ${message}`)
      }
      if (entry) files.add(entry)
    }
    return files
  }

  function checkRequiredTarballFiles(tarballPath: string) {
    const files = inspectTarballEntries(tarballPath)
    for (const required of PluginArtifact.requiredFiles) {
      if (!files.has(required)) throw new Error(`Remote plugin artifact is missing ${required}`)
    }
  }

  async function extractArchive(tarballPath: string) {
    inspectTarballEntries(tarballPath)
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "synergy-market-plugin-"))
    const result = Bun.spawnSync(["tar", "-xzf", tarballPath, "-C", dir], { stdout: "pipe", stderr: "pipe" })
    if (result.exitCode !== 0) {
      const stderr = new TextDecoder().decode(result.stderr)
      throw new Error(`Failed to extract plugin archive${stderr ? `: ${stderr}` : ""}`)
    }
    return dir
  }

  async function downloadTo(url: string, filepath: string, timeoutMs: number) {
    const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
    if (!response.ok) throw new Error(`Failed to download ${url}: HTTP ${response.status}`)
    await fs.mkdir(path.dirname(filepath), { recursive: true })
    await Bun.write(filepath, new Uint8Array(await response.arrayBuffer()))
  }

  function assertIntegrity(tarballPath: string, integrity: string) {
    const expected = integrity.slice("sha256-".length)
    const actual = sha256File(tarballPath)
    if (actual !== expected) throw new Error(`Remote plugin artifact integrity mismatch`)
    return actual
  }

  async function removeArtifactCache(tarballPath: string) {
    await fs.rm(tarballPath, { force: true }).catch(() => {})
    await fs.rm(`${tarballPath}.sig`, { force: true }).catch(() => {})
  }

  async function ensureDownloaded(version: NormalizedVersion, id: string, registryUrl: string, timeoutMs: number) {
    if (!version.downloadUrl) throw new Error(`Official registry entry ${id}@${version.version} has no downloadUrl`)
    if (!version.signatureUrl) throw new Error(`Official registry entry ${id}@${version.version} has no signatureUrl`)
    const dir = artifactDir(registryUrl, id, version.version, version.integrity)
    const tarballPath = path.join(dir, `${id}-${version.version}.synergy-plugin.tgz`)
    const signaturePath = `${tarballPath}.sig`
    if (fsSync.existsSync(tarballPath) && fsSync.existsSync(signaturePath)) {
      try {
        assertIntegrity(tarballPath, version.integrity)
        return { tarballPath, signaturePath }
      } catch {
        await removeArtifactCache(tarballPath)
      }
    }

    const stagingRoot = path.join(Global.Path.state, "plugin-install", "staging")
    await fs.mkdir(stagingRoot, { recursive: true })
    const stagingDir = await fs.mkdtemp(path.join(stagingRoot, `${id}-${version.version}-`))
    const stagedTarballPath = path.join(stagingDir, path.basename(tarballPath))
    const stagedSignaturePath = `${stagedTarballPath}.sig`
    try {
      await downloadTo(version.downloadUrl, stagedTarballPath, timeoutMs)
      assertIntegrity(stagedTarballPath, version.integrity)
      await downloadTo(version.signatureUrl, stagedSignaturePath, timeoutMs)
      await fs.mkdir(dir, { recursive: true })
      await fs.rename(stagedTarballPath, tarballPath)
      await fs.rename(stagedSignaturePath, signaturePath)
      return { tarballPath, signaturePath }
    } catch (err) {
      await removeArtifactCache(tarballPath)
      throw err
    } finally {
      await fs.rm(stagingDir, { recursive: true, force: true }).catch(() => {})
    }
  }

  export async function verifyOfficialArtifact(id: string, version: string): Promise<VerifiedArtifact> {
    const config = await currentConfig()
    const entry = await getOfficialEntry(id)
    if (!entry) throw verificationError(`Official registry plugin not found: ${id}`)
    if (entry.yankedVersions?.includes(version))
      throw verificationError(`Official registry version is yanked: ${id}@${version}`)
    const target = entry.versions.find((candidate) => candidate.version === version)
    if (!target) throw verificationError(`Official registry version not found: ${id}@${version}`)

    const { tarballPath, signaturePath } = await ensureDownloaded(
      target,
      id,
      config.registryUrl,
      config.artifactDownloadTimeoutMs,
    )
    let extractedDir: string | null = null
    try {
      const tarballHash = assertIntegrity(tarballPath, target.integrity)
      checkRequiredTarballFiles(tarballPath)

      const signature = readSignatureFile(tarballPath)
      if (!signature) throw verificationError(`Remote plugin artifact signature is missing or invalid`)
      const trustedSignature = target.signature
      if (!trustedSignature) throw verificationError(`Official registry version is missing reviewed signature metadata`)
      if (trustedSignature.algorithm !== signature.algorithm) {
        throw verificationError(`Remote plugin artifact signature algorithm mismatch`)
      }
      if (trustedSignature.signer !== signature.signer) {
        throw verificationError(`Remote plugin artifact signature signer mismatch`)
      }
      if (signature.pluginId !== id) throw verificationError(`Remote plugin artifact signature plugin id mismatch`)
      if (signature.version !== version) throw verificationError(`Remote plugin artifact signature version mismatch`)
      if (signature.payload.tarballHash !== tarballHash) {
        throw verificationError(`Remote plugin artifact signature tarball hash mismatch`)
      }
      if (signature.payload.manifestHash !== target.manifestHash) {
        throw verificationError(`Remote plugin artifact signature manifest hash mismatch`)
      }
      if (signature.payload.permissionsHash !== target.permissionsHash) {
        throw verificationError(`Remote plugin artifact signature permissions hash mismatch`)
      }

      extractedDir = await extractArchive(tarballPath)
      const manifestPath = path.join(extractedDir, "plugin.json")
      const rawManifest = JSON.parse(await Bun.file(manifestPath).text())
      const envelope = PluginManifestEnvelope.parse(rawManifest)
      assertPluginCompatibility(envelope)
      const manifest = PluginManifest.parse(rawManifest) as PluginManifestType
      if (manifest.id !== id) throw verificationError(`Remote plugin artifact manifest id mismatch`)
      if (manifest.version !== version) throw verificationError(`Remote plugin artifact manifest version mismatch`)

      const capabilities = baseCapabilities(manifest)
      const manifestHash = computeManifestHash(manifest)
      const permissionsHash = computePermissionsHash(manifest, capabilities)
      if (manifestHash !== target.manifestHash) throw verificationError(`Remote plugin artifact manifest hash mismatch`)
      if (permissionsHash !== target.permissionsHash)
        throw verificationError(`Remote plugin artifact permissions hash mismatch`)

      const signatureValid = await verifySignatureWithPublicKey(tarballPath, signature, trustedSignature.signer)
      if (!signatureValid) throw verificationError(`Remote plugin artifact signature verification failed`)

      return {
        entry,
        version: target,
        tarballPath,
        signaturePath,
        cacheKey: `official:${id}@${version}:${tarballHash}`,
        manifest,
        capabilities,
        signature,
      }
    } catch (err) {
      await removeArtifactCache(tarballPath)
      throw err
    } finally {
      if (extractedDir) await fs.rm(extractedDir, { recursive: true, force: true }).catch(() => {})
    }
  }
}
