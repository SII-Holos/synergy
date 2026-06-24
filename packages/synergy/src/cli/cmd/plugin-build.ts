import { cmd } from "./cmd"
import { UI } from "../ui"
import { PluginManifest, type PluginManifest as PluginManifestType } from "@ericsanchezok/synergy-plugin"
import { sha256File, sha256JSON } from "../../util/crypto"
import { EOL } from "os"
import path from "path"
import fs from "fs"
import type { Argv } from "yargs"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function ensureDir(dirPath: string) {
  fs.mkdirSync(dirPath, { recursive: true })
}

function copyDir(src: string, dest: string) {
  ensureDir(dest)
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name)
    const destPath = path.join(dest, entry.name)
    if (entry.isDirectory()) {
      copyDir(srcPath, destPath)
    } else {
      fs.copyFileSync(srcPath, destPath)
    }
  }
}

function permissionSummary(manifest: PluginManifestType): Record<string, unknown> {
  const perms = manifest.permissions ?? {}
  const result: Record<string, unknown> = {}

  if (perms.tools) {
    result.tools = perms.tools
  }
  if (perms.data) {
    result.data = perms.data
  }
  if (perms.network) {
    result.network = perms.network
  }
  if (perms.ui) {
    result.ui = perms.ui
  }
  if (perms.hooks) {
    result.hooks = perms.hooks
  }

  // Also summarize contributed tools' capability declarations
  const tools = manifest.contributes?.tools ?? []
  if (tools.length > 0) {
    const toolPerms: Record<string, unknown> = {}
    for (const tool of tools) {
      if (tool.capabilities) {
        toolPerms[tool.name] = tool.capabilities
      }
    }
    if (Object.keys(toolPerms).length > 0) {
      result.contributedTools = toolPerms
    }
  }

  return result
}

// ---------------------------------------------------------------------------
// build [path]
// ---------------------------------------------------------------------------

export const PluginBuildCommand = cmd({
  command: "build [path]",
  describe: "build a plugin for distribution",
  builder: (yargs: Argv) =>
    yargs.positional("path", {
      type: "string",
      describe: "path to plugin directory (defaults to cwd)",
    }),
  async handler(args) {
    const pluginDir = path.resolve((args.path as string) ?? process.cwd())
    const manifestPath = path.join(pluginDir, "plugin.json")

    if (!fs.existsSync(manifestPath)) {
      UI.error(`No plugin.json found at ${manifestPath}`)
      process.exitCode = 1
      return
    }

    // 1. Read and validate manifest
    let manifest: PluginManifestType
    const raw = JSON.parse(fs.readFileSync(manifestPath, "utf-8"))
    const parsed = PluginManifest.safeParse(raw)
    if (!parsed.success) {
      UI.error("Invalid plugin manifest:")
      for (const issue of parsed.error.issues) {
        UI.println(`  ${UI.Style.TEXT_DIM}${issue.path.join(".")}:${UI.Style.TEXT_NORMAL} ${issue.message}`)
      }
      process.exitCode = 1
      return
    }
    manifest = parsed.data as PluginManifestType

    const spinner = (message: string) => {
      process.stderr.write(`${UI.Style.TEXT_DIM}  ${message}...${UI.Style.TEXT_NORMAL}${EOL}`)
    }

    UI.println(`${UI.Style.TEXT_NORMAL_BOLD}Building${UI.Style.TEXT_NORMAL} ${manifest.name} v${manifest.version}`)
    UI.println(`  ${UI.Style.TEXT_DIM}Source:${UI.Style.TEXT_NORMAL} ${pluginDir}`)

    const distDir = path.join(pluginDir, "dist")
    ensureDir(distDir)

    // 2. Backend build
    const entryFile = manifest.main ?? "./src/index.ts"
    const entryPath = path.resolve(pluginDir, entryFile)
    const runtimeOutdir = path.join(distDir, "runtime")
    spinner("Building backend")
    const backendResult = await Bun.build({
      entrypoints: [entryPath],
      outdir: runtimeOutdir,
      target: "bun",
      external: ["@ericsanchezok/synergy-plugin", "@ericsanchezok/synergy-sdk", "@ericsanchezok/synergy-util"],
    })
    if (!backendResult.success) {
      for (const log of backendResult.logs) {
        UI.println(`  ${UI.Style.TEXT_WARNING}${log.message}${UI.Style.TEXT_NORMAL}`)
      }
      UI.error("Backend build failed")
      process.exitCode = 1
      return
    }

    // 3. Frontend build if ui entry exists
    const uiEntry = manifest.contributes?.ui?.entry
    if (uiEntry) {
      const uiEntryPath = path.resolve(pluginDir, uiEntry)
      if (fs.existsSync(uiEntryPath)) {
        const uiOutdir = path.join(distDir, "ui")
        spinner("Building frontend")
        const frontendResult = await Bun.build({
          entrypoints: [uiEntryPath],
          outdir: uiOutdir,
          target: "browser",
        })
        if (!frontendResult.success) {
          for (const log of frontendResult.logs) {
            UI.println(`  ${UI.Style.TEXT_WARNING}${log.message}${UI.Style.TEXT_NORMAL}`)
          }
          UI.error("Frontend build failed")
          process.exitCode = 1
          return
        }
      }
    }

    // 4. Normalize manifest
    spinner("Normalizing manifest")
    const normalizedPath = path.join(distDir, "plugin.normalized.json")
    fs.writeFileSync(normalizedPath, JSON.stringify(manifest, null, 2))

    // 5. Permission summary
    spinner("Generating permission summary")
    const permsSummaryPath = path.join(distDir, "permissions.summary.json")
    const summary = permissionSummary(manifest)
    fs.writeFileSync(permsSummaryPath, JSON.stringify(summary, null, 2))

    // 6. Copy public/assets
    const publicAssetsPath = path.join(pluginDir, "public", "assets")
    const distAssetsPath = path.join(distDir, "assets")
    if (fs.existsSync(publicAssetsPath)) {
      spinner("Copying assets")
      copyDir(publicAssetsPath, distAssetsPath)
    }

    // 7. Integrity hashes
    spinner("Computing integrity hashes")
    interface IntegrityMap {
      runtime?: string
      ui?: string
      manifest: string
      permissions: string
    }
    const integrity: IntegrityMap = {
      manifest: sha256File(normalizedPath),
      permissions: sha256JSON(summary),
    }

    const runtimeIndex = path.join(runtimeOutdir, "index.js")
    if (fs.existsSync(runtimeIndex)) {
      integrity.runtime = sha256File(runtimeIndex)
    }

    if (uiEntry) {
      const uiIndex = path.join(distDir, "ui", "index.js")
      if (fs.existsSync(uiIndex)) {
        integrity.ui = sha256File(uiIndex)
      }
    }

    const integrityPath = path.join(distDir, "integrity.json")
    fs.writeFileSync(integrityPath, JSON.stringify(integrity, null, 2))

    // Done
    UI.println(
      `${UI.Style.TEXT_SUCCESS}✔${UI.Style.TEXT_NORMAL} Built ${manifest.name} v${manifest.version} → ${distDir}`,
    )
    UI.println(`  ${UI.Style.TEXT_DIM}Output:${UI.Style.TEXT_NORMAL} ${distDir}`)
  },
})
