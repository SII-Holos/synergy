// L4 assembly: load built-in product registrations before any core registry use
import "../product-registration"
import { ProductRuntimeHandle } from "./runtime-handle"
import { Server } from "@ericsanchezok/synergy-server/server/server"
import { Installation } from "@ericsanchezok/synergy-harness/global/installation"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { ScopedState } from "@ericsanchezok/synergy-harness/scope/scoped-state"
import { Scope } from "@ericsanchezok/synergy-harness/scope"
import { Config } from "@ericsanchezok/synergy-harness/config/config"
import { Log } from "@ericsanchezok/synergy-harness/util/log"
import * as ChannelTypes from "@ericsanchezok/synergy-connections/channel/types"
import { Provider } from "@ericsanchezok/synergy-harness/provider/provider"
import { DaemonLogRotate } from "@ericsanchezok/synergy-cli/daemon/log-rotate"
import { StartupReporter } from "@ericsanchezok/synergy-cli/cli/startup-reporter"
import { Flag } from "@ericsanchezok/synergy-harness/flag/flag"
import { Observability } from "@ericsanchezok/synergy-harness/observability"
import { Plugin } from "@ericsanchezok/synergy-plugin-host/plugin"
import { PluginSpec } from "@ericsanchezok/synergy-harness/util/plugin-spec"
import { watchManagedParent } from "@ericsanchezok/synergy-harness/util/managed-parent"
import { peekRuntimeEndpointGeneration } from "@ericsanchezok/synergy-harness/util/runtime-endpoint"

const log = Log.create({ service: "server-runtime" })

const CHANNEL_CONNECT_TIMEOUT = 15_000
const STATUS_POLL_INTERVAL = 320

export interface RuntimeOptions {
  interactive: boolean
  printBanner: boolean
  printChannelStatus: boolean
  network: {
    hostname: string
    port: number
    mdns?: boolean
    cors?: string[]
  }
}
export async function run(options: RuntimeOptions) {
  const reporter = options.printBanner ? StartupReporter.create() : undefined
  await using handle = await ProductRuntimeHandle.open({
    mode: "server",
    network: options.network,
    reporter: reporter ? { summary: (summary) => reporter.migration(summary) } : undefined,
  })
  const server = handle.server
  reporter?.migration(handle.migration)
  registerShutdown(handle)
  await Observability.cleanup().catch(() => {})
  await Observability.emit("server.start", {
    data: {
      pid: process.pid,
      cwd: process.cwd(),
      launchCwd: startupScopeLabel(),
      mode: process.env.SYNERGY_DAEMON === "1" ? "daemon" : "server",
      network: options.network,
    },
  })

  const statuses: StartupReporter.StatusRow[] = []

  // Deliver install lifecycles queued by CLI installs that ran outside a host process.
  // Runs after the plugin catalog is loaded and before the runtime.started broadcast so the
  // broadcast itself serves as the catch-up notification for plugins delivered here.
  await ScopeContext.provide({
    scope: Scope.home(),
    fn: async () => {
      await Plugin.runPendingInstallLifecycles()
    },
  }).catch((error) => log.warn("pending plugin install lifecycles failed", { error }))
  const endpointGeneration = peekRuntimeEndpointGeneration()
  if (endpointGeneration) {
    void ScopeContext.provide({
      scope: Scope.home(),
      fn: () => Plugin.trigger("runtime.started", { endpointGeneration }, {}),
    }).catch((error) => log.warn("plugin runtime.started hooks failed", { error }))
  }
  statuses.push(
    await ScopeContext.provide({
      scope: Scope.home(),
      fn: async () => pluginStatusRow(await Plugin.getLoaded(), await Plugin.getDisabled()),
    }),
  )
  if (options.printChannelStatus) {
    statuses.push(
      ...(await ScopeContext.provide({
        scope: Scope.home(),
        fn: connectionStatusRows,
      })),
    )
  }

  if (options.printBanner) {
    if (
      await ScopeContext.provide({
        scope: Scope.home(),
        fn: hasNoModelConfigured,
      })
    ) {
      reporter?.warning("No AI model configured — run synergy config before sending messages.")
    }
    const issues = Config.diagnostics()
    for (const issue of issues) {
      const location = issue.quarantinedPath ?? issue.path
      reporter?.warning(`Configuration issue (${issue.code}): ${issue.error}${location ? ` — ${location}` : ""}`)
    }
    renderBanner({ server, network: options.network, reporter: reporter ?? StartupReporter.create(), statuses })
  }

  if (process.env.SYNERGY_DAEMON === "1") {
    DaemonLogRotate.start()
  }

  await new Promise(() => {})
}

function renderBanner(input: {
  server: { hostname?: string; port?: number }
  network: RuntimeOptions["network"]
  reporter: StartupReporter.Reporter
  statuses: StartupReporter.StatusRow[]
}) {
  const hostname = input.server.hostname || input.network.hostname || "localhost"
  const port = input.server.port || Server.DEFAULT_PORT
  const url = displayUrl(hostname, port)
  const bind = `${hostname}:${port}`
  const portExplicitlySet = process.argv.includes("--port")
  const fellBackToRandom = !portExplicitlySet && port !== Server.DEFAULT_PORT
  const attach = port === Server.DEFAULT_PORT ? "" : " --attach " + url
  if (fellBackToRandom) {
    input.reporter.warning(`Port ${Server.DEFAULT_PORT} is busy; using ${port}.`)
  }

  input.reporter.render({
    title: `Synergy ${Installation.VERSION}`,
    rows: [
      { label: "Mode", value: "global server" },
      { label: "Launch cwd", value: startupScopeLabel() },
      { label: "Server", value: url },
      { label: "Bind", value: bind },
      { label: "Logs", value: Log.file() || "stderr" },
    ],
    statuses: input.statuses,
    next: ["synergy web" + attach, "synergy send" + attach + ' "your message"'],
  })
}

export function startupScopeLabel() {
  return Flag.SYNERGY_CWD || process.cwd()
}

export function pluginStatusRow(
  loaded: Array<{ id: string; name: string }>,
  disabled: Array<{ pluginId: string }>,
): StartupReporter.StatusRow {
  if (loaded.length === 0 && disabled.length === 0) {
    return { label: "Plugins", value: "none configured", kind: "muted" }
  }
  const names = loaded.map((plugin) => plugin.name).join(", ")
  if (disabled.length === 0) return { label: "Plugins", value: names, kind: "success" }
  const unavailable = `${disabled.length} unavailable: ${disabled.map((plugin) => PluginSpec.displayName(plugin.pluginId)).join(", ")}`
  return { label: "Plugins", value: names ? `${names}; ${unavailable}` : unavailable, kind: "error" }
}

async function hasNoModelConfigured() {
  try {
    const providers = await Provider.list()
    return Object.keys(providers).length === 0
  } catch {
    return false
  }
}

function getStatusText(status: ChannelTypes.Status): string {
  if (status.status === "failed") return `failed: ${status.error}`
  return status.status
}

async function resolveStatuses(input: {
  statuses: Record<string, ChannelTypes.Status>
  refresh: () => Promise<Record<string, ChannelTypes.Status>>
}): Promise<Record<string, ChannelTypes.Status>> {
  const entries = Object.entries(input.statuses)
  if (entries.length === 0) return {}

  const result: Record<string, ChannelTypes.Status> = { ...input.statuses }
  await Promise.all(
    entries.map(async ([key, status]) => {
      if (status.status === "connecting") {
        result[key] = await new Promise<ChannelTypes.Status>((resolve) => {
          const timeout = setTimeout(
            () => resolve({ status: "failed", error: "connection timeout" } as ChannelTypes.Status),
            CHANNEL_CONNECT_TIMEOUT,
          )
          const spin = setInterval(async () => {
            const current = await input.refresh().catch(() => ({}) as Record<string, ChannelTypes.Status>)
            const nextStatus = current[key]
            if (nextStatus && nextStatus.status !== "connecting") {
              clearInterval(spin)
              clearTimeout(timeout)
              resolve(nextStatus)
            }
          }, STATUS_POLL_INTERVAL)
        })
      }
    }),
  )
  return result
}

async function holosStatusRow(): Promise<StartupReporter.StatusRow> {
  const { HolosRuntime } = await import("@ericsanchezok/synergy-connections/holos/runtime")
  type HolosStatus = Awaited<ReturnType<typeof HolosRuntime.status>>

  const status = await HolosRuntime.status()
  const key = "agent network"

  const getHolosStatusText = (current: HolosStatus) => {
    if (current.status === "failed") return `failed: ${current.error}`
    return current.status
  }

  if (status.status === "connecting") {
    const finalStatus = await new Promise<HolosStatus>((resolve) => {
      const timeout = setTimeout(
        () => resolve({ status: "failed", error: "connection timeout" }),
        CHANNEL_CONNECT_TIMEOUT,
      )
      const spin = setInterval(async () => {
        const nextStatus = await HolosRuntime.status().catch(
          (): HolosStatus => ({ status: "failed", error: "status unavailable" }),
        )
        if (nextStatus.status !== "connecting") {
          clearInterval(spin)
          clearTimeout(timeout)
          resolve(nextStatus)
        }
      }, STATUS_POLL_INTERVAL)
    })
    return { label: "Holos", value: `${key} ${getHolosStatusText(finalStatus)}`, kind: statusKind(finalStatus.status) }
  }

  return { label: "Holos", value: `${key} ${getHolosStatusText(status)}`, kind: statusKind(status.status) }
}

async function connectionStatusRows(): Promise<StartupReporter.StatusRow[]> {
  const { Bus } = await import("@ericsanchezok/synergy-harness/bus")
  const { Channel } = await import("@ericsanchezok/synergy-connections/channel")

  const channelStatuses = await resolveStatuses({ statuses: await Channel.status(), refresh: () => Channel.status() })
  const rows: StartupReporter.StatusRow[] = [channelStatusRow(channelStatuses), await holosStatusRow()]

  const channelState = ScopedState.create(
    () => {
      const unsubs: Array<() => void> = []
      unsubs.push(
        Bus.subscribe(Channel.Event.Connected, (event) => {
          const channel = event.properties.channelType + ":" + event.properties.accountId
          StartupReporter.print({
            title: "Synergy connection update",
            statuses: [{ label: "Channels", value: `${channel} reconnected`, kind: "success" }],
          })
        }),
      )
      unsubs.push(
        Bus.subscribe(Channel.Event.Disconnected, (event) => {
          const channel = event.properties.channelType + ":" + event.properties.accountId
          const reason = event.properties.reason ? ": " + event.properties.reason : ""
          StartupReporter.print({
            title: "Synergy connection update",
            statuses: [{ label: "Channels", value: `${channel} disconnected${reason}`, kind: "warning" }],
          })
        }),
      )
      return { unsubs }
    },
    async (s) => {
      for (const unsub of s.unsubs) unsub()
    },
  )
  void channelState()
  return rows
}

function channelStatusRow(statuses: Record<string, ChannelTypes.Status>): StartupReporter.StatusRow {
  const entries = Object.entries(statuses)
  if (entries.length === 0) return { label: "Channels", value: "none configured", kind: "muted" }
  const failed = entries.filter(([, status]) => status.status === "failed")
  if (failed.length > 0) {
    return {
      label: "Channels",
      value: failed.map(([key, status]) => `${key} ${getStatusText(status)}`).join(", "),
      kind: "error",
    }
  }
  const connected = entries.filter(([, status]) => status.status === "connected")
  if (connected.length === entries.length) {
    return { label: "Channels", value: connected.map(([key]) => `${key} connected`).join(", "), kind: "success" }
  }
  return {
    label: "Channels",
    value: entries.map(([key, status]) => `${key} ${getStatusText(status)}`).join(", "),
    kind: entries.some(([, status]) => status.status === "connecting") ? "pending" : "muted",
  }
}

function statusKind(status: ChannelTypes.Status["status"]): StartupReporter.StatusRow["kind"] {
  if (status === "connected") return "success"
  if (status === "connecting") return "pending"
  if (status === "failed") return "error"
  return "muted"
}

function displayUrl(hostname: string, port: number) {
  const displayHost = hostname === "0.0.0.0" ? "localhost" : hostname === "::" ? "::1" : hostname
  const url = new URL("http://localhost")
  url.hostname = displayHost
  url.port = String(port)
  return url.toString().replace(/\/$/, "")
}

function registerShutdown(handle: ProductRuntimeHandle.Handle) {
  let shuttingDown = false
  let stopWatchingParent = () => {}
  const gracefulShutdown = async (signal: string) => {
    if (shuttingDown) {
      Log.flush()
      process.exit(1)
    }
    shuttingDown = true
    handle.closeAdmission()
    stopWatchingParent()
    DaemonLogRotate.stop()
    log.info("shutting down", { signal })
    const deadline = setTimeout(() => {
      log.error("runtime cleanup timed out", { signal })
      Log.flush()
      process.exit(1)
    }, handle.shutdownTimeoutMs)
    deadline.unref()
    let exitCode = 0
    try {
      await handle.close()
    } catch (error) {
      exitCode = 1
      log.error("runtime cleanup failed", { error })
    } finally {
      clearTimeout(deadline)
      Log.flush()
    }
    process.exit(exitCode)
  }
  process.on("SIGTERM", () => void gracefulShutdown("SIGTERM"))
  process.on("SIGINT", () => void gracefulShutdown("SIGINT"))
  stopWatchingParent = watchManagedParent({
    expectedParentPid: process.env.SYNERGY_DESKTOP_PARENT_PID,
    onParentExit: () => void gracefulShutdown("desktop-parent-exit"),
  })
}
