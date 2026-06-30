import path from "path"
import fs from "fs"
import type { Argv } from "yargs"
import {
  PluginArtifact,
  PluginManifest,
  type PluginManifest as PluginManifestType,
} from "@ericsanchezok/synergy-plugin"
import { cmd } from "../cmd"
import { UI } from "../ui"
import { sha256File } from "../lib/crypto"
import { missingPackagedAssets } from "../lib/artifact-assets"

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function safePackageName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_.-]/g, "-")
}

export function readSourceManifest(pluginDir: string): PluginManifestType {
  const manifestPath = path.join(pluginDir, "plugin.json")
  const raw = JSON.parse(fs.readFileSync(manifestPath, "utf-8"))
  return PluginManifest.parse(raw) as PluginManifestType
}

export function packPluginProject(pluginDir: string): string {
  const manifestPath = path.join(pluginDir, "plugin.json")
  if (!fs.existsSync(manifestPath)) throw new Error(`No plugin.json found at ${manifestPath}`)

  const manifest = readSourceManifest(pluginDir)
  UI.println(`${UI.Style.TEXT_NORMAL_BOLD}Packing${UI.Style.TEXT_NORMAL} ${manifest.name} v${manifest.version}`)

  const distDir = path.join(pluginDir, "dist")
  if (!fs.existsSync(distDir))
    throw new Error(`dist/ directory not found at ${distDir}. Run "synergy-plugin build" first.`)
  if (!fs.existsSync(path.join(distDir, PluginArtifact.manifestFile))) {
    throw new Error(`dist/${PluginArtifact.manifestFile} not found at ${distDir}. Run "synergy-plugin build" first.`)
  }
  for (const required of PluginArtifact.requiredFiles.filter((file) => file !== PluginArtifact.manifestFile)) {
    if (!fs.existsSync(path.join(distDir, required))) {
      throw new Error(`dist/${required} not found at ${distDir}. Run "synergy-plugin build" first.`)
    }
  }

  const distManifest = PluginManifest.parse(
    JSON.parse(fs.readFileSync(path.join(distDir, PluginArtifact.manifestFile), "utf-8")),
  ) as PluginManifestType
  const missing = missingPackagedAssets(distDir, distManifest)
  if (missing.length > 0) {
    const details = missing.map((asset) => `  - ${asset.label}: ${asset.packageRelative}`).join("\n")
    throw new Error(`dist/ is missing manifest-declared plugin assets:\n${details}`)
  }

  const tgzName = `${safePackageName(manifest.name)}-${manifest.version}.synergy-plugin.tgz`
  const result = Bun.spawnSync(["tar", "-czf", tgzName, "-C", distDir, "."], { cwd: pluginDir })
  if (result.exitCode !== 0) {
    const stderr = new TextDecoder().decode(result.stderr)
    throw new Error(`Failed to create tarball${stderr ? `: ${stderr}` : ""}`)
  }

  const tgzPath = path.join(pluginDir, tgzName)
  const st = fs.statSync(tgzPath)
  const integrity = sha256File(tgzPath)
  UI.println(
    `${UI.Style.TEXT_SUCCESS}✔${UI.Style.TEXT_NORMAL} Packed: ${UI.Style.TEXT_HIGHLIGHT}${tgzName}${UI.Style.TEXT_NORMAL}`,
  )
  UI.println(`  ${UI.Style.TEXT_DIM}Size:${UI.Style.TEXT_NORMAL} ${formatSize(st.size)}`)
  UI.println(`  ${UI.Style.TEXT_DIM}Integrity:${UI.Style.TEXT_NORMAL} sha256-${integrity}`)
  return tgzPath
}

export const PluginPackCommand = cmd({
  command: "pack [path]",
  describe: "package a built plugin into a .synergy-plugin.tgz",
  builder: (yargs: Argv) =>
    yargs.positional("path", {
      type: "string",
      describe: "path to plugin directory (defaults to cwd)",
    }),
  async handler(args) {
    try {
      packPluginProject(path.resolve((args.path as string) ?? process.cwd()))
    } catch (error) {
      UI.error(error instanceof Error ? error.message : String(error))
      process.exitCode = 1
    }
  },
})
