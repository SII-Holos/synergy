import { SessionStaging } from "../session/staging"
import { StorageRecovery } from "../storage/recovery"
import { Storage } from "../storage/storage"
import type { ImportProgress } from "../storage/legacy-import"
import { StorageBootstrap } from "../storage/bootstrap"
import { SessionCompat } from "../session/compat-import"
import { StorageRetention } from "../storage/retention"
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
    storage?: Storage.Handle
    mode: "server" | "oneshot"
    network?: RuntimeNetwork | (() => Promise<RuntimeNetwork>)
    services?: RuntimeServices
    reporter?: MigrationReporter
    storageReporter?: (progress: ImportProgress) => void
    migrationOutput?: RunOptions["output"]
    recoveryReporter?: { progress(current: number): void; completed(): void }
  }) {
    const services = options.services ?? {}
    const ownership = await ServerProcessLock.acquire(undefined, options.mode === "oneshot" ? "oneshot" : undefined)
    let storage: StorageBootstrap.Prepared | undefined
    let uninstallStorage: (() => void) | undefined
    let server: RuntimeServer | undefined
    let residentStarted = false
    let stopCompat: (() => Promise<void>) | undefined
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
        await cleanup(() => StorageRetention.stop())
        await cleanup(() => stopCompat?.())
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
        // A turn that already released its lease is absent from the runtime
        // snapshot, so its detached work must be canceled globally rather
        // than per still-active session.
        await cleanup(() => LoopJob.cancelDetachedAll())
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
        await cleanup(async () => {
          // Re-arm only after execution and transport have both stopped;
          // any cleanup failure keeps owners listed for startup recovery.
          if (errors.length === 0) await RolloutRecovery.settle()
        })
        ObservabilityStore.interruptRunningSpans({ reason: "runtime_shutdown" })
        ObservabilityResources.stop()
        await cleanup(() => Observability.flush())
        await cleanup(() => ObservabilityStore.close())
        await cleanup(() => storage?.store.close())
        uninstallStorage?.()
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
      if (options.storage) uninstallStorage = Storage.install(options.storage)
      else {
        storage = await StorageBootstrap.prepare({ root: Global.Path.root, progress: options.storageReporter })
        uninstallStorage = Storage.install({ store: storage.store, artifactDirectory: Global.Path.data })
      }
      await SessionStaging.recover()
      const migration = await ensureMigrations({
        output: options.migrationOutput ?? "silent",
        reporter: options.reporter,
      })
      await SessionCompat.prepareRecovery()
      if (storage && storage.manifest.phase !== "active")
        await StorageRecovery.validate((current, timeoutMs) =>
          options.storageReporter?.(
            timeoutMs === undefined
              ? { stage: "validate", current, total: 0, bytes: 0 }
              : { stage: "validate-engine", current: 0, total: 0, bytes: 0, timeoutMs },
          ),
        )
      await storage?.activate()
      await StorageRecovery.recoverOwners()
      await StorageRecovery.load()
      await StorageRecovery.reconcileNotifications()
      if (await SessionCompat.isActive()) stopCompat = SessionCompat.startBackgroundMigrator()
      options.storageReporter?.({ stage: "complete", current: 0, total: 0, bytes: 0 })
      const resolved = await ScopeContext.provide({ scope: Scope.home(), fn: () => Config.resolveExecution() })
      const requested = Experiment.applyRuntime(resolved, options.experiment?.runtime ?? {})
      const shutdownTimeoutMs = configureExecution(requested, options.mode)
      const config = resolveExecutionConfiguration(requested, options.mode)
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
      StorageRetention.schedule({
        current: () => ({
          retentionMs: ObservabilityConfig.current().storage.retentionMs,
          maxBytes: ObservabilityConfig.current().storage.maxSqliteBytes,
        }),
        liveSessionIDs: () => SessionManager.liveSessionIDs(),
      })
      if (options.mode === "server") {
        // First-message latency: warm the execution pools and tokenizer while
        // transport and resident services initialize, so the first turn or
        // classification finds a ready worker instead of paying cold start.
        AgentTurn.prewarm()
        PolicyWorker.prewarm()
        void ScopeContext.provide({
          scope: Scope.home(),
          fn: async () => {
            const [{ Provider }, { Token }] = await Promise.all([
              import("../provider/provider"),
              import("../util/token"),
            ])
            await Token.warmup((await Provider.defaultModel()).modelID)
          },
        }).catch(() => undefined)
      }
      services.reload?.start()
      ObservabilityStore.interruptRunningSpans({ reason: "previous_runtime_ended" })
      await ScopeContext.provide({
        scope: Scope.home(),
        fn: async () => {
          await services.initializeExtensions?.()
        },
      })
      if (services.transport) {
        const network = (typeof options.network === "function" ? await options.network() : options.network) ?? {
          hostname: "127.0.0.1",
          port: 0,
        }
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
