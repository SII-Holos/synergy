import path from "path"
import fs from "fs"
import type { Argv } from "yargs"
import { PluginManifest, type PluginManifest as PluginManifestType } from "@ericsanchezok/synergy-plugin"
import { baseCapabilities, computeRisk, permissionItems } from "@ericsanchezok/synergy-plugin/permissions"
import { cmd } from "../cmd"
import { UI } from "../ui"

function timestamp(): string {
  return new Date().toLocaleTimeString("en-US", { hour12: false })
}

function debounce(ms: number) {
  let timer: ReturnType<typeof setTimeout> | undefined
  return (fn: () => void) => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(fn, ms)
  }
}

function riskLabel(risk: "low" | "medium" | "high"): string {
  if (risk === "high") return UI.Style.TEXT_DANGER + "high" + UI.Style.TEXT_NORMAL
  if (risk === "medium") return UI.Style.TEXT_WARNING + "medium" + UI.Style.TEXT_NORMAL
  return UI.Style.TEXT_SUCCESS + "low" + UI.Style.TEXT_NORMAL
}

function printPermissionPreview(manifest: PluginManifestType) {
  const capabilities = baseCapabilities(manifest)
  const risk = computeRisk(capabilities, manifest)
  const items = permissionItems(manifest, capabilities)

  UI.println(`✓ permissions: ${riskLabel(risk)} risk`)
  if (items.length > 0) {
    UI.println(`  -> ${items.map((item) => `${item.title} (${riskLabel(item.severity)})`).join(", ")}`)
  }
}

function countUiContributions(manifest: PluginManifestType): number {
  const ui = manifest.contributes?.ui
  if (!ui) return 0
  return (
    (ui.toolRenderers?.length ?? 0) +
    (ui.partRenderers?.length ?? 0) +
    (ui.workspacePanels?.length ?? 0) +
    (ui.globalPanels?.length ?? 0) +
    (ui.settings?.length ?? 0) +
    (ui.chatComponents?.length ?? 0) +
    (ui.themes?.length ?? 0) +
    (ui.icons?.length ?? 0) +
    (ui.commands?.length ?? 0) +
    (ui.routes?.length ?? 0)
  )
}

function readManifest(manifestPath: string): PluginManifestType {
  const raw = JSON.parse(fs.readFileSync(manifestPath, "utf-8"))
  return PluginManifest.parse(raw) as PluginManifestType
}

export const PluginDevCommand = cmd({
  command: "dev [path]",
  describe: "start plugin development mode with file watching",
  builder: (yargs: Argv) =>
    yargs
      .positional("path", {
        type: "string",
        describe: "path to plugin directory (defaults to cwd)",
      })
      .option("sandbox-preview", {
        type: "boolean",
        default: false,
        describe: "print Synergy sandbox preview URLs for UI panels",
      })
      .option("port", {
        type: "number",
        default: 3000,
        describe: "Synergy server port for preview URLs",
      }),
  async handler(args) {
    const pluginDir = path.resolve((args.path as string) ?? process.cwd())
    const manifestPath = path.join(pluginDir, "plugin.json")
    if (!fs.existsSync(manifestPath)) {
      UI.error(`No plugin.json found at ${manifestPath}`)
      process.exitCode = 1
      return
    }

    let manifest: PluginManifestType
    try {
      manifest = readManifest(manifestPath)
    } catch (error) {
      UI.error(`Failed to read manifest: ${error instanceof Error ? error.message : String(error)}`)
      process.exitCode = 1
      return
    }

    UI.println(
      `${UI.Style.TEXT_NORMAL_BOLD}Synergy Plugin Dev${UI.Style.TEXT_NORMAL} - ${manifest.name} v${manifest.version}`,
    )
    UI.println()
    UI.println(`${UI.Style.TEXT_SUCCESS}✓${UI.Style.TEXT_NORMAL} manifest valid`)
    printPermissionPreview(manifest)

    const uiContribs = countUiContributions(manifest)
    if (uiContribs > 0) {
      UI.println()
      UI.println(`UI: ${uiContribs} contribution${uiContribs !== 1 ? "s" : ""}`)
    }

    if (args["sandbox-preview"]) {
      for (const panel of manifest.contributes?.ui?.workspacePanels ?? []) {
        if (panel.sandbox) {
          UI.println(
            `  ${panel.label}: http://localhost:${args.port}/plugin/${encodeURIComponent(manifest.name)}/sandbox/${encodeURIComponent(panel.id)}`,
          )
        }
      }
      for (const panel of manifest.contributes?.ui?.globalPanels ?? []) {
        if (panel.sandbox) {
          UI.println(
            `  ${panel.label}: http://localhost:${args.port}/plugin/${encodeURIComponent(manifest.name)}/sandbox/${encodeURIComponent(panel.id)}`,
          )
        }
      }
    }

    const srcDir = path.join(pluginDir, "src")
    if (!fs.existsSync(srcDir)) {
      UI.println(`${UI.Style.TEXT_WARNING}⚠${UI.Style.TEXT_NORMAL} No src/ directory found at ${srcDir}`)
      return
    }

    UI.println()
    UI.println(`Watching ${srcDir} for changes...`)
    UI.println(
      `${UI.Style.TEXT_DIM}Run synergy plugin add file://${pluginDir} in a Synergy runtime when you need live installation/reload.${UI.Style.TEXT_NORMAL}`,
    )
    UI.println()

    const onReload = debounce(300)
    const watcher = fs.watch(srcDir, { recursive: true }, (_event, filename) => {
      if (!filename) return
      onReload(() => {
        UI.println(`${timestamp()} [${manifest.name}] File changed: ${filename}`)
        try {
          manifest = readManifest(manifestPath)
          UI.println(`${UI.Style.TEXT_SUCCESS}✓${UI.Style.TEXT_NORMAL} manifest valid`)
          printPermissionPreview(manifest)
          UI.println()
        } catch (error) {
          UI.error(`Manifest read error: ${error instanceof Error ? error.message : String(error)}`)
        }
      })
    })

    const shutdown = () => {
      UI.println()
      UI.println("Shutting down...")
      watcher.close()
      process.exit(0)
    }
    process.on("SIGINT", shutdown)
    process.on("SIGTERM", shutdown)
  },
})
