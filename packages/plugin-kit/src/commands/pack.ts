import fs from "fs"
import path from "path"
import type { Argv } from "yargs"
import { PluginArtifact, PluginManifest, type PluginManifestType } from "@ericsanchezok/synergy-plugin"
import { cmd } from "../cmd.js"
import { UI } from "../ui.js"
import { sha256File } from "../lib/crypto.js"

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function safePackageName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_.-]/g, "-")
}

export function readBuiltManifest(pluginDir: string): PluginManifestType {
  const manifestPath = path.join(pluginDir, "dist", PluginArtifact.manifestFile)
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`Built manifest not found at ${manifestPath}. Run "synergy-plugin build" first.`)
  }
  return PluginManifest.parse(JSON.parse(fs.readFileSync(manifestPath, "utf-8")))
}

export function packPluginProject(pluginDir: string): string {
  const distDir = path.join(pluginDir, "dist")
  const manifest = readBuiltManifest(pluginDir)
  for (const required of PluginArtifact.requiredFiles) {
    if (!fs.existsSync(path.join(distDir, required))) {
      throw new Error(`dist/${required} is missing. Run "synergy-plugin build" first.`)
    }
  }
  if (manifest.artifacts.runtime && !fs.existsSync(path.join(distDir, manifest.artifacts.runtime.entry))) {
    throw new Error(`Runtime artifact is missing: ${manifest.artifacts.runtime.entry}`)
  }
  if (manifest.artifacts.ui && !fs.existsSync(path.join(distDir, manifest.artifacts.ui.entry))) {
    throw new Error(`UI artifact is missing: ${manifest.artifacts.ui.entry}`)
  }

  UI.println(`${UI.Style.TEXT_NORMAL_BOLD}Packing${UI.Style.TEXT_NORMAL} ${manifest.id} v${manifest.version}`)
  const archiveName = `${safePackageName(manifest.id)}-${manifest.version}.synergy-plugin.tgz`
  const entries = fs.readdirSync(distDir).sort()
  if (entries.length === 0) throw new Error(`Plugin build output is empty: ${distDir}`)
  const result = Bun.spawnSync(["tar", "-czf", archiveName, "-C", distDir, ...entries], { cwd: pluginDir })
  if (result.exitCode !== 0) {
    throw new Error(`Failed to create plugin archive: ${new TextDecoder().decode(result.stderr)}`)
  }
  const archivePath = path.join(pluginDir, archiveName)
  UI.println(`${UI.Style.TEXT_SUCCESS}Packed${UI.Style.TEXT_NORMAL} ${archiveName}`)
  UI.println(`  ${formatSize(fs.statSync(archivePath).size)} sha256-${sha256File(archivePath)}`)
  return archivePath
}

export const PluginPackCommand = cmd({
  command: "pack [path]",
  describe: "package a built plugin",
  builder: (yargs: Argv) =>
    yargs.positional("path", { type: "string", describe: "plugin directory (defaults to cwd)" }),
  async handler(args) {
    try {
      packPluginProject(path.resolve((args.path as string) ?? process.cwd()))
    } catch (error) {
      UI.error(error instanceof Error ? error.message : String(error))
      process.exitCode = 1
    }
  },
})
