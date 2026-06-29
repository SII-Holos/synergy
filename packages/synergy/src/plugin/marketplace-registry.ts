import { PluginManifest, type PluginManifest as PluginManifestType } from "@ericsanchezok/synergy-plugin"
import { CAPABILITY_DETAILS, permissionCategoryForKey, pluginInstallRisk } from "@ericsanchezok/synergy-plugin/permissions"
import fs from "fs/promises"
import fsSync from "fs"
import os from "os"
import path from "path"
import z from "zod"
import { Config } from "../config/config"
import { PLUGIN_MARKETPLACE_DEFAULTS, PluginMarketplace as PluginMarketplaceConfig } from "../config/schema"
import { Global } from "../global"
import { sha256File } from "../util/crypto"
import { baseCapabilities } from "./capability"
import { computeManifestHash, computePermissionsHash } from "./consent/approval-store"
import { readSignatureFile, verifySignatureWithPublicKey, type SignatureMetadata } from "./signature"
import { defaultPluginTrustDecision } from "./trust"

export namespace PluginMarketplaceRegistry {
  export const Source = z.enum(["official", "local"])
  export type Source = z.infer<typeof Source>

  export const DEFAULT_REGISTRY_URL: string = PLUGIN_MARKETPLACE_DEFAULTS.registryUrl

  const Risk = z.enum(["low", "medium", "high"])
  const RuntimeMode = z.enum(["in-process", "worker", "process"])
  const Author = z.object({
    name: z.string(),
    email: z.string().optional(),
    url: z.string().optional(),
  })
  const RemotePermission = z.object({
    key: z.string(),
    description: z.string(),
    risk: Risk,
    granted: z.boolean().optional(),
  })
  const RemoteSignature = z.object({
    algorithm: z.literal("ed25519"),
    signer: z.string().regex(/^[a-f0-9]{64}$/i),
  })
  const RemoteIcon = z.discriminatedUnion("type", [
    z.object({ type: z.literal("lucide"), name: z.string().min(1) }),
    z.object({ type: z.literal("registry-svg"), path: z.string().min(1) }),
  ])
  const RemoteVersion = z
    .object({
      version: z.string(),
      downloadUrl: z.string().url(),
      signatureUrl: z.string().url(),
      signature: RemoteSignature,
      integrity: z.string().regex(/^sha256-[a-f0-9]{64}$/),
      manifestHash: z.string(),
      permissionsHash: z.string(),
      risk: Risk,
      runtimeMode: RuntimeMode,
      permissionsSummary: z.array(RemotePermission),
      tools: z.array(z.string()),
      uiSurfaces: z.array(z.string()),
      publishedAt: z.string(),
      changelog: z.string().optional(),
    })
    .strict()
  const RemoteEntry = z
    .object({
      schemaVersion: z.literal(1),
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
      versions: z.array(RemoteVersion),
      yankedVersions: z.array(z.string()).optional().default([]),
    })
    .strict()
  const RemoteSummary = z.object({
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
    latestVersion: z.string(),
    updatedAt: z.string(),
    risk: Risk,
    runtimeMode: RuntimeMode,
    tools: z.array(z.string()),
    uiSurfaces: z.array(z.string()),
  })
  const RemoteRegistry = z.object({
    schemaVersion: z.literal(1),
    updatedAt: z.string(),
    plugins: z.array(RemoteSummary),
  })

  export type RemoteEntry = z.infer<typeof RemoteEntry>
  export type RemoteVersion = z.infer<typeof RemoteVersion>
  export type RemoteSummary = z.infer<typeof RemoteSummary>

  export type NormalizedIcon = { type: "lucide"; name: string } | { type: "image"; url: string; alt?: string }

  export interface NormalizedVersion {
    version: string
    manifestHash: string
    permissionsHash: string
    signature?: { algorithm: "ed25519"; signer: string }
    signatureUrl?: string
    downloadUrl?: string
    integrity: string
    risk: "low" | "medium" | "high"
    runtimeMode?: "in-process" | "worker" | "process"
    permissionsSummary: Array<{ key: string; description: string; risk: "low" | "medium" | "high"; granted?: boolean }>
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
    versions: NormalizedVersion[]
    createdAt: number
    updatedAt: number
    risk: "low" | "medium" | "high"
    trustTier: "declarative" | "trusted-import" | "sandbox"
    runtimeMode: "in-process" | "worker" | "process"
    permissionsSummary: Array<{ key: string; category: string; severity: string; title: string; description: string }>
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
    updatedAt: number
    risk: "low" | "medium" | "high"
    trustTier: "declarative" | "trusted-import" | "sandbox"
    runtimeMode: "in-process" | "worker" | "process"
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
    risk: "low" | "medium" | "high"
    signature: SignatureMetadata
  }

  function cacheRoot() {
    return path.join(Global.Path.cache, "plugin-market")
  }

  function registryCachePath() {
    return path.join(cacheRoot(), "registry.json")
  }

  function entryCachePath(id: string) {
    return path.join(cacheRoot(), "entries", `${id}.json`)
  }

  function artifactDir(id: string, version: string) {
    return path.join(cacheRoot(), "artifacts", id, version)
  }

  function timestamp(input: string | number | undefined): number {
    if (typeof input === "number") return input
    if (!input) return 0
    const value = Date.parse(input)
    return Number.isFinite(value) ? value : 0
  }

  function trustTier(source: Source): "trusted-import" | "sandbox" {
    return defaultPluginTrustDecision({ source }).tier === "trusted-import" ? "trusted-import" : "sandbox"
  }

  function normalizePermissionSummary(items: NormalizedVersion["permissionsSummary"]) {
    return items.map((item) => ({
      key: item.key,
      category: permissionCategoryForKey(item.key),
      severity: item.risk,
      title: CAPABILITY_DETAILS[item.key]?.title ?? item.key,
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

  function normalizeVersion(version: RemoteVersion, source: Source): NormalizedVersion {
    return {
      version: version.version,
      manifestHash: version.manifestHash,
      permissionsHash: version.permissionsHash,
      signature: version.signature,
      signatureUrl: version.signatureUrl,
      downloadUrl: version.downloadUrl,
      integrity: version.integrity,
      risk: version.risk,
      runtimeMode: version.runtimeMode,
      permissionsSummary: version.permissionsSummary,
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
    const versions = entry.versions.map((version) => normalizeVersion(version, source))
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
      versions,
      createdAt: versions.length ? Math.min(...versions.map((version) => version.publishedAt)) : 0,
      updatedAt: latest?.publishedAt ?? 0,
      risk: latest?.risk ?? "low",
      trustTier: trustTier(source),
      runtimeMode: latest?.runtimeMode ?? "process",
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
      updatedAt: timestamp(summary.updatedAt),
      risk: summary.risk,
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
    if (process.env.SYNERGY_TEST_HOME && process.env.SYNERGY_ENABLE_REMOTE_PLUGIN_MARKET !== "1") {
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
    await fs.mkdir(path.dirname(filepath), { recursive: true })
    const tmp = `${filepath}.tmp`
    await Bun.write(tmp, JSON.stringify(value, null, 2))
    await fs.rename(tmp, filepath)
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

  async function remoteRegistry(inputConfig?: Awaited<ReturnType<typeof currentConfig>>) {
    const config = inputConfig ?? (await currentConfig())
    if (!config.enabled) return { schemaVersion: 1 as const, updatedAt: new Date(0).toISOString(), plugins: [] }
    const cachedPath = registryCachePath()
    if (await isFresh(cachedPath, config.cacheTtlMs)) {
      const cached = await readJsonFile(cachedPath, RemoteRegistry)
      if (cached) return cached
    }

    try {
      const registry = await fetchJson(config.registryUrl, RemoteRegistry, config.requestTimeoutMs)
      await writeJsonFile(cachedPath, registry)
      return registry
    } catch (err) {
      if (config.offlineCache) {
        const cached = await readJsonFile(cachedPath, RemoteRegistry)
        if (cached) return cached
      }
      throw err
    }
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
      const cached = await readJsonFile(entryCachePath(id), RemoteEntry)
      return cached ? normalizeEntry(cached, "official", undefined, config.registryUrl) : null
    }

    const cachedPath = entryCachePath(id)
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

  function checkRequiredTarballFiles(tarballPath: string) {
    const result = Bun.spawnSync(["tar", "-tzf", tarballPath], { stdout: "pipe", stderr: "pipe" })
    if (result.exitCode !== 0) {
      const stderr = new TextDecoder().decode(result.stderr)
      throw new Error(`Failed to inspect plugin archive${stderr ? `: ${stderr}` : ""}`)
    }
    const files = new Set(
      new TextDecoder()
        .decode(result.stdout)
        .split("\n")
        .map((line) => line.replace(/^\.\//, "").replace(/\/$/, ""))
        .filter(Boolean),
    )
    for (const required of ["plugin.json", "runtime/index.js", "integrity.json", "permissions.summary.json"]) {
      if (!files.has(required)) throw new Error(`Remote plugin artifact is missing ${required}`)
    }
  }

  async function extractArchive(tarballPath: string) {
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

  async function ensureDownloaded(version: NormalizedVersion, id: string, timeoutMs: number) {
    if (!version.downloadUrl) throw new Error(`Official registry entry ${id}@${version.version} has no downloadUrl`)
    if (!version.signatureUrl) throw new Error(`Official registry entry ${id}@${version.version} has no signatureUrl`)
    const dir = artifactDir(id, version.version)
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
    if (!entry) throw new Error(`Official registry plugin not found: ${id}`)
    if (entry.yankedVersions?.includes(version))
      throw new Error(`Official registry version is yanked: ${id}@${version}`)
    const target = entry.versions.find((candidate) => candidate.version === version)
    if (!target) throw new Error(`Official registry version not found: ${id}@${version}`)

    const { tarballPath, signaturePath } = await ensureDownloaded(target, id, config.artifactDownloadTimeoutMs)
    let extractedDir: string | null = null
    try {
      const tarballHash = assertIntegrity(tarballPath, target.integrity)
      checkRequiredTarballFiles(tarballPath)

      const signature = readSignatureFile(tarballPath)
      if (!signature) throw new Error(`Remote plugin artifact signature is missing or invalid`)
      const trustedSignature = target.signature
      if (!trustedSignature) throw new Error(`Official registry version is missing reviewed signature metadata`)
      if (trustedSignature.algorithm !== signature.algorithm) {
        throw new Error(`Remote plugin artifact signature algorithm mismatch`)
      }
      if (trustedSignature.signer !== signature.signer) {
        throw new Error(`Remote plugin artifact signature signer mismatch`)
      }
      if (signature.pluginId !== id) throw new Error(`Remote plugin artifact signature plugin id mismatch`)
      if (signature.version !== version) throw new Error(`Remote plugin artifact signature version mismatch`)
      if (signature.payload.tarballHash !== tarballHash) {
        throw new Error(`Remote plugin artifact signature tarball hash mismatch`)
      }
      if (signature.payload.manifestHash !== target.manifestHash) {
        throw new Error(`Remote plugin artifact signature manifest hash mismatch`)
      }
      if (signature.payload.permissionsHash !== target.permissionsHash) {
        throw new Error(`Remote plugin artifact signature permissions hash mismatch`)
      }

      extractedDir = await extractArchive(tarballPath)
      const manifestPath = path.join(extractedDir, "plugin.json")
      const manifest = PluginManifest.parse(JSON.parse(await Bun.file(manifestPath).text())) as PluginManifestType
      if (manifest.name !== id) throw new Error(`Remote plugin artifact manifest name mismatch`)
      if (manifest.version !== version) throw new Error(`Remote plugin artifact manifest version mismatch`)

      const capabilities = baseCapabilities(manifest)
      const manifestHash = computeManifestHash(manifest)
      const permissionsHash = computePermissionsHash(manifest, capabilities)
      if (manifestHash !== target.manifestHash) throw new Error(`Remote plugin artifact manifest hash mismatch`)
      if (permissionsHash !== target.permissionsHash)
        throw new Error(`Remote plugin artifact permissions hash mismatch`)

      const signatureValid = await verifySignatureWithPublicKey(tarballPath, signature, trustedSignature.signer)
      if (!signatureValid) throw new Error(`Remote plugin artifact signature verification failed`)

      return {
        entry,
        version: target,
        tarballPath,
        signaturePath,
        cacheKey: `official:${id}@${version}:${tarballHash}`,
        manifest,
        capabilities,
        risk: pluginInstallRisk(manifest),
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
