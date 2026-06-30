import { cmd } from "./cmd"
import { UI } from "../ui"
import { PluginManifest, type PluginManifest as PluginManifestType } from "@ericsanchezok/synergy-plugin"
import {
  baseCapabilities,
  permissionItems,
  pluginRisk,
  publicToolNames,
  registryPermissionSummary,
} from "@ericsanchezok/synergy-util/capability"
import { resolvePluginPolicyDecision } from "@ericsanchezok/synergy-util/plugin-policy"
import { computeManifestHash, computePermissionsHash } from "../../plugin/consent/approval-store"
import { sha256File } from "../../util/crypto"
import { localRegistryArtifactDir } from "../../plugin/local-registry-store"
import path from "path"
import os from "os"
import fs from "fs"
import type { Argv } from "yargs"
import { attachOption, ensureServer, fetchRegistryApi } from "./plugin-server"

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
  const store = localRegistryArtifactDir(id, version)
  fs.mkdirSync(store, { recursive: true })
  const dest = path.join(store, path.basename(tarballPath))
  fs.copyFileSync(tarballPath, dest)
  return dest
}

export const PluginPublishCommand = cmd({
  command: "publish <tarball>",
  describe: "publish a plugin tarball to the local development registry",
  builder: (yargs: Argv) =>
    yargs
      .positional("tarball", {
        type: "string",
        describe: "path to the plugin .synergy-plugin.tgz tarball",
        demandOption: true,
      })
      .options(attachOption),
  async handler(args) {
    const tarballPath = path.resolve(args.tarball as string)

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
      const risk = pluginRisk(manifest, { scope: "install" })
      const policy = resolvePluginPolicyDecision({
        manifest,
        source: "local",
        devMode: true,
        userTrusted: true,
        risk,
      })
      const detailedPermissions = permissionItems(manifest, capabilities)
      const registryPermissions = registryPermissionSummary(manifest, capabilities)

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
        trustTier: policy.trust.tier,
        runtimeMode: policy.runtimeMode,
        permissionsSummary: detailedPermissions,
        uiSurfaces: uiSurfaces(manifest),
        tools: publicToolNames(manifest),
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

      const serverUrl = args.attach as string
      if (!(await ensureServer(serverUrl))) {
        process.exitCode = 1
        return
      }
      const result = await fetchRegistryApi<PublishInput>(serverUrl, "/plugins/publish", "POST", input)
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
