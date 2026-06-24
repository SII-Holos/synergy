import path from "path"
import fs from "fs"
import { EOL } from "os"
import type { Argv } from "yargs"
import { PluginManifest, type PluginManifest as PluginManifestType } from "@ericsanchezok/synergy-plugin"
import { cmd } from "../cmd"
import { UI } from "../ui"
import { sha256File, sha256JSON } from "../lib/crypto"

function ensureDir(dirPath: string) {
  fs.mkdirSync(dirPath, { recursive: true })
}

function copyDir(src: string, dest: string) {
  ensureDir(dest)
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name)
    const destPath = path.join(dest, entry.name)
    if (entry.isDirectory()) copyDir(srcPath, destPath)
    else fs.copyFileSync(srcPath, destPath)
  }
}

function copyFilePreserve(pluginDir: string, distDir: string, relativePath: string) {
  const normalized = relativePath.replace(/^\.\//, "")
  const src = path.resolve(pluginDir, normalized)
  if (!fs.existsSync(src) || !fs.statSync(src).isFile()) return
  const dest = path.join(distDir, normalized)
  ensureDir(path.dirname(dest))
  fs.copyFileSync(src, dest)
}

function findUiSource(pluginDir: string): string | undefined {
  const candidates = ["src/ui.tsx", "src/ui/index.tsx", "src/ui.ts", "src/ui/index.ts"]
  return candidates.map((candidate) => path.join(pluginDir, candidate)).find((candidate) => fs.existsSync(candidate))
}

function packagedManifest(manifest: PluginManifestType): PluginManifestType {
  const next = structuredClone(manifest) as PluginManifestType
  next.main = "./runtime/index.js"
  if (next.contributes?.ui?.entry) {
    next.contributes.ui.entry = next.contributes.ui.entry.replace(/^\.\//, "").replace(/^dist\//, "./")
    if (!next.contributes.ui.entry.startsWith(".")) next.contributes.ui.entry = `./${next.contributes.ui.entry}`
  }
  return next
}

function permissionSummary(manifest: PluginManifestType): Record<string, unknown> {
  const perms = manifest.permissions ?? {}
  const result: Record<string, unknown> = {}

  if (perms.tools) result.tools = perms.tools
  if (perms.data) result.data = perms.data
  if (perms.network) result.network = perms.network
  if (perms.ui) result.ui = perms.ui
  if (perms.hooks) result.hooks = perms.hooks

  const tools = manifest.contributes?.tools ?? []
  if (tools.length > 0) {
    const toolPerms: Record<string, unknown> = {}
    for (const tool of tools) {
      if (tool.capabilities) toolPerms[tool.name] = tool.capabilities
    }
    if (Object.keys(toolPerms).length > 0) result.contributedTools = toolPerms
  }

  return result
}

export async function buildPluginProject(pluginDir: string): Promise<boolean> {
  const manifestPath = path.join(pluginDir, "plugin.json")
  if (!fs.existsSync(manifestPath)) {
    UI.error(`No plugin.json found at ${manifestPath}`)
    return false
  }

  let manifest: PluginManifestType
  const raw = JSON.parse(fs.readFileSync(manifestPath, "utf-8"))
  const parsed = PluginManifest.safeParse(raw)
  if (!parsed.success) {
    UI.error("Invalid plugin manifest:")
    for (const issue of parsed.error.issues) {
      UI.println(`  ${UI.Style.TEXT_DIM}${issue.path.join(".")}:${UI.Style.TEXT_NORMAL} ${issue.message}`)
    }
    return false
  }
  manifest = parsed.data as PluginManifestType

  const spinner = (message: string) => {
    process.stderr.write(`${UI.Style.TEXT_DIM}  ${message}...${UI.Style.TEXT_NORMAL}${EOL}`)
  }

  UI.println(`${UI.Style.TEXT_NORMAL_BOLD}Building${UI.Style.TEXT_NORMAL} ${manifest.name} v${manifest.version}`)
  UI.println(`  ${UI.Style.TEXT_DIM}Source:${UI.Style.TEXT_NORMAL} ${pluginDir}`)

  const distDir = path.join(pluginDir, "dist")
  fs.rmSync(distDir, { recursive: true, force: true })
  ensureDir(distDir)

  const entryFile = manifest.main ?? "./src/index.ts"
  const entryPath = path.resolve(pluginDir, entryFile)
  const runtimeOutdir = path.join(distDir, "runtime")
  spinner("Building backend")
  const backendResult = await Bun.build({
    entrypoints: [entryPath],
    outdir: runtimeOutdir,
    target: "bun",
    naming: "index.js",
    external: ["@ericsanchezok/synergy-plugin", "@ericsanchezok/synergy-sdk", "@ericsanchezok/synergy-util"],
  })
  if (!backendResult.success) {
    for (const log of backendResult.logs) {
      UI.println(`  ${UI.Style.TEXT_WARNING}${log.message}${UI.Style.TEXT_NORMAL}`)
    }
    UI.error("Backend build failed")
    return false
  }

  const uiEntry = manifest.contributes?.ui?.entry
  if (uiEntry) {
    const uiSourcePath = findUiSource(pluginDir)
    const uiOutputPath = path.resolve(pluginDir, uiEntry)
    if (uiSourcePath) {
      const uiOutdir = path.dirname(uiOutputPath)
      spinner("Building frontend")
      const frontendResult = await Bun.build({
        entrypoints: [uiSourcePath],
        outdir: uiOutdir,
        target: "browser",
        naming: path.basename(uiOutputPath),
      })
      if (!frontendResult.success) {
        for (const log of frontendResult.logs) {
          UI.println(`  ${UI.Style.TEXT_WARNING}${log.message}${UI.Style.TEXT_NORMAL}`)
        }
        UI.error("Frontend build failed")
        return false
      }
    } else if (!fs.existsSync(uiOutputPath)) {
      UI.error(`UI source not found. Expected one of src/ui.tsx or src/ui/index.tsx for ${uiEntry}`)
      return false
    }
  }

  spinner("Normalizing manifest")
  const distManifest = packagedManifest(manifest)
  const distManifestPath = path.join(distDir, "plugin.json")
  fs.writeFileSync(distManifestPath, JSON.stringify(distManifest, null, 2))
  const normalizedPath = path.join(distDir, "plugin.normalized.json")
  fs.writeFileSync(normalizedPath, JSON.stringify(distManifest, null, 2))

  const packageJsonPath = path.join(pluginDir, "package.json")
  if (fs.existsSync(packageJsonPath)) {
    const pkg = JSON.parse(fs.readFileSync(packageJsonPath, "utf-8"))
    pkg.main = "./runtime/index.js"
    pkg.exports = { ".": "./runtime/index.js" }
    fs.writeFileSync(path.join(distDir, "package.json"), JSON.stringify(pkg, null, 2))
  }

  spinner("Generating permission summary")
  const summary = permissionSummary(manifest)
  fs.writeFileSync(path.join(distDir, "permissions.summary.json"), JSON.stringify(summary, null, 2))

  const publicAssetsPath = path.join(pluginDir, "public", "assets")
  if (fs.existsSync(publicAssetsPath)) {
    spinner("Copying assets")
    copyDir(publicAssetsPath, path.join(distDir, "assets"))
  }
  for (const theme of manifest.contributes?.ui?.themes ?? []) copyFilePreserve(pluginDir, distDir, theme.path)
  for (const icon of manifest.contributes?.ui?.icons ?? []) copyFilePreserve(pluginDir, distDir, icon.path)

  spinner("Computing integrity hashes")
  const integrity: Record<string, string> = {
    manifest: sha256File(distManifestPath),
    permissions: sha256JSON(summary),
  }
  const runtimeIndex = path.join(runtimeOutdir, "index.js")
  if (fs.existsSync(runtimeIndex)) integrity.runtime = sha256File(runtimeIndex)
  if (uiEntry) {
    const uiIndex = path.resolve(pluginDir, uiEntry)
    if (fs.existsSync(uiIndex)) integrity.ui = sha256File(uiIndex)
  }
  fs.writeFileSync(path.join(distDir, "integrity.json"), JSON.stringify(integrity, null, 2))

  UI.println(
    `${UI.Style.TEXT_SUCCESS}✔${UI.Style.TEXT_NORMAL} Built ${manifest.name} v${manifest.version} -> ${distDir}`,
  )
  UI.println(`  ${UI.Style.TEXT_DIM}Output:${UI.Style.TEXT_NORMAL} ${distDir}`)
  return true
}

export const PluginBuildCommand = cmd({
  command: "build [path]",
  describe: "build a plugin for distribution",
  builder: (yargs: Argv) =>
    yargs.positional("path", {
      type: "string",
      describe: "path to plugin directory (defaults to cwd)",
    }),
  async handler(args) {
    const ok = await buildPluginProject(path.resolve((args.path as string) ?? process.cwd()))
    if (!ok) process.exitCode = 1
  },
})
