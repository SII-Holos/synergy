import { cmd } from "./cmd"
import { UI } from "../ui"
import { PluginManifest, type PluginManifest as PluginManifestType } from "@ericsanchezok/synergy-plugin"
import { Plugin } from "@/plugin"
import { computeRisk } from "@/plugin/consent/risk"
import path from "path"
import fs from "fs"
import type { Argv } from "yargs"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

let overallRisk: (m: PluginManifestType) => "low" | "medium" | "high"
overallRisk = (m) => {
  const caps: string[] = []
  const pt = m.permissions?.tools
  if (pt?.shell) caps.push("shell")
  if (pt?.filesystem === "write") caps.push("filesystem:write")
  else if (pt?.filesystem === "read") caps.push("filesystem:read")
  if (pt?.network) caps.push("network")
  if (pt?.mcp === "invoke") caps.push("mcp:invoke")
  if (pt?.mcp === "spawn") caps.push("mcp:spawn")
  const pd = m.permissions?.data
  if (pd?.session === "read") caps.push("session_data")
  if (pd?.workspace === "read") caps.push("workspace_data")
  if (pd?.secrets === "own") caps.push("secrets")
  if (pd?.config === "global") caps.push("config:write")
  if (pd?.config === "plugin") caps.push("config:read")
  return computeRisk(caps, m)
}

function riskLabel(risk: "low" | "medium" | "high"): string {
  if (risk === "high") return UI.Style.TEXT_DANGER + "high" + UI.Style.TEXT_NORMAL
  if (risk === "medium") return UI.Style.TEXT_WARNING + "medium" + UI.Style.TEXT_NORMAL
  return UI.Style.TEXT_SUCCESS + "low" + UI.Style.TEXT_NORMAL
}

function printPermissionPreview(manifest: PluginManifestType) {
  const pt = manifest.permissions?.tools
  const pd = manifest.permissions?.data
  const risk = overallRisk(manifest)
  const caps: string[] = []

  if (pt?.shell) caps.push(`shell (${UI.Style.TEXT_DANGER}high${UI.Style.TEXT_NORMAL})`)
  if (pt?.filesystem === "write") caps.push(`filesystem: write (${UI.Style.TEXT_DANGER}high${UI.Style.TEXT_NORMAL})`)
  else if (pt?.filesystem === "read")
    caps.push(`filesystem: read (${UI.Style.TEXT_WARNING}medium${UI.Style.TEXT_NORMAL})`)

  UI.println(`✓ permissions: ${riskLabel(risk)} risk`)

  if (caps.length > 0) {
    UI.println(`  → tools: ${caps.join(", ")}`)
  }

  if (pt?.network) {
    const net =
      pt.network === true
        ? "all hosts"
        : typeof pt.network === "object" && "hosts" in pt.network
          ? (pt.network as { hosts: string[] }).hosts.join(", ")
          : String(pt.network)
    UI.println(`  → network: ${net}`)
  }

  if (pd?.session === "read") {
    UI.println(`  → data: session read`)
  }
  if (pd?.workspace === "read") {
    UI.println(`  → data: workspace read`)
  }
  if (pd?.secrets === "own") {
    UI.println(`  → data: secrets`)
  }

  const ui = manifest.contributes?.ui
  if (ui) {
    const uiParts: string[] = []
    if (ui.toolRenderers?.length)
      uiParts.push(`${ui.toolRenderers.length} tool renderer${ui.toolRenderers.length !== 1 ? "s" : ""}`)
    if (ui.partRenderers?.length)
      uiParts.push(`${ui.partRenderers.length} part renderer${ui.partRenderers.length !== 1 ? "s" : ""}`)
    if (ui.workspacePanels?.length)
      uiParts.push(`${ui.workspacePanels.length} workspace panel${ui.workspacePanels.length !== 1 ? "s" : ""}`)
    if (ui.globalPanels?.length)
      uiParts.push(`${ui.globalPanels.length} global panel${ui.globalPanels.length !== 1 ? "s" : ""}`)
    if (ui.routes?.length) uiParts.push(`${ui.routes.length} route${ui.routes.length !== 1 ? "s" : ""}`)
    if (uiParts.length > 0) {
      UI.println(`  → UI: ${uiParts.join(", ")}`)
    }
  }
}

function printRuntimeStatus(manifest: PluginManifestType) {
  UI.println(`Runtime: ${UI.Style.TEXT_DIM}${manifest.name} v${manifest.version}${UI.Style.TEXT_NORMAL}`)
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

// ---------------------------------------------------------------------------
// dev [path]
// ---------------------------------------------------------------------------

export const PluginDevCommand = cmd({
  command: "dev [path]",
  describe: "start plugin development mode with file watching and auto-reload",
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

    // Read and validate manifest
    let manifest: PluginManifestType
    try {
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
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e)
      UI.error(`Failed to read manifest: ${msg}`)
      process.exitCode = 1
      return
    }

    // Header
    UI.println(
      `${UI.Style.TEXT_NORMAL_BOLD}Synergy Plugin Dev${UI.Style.TEXT_NORMAL} — ${manifest.name} v${manifest.version}`,
    )
    UI.println()

    // Validate
    UI.println(`${UI.Style.TEXT_SUCCESS}✓${UI.Style.TEXT_NORMAL} manifest valid`)

    // Permissions
    printPermissionPreview(manifest)

    // Runtime header
    UI.println()
    printRuntimeStatus(manifest)

    const uiContribs = countUiContributions(manifest)
    if (uiContribs > 0) {
      const ui = manifest.contributes!.ui!
      const uiParts: string[] = []
      if (ui.toolRenderers?.length)
        uiParts.push(`${ui.toolRenderers.length} tool renderer${ui.toolRenderers.length !== 1 ? "s" : ""}`)
      if (ui.workspacePanels?.length)
        uiParts.push(`${ui.workspacePanels.length} workspace panel${ui.workspacePanels.length !== 1 ? "s" : ""}`)
      UI.println(`UI: ${uiParts.join(", ")}`)
    }

    // Watch mode
    const srcDir = path.join(pluginDir, "src")
    if (!fs.existsSync(srcDir)) {
      UI.println(`${UI.Style.TEXT_WARNING}⚠${UI.Style.TEXT_NORMAL} No src/ directory found at ${srcDir}`)
    }

    UI.println()
    UI.println(`Watching ${srcDir} for changes...`)
    UI.println()

    const onReload = debounce(300)

    const watcher = fs.watch(srcDir, { recursive: true }, (_event, filename) => {
      if (!filename) return

      onReload(() => {
        const now = timestamp()
        UI.println(`${now} [${manifest.name}] File changed: ${filename}`)
        UI.print("Reloading... ")

        // Re-validate manifest
        try {
          const raw = JSON.parse(fs.readFileSync(manifestPath, "utf-8"))
          const parsed = PluginManifest.safeParse(raw)
          if (parsed.success) {
            manifest = parsed.data as PluginManifestType

            // Try to reload plugin state
            Plugin.reload()
              .then(() => {
                UI.println(`${UI.Style.TEXT_SUCCESS}done${UI.Style.TEXT_NORMAL}`)
                printRuntimeStatus(manifest)
                UI.println()
              })
              .catch((err: unknown) => {
                const msg = err instanceof Error ? err.message : String(err)
                UI.println(`${UI.Style.TEXT_WARNING}reload skipped (${msg})${UI.Style.TEXT_NORMAL}`)
                UI.println(`${UI.Style.TEXT_SUCCESS}✓${UI.Style.TEXT_NORMAL} manifest valid`)
                printPermissionPreview(manifest)
                UI.println()
              })
          } else {
            UI.println(`${UI.Style.TEXT_DANGER}failed${UI.Style.TEXT_NORMAL}`)
            UI.error("Manifest validation failed:")
            for (const issue of parsed.error.issues) {
              UI.println(`  ${UI.Style.TEXT_DIM}${issue.path.join(".")}:${UI.Style.TEXT_NORMAL} ${issue.message}`)
            }
            UI.println()
          }
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e)
          UI.println(`${UI.Style.TEXT_DANGER}failed${UI.Style.TEXT_NORMAL}`)
          UI.error(`Manifest read error: ${msg}`)
          UI.println()
        }
      })
    })

    // Handle graceful exit
    const shutdown = () => {
      UI.println()
      UI.println("Shutting down...")
      watcher.close()
      UI.println("Runtime stopped. Goodbye!")
      process.exit(0)
    }

    process.on("SIGINT", shutdown)
    process.on("SIGTERM", shutdown)
  },
})
