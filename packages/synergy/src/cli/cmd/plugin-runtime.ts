import { cmd } from "./cmd"
import { UI } from "../ui"
import type { Argv } from "yargs"
import { attachOption, ensureServer, fetchPluginApi } from "./plugin-server"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface RuntimeInfo {
  mode: string
  pid?: number
  state: string
  restarts: number
  lastHeartbeatAt?: number
  memoryMb?: number
  limits: Record<string, number>
  lastError?: string
}

function formatRuntimeState(state: string): string {
  const map: Record<string, string> = {
    ready: UI.Style.TEXT_SUCCESS + "ready" + UI.Style.TEXT_NORMAL,
    starting: UI.Style.TEXT_WARNING + "starting" + UI.Style.TEXT_NORMAL,
    unhealthy: UI.Style.TEXT_DANGER + "unhealthy" + UI.Style.TEXT_NORMAL,
    stopped: UI.Style.TEXT_DIM + "stopped" + UI.Style.TEXT_NORMAL,
    crashed: UI.Style.TEXT_DANGER + "crashed" + UI.Style.TEXT_NORMAL,
  }
  return map[state] ?? state
}

// ---------------------------------------------------------------------------
// status <plugin>
// ---------------------------------------------------------------------------

const PluginRuntimeStatusCommand = cmd({
  command: "status <plugin>",
  describe: "show plugin runtime status",
  builder: (yargs: Argv) =>
    yargs
      .positional("plugin", {
        type: "string",
        describe: "plugin id",
        demandOption: true,
      })
      .options(attachOption),
  async handler(args) {
    const serverUrl = args.attach
    if (!(await ensureServer(serverUrl))) process.exit(1)

    const pluginId = args.plugin as string
    const status = await fetchPluginApi<{ runtime?: RuntimeInfo }>(serverUrl, `/${pluginId}/status`)
    const runtime = status?.runtime ?? null

    if (!runtime) {
      UI.println(
        `${UI.Style.TEXT_DIM}Plugin "${pluginId}" has no runtime entry (in-process mode or not running).${UI.Style.TEXT_NORMAL}`,
      )
      return
    }

    UI.println()
    UI.println(`${UI.Style.TEXT_NORMAL_BOLD}Runtime:${UI.Style.TEXT_NORMAL} ${pluginId}`)
    UI.println(`  ${UI.Style.TEXT_DIM}Mode:${UI.Style.TEXT_NORMAL}       ${runtime.mode}`)
    UI.println(`  ${UI.Style.TEXT_DIM}State:${UI.Style.TEXT_NORMAL}      ${formatRuntimeState(runtime.state)}`)
    if (runtime.pid !== undefined && runtime.pid > 0) {
      UI.println(`  ${UI.Style.TEXT_DIM}PID:${UI.Style.TEXT_NORMAL}        ${runtime.pid}`)
    }
    UI.println(`  ${UI.Style.TEXT_DIM}Restarts:${UI.Style.TEXT_NORMAL}   ${runtime.restarts}`)
    if (runtime.lastHeartbeatAt) {
      const ago = Math.round((Date.now() - runtime.lastHeartbeatAt) / 1000)
      UI.println(`  ${UI.Style.TEXT_DIM}Heartbeat:${UI.Style.TEXT_NORMAL}  ${ago}s ago`)
    }
    if (runtime.memoryMb !== undefined) {
      UI.println(`  ${UI.Style.TEXT_DIM}Memory:${UI.Style.TEXT_NORMAL}     ${runtime.memoryMb} MB`)
    }
    if (runtime.lastError) {
      UI.println(`  ${UI.Style.TEXT_DIM}Last Error:${UI.Style.TEXT_NORMAL} ${runtime.lastError}`)
    }
    UI.println(`  ${UI.Style.TEXT_DIM}Limits:${UI.Style.TEXT_NORMAL}`)
    for (const [key, val] of Object.entries(runtime.limits)) {
      UI.println(`    ${key}: ${val}`)
    }
  },
})

// ---------------------------------------------------------------------------
// restart <plugin>
// ---------------------------------------------------------------------------

const PluginRuntimeRestartCommand = cmd({
  command: "restart <plugin>",
  describe: "restart plugin runtime",
  builder: (yargs: Argv) =>
    yargs
      .positional("plugin", {
        type: "string",
        describe: "plugin id",
        demandOption: true,
      })
      .options(attachOption),
  async handler(args) {
    const serverUrl = args.attach
    if (!(await ensureServer(serverUrl))) process.exit(1)

    const pluginId = args.plugin as string
    UI.println(`${UI.Style.TEXT_DIM}Restarting ${pluginId}...${UI.Style.TEXT_NORMAL}`)

    const runtime = await fetchPluginApi<RuntimeInfo | null>(serverUrl, `/${pluginId}/runtime/reload`, "POST")

    if (runtime) {
      UI.println(
        `${UI.Style.TEXT_SUCCESS}✔${UI.Style.TEXT_NORMAL} Plugin restarted — state: ${formatRuntimeState(runtime.state)}`,
      )
    } else {
      UI.println(`${UI.Style.TEXT_WARNING}⚠${UI.Style.TEXT_NORMAL} Plugin restarted but no runtime info returned`)
    }
  },
})

// ---------------------------------------------------------------------------
// stop <plugin>
// ---------------------------------------------------------------------------

const PluginRuntimeStopCommand = cmd({
  command: "stop <plugin>",
  describe: "stop plugin runtime",
  builder: (yargs: Argv) =>
    yargs
      .positional("plugin", {
        type: "string",
        describe: "plugin id",
        demandOption: true,
      })
      .options(attachOption),
  async handler(args) {
    const serverUrl = args.attach
    if (!(await ensureServer(serverUrl))) process.exit(1)

    const pluginId = args.plugin as string
    await fetchPluginApi(serverUrl, `/${pluginId}/runtime/stop`, "POST")
    UI.println(`${UI.Style.TEXT_SUCCESS}✔${UI.Style.TEXT_NORMAL} Plugin "${pluginId}" runtime stopped`)
  },
})

// ---------------------------------------------------------------------------
// logs <plugin>
// ---------------------------------------------------------------------------

const PluginRuntimeLogsCommand = cmd({
  command: "logs <plugin>",
  describe: "show plugin runtime logs",
  builder: (yargs: Argv) =>
    yargs
      .positional("plugin", {
        type: "string",
        describe: "plugin id",
        demandOption: true,
      })
      .options(attachOption),
  async handler(args) {
    const serverUrl = args.attach
    if (!(await ensureServer(serverUrl))) process.exit(1)

    const pluginId = args.plugin as string
    const logs = await fetchPluginApi<Array<{ timestamp: number; level: string; message: string }>>(
      serverUrl,
      `/${pluginId}/runtime/logs`,
    )

    if (logs.length === 0) {
      UI.println(
        `${UI.Style.TEXT_DIM}No logs captured yet — enable log capture to view plugin logs${UI.Style.TEXT_NORMAL}`,
      )
      return
    }

    for (const entry of logs) {
      const time = new Date(entry.timestamp).toLocaleTimeString("en-US", { hour12: false })
      const level = entry.level.toUpperCase().padEnd(5)
      UI.println(`${UI.Style.TEXT_DIM}${time}${UI.Style.TEXT_NORMAL} ${level} ${entry.message}`)
    }
  },
})

// ---------------------------------------------------------------------------
// runtime command group
// ---------------------------------------------------------------------------

export const PluginRuntimeCommand = cmd({
  command: "runtime",
  describe: "manage plugin runtime lifecycle",
  builder: (yargs: Argv) =>
    yargs
      .command(PluginRuntimeStatusCommand)
      .command(PluginRuntimeRestartCommand)
      .command(PluginRuntimeStopCommand)
      .command(PluginRuntimeLogsCommand)
      .demandCommand(),
  async handler() {},
})
