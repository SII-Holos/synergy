import { ensureMigrations } from "../migration"
import { Server } from "./server"
import { Installation } from "../global/installation"
import { ScopeContext } from "../scope/context"
import { ScopedState } from "../scope/scoped-state"
import { ScopeRuntime } from "../scope/runtime"
import { Scope } from "../scope"
import { ProcessRegistry } from "../process/registry"
import { Log } from "../util/log"
import * as ChannelTypes from "../channel/types"
import { Provider } from "../provider/provider"
import { DaemonLogRotate } from "../daemon/log-rotate"
import { ServerProcessLock } from "../daemon/server-process-lock"
import { StartupReporter } from "../cli/startup-reporter"
import { Flag } from "../flag/flag"
import { GlobalRuntime } from "./global-runtime"
import { Observability, ObservabilityResources, ObservabilityStore } from "../observability"
import { Session } from "../session"
import { Plugin } from "../plugin"
import { PluginSpec } from "../util/plugin-spec"
import { watchManagedParent } from "./managed-parent"

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
  const migration = await ensureMigrations({
    output: "silent",
    reporter: reporter
      ? {
          summary: (summary) => reporter.migration(summary),
        }
      : undefined,
  })
  reporter?.migration(migration)

  const processLock = await ServerProcessLock.acquire()
  ObservabilityStore.interruptRunningSpans({ reason: "previous_runtime_ended" })
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

  // Holos login: intentionally skipped at CLI startup.
  // Users can log in via Web UI sidebar Holos panel or 'synergy holos login'.
  // We intentionally skip the CLI startup entrypoint for now and keep standalone startup here.
  // try {
  //   await HolosStartup.resolveIdentity(options.interactive)
  // } catch (error) {
  //   log.warn("holos identity resolution failed, launching in standalone mode", {
  //     error: error instanceof Error ? error : new Error(String(error)),
  //     interactive: options.interactive,
  //   })
  // }

  Server.mountApp()
  const server = Server.listen(options.network)
  registerShutdown(server, processLock.release)
  const statuses: StartupReporter.StatusRow[] = []

  await GlobalRuntime.start()
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
  const { HolosRuntime } = await import("../holos/runtime")
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
  const { Bus } = await import("../bus")
  const { Channel } = await import("../channel")

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

function registerShutdown(
  server: { stop: (closeActiveConnections?: boolean) => Promise<void> },
  releaseLock: () => Promise<void>,
) {
  let shuttingDown = false
  let stopWatchingParent = () => {}

  const gracefulShutdown = async (signal: string) => {
    if (shuttingDown) {
      await Observability.emit("shutdown.force_exit", {
        level: "error",
        data: { signal, reason: "duplicate signal" },
      })
      process.exit(1)
      return
    }

    shuttingDown = true
    stopWatchingParent()
    log.info("received signal, shutting down gracefully", { signal })
    await Observability.emit("shutdown.signal", {
      data: {
        signal,
        pid: process.pid,
      },
    })

    let phase = "start"

    const forceExitTimeout = setTimeout(() => {
      void (async () => {
        log.warn("graceful shutdown timed out, forcing exit")
        await Observability.emit("shutdown.force_exit", {
          level: "error",
          data: {
            signal,
            phase,
            reason: "timeout",
          },
        })
        await releaseLock().catch(() => {})
        Log.flush()
        process.exit(1)
      })()
    }, 5000)
    forceExitTimeout.unref()

    try {
      phase = "stop log rotate"
      await Observability.emit("shutdown.phase", { data: { phase } })
      DaemonLogRotate.stop()

      phase = "kill running processes"
      await Observability.emit("shutdown.phase", { data: { phase } })
      await ProcessRegistry.killAllRunning()

      phase = "flush session parts"
      await Observability.emit("shutdown.phase", { data: { phase } })
      await Session.flushPartWrites().catch((error) => {
        log.warn("failed to flush session part writes", { error })
      })

      phase = "stop global runtime"
      await Observability.emit("shutdown.phase", { data: { phase } })
      await GlobalRuntime.stop()

      phase = "dispose scopes"
      await Observability.emit("shutdown.phase", { data: { phase } })
      await ScopeRuntime.disposeAll()

      phase = "server stop"
      await Observability.emit("shutdown.phase", { data: { phase } })
      await server.stop()

      phase = "release lock"
      await Observability.emit("shutdown.phase", { data: { phase } })
      await releaseLock()

      phase = "complete"
      await Observability.emit("server.stop", { data: { signal, pid: process.pid } })
    } catch (error) {
      log.error("error during graceful shutdown", { error })
      await Observability.emit("shutdown.error", {
        level: "error",
        data: {
          signal,
          phase,
          error:
            error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : String(error),
        },
      })
    }

    if (phase !== "complete") {
      try {
        phase = "release lock"
        await Observability.emit("shutdown.phase", { data: { phase, afterError: true } })
        await releaseLock()
      } catch (error) {
        log.error("failed to release server process lock", { error })
        await Observability.emit("shutdown.error", {
          level: "error",
          data: {
            signal,
            phase,
            error:
              error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : String(error),
          },
        })
      }
    }

    ObservabilityStore.interruptRunningSpans({ reason: "runtime_shutdown" })
    ObservabilityResources.stop()
    await Observability.flush().catch((error) => {
      log.warn("failed to flush observability during shutdown", { error })
    })
    ObservabilityStore.close()

    clearTimeout(forceExitTimeout)
    Log.flush()
    process.exit(0)
  }

  process.on("SIGTERM", () => gracefulShutdown("SIGTERM"))
  process.on("SIGINT", () => gracefulShutdown("SIGINT"))
  stopWatchingParent = watchManagedParent({
    expectedParentPid: process.env.SYNERGY_DESKTOP_PARENT_PID,
    onParentExit: () => void gracefulShutdown("desktop-parent-exit"),
  })
}
