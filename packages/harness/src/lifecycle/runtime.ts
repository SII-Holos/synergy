import { ConfigExtensions } from "../config/extensions"
import { MigrationRegistry } from "../migration/registry"
import { ensureMigrations, type MigrationReporter, type RunOptions } from "../migration/index"
import { ServerProcessLock } from "../util/server-process-lock"
import { Scope } from "../scope/index"
import { ScopeContext } from "../scope/context"
import { ScopeRuntime } from "../scope/runtime"
import { ScopeStartup } from "../scope/startup"
import { Config } from "../config/config"
import { ObservabilityConfig } from "../observability/config"
import { Global } from "../global/index"
import { Experiment } from "../config/experiment"
import { Session } from "../session/index"
import { SessionManager } from "../session/manager"
import { SessionCortexRuntime } from "../session/cortex-runtime"
import { SessionAbort } from "../session/abort"
import { LoopJob } from "../session/loop-job"
import { RolloutRecovery } from "../session/rollout/recovery"
import { ProcessRegistry } from "../process/registry"
import { AgentTurn } from "../session/agent-turn/index"
import { PolicyWorker } from "../enforcement/policy-worker/index"
import { ToolScheduler } from "../session/tool-scheduler"
import { Observability, ObservabilityResources, ObservabilityStore } from "../observability/index"
import { configureRuntimeEndpoint } from "../util/runtime-endpoint"
import { configureExecution, resolveExecutionConfiguration } from "../execution/execution-config"

export interface RuntimeNetwork {
  hostname: string
  port: number
  mdns?: boolean
  cors?: string[]
}

export interface RuntimeServer {
  hostname?: string
  port?: number
  stop(closeActiveConnections?: boolean): Promise<unknown> | void
}

export interface RuntimeServices {
  configSchemaPath?: string
  reload?: { start(): void; stop(): Promise<unknown> | void }
  initializeExtensions?(): Promise<void>
  disposeExtensions?(): Promise<void>
  resident?: { start(config: Config.Info): Promise<void>; stop(): Promise<void> }
  transport?: {
    listen(network: RuntimeNetwork, mode: "server" | "oneshot"): RuntimeServer
    closeAdmission(): void
  }
}

export namespace RuntimeHandle {
  export type Handle = Awaited<ReturnType<typeof open>>

  export async function open(options: {
    experiment?: Experiment.File
    mode: "server" | "oneshot"
    network?: RuntimeNetwork
    services?: RuntimeServices
    reporter?: MigrationReporter
    migrationOutput?: RunOptions["output"]
    recoveryReporter?: { progress(current: number): void; completed(): void }
  }) {
    const services = options.services ?? {}
    const ownership = await ServerProcessLock.acquire(undefined, options.mode === "oneshot" ? "oneshot" : undefined)
    let server: RuntimeServer | undefined
    let residentStarted = false
    let closing: Promise<void> | undefined

    function closeAdmission() {
      SessionManager.closeAdmission()
      AgentTurn.closeAdmission()
      PolicyWorker.closeAdmission()
      ToolScheduler.closeAdmission()
      if (server) services.transport?.closeAdmission()
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
        await cleanup(() => services.reload?.stop())
        closeAdmission()
        if (residentStarted) await cleanup(() => services.resident?.stop())
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
        }
        for (const session of sessions) {
          await cleanup(() => LoopJob.cancelDetached(session.id))
        }
        for (const stop of [() => AgentTurn.stop(), () => PolicyWorker.stop(), () => ToolScheduler.stop()])
          await cleanup(stop)
        await cleanup(() => LoopJob.drainAll())
        await cleanup(() => Session.flushPartWrites())
        await cleanup(() => services.disposeExtensions?.())
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
      MigrationRegistry.lock()
      ConfigExtensions.lock()
      await Global.initialize({ configSchemaPath: options.services?.configSchemaPath })
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
      await RolloutRecovery.all((current) => options.recoveryReporter?.progress(current))
      options.recoveryReporter?.completed()
      ObservabilityStore.releaseMigrationConnection()
      ObservabilityStore.markRuntimeReady()
      ObservabilityConfig.refresh(config)
      ObservabilityStore.open()
      ObservabilityResources.start()
      services.reload?.start()
      ObservabilityStore.interruptRunningSpans({ reason: "previous_runtime_ended" })
      await ScopeContext.provide({
        scope: Scope.home(),
        fn: async () => {
          await services.initializeExtensions?.()
        },
      })
      if (services.transport) {
        const network = options.network ?? { hostname: "127.0.0.1", port: 0 }
        server = services.transport.listen(network, options.mode)
        configureRuntimeEndpoint({ hostname: server.hostname ?? network.hostname, port: server.port ?? network.port })
      }
      if (options.mode === "server" && services.resident) {
        residentStarted = true
        await services.resident.start(config)
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
