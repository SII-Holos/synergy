import { cmd } from "./cmd"
import { UI } from "../ui"
import { PluginManifest, type PluginManifest as PluginManifestType } from "@ericsanchezok/synergy-plugin"
import { baseCapabilities, permissionItems, pluginRisk } from "@ericsanchezok/synergy-util/capability"
import { Plugin } from "@/plugin"
import path from "path"
import fs from "fs"
import type { Argv } from "yargs"

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
  const risk = pluginRisk(manifest, { scope: "install" })
  const items = permissionItems(manifest, capabilities)

  UI.println(`✓ permissions: ${riskLabel(risk)} risk`)

  if (items.length > 0) {
    UI.println(`  → ${items.map((item) => `${item.title} (${riskLabel(item.severity)})`).join(", ")}`)
  }

  const ui = manifest.contributes?.ui
  if (ui) {
    const uiParts: string[] = []
    if (ui.toolRenderers?.length)
      uiParts.push(`${ui.toolRenderers.length} tool renderer${ui.toolRenderers.length !== 1 ? "s" : ""}`)
    if (ui.partRenderers?.length)
      uiParts.push(`${ui.partRenderers.length} part renderer${ui.partRenderers.length !== 1 ? "s" : ""}`)
    if (ui.workbenchPanels?.length)
      uiParts.push(`${ui.workbenchPanels.length} workbench panel${ui.workbenchPanels.length !== 1 ? "s" : ""}`)
    if (ui.navigation?.length) uiParts.push(`${ui.navigation.length} nav item${ui.navigation.length !== 1 ? "s" : ""}`)
    if (ui.composerSlots?.length)
      uiParts.push(`${ui.composerSlots.length} composer slot${ui.composerSlots.length !== 1 ? "s" : ""}`)
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
    (ui.workbenchPanels?.length ?? 0) +
    (ui.navigation?.length ?? 0) +
    (ui.settings?.length ?? 0) +
    (ui.messageSlots?.length ?? 0) +
    (ui.composerSlots?.length ?? 0) +
    (ui.themes?.length ?? 0) +
    (ui.icons?.length ?? 0) +
    (ui.commands?.length ?? 0)
  )
}

// ---------------------------------------------------------------------------
// Health snapshot — exported for testability
// ---------------------------------------------------------------------------

export interface HealthSnapshot {
  mode: string
  pid?: number
  state: string
  memoryMb?: number
  lastHeartbeatAt?: number
  activeRequests: number
  droppedLogs: number
}

import { getRuntime, getLogBuffer } from "@/plugin-runtime"

/** Gather next-tick health snapshot from the supervisor and log buffer. */
export function collectHealthSnapshot(pluginId: string): HealthSnapshot | null {
  const entry = getRuntime(pluginId)
  if (!entry) return null
  return {
    mode: entry.mode,
    pid: entry.pid,
    state: entry.state,
    memoryMb: entry.memoryMb,
    lastHeartbeatAt: entry.lastHeartbeatAt,
    activeRequests: entry.concurrencyLimiter?.activeCount() ?? 0,
    droppedLogs: getLogBuffer().droppedCount(pluginId),
  }
}

/** Format a health snapshot as a set of display lines. */
export function formatHealthSnapshot(snapshot: HealthSnapshot): string[] {
  const lines: string[] = []
  lines.push(`  Mode:      ${snapshot.mode}`)
  if (snapshot.pid !== undefined) {
    lines.push(`  PID:       ${snapshot.pid}`)
  }
  lines.push(`  State:     ${snapshot.state}`)
  if (snapshot.memoryMb !== undefined) {
    lines.push(`  Memory:    ${snapshot.memoryMb} MB`)
  }
  if (snapshot.lastHeartbeatAt !== undefined) {
    const ago = Math.round((Date.now() - snapshot.lastHeartbeatAt) / 1000)
    lines.push(`  Heartbeat: ${ago}s ago`)
  }
  lines.push(`  Requests:  ${snapshot.activeRequests} active`)
  lines.push(`  Logs:      ${snapshot.droppedLogs} dropped`)
  return lines
}

/** Format log entries as display lines, showing the most recent entries up to maxLines (default 10). */
export function formatLogTail(
  entries: { timestamp: number; level: string; message: string }[],
  maxLines = 10,
): string[] {
  if (entries.length === 0) return []
  const tail = entries.slice(-maxLines)
  return tail.map((e) => {
    const time = new Date(e.timestamp).toLocaleTimeString("en-US", { hour12: false })
    return `  ${time} ${e.level.padEnd(7)} ${e.message}`
  })
}

function printHealthDashboard(manifest: PluginManifestType) {
  const pluginId = manifest.name
  const snapshot = collectHealthSnapshot(pluginId)
  if (!snapshot) return

  UI.println()
  UI.println(`  ${UI.Style.TEXT_NORMAL_BOLD}Health${UI.Style.TEXT_NORMAL}`)
  for (const line of formatHealthSnapshot(snapshot)) {
    UI.println(line)
  }

  const logEntries = getLogBuffer().list(pluginId)
  const tail = formatLogTail(logEntries)
  if (tail.length > 0) {
    UI.println()
    UI.println(`  ${UI.Style.TEXT_NORMAL_BOLD}Log tail (last ${tail.length})${UI.Style.TEXT_NORMAL}`)
    for (const line of tail) {
      UI.println(line)
    }
  }
}

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
    printHealthDashboard(manifest)

    const uiContribs = countUiContributions(manifest)
    if (uiContribs > 0) {
      const ui = manifest.contributes!.ui!
      const uiParts: string[] = []
      if (ui.toolRenderers?.length)
        uiParts.push(`${ui.toolRenderers.length} tool renderer${ui.toolRenderers.length !== 1 ? "s" : ""}`)
      if (ui.workbenchPanels?.length)
        uiParts.push(`${ui.workbenchPanels.length} workbench panel${ui.workbenchPanels.length !== 1 ? "s" : ""}`)
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
                printHealthDashboard(manifest)
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
