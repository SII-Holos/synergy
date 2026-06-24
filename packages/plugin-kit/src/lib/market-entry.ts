import fs from "fs"
import os from "os"
import path from "path"
import { PluginManifest, type PluginManifest as PluginManifestType } from "@ericsanchezok/synergy-plugin"
import { baseCapabilities } from "./capability"
import { computeManifestHash, computePermissionsHash } from "./hash"
import { computeRisk } from "./risk"
import { resolveRuntimeMode } from "./runtime-mode"
import { readSignatureFile } from "./signature"
import { sha256File } from "./crypto"

export interface GithubRegistryEntry {
  schemaVersion: 1
  id: string
  name: string
  description: string
  repo: string
  homepage?: string
  author: { name: string; email?: string; url?: string }
  verified: boolean
  official: boolean
  keywords: string[]
  compatibility: { synergy: string }
  versions: Array<{
    version: string
    downloadUrl: string
    signatureUrl: string
    integrity: string
    manifestHash: string
    permissionsHash: string
    risk: "low" | "medium" | "high"
    runtimeMode: "in-process" | "worker" | "process"
    permissionsSummary: Array<{ key: string; description: string; risk: string }>
    tools: string[]
    uiSurfaces: string[]
    publishedAt: string
    changelog?: string
  }>
  yankedVersions: string[]
}

export function parseAuthor(input?: string): GithubRegistryEntry["author"] {
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
  if (!input) return undefined
  const trimmed = input.trim()
  const gitSsh = trimmed.match(/^git@github\.com:([^/]+\/[^/]+?)(?:\.git)?$/)
  if (gitSsh) return `https://github.com/${gitSsh[1]}`
  if (/^https:\/\/github\.com\/[^/]+\/[^/]+/.test(trimmed)) return trimmed.replace(/\.git$/, "")
  return trimmed
}

export function githubRepoSlug(input?: string): string | undefined {
  const normalized = normalizeRepoUrl(input)
  if (!normalized) return undefined
  const match = normalized.match(/^https:\/\/github\.com\/([^/]+\/[^/]+?)(?:\/.*)?$/)
  if (!match) return undefined
  return match[1].replace(/\.git$/, "")
}

export function releaseAssetUrl(repo: string | undefined, version: string, filename: string): string | undefined {
  const normalized = normalizeRepoUrl(repo)
  if (!normalized || !normalized.startsWith("https://github.com/")) return undefined
  return `${normalized}/releases/download/v${version}/${encodeURIComponent(filename)}`
}

function extractArchive(tarballPath: string): string {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "synergy-plugin-entry-"))
  const result = Bun.spawnSync(["tar", "-xzf", tarballPath, "-C", tmp], { stdout: "pipe", stderr: "pipe" })
  if (result.exitCode !== 0) {
    const stderr = new TextDecoder().decode(result.stderr)
    throw new Error(`Failed to inspect tarball${stderr ? `: ${stderr}` : ""}`)
  }
  return tmp
}

export function readTarballManifest(tarballPath: string): PluginManifestType {
  const extractedDir = extractArchive(tarballPath)
  const manifestPath = path.join(extractedDir, "plugin.json")
  if (!fs.existsSync(manifestPath)) {
    throw new Error("Tarball does not contain plugin.json. Run `synergy-plugin build` and `synergy-plugin pack` first.")
  }
  return PluginManifest.parse(JSON.parse(fs.readFileSync(manifestPath, "utf-8"))) as PluginManifestType
}

export function uiSurfaces(manifest: PluginManifestType): string[] {
  const ui = manifest.contributes?.ui
  if (!ui) return []
  const surfaces: string[] = []
  if (ui.toolRenderers?.length) surfaces.push("toolRenderers")
  if (ui.partRenderers?.length) surfaces.push("partRenderers")
  if (ui.workspacePanels?.length) surfaces.push("workspacePanels")
  if (ui.globalPanels?.length) surfaces.push("globalPanels")
  if (ui.settings?.length) surfaces.push("settings")
  if (ui.chatComponents?.length) surfaces.push("chatComponents")
  if (ui.themes?.length) surfaces.push("themes")
  if (ui.icons?.length) surfaces.push("icons")
  if (ui.routes?.length) surfaces.push("routes")
  if (ui.commands?.length) surfaces.push("commands")
  return surfaces
}

function registryPermissions(capabilities: string[]) {
  return capabilities.map((cap) => ({
    key: cap,
    description: `Requires ${cap}`,
    risk: cap.includes("write") || cap === "shell" || cap === "secrets" ? "high" : "medium",
  }))
}

export function githubEntry(input: {
  tarballPath: string
  repo?: string
  downloadUrl?: string
  signatureUrl?: string
  verified?: boolean
  official?: boolean
  changelog?: string
  publishedAt?: string
}): GithubRegistryEntry {
  const manifest = readTarballManifest(input.tarballPath)
  const repo = normalizeRepoUrl(input.repo ?? manifest.repository ?? manifest.homepage)
  if (!repo) throw new Error("GitHub registry entry requires --repo or manifest.repository")

  const filename = path.basename(input.tarballPath)
  const downloadUrl = input.downloadUrl ?? releaseAssetUrl(repo, manifest.version, filename)
  const signatureUrl = input.signatureUrl ?? (downloadUrl ? `${downloadUrl}.sig` : undefined)
  if (!downloadUrl || !signatureUrl) {
    throw new Error("GitHub registry entry requires --download-url and --signature-url")
  }

  const capabilities = baseCapabilities(manifest)
  const risk = computeRisk(capabilities, manifest)
  const runtimeMode = resolveRuntimeMode({
    source: "local",
    manifestMode: manifest.runtime?.mode,
    userTrusted: true,
    risk,
  })
  const integrity = `sha256-${sha256File(input.tarballPath)}`
  const manifestHash = computeManifestHash(manifest)
  const permissionsHash = computePermissionsHash(manifest, capabilities)
  const signature = readSignatureFile(input.tarballPath)
  if (!signature) throw new Error(`Signature file not found or invalid: ${input.tarballPath}.sig`)
  if (signature.pluginId !== manifest.name) throw new Error("Signature pluginId does not match manifest name")
  if (signature.version !== manifest.version) throw new Error("Signature version does not match manifest version")
  if (signature.payload.tarballHash !== integrity.slice("sha256-".length)) {
    throw new Error("Signature tarball hash does not match artifact integrity")
  }
  if (signature.payload.manifestHash !== manifestHash)
    throw new Error("Signature manifest hash does not match manifest")
  if (signature.payload.permissionsHash !== permissionsHash) {
    throw new Error("Signature permissions hash does not match manifest capabilities")
  }

  return {
    schemaVersion: 1,
    id: manifest.name,
    name: manifest.name,
    description: manifest.description,
    repo,
    ...(manifest.homepage ? { homepage: manifest.homepage } : {}),
    author: parseAuthor(manifest.author),
    verified: Boolean(input.verified),
    official: Boolean(input.official),
    keywords: [...new Set([...(manifest.keywords ?? []), "synergy-plugin"])].sort(),
    compatibility: { synergy: manifest.engines?.synergy ?? manifest.minSynergyVersion ?? ">=1.0.0" },
    versions: [
      {
        version: manifest.version,
        downloadUrl,
        signatureUrl,
        integrity,
        manifestHash,
        permissionsHash,
        risk,
        runtimeMode,
        permissionsSummary: registryPermissions(capabilities),
        tools: (manifest.contributes?.tools ?? []).map((tool) => tool.name),
        uiSurfaces: uiSurfaces(manifest),
        publishedAt: input.publishedAt ?? new Date().toISOString(),
        ...(input.changelog ? { changelog: input.changelog } : {}),
      },
    ],
    yankedVersions: [],
  }
}

export function writeGithubEntry(filepath: string, next: GithubRegistryEntry): GithubRegistryEntry {
  let merged = next
  if (fs.existsSync(filepath)) {
    const existing = JSON.parse(fs.readFileSync(filepath, "utf-8")) as GithubRegistryEntry
    const versions = [
      ...existing.versions.filter((version) => version.version !== next.versions[0]?.version),
      ...next.versions,
    ].sort((a, b) => Date.parse(a.publishedAt) - Date.parse(b.publishedAt))
    merged = { ...existing, ...next, versions, yankedVersions: existing.yankedVersions ?? [] }
  }
  fs.mkdirSync(path.dirname(filepath), { recursive: true })
  fs.writeFileSync(filepath, JSON.stringify(merged, null, 2) + "\n")
  return merged
}
