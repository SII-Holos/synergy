import "../product-registration"
import { ensureMigrations, type MigrationReporter, type RunOptions } from "@/migration"
import { ServerProcessLock } from "@/util/server-process-lock"
import { Scope } from "@/scope"
import { ScopeContext } from "@/scope/context"
import { ScopeRuntime } from "@/scope/runtime"
import { ScopeStartup } from "@/scope/startup"
import { Config } from "@/config/config"
import { RuntimeReload } from "@/runtime/reload"
import { ObservabilityConfig } from "@/observability/config"
import { Global } from "@/global"
import { Experiment } from "@/config/experiment"
import { Plugin } from "@/plugin"
import { Session } from "@/session"
import { SessionManager } from "@/session/manager"
import { SessionCortexRuntime } from "@/session/cortex-runtime"
import { SessionAbort } from "@/session/abort"
import { LoopJob } from "@/session/loop-job"
import { ActivitySummary } from "@/session/activity-summary"
import { RolloutRecovery } from "@/session/rollout/recovery"
import { ProcessRegistry } from "@/process/registry"
import { AgentTurn } from "@/session/agent-turn"
import { PolicyWorker } from "@/enforcement/policy-worker"
import { ToolScheduler } from "@/session/tool-scheduler"
import { MCP } from "@/mcp"
import { Embedding } from "@/vector/embedding"
import { Observability, ObservabilityResources, ObservabilityStore } from "@/observability"
import { configureRuntimeEndpoint } from "@/util/runtime-endpoint"
import { Server } from "./server"
import { GlobalRuntime } from "./global-runtime"
import { configureExecution, resolveExecutionConfiguration } from "./execution-config"

export namespace RuntimeHandle {
  export type Handle = Awaited<ReturnType<typeof open>>

  export async function open(options: {
    experiment?: Experiment.File
    mode: "server" | "oneshot"
    network: Parameters<typeof Server.listen>[0]
    reporter?: MigrationReporter
    migrationOutput?: RunOptions["output"]
  }) {
    const ownership = await ServerProcessLock.acquire(undefined, options.mode === "oneshot" ? "oneshot" : undefined)
    let server: ReturnType<typeof Server.listen> | undefined
    let residentStarted = false
    let closing: Promise<void> | undefined

    function closeAdmission() {
      SessionManager.closeAdmission()
      AgentTurn.closeAdmission()
      PolicyWorker.closeAdmission()
      ToolScheduler.closeAdmission()
      if (server) Server.beginShutdown()
    }

    function close() {
      closing ??= (async () => {
        closeAdmission()
        const errors: unknown[] = []
        async function cleanup(action: () => Promise<unknown> | void) {
          try {
            await action()
          } catch (error) {
            errors.push(error)
          }
        }
        await cleanup(() => RuntimeReload.stopAutoReload())
        closeAdmission()
        if (residentStarted) await cleanup(() => GlobalRuntime.stop())
        const resolved = await Promise.allSettled(
          SessionManager.listRunningRuntimes().map((runtime) => Session.get(runtime.sessionID)),
        )
        const sessions: Session.Info[] = []
        for (const result of resolved) {
          if (result.status === "fulfilled") sessions.push(result.value)
          else errors.push(result.reason)
        }
        await cleanup(async () => {
          const results = await Promise.allSettled(
            sessions.map((session) =>
              ScopeContext.provide({ scope: session.scope, fn: () => SessionAbort.abort(session.id) }),
            ),
          )
          for (const result of results) if (result.status === "rejected") errors.push(result.reason)
        })
        await cleanup(() => ProcessRegistry.killAllRunning())
        await cleanup(() => SessionManager.drain())
        await cleanup(() => SessionCortexRuntime.drain())
        for (const session of sessions) {
          await cleanup(() => LoopJob.drain(session.id))
          await cleanup(() =>
            ScopeContext.provide({
              scope: session.scope,
              fn: () => ActivitySummary.drain(session.id, AbortSignal.abort()),
            }),
          )
        }
        for (const stop of [() => AgentTurn.stop(), () => PolicyWorker.stop(), () => ToolScheduler.stop()])
          await cleanup(stop)
        await cleanup(() => Session.flushPartWrites())
        await cleanup(() => MCP.stop())
        await cleanup(() => Embedding.dispose())
        await cleanup(() => ScopeRuntime.disposeAll())
        await cleanup(async () => {
          await server?.stop(true)
          configureRuntimeEndpoint(undefined)
        })
        ObservabilityStore.interruptRunningSpans({ reason: "runtime_shutdown" })
        ObservabilityResources.stop()
        await cleanup(() => Observability.flush())
        await cleanup(() => ObservabilityStore.close())
        await cleanup(() => ownership.release())
        ScopeStartup.configure("server")
        Experiment.configureRuntime()
        if (errors.length) throw new AggregateError(errors, "Synergy runtime cleanup failed")
      })()
      return closing
    }

    try {
      await Global.initialize()
      const migration = await ensureMigrations({
        output: options.migrationOutput ?? "silent",
        reporter: options.reporter,
      })
      const resolved = await ScopeContext.provide({ scope: Scope.home(), fn: () => Config.resolveExecution() })
      const requested = Experiment.applyRuntime(resolved, options.experiment?.runtime ?? {})
      const shutdownTimeoutMs = configureExecution(requested)
      const config = resolveExecutionConfiguration(requested)
      Experiment.configureRuntime(config, options.experiment?.runtime)
      ScopeStartup.configure(options.mode)
      SessionManager.openAdmission()
      await RolloutRecovery.all()
      ObservabilityStore.releaseMigrationConnection()
      ObservabilityStore.markRuntimeReady()
      ObservabilityConfig.refresh(config)
      ObservabilityStore.open()
      ObservabilityResources.start()
      RuntimeReload.startAutoReload()
      ObservabilityStore.interruptRunningSpans({ reason: "previous_runtime_ended" })
      await ScopeContext.provide({
        scope: Scope.home(),
        fn: async () => {
          await Plugin.init()
          ActivitySummary.init()
        },
      })
      if (options.mode === "server") Server.mountApp()
      Server.resumeRequests()
      server = Server.listen({ ...options.network, preferDefaultPort: options.mode === "server" })
      configureRuntimeEndpoint({
        hostname: server.hostname ?? options.network.hostname,
        port: server.port ?? options.network.port,
      })
      if (options.mode === "server") {
        residentStarted = true
        await GlobalRuntime.start(config)
      }
      return { server, migration, config, shutdownTimeoutMs, closeAdmission, close, [Symbol.asyncDispose]: close }
    } catch (error) {
      try {
        await close()
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], "Synergy runtime startup failed")
      }
      throw error
    }
  }
}
