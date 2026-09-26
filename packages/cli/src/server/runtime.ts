import { RuntimeContext } from "@ericsanchezok/synergy-harness/lifecycle/context"
import { RuntimeHandle } from "@ericsanchezok/synergy-harness/lifecycle"
import { RuntimeComponents } from "@ericsanchezok/synergy-harness/lifecycle"
import { runtimeReadyLine } from "@ericsanchezok/synergy-sdk/runtime-ready"
import type { LocalRuntimeOptions } from "@ericsanchezok/synergy-local-runtime"
import { DEFAULT_SERVER_PORT } from "@ericsanchezok/synergy-harness/util/server-defaults"
import { Installation } from "@ericsanchezok/synergy-harness/global/installation"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { Scope } from "@ericsanchezok/synergy-harness/scope"
import { Config } from "@ericsanchezok/synergy-harness/config/config"
import { Log } from "@ericsanchezok/synergy-harness/util/log"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { Provider } from "@ericsanchezok/synergy-harness/provider/provider"
import { DaemonLogRotate } from "@ericsanchezok/synergy-cli/daemon/log-rotate"
import { StartupReporter } from "@ericsanchezok/synergy-cli/cli/startup-reporter"
import { Flag } from "@ericsanchezok/synergy-harness/flag/flag"
import { Observability } from "@ericsanchezok/synergy-harness/observability"
import { watchManagedParent } from "@ericsanchezok/synergy-harness/util/managed-parent"

const log = Log.create({ service: "server-runtime" })

type Network = import("@ericsanchezok/synergy-harness/lifecycle").RuntimeNetwork

export interface RuntimeOptions {
  managedReady?: boolean
  logging?: Log.Options
  storageReporter?: LocalRuntimeOptions["storageReporter"]
  maintenanceReporter?: LocalRuntimeOptions["maintenanceReporter"]
  migrationReporter?: LocalRuntimeOptions["reporter"]
  migrationOutput?: LocalRuntimeOptions["migrationOutput"]
  recoveryReporter?: LocalRuntimeOptions["recoveryReporter"]
  interactive: boolean
  printBanner: boolean
  printChannelStatus: boolean
  runtimeFactory: (options: LocalRuntimeOptions) => Promise<RuntimeHandle.Handle>
  status?: (printUpdates: boolean) => Promise<StartupReporter.StatusRow[]>
  network: Network | (() => Promise<Network>)
}
export async function run(options: RuntimeOptions) {
  if (options.managedReady) {
    if (!process.env.SYNERGY_SERVER_TOKEN) throw new Error("Managed runtime credentials are required")
    if (process.env.SYNERGY_EXPECT_VERSION && process.env.SYNERGY_EXPECT_VERSION !== Installation.VERSION)
      throw new Error("Managed runtime version does not match the requested host")
  }
  let network: Network = { hostname: "127.0.0.1", port: 0 }
  const reporter = options.printBanner ? StartupReporter.create() : undefined
  await using handle = await options.runtimeFactory({
    mode: "server",
    logging: options.logging,
    network: async () => {
      network = typeof options.network === "function" ? await options.network() : options.network
      return network
    },
    reporter:
      options.migrationReporter ?? (reporter ? { summary: (summary) => reporter.migration(summary) } : undefined),
    migrationOutput: options.migrationOutput,
    recoveryReporter: options.recoveryReporter,
    storageReporter: options.storageReporter,
    maintenanceReporter: options.maintenanceReporter,
  })
  return await handle.run(async () => {
    const server = handle.server
    if (!server) throw new Error("The selected runtime has no HTTP transport")
    reporter?.migration(handle.migration)
    registerShutdown(handle)
    if (options.managedReady) {
      const host = RuntimeContext.current().host
      process.stdout.write(
        runtimeReadyLine({
          protocol: 1,
          pid: process.pid,
          version: Installation.VERSION,
          home: host.root,
          url: displayUrl(server.hostname ?? network.hostname, server.port ?? network.port),
          components: RuntimeComponents.selected(),
        }),
      )
    }
    await Observability.cleanup().catch(() => {})
    await Observability.emit("server.start", {
      data: {
        pid: process.pid,
        cwd: process.cwd(),
        launchCwd: startupScopeLabel(),
        mode: process.env.SYNERGY_DAEMON === "1" ? "daemon" : "server",
        network,
      },
    })

    const statuses = (await options.status?.(options.printChannelStatus)) ?? []

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
      renderBanner({ server, network, reporter: reporter ?? StartupReporter.create(), statuses })
    }

    if (process.env.SYNERGY_DAEMON === "1") {
      DaemonLogRotate.start()
    }

    await new Promise(() => {})
  })
}

function renderBanner(input: {
  server: { hostname?: string; port?: number }
  network: Network
  reporter: StartupReporter.Reporter
  statuses: StartupReporter.StatusRow[]
}) {
  const hostname = input.server.hostname || input.network.hostname || "localhost"
  const port = input.server.port || DEFAULT_SERVER_PORT
  const url = displayUrl(hostname, port)
  const bind = `${hostname}:${port}`
  const portExplicitlySet = process.argv.includes("--port")
  const fellBackToRandom = !portExplicitlySet && port !== DEFAULT_SERVER_PORT
  const attach = port === DEFAULT_SERVER_PORT ? "" : " --attach " + url
  if (fellBackToRandom) {
    input.reporter.warning(`Port ${DEFAULT_SERVER_PORT} is busy; using ${port}.`)
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

async function hasNoModelConfigured() {
  try {
    const providers = await Provider.list()
    return Object.keys(providers).length === 0
  } catch {
    return false
  }
}

function displayUrl(hostname: string, port: number) {
  const displayHost = hostname === "0.0.0.0" ? "localhost" : hostname === "::" ? "::1" : hostname
  const url = new URL("http://localhost")
  url.hostname = displayHost
  url.port = String(port)
  return url.toString().replace(/\/$/, "")
}

function registerShutdown(handle: RuntimeHandle.Handle) {
  let shuttingDown = false
  let stopWatchingParent = () => {}
  // A store that failed terminally cannot be repaired in place, so the process
  // must not keep serving HTTP over it. Escalate through the same graceful
  // shutdown used for signals, exactly once, and exit non-zero so a supervisor
  // (systemd Restart=on-failure, launchd KeepAlive, the Desktop manager) restarts.
  let stopWatchingStorage = () => {}
  let escalated = false
  const owner = RuntimeContext.current()
  const gracefulShutdown = owner.bind(async (signal: string, exitCode: number = 0) => {
    if (shuttingDown) {
      Log.flush()
      process.exit(1)
    }
    shuttingDown = true
    handle.closeAdmission()
    stopWatchingParent()
    stopWatchingStorage()
    DaemonLogRotate.stop()
    log.info("shutting down", { signal })
    const deadline = setTimeout(() => {
      log.error("runtime cleanup timed out", { signal })
      Log.flush()
      process.exit(1)
    }, handle.shutdownTimeoutMs)
    deadline.unref()
    let code = exitCode
    try {
      await handle.close()
    } catch (error) {
      code = 1
      console.error("Runtime cleanup failed", error)
    } finally {
      clearTimeout(deadline)
    }
    process.exit(code)
  })
  process.on("SIGTERM", () => void gracefulShutdown("SIGTERM"))
  process.on("SIGINT", () => void gracefulShutdown("SIGINT"))
  stopWatchingStorage = Storage.onUnavailable((error) => {
    if (escalated) return
    escalated = true
    log.error("authoritative storage is unavailable", { error })
    void gracefulShutdown("storage-unavailable", 1)
  })
  stopWatchingParent = watchManagedParent({
    expectedParentPid: process.env.SYNERGY_DESKTOP_PARENT_PID,
    onParentExit: () => void gracefulShutdown("desktop-parent-exit"),
  })
}
