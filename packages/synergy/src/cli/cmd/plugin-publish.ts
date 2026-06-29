import { cmd } from "./cmd"
import { UI } from "../ui"
import { PluginManifest, type PluginManifest as PluginManifestType } from "@ericsanchezok/synergy-plugin"
import { permissionItems, registryPermissionSummary } from "@ericsanchezok/synergy-plugin/permissions"
import { Global } from "../../global"
import { baseCapabilities } from "../../plugin/capability"
import { computeRisk } from "../../plugin/consent/risk"
import { computeManifestHash, computePermissionsHash } from "../../plugin/consent/approval-store"
import { resolveRuntimeMode } from "../../plugin-runtime/mode-resolver"
import { readSignatureFile } from "../../plugin/signature"
import { sha256File } from "../../util/crypto"
import path from "path"
import os from "os"
import fs from "fs"
import type { Argv } from "yargs"
import { fetchRegistryApi } from "./plugin-server"

interface RegistryPluginVersion {
  version: string
  manifestHash: string
  permissionsHash: string
  risk: "low" | "medium" | "high"
  permissionsSummary: Array<{ key: string; description: string; risk: string }>
  publishedAt: number
  integrity: string
  downloadUrl?: string
}

interface PublishInput {
  id: string
  name: string
  description: string
  author: { name: string; email?: string; url?: string }
  verified: boolean
  official: boolean
  keywords: string[]
  versions: RegistryPluginVersion[]
  risk: "low" | "medium" | "high"
  trustTier: "declarative" | "trusted-import" | "sandbox"
  runtimeMode: "in-process" | "worker" | "process"
  permissionsSummary: Array<{ key: string; category: string; severity: string; title: string; description: string }>
  uiSurfaces: string[]
  tools: string[]
  downloads: number
}

interface GithubRegistryEntry {
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
    runtimeMode: "in-process" | "worker" | "process"
    permissionsSummary: Array<{ key: string; description: string; risk: string }>
    tools: string[]
    uiSurfaces: string[]
    publishedAt: string
    changelog?: string
  }>
  yankedVersions: string[]
}

function parseAuthor(input?: string): PublishInput["author"] {
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

function extractArchive(tarballPath: string): string {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "synergy-plugin-publish-"))
  const result = Bun.spawnSync(["tar", "-xzf", tarballPath, "-C", tmp], { stdout: "pipe", stderr: "pipe" })
  if (result.exitCode !== 0) {
    const stderr = new TextDecoder().decode(result.stderr)
    throw new Error(`Failed to inspect tarball${stderr ? `: ${stderr}` : ""}`)
  }
  return tmp
}

function readManifest(extractedDir: string): PluginManifestType {
  const manifestPath = path.join(extractedDir, "plugin.json")
  if (!fs.existsSync(manifestPath)) {
    throw new Error("Tarball does not contain plugin.json. Run `synergy plugin build` and `synergy plugin pack` first.")
  }
  return PluginManifest.parse(JSON.parse(fs.readFileSync(manifestPath, "utf-8"))) as PluginManifestType
}

function uiSurfaces(manifest: PluginManifestType): string[] {
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

function copyArtifact(tarballPath: string, id: string, version: string): string {
  const store = path.join(Global.Path.data, "registry", "artifacts", id, version)
  fs.mkdirSync(store, { recursive: true })
  const dest = path.join(store, path.basename(tarballPath))
  fs.copyFileSync(tarballPath, dest)
  return dest
}

function normalizeRepoUrl(input?: string): string | undefined {
  if (!input) return undefined
  const trimmed = input.trim()
  const gitSsh = trimmed.match(/^git@github\.com:([^/]+\/[^/]+?)(?:\.git)?$/)
  if (gitSsh) return `https://github.com/${gitSsh[1]}`
  if (/^https:\/\/github\.com\/[^/]+\/[^/]+/.test(trimmed)) return trimmed.replace(/\.git$/, "")
  return trimmed
}

function releaseAssetUrl(repo: string | undefined, version: string, filename: string): string | undefined {
  const normalized = normalizeRepoUrl(repo)
  if (!normalized || !normalized.startsWith("https://github.com/")) return undefined
  return `${normalized}/releases/download/v${version}/${encodeURIComponent(filename)}`
}

function githubEntry(input: {
  manifest: PluginManifestType
  capabilities: string[]
  risk: "low" | "medium" | "high"
  runtimeMode: "in-process" | "worker" | "process"
  integrity: string
  tarballPath: string
  downloadUrl?: string
  signatureUrl?: string
  repo?: string
  verified: boolean
  official: boolean
  changelog?: string
}): GithubRegistryEntry {
  const repo = normalizeRepoUrl(input.repo ?? input.manifest.repository ?? input.manifest.homepage)
  if (!repo) {
    throw new Error("GitHub registry publishing requires --repo or manifest.repository")
  }
  const filename = path.basename(input.tarballPath)
  const downloadUrl = input.downloadUrl ?? releaseAssetUrl(repo, input.manifest.version, filename)
  const signatureUrl = input.signatureUrl ?? (downloadUrl ? `${downloadUrl}.sig` : undefined)
  if (!downloadUrl || !signatureUrl) {
    throw new Error("GitHub registry publishing requires --download-url and --signature-url")
  }

  const manifestHash = computeManifestHash(input.manifest)
  const permissionsHash = computePermissionsHash(input.manifest, input.capabilities)
  const signature = readSignatureFile(input.tarballPath)
  if (!signature) throw new Error(`Signature file not found or invalid: ${input.tarballPath}.sig`)
  if (signature.pluginId !== input.manifest.name) throw new Error("Signature pluginId does not match manifest name")
  if (signature.version !== input.manifest.version) throw new Error("Signature version does not match manifest version")
  if (signature.payload.tarballHash !== input.integrity.slice("sha256-".length)) {
    throw new Error("Signature tarball hash does not match artifact integrity")
  }
  if (signature.payload.manifestHash !== manifestHash)
    throw new Error("Signature manifest hash does not match manifest")
  if (signature.payload.permissionsHash !== permissionsHash) {
    throw new Error("Signature permissions hash does not match manifest capabilities")
  }

  const permissionsSummary = registryPermissionSummary(input.manifest, input.capabilities)
  return {
    schemaVersion: 1,
    id: input.manifest.name,
    name: input.manifest.name,
    description: input.manifest.description,
    repo,
    ...(input.manifest.homepage ? { homepage: input.manifest.homepage } : {}),
    author: parseAuthor(input.manifest.author),
    verified: input.verified,
    official: input.official,
    keywords: [...new Set([...(input.manifest.keywords ?? []), "synergy-plugin"])].sort(),
    versions: [
      {
        version: input.manifest.version,
        downloadUrl,
        signatureUrl,
        signature: {
          algorithm: "ed25519",
          signer: signature.signer,
        },
        integrity: input.integrity,
        manifestHash,
        permissionsHash,
        risk: input.risk,
        runtimeMode: input.runtimeMode,
        permissionsSummary,
        tools: (input.manifest.contributes?.tools ?? []).map((tool) => tool.name),
        uiSurfaces: uiSurfaces(input.manifest),
        publishedAt: new Date().toISOString(),
        ...(input.changelog ? { changelog: input.changelog } : {}),
      },
    ],
    yankedVersions: [],
  }
}

function writeGithubEntry(filepath: string, next: GithubRegistryEntry) {
  let merged = next
  if (fs.existsSync(filepath)) {
    const existing = JSON.parse(fs.readFileSync(filepath, "utf-8")) as GithubRegistryEntry
    const versions = [
      ...existing.versions.filter((version) => version.version !== next.versions[0]?.version),
      ...next.versions,
    ].sort((a, b) => Date.parse(a.publishedAt) - Date.parse(b.publishedAt))
    merged = {
      ...existing,
      ...next,
      versions,
      yankedVersions: existing.yankedVersions ?? [],
    }
  }
  fs.mkdirSync(path.dirname(filepath), { recursive: true })
  fs.writeFileSync(filepath, JSON.stringify(merged, null, 2) + "\n")
}

export const PluginPublishCommand = cmd({
  command: "publish <tarball>",
  describe: "submit a plugin tarball to the registry",
  builder: (yargs: Argv) =>
    yargs
      .positional("tarball", {
        type: "string",
        describe: "path to the plugin .synergy-plugin.tgz tarball",
        demandOption: true,
      })
      .option("registry", {
        type: "string",
        choices: ["local", "github"] as const,
        default: "local",
        describe: "registry target: local publishes to the running local registry, github prints aggregator JSON",
      })
      .option("write-entry", {
        type: "string",
        describe: "write or update a synergy-plugins plugins/<id>.json entry when --registry github is used",
      })
      .option("download-url", {
        type: "string",
        describe: "release asset URL for the .synergy-plugin.tgz when --registry github is used",
      })
      .option("signature-url", {
        type: "string",
        describe: "release asset URL for the .sig file when --registry github is used",
      })
      .option("repo", {
        type: "string",
        describe: "plugin repository URL for the GitHub aggregator entry",
      })
      .option("verified", {
        type: "boolean",
        default: false,
        describe: "mark the generated GitHub aggregator entry as verified",
      })
      .option("official", {
        type: "boolean",
        default: false,
        describe: "mark the generated GitHub aggregator entry as official",
      })
      .option("changelog", {
        type: "string",
        describe: "version changelog for the generated GitHub aggregator entry",
      }),
  async handler(args) {
    const tarballPath = path.resolve(args.tarball as string)
    const registry = (args.registry as "local" | "github" | undefined) ?? "local"

    if (!fs.existsSync(tarballPath)) {
      UI.error(`Tarball not found: ${tarballPath}`)
      process.exitCode = 1
      return
    }

    if (!/\.synergy-plugin\.tgz$/i.test(tarballPath) && !/\.tgz$/i.test(tarballPath)) {
      UI.error(`Expected a .synergy-plugin.tgz tarball: ${path.basename(tarballPath)}`)
      process.exitCode = 1
      return
    }

    try {
      const extractedDir = extractArchive(tarballPath)
      const manifest = readManifest(extractedDir)
      const capabilities = baseCapabilities(manifest)
      const risk = computeRisk(capabilities, manifest)
      const runtimeMode = resolveRuntimeMode({
        source: "local",
        manifestMode: manifest.runtime?.mode,
        devMode: true,
        userTrusted: true,
        risk,
      })
      const integrity = `sha256-${sha256File(tarballPath)}`
      const detailedPermissions = permissionItems(manifest, capabilities)
      const registryPermissions = registryPermissionSummary(manifest, capabilities)

      if (registry === "github") {
        const entry = githubEntry({
          manifest,
          capabilities,
          risk,
          runtimeMode,
          integrity,
          tarballPath,
          downloadUrl: args.downloadUrl as string | undefined,
          signatureUrl: args.signatureUrl as string | undefined,
          repo: args.repo as string | undefined,
          verified: Boolean(args.verified),
          official: Boolean(args.official),
          changelog: args.changelog as string | undefined,
        })
        const rendered = JSON.stringify(entry, null, 2)
        const writeEntry = args.writeEntry as string | undefined
        if (writeEntry) {
          const outputPath = path.resolve(writeEntry)
          writeGithubEntry(outputPath, entry)
          UI.println(`${UI.Style.TEXT_SUCCESS}✔${UI.Style.TEXT_NORMAL} Wrote GitHub registry entry ${outputPath}`)
          UI.println(
            `  ${UI.Style.TEXT_DIM}Run in synergy-plugins:${UI.Style.TEXT_NORMAL} bun run validate && bun run build-registry`,
          )
        } else {
          UI.println(rendered)
        }
        return
      }

      const artifactPath = copyArtifact(tarballPath, manifest.name, manifest.version)
      const artifactIntegrity = `sha256-${sha256File(artifactPath)}`
      const input: PublishInput = {
        id: manifest.name,
        name: manifest.name,
        description: manifest.description,
        author: parseAuthor(manifest.author),
        verified: false,
        official: false,
        keywords: [...new Set([...(manifest.keywords ?? []), "synergy-plugin"])],
        risk,
        trustTier: manifest.trust?.requestedTier ?? "sandbox",
        runtimeMode,
        permissionsSummary: detailedPermissions,
        uiSurfaces: uiSurfaces(manifest),
        tools: (manifest.contributes?.tools ?? []).map((tool) => tool.name),
        downloads: 0,
        versions: [
          {
            version: manifest.version,
            manifestHash: computeManifestHash(manifest),
            permissionsHash: computePermissionsHash(manifest, capabilities),
            risk,
            permissionsSummary: registryPermissions,
            publishedAt: Date.now(),
            integrity: artifactIntegrity,
            downloadUrl: `file://${artifactPath}`,
          },
        ],
      }

      UI.println(`${UI.Style.TEXT_NORMAL_BOLD}Publishing${UI.Style.TEXT_NORMAL} ${manifest.name} v${manifest.version}`)
      UI.println(`  ${UI.Style.TEXT_DIM}Tarball:${UI.Style.TEXT_NORMAL} ${tarballPath}`)
      UI.println(`  ${UI.Style.TEXT_DIM}Artifact:${UI.Style.TEXT_NORMAL} ${artifactPath}`)

      const result = await fetchRegistryApi<PublishInput>("http://localhost:3000", "/plugins/publish", "POST", input)
      UI.println(
        `${UI.Style.TEXT_SUCCESS}✔${UI.Style.TEXT_NORMAL} Published ${result.name} v${result.versions[result.versions.length - 1]?.version}`,
      )
      UI.println(`  ${UI.Style.TEXT_DIM}ID:${UI.Style.TEXT_NORMAL} ${result.id}`)
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e)
      UI.error(`Publish failed: ${msg}`)
      process.exitCode = 1
    }
  },
})
