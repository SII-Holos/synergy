import fs from "fs"
import os from "os"
import path from "path"
import {
  PluginManifest,
  normalizePluginArchiveEntry,
  type PluginManifest as PluginManifestType,
} from "@ericsanchezok/synergy-plugin"
import {
  githubReleaseTag,
  githubReleaseAssetUrl,
  githubRepoSlug as sharedGithubRepoSlug,
  normalizeGitHubRepoUrl,
} from "@ericsanchezok/synergy-plugin/market"
import { computeManifestHash, computePermissionsHash } from "./hash.js"
import { readSignatureFile } from "./signature.js"
import { sha256File } from "./crypto.js"
import { isManifestIconPath, packageRelativePath, resolveUnder } from "./artifact-assets.js"

export type RegistryIcon = { type: "lucide"; name: string } | { type: "registry-svg"; path: string }
export type MarketplaceReleaseBackend = "github" | "manual"

export interface RegistryEntry {
  schemaVersion: 1
  id: string
  name: string
  description: string
  repo: string
  homepage?: string
  author: { name: string; email?: string; url?: string }
  icon?: RegistryIcon
  verified: boolean
  official: boolean
  keywords: string[]
  compatibility: { synergy: string }
  versions: Array<{
    version: string
    downloadUrl: string
    signatureUrl: string
    signature: {
      algorithm: "ed25519"
      signer: string
    }
    integrity: string
    manifestHash: string
    permissionsHash: string
    risk: "low" | "medium" | "high"
    runtimeMode: "process"
    permissionsSummary: Array<{ key: string; description: string; risk: string }>
    tools: string[]
    uiSurfaces: string[]
    publishedAt: string
    changelog?: string
  }>
  yankedVersions: string[]
}

export function parseAuthor(input?: string): RegistryEntry["author"] {
  if (!input) return { name: "unknown" }
  const email = input.match(/<([^>]+)>/)?.[1]
  const url = input.match(/\(([^)]+)\)/)?.[1]
  const name =
    input
      .replace(/<[^>]+>/g, "")
      .replace(/\([^)]+\)/g, "")
      .trim() || input
  return { name, ...(email ? { email } : {}), ...(url ? { url } : {}) }
}

export function normalizeRepoUrl(input?: string): string | undefined {
  return normalizeGitHubRepoUrl(input) ?? input?.trim()
}

export function githubRepoSlug(input?: string): string | undefined {
  return sharedGithubRepoSlug(input)
}

export function renderReleaseUrlTemplate(input: {
  template: string
  repo: string
  version: string
  tag?: string
  filename: string
}): string {
  const tag = input.tag ?? githubReleaseTag(input.version)
  return input.template
    .replaceAll("{repo}", input.repo.replace(/\/+$/, ""))
    .replaceAll("{version}", input.version)
    .replaceAll("{tag}", tag)
    .replaceAll("{filename}", encodeURIComponent(input.filename))
}

export function resolveReleaseAssetUrls(input: {
  backend?: MarketplaceReleaseBackend
  repo: string
  version: string
  filename: string
  downloadUrl?: string
  signatureUrl?: string
  releaseUrlTemplate?: string
  releaseTagTemplate?: string
}): { downloadUrl: string; signatureUrl: string } {
  const backend = input.backend ?? "github"
  const tag = githubReleaseTag(input.version, input.releaseTagTemplate)
  const downloadUrl =
    input.downloadUrl ??
    (input.releaseUrlTemplate
      ? renderReleaseUrlTemplate({
          template: input.releaseUrlTemplate,
          repo: input.repo,
          version: input.version,
          tag,
          filename: input.filename,
        })
      : backend === "github"
        ? githubReleaseAssetUrl({
            repo: input.repo,
            version: input.version,
            filename: input.filename,
            tagTemplate: input.releaseTagTemplate,
          })
        : undefined)
  const signatureUrl = input.signatureUrl ?? (downloadUrl ? `${downloadUrl}.sig` : undefined)
  if (!downloadUrl || !signatureUrl) {
    throw new Error(
      "Marketplace entry requires release asset URLs. Use GitHub backend, --release-url-template, or explicit --download-url and --signature-url.",
    )
  }
  return { downloadUrl, signatureUrl }
}

function extractArchive(tarballPath: string): string {
  validateArchiveEntries(tarballPath)
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "synergy-plugin-entry-"))
  const result = Bun.spawnSync(["tar", "-xzf", tarballPath, "-C", tmp], { stdout: "pipe", stderr: "pipe" })
  if (result.exitCode !== 0) {
    const stderr = new TextDecoder().decode(result.stderr)
    throw new Error(`Failed to inspect tarball${stderr ? `: ${stderr}` : ""}`)
  }
  return tmp
}

function validateArchiveEntries(tarballPath: string) {
  const result = Bun.spawnSync(["tar", "-tzf", tarballPath], { stdout: "pipe", stderr: "pipe" })
  if (result.exitCode !== 0) {
    const stderr = new TextDecoder().decode(result.stderr)
    throw new Error(`Failed to inspect tarball${stderr ? `: ${stderr}` : ""}`)
  }
  for (const line of new TextDecoder().decode(result.stdout).split("\n")) {
    try {
      normalizePluginArchiveEntry(line)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      throw new Error(`Plugin tarball contains unsafe path: ${message}`)
    }
  }
}

export function readTarballManifest(tarballPath: string): PluginManifestType {
  const extractedDir = extractArchive(tarballPath)
  const manifestPath = path.join(extractedDir, "plugin.json")
  if (!fs.existsSync(manifestPath)) {
    throw new Error("Tarball does not contain plugin.json. Run `synergy-plugin build` and `synergy-plugin pack` first.")
  }
  return PluginManifest.parse(JSON.parse(fs.readFileSync(manifestPath, "utf-8"))) as PluginManifestType
}

function registryIconPath(pluginId: string): string {
  return `icons/${pluginId}.svg`
}

function iconForManifest(manifest: PluginManifestType, extractedDir: string): RegistryIcon | undefined {
  if (!manifest.icon) return undefined
  if (!isManifestIconPath(manifest.icon)) return { type: "lucide", name: manifest.icon }

  const packagedPath = packageRelativePath(manifest.icon)
  const iconPath = resolveUnder(extractedDir, packagedPath)
  if (!fs.existsSync(iconPath)) throw new Error(`Marketplace icon not found in tarball: ${manifest.icon}`)
  const stat = fs.statSync(iconPath)
  if (!stat.isFile()) throw new Error(`Marketplace icon must be a file: ${manifest.icon}`)
  return { type: "registry-svg", path: registryIconPath(manifest.id) }
}

function compatibilityForManifest(manifest: PluginManifestType): RegistryEntry["compatibility"] {
  return { synergy: `plugin-api:${manifest.apiVersion}` }
}

export function uiSurfaces(manifest: PluginManifestType): string[] {
  return [...new Set(manifest.contributions.filter((item) => item.kind.startsWith("ui.")).map((item) => item.kind))]
}

export function registryEntry(input: {
  tarballPath: string
  repo?: string
  downloadUrl?: string
  signatureUrl?: string
  releaseBackend?: MarketplaceReleaseBackend
  releaseUrlTemplate?: string
  releaseTagTemplate?: string
  changelog?: string
  publishedAt?: string
}): RegistryEntry {
  const extractedDir = extractArchive(input.tarballPath)
  const manifestPath = path.join(extractedDir, "plugin.json")
  if (!fs.existsSync(manifestPath)) {
    throw new Error("Tarball does not contain plugin.json. Run `synergy-plugin build` and `synergy-plugin pack` first.")
  }
  const manifest = PluginManifest.parse(JSON.parse(fs.readFileSync(manifestPath, "utf-8"))) as PluginManifestType
  const repo = normalizeRepoUrl(input.repo ?? manifest.repository ?? manifest.homepage)
  if (!repo) throw new Error("Marketplace registry entry requires --repo or manifest.repository")

  const filename = path.basename(input.tarballPath)
  const { downloadUrl, signatureUrl } = resolveReleaseAssetUrls({
    backend: input.releaseBackend,
    repo,
    version: manifest.version,
    filename,
    downloadUrl: input.downloadUrl,
    signatureUrl: input.signatureUrl,
    releaseUrlTemplate: input.releaseUrlTemplate,
    releaseTagTemplate: input.releaseTagTemplate,
  })

  const capabilities = manifest.capabilities.map((item) => item.id)
  const tools = manifest.contributions.filter((item) => item.kind === "tool").map((item) => item.id)
  const risk = capabilities.some((item) => item === "workspace.write" || item === "secrets" || item === "task.run")
    ? ("high" as const)
    : capabilities.length
      ? ("medium" as const)
      : ("low" as const)
  const integrity = `sha256-${sha256File(input.tarballPath)}`
  const manifestHash = computeManifestHash(manifest)
  const permissionsHash = computePermissionsHash(manifest, capabilities)
  const signature = readSignatureFile(input.tarballPath)
  if (!signature) throw new Error(`Signature file not found or invalid: ${input.tarballPath}.sig`)
  if (signature.pluginId !== manifest.id) throw new Error("Signature pluginId does not match manifest id")
  if (signature.version !== manifest.version) throw new Error("Signature version does not match manifest version")
  if (signature.payload.tarballHash !== integrity.slice("sha256-".length)) {
    throw new Error("Signature tarball hash does not match artifact integrity")
  }
  if (signature.payload.manifestHash !== manifestHash)
    throw new Error("Signature manifest hash does not match manifest")
  if (signature.payload.permissionsHash !== permissionsHash) {
    throw new Error("Signature permissions hash does not match manifest capabilities")
  }
  const icon = iconForManifest(manifest, extractedDir)

  return {
    schemaVersion: 1,
    id: manifest.id,
    name: manifest.name,
    description: manifest.description,
    repo,
    ...(manifest.homepage ? { homepage: manifest.homepage } : {}),
    author: parseAuthor(manifest.author),
    ...(icon ? { icon } : {}),
    verified: false,
    official: false,
    keywords: [...new Set([...(manifest.keywords ?? []), "synergy-plugin"])].sort(),
    compatibility: compatibilityForManifest(manifest),
    versions: [
      {
        version: manifest.version,
        downloadUrl,
        signatureUrl,
        signature: {
          algorithm: "ed25519",
          signer: signature.signer,
        },
        integrity,
        manifestHash,
        permissionsHash,
        risk,
        runtimeMode: "process",
        permissionsSummary: capabilities.map((key) => ({ key, description: `Synergy host capability ${key}`, risk })),
        tools,
        uiSurfaces: uiSurfaces(manifest),
        publishedAt: input.publishedAt ?? new Date().toISOString(),
        ...(input.changelog ? { changelog: input.changelog } : {}),
      },
    ],
    yankedVersions: [],
  }
}

function registryRootForEntryPath(entryPath: string): string {
  const dir = path.dirname(entryPath)
  return path.basename(dir) === "plugins" ? path.dirname(dir) : dir
}

export function copyRegistryEntryIcon(input: {
  tarballPath: string
  entryPath: string
  entry: RegistryEntry
}): string | undefined {
  if (input.entry.icon?.type !== "registry-svg") return undefined
  const manifest = readTarballManifest(input.tarballPath)
  if (!isManifestIconPath(manifest.icon)) throw new Error(`Marketplace icon path is not a local SVG: ${manifest.icon}`)

  const extractedDir = extractArchive(input.tarballPath)
  const source = resolveUnder(extractedDir, packageRelativePath(manifest.icon))
  if (!fs.existsSync(source)) throw new Error(`Marketplace icon not found in tarball: ${manifest.icon}`)

  const registryRoot = registryRootForEntryPath(input.entryPath)
  const destination = resolveUnder(registryRoot, input.entry.icon.path)
  fs.mkdirSync(path.dirname(destination), { recursive: true })
  fs.copyFileSync(source, destination)
  return destination
}

export function writeRegistryEntry(filepath: string, next: RegistryEntry): RegistryEntry {
  let merged = next
  if (fs.existsSync(filepath)) {
    const existing = JSON.parse(fs.readFileSync(filepath, "utf-8")) as RegistryEntry
    const versions = [
      ...existing.versions.filter((version) => version.version !== next.versions[0]?.version),
      ...next.versions,
    ].sort((a, b) => Date.parse(a.publishedAt) - Date.parse(b.publishedAt))
    merged = {
      ...existing,
      ...next,
      verified: existing.verified ?? next.verified,
      official: existing.official ?? next.official,
      versions,
      yankedVersions: existing.yankedVersions ?? [],
    }
  }
  fs.mkdirSync(path.dirname(filepath), { recursive: true })
  fs.writeFileSync(filepath, JSON.stringify(merged, null, 2) + "\n")
  return merged
}
