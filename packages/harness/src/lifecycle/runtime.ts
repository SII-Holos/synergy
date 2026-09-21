import { observeStorageMaintenance } from "../storage/maintenance-progress"
import type { StorageMaintenanceEvent } from "@ericsanchezok/synergy-util/runtime-startup"
import { registerHarness } from "./register"
import { ProviderCatalog } from "../provider/catalog"
import { ModelsCatalog, startModelCatalogRefresh } from "../provider/models"
import { RuntimeContext, type RuntimeHost } from "./context"
import { SessionStaging } from "../session/staging"
import { StorageRecovery } from "../storage/recovery"
import { Storage } from "../storage/storage"
import type { ImportProgress } from "../storage/legacy-import"
import { SessionCompat } from "../session/compat-import"
import { StorageRetention } from "../storage/retention"
import { StorageReclamation } from "../storage/format-reclamation"
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
import { ToolResolver } from "../session/tool-resolver"
import { ToolScheduler } from "../session/tool-scheduler"
import {
  Observability,
  ObservabilityResources,
  ObservabilityStore,
  ObservabilityMetrics,
  ObservabilityWriter,
} from "../observability/index"
import { configureRuntimeEndpoint } from "../util/runtime-endpoint"
import { configureExecution, resolveExecutionConfiguration } from "../execution/execution-config"
import { Log } from "../util/log"
import { Bus } from "../bus"
import { GlobalBus } from "../bus/global"
import { SecretVault } from "../secrets/vault"

const log = Log.create({ service: "runtime" })

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

export interface RuntimeComposition {
  register(): void
  services?(): RuntimeServices
}

export type RuntimeStorage =
  | { kind: "owned"; open(): Promise<{ handle: Storage.Handle; activate(): Promise<void>; needsValidation: boolean }> }
  | { kind: "borrowed"; handle: Storage.Handle }

const storageOwners = new WeakSet<Storage.Handle["store"]>()

export namespace RuntimeHandle {
  export type Handle = Awaited<ReturnType<typeof open>>

  export interface OpenOptions {
    experiment?: Experiment.File
    host: RuntimeHost
    composition: RuntimeComposition
    storage: RuntimeStorage
    signal?: AbortSignal
    logging?: Log.Options
    mode: "server" | "oneshot"
    network?: RuntimeNetwork | (() => Promise<RuntimeNetwork>)
    reporter?: MigrationReporter
    storageReporter?: (progress: ImportProgress) => void
    maintenanceReporter?: (event: StorageMaintenanceEvent) => void
    migrationOutput?: RunOptions["output"]
    recoveryReporter?: { progress(current: number): void; completed(): void }
  }

  export async function open(options: OpenOptions) {
    const instance = RuntimeContext.create(options.host)
    return instance.run(async () => {
      let runtime: Awaited<ReturnType<typeof openRuntime>> | undefined
      try {
        return await observeStorageMaintenance(
          async () => (runtime = await openRuntime(options, instance)),
          (event) => {
            log.info("storage maintenance", event)
            options.maintenanceReporter?.(event)
          },
        )
      } catch (error) {
        await runtime?.close().catch(() => {})
        throw error
      }
    })
  }

  async function openRuntime(options: OpenOptions, instance: RuntimeContext.Instance) {
    let services: RuntimeServices = {}
    let phase: "opening" | "ready" | "closing" | "closed" = "opening"
    let ownership: Awaited<ReturnType<typeof ServerProcessLock.acquire>> | undefined
    let storage: Awaited<ReturnType<Extract<RuntimeStorage, { kind: "owned" }>["open"]>> | undefined
    let attached = false
    let server: RuntimeServer | undefined
    let residentStarted = false
    let stopCompat: (() => Promise<void>) | undefined
    let stopReclamation: (() => Promise<void>) | undefined
    let stopVaultSync: (() => void) | undefined
    let vaultSync = Promise.resolve()
    let closing: Promise<void> | undefined
    const shutdown = new AbortController()
    const stopBackground: Array<() => void> = []

    function closeAdmission() {
      SessionManager.closeAdmission()
      AgentTurn.closeAdmission()
      PolicyWorker.closeAdmission()
      ToolScheduler.closeAdmission()
      if (server) services.transport?.closeAdmission()
    }

    function close() {
      shutdown.abort(new Error("Runtime is closing"))
      phase = phase === "closed" ? "closed" : "closing"
      closing ??= (async () => {
        const errors: unknown[] = []
        async function cleanup(action: () => unknown) {
          try {
            await action()
          } catch (error) {
            errors.push(error)
          }
        }
        await cleanup(closeAdmission)
        if (!attached) {
          await cleanup(() => Log.close())
          await cleanup(() => storage?.handle.store.close())
          await cleanup(() => ownership?.release())
          phase = "closed"
          instance.dispose()
          if (errors.length) throw new AggregateError(errors, "Synergy runtime cleanup failed")
          return
        }
        for (const stop of stopBackground) await cleanup(stop)
        await cleanup(() => StorageRetention.stop())
        await cleanup(() => stopReclamation?.())
        await cleanup(() => stopCompat?.())
        await cleanup(async () => {
          stopVaultSync?.()
          await vaultSync
        })
        await cleanup(() => services.reload?.stop())
        await cleanup(closeAdmission)
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
              // Shutdown is an interruption, not the user asking this session
              // to hold still: the reason distinguishes "the host went away"
              // from "I pressed stop" on the paused session after restart.
              ScopeContext.provide({
                scope: session.scope,
                fn: () => SessionAbort.abort(session.id, { pauseReason: "interrupted" }),
              }),
            ),
          )
          for (const result of results) if (result.status === "rejected") errors.push(result.reason)
        })
        await cleanup(() => ProcessRegistry.stop())
        await cleanup(() => SessionManager.drain())
        await cleanup(() => SessionCortexRuntime.stop())
        for (const session of sessions) {
          await cleanup(() => LoopJob.drain(session.id))
        }
        // A turn that already released its lease is absent from the runtime
        // snapshot, so its detached work must be canceled globally rather
        // than per still-active session.
        await cleanup(() => LoopJob.cancelDetachedAll())
        for (const stop of [() => AgentTurn.stop(), () => PolicyWorker.stop(), () => ToolScheduler.stop()])
          await cleanup(stop)
        await cleanup(() => ToolResolver.stop())
        await cleanup(() => LoopJob.drainAll())
        await cleanup(() => Session.flushPartWrites())
        await cleanup(async () => {
          await server?.stop(true)
          configureRuntimeEndpoint(undefined)
        })
        await cleanup(() => ModelsCatalog.stop())
        await cleanup(() => ProviderCatalog.stop())
        await cleanup(() => ScopeRuntime.stop())
        await cleanup(() => services.disposeExtensions?.())
        await cleanup(() => SessionCompat.drain())
        await cleanup(() => ObservabilityStore.interruptRunningSpans({ reason: "runtime_shutdown" }))
        await cleanup(() => ObservabilityResources.stop())
        await cleanup(() => Observability.flush())
        await cleanup(() => ObservabilityWriter.stop())
        await cleanup(() => ObservabilityMetrics.stop())
        await cleanup(() => ObservabilityStore.stop())
        await cleanup(() => GlobalBus().removeAllListeners())
        await cleanup(() => Log.close())
        await cleanup(async () => {
          if (errors.length === 0) await RolloutRecovery.settle()
        })
        await cleanup(() => storage?.handle.store.close())
        if (attached && instance.storage) storageOwners.delete(instance.storage.store)
        instance.storage = undefined
        await cleanup(() => ownership?.release())
        phase = "closed"
        instance.dispose()
        if (errors.length) throw new AggregateError(errors, "Synergy runtime cleanup failed")
      })()
      return closing
    }

    try {
      options.signal?.throwIfAborted()
      registerHarness()
      options.composition.register()
      ScopeStartup.plan()
      services = options.composition.services?.() ?? {}
      ownership = await ServerProcessLock.acquire(undefined, options.mode === "oneshot" ? "oneshot" : undefined)
      RuntimeContext.sealComposition()
      MigrationRegistry.lock()
      ConfigExtensions.lock()
      await Global.initialize({ configSchemaPath: services.configSchemaPath })
      await Log.init(options.logging ?? { print: false })
      options.signal?.throwIfAborted()
      if (options.storage.kind === "owned") storage = await options.storage.open()
      const handle = options.storage.kind === "borrowed" ? options.storage.handle : storage!.handle
      if (storageOwners.has(handle.store)) {
        storage = undefined
        throw new Error("Another Runtime already owns this storage Handle")
      }
      storageOwners.add(handle.store)
      attached = true
      instance.storage = handle
      options.signal?.throwIfAborted()
      await SessionStaging.recover()
      const migration = await ensureMigrations({
        output: options.migrationOutput ?? "silent",
        reporter: options.reporter,
      })
      await SessionCompat.prepareRecovery((current, total) =>
        options.storageReporter?.({ stage: "owners", current, total, bytes: 0 }),
      )
      if (storage?.needsValidation)
        await StorageRecovery.validate((current) =>
          options.storageReporter?.({ stage: "validate", current, total: 0, bytes: 0 }),
        )
      await storage?.activate()
      await StorageRecovery.recoverOwners()
      await StorageRecovery.load()
      await StorageRecovery.reconcileNotifications()
      options.storageReporter?.({ stage: "complete", current: 0, total: 0, bytes: 0 })
      options.signal?.throwIfAborted()
      const resolved = await ScopeContext.provide({ scope: Scope.home(), fn: () => Config.resolveExecution() })
      const requested = Experiment.applyRuntime(resolved, options.experiment?.runtime ?? {})
      const shutdownTimeoutMs = configureExecution(requested, options.mode)
      const config = resolveExecutionConfiguration(requested, options.mode)
      Experiment.configureRuntime(config, options.experiment?.runtime)
      ScopeStartup.configure(options.mode)
      // Secret vault sync: register secret-shaped config values on startup
      // and on every config reload; registration is idempotent by id.
      await ScopeContext.provide({ scope: Scope.home(), fn: () => SecretVault.syncFromConfig(config) }).catch((error) =>
        log?.warn?.("secret vault config sync failed", { error: String(error) }),
      )
      stopVaultSync = Bus.subscribeGlobal(Config.Event.Updated, () => {
        const scope = ScopeContext.current.scope
        vaultSync = vaultSync
          .then(() =>
            ScopeContext.provide({
              scope,
              fn: async () => {
                const current = await Config.current()
                await SecretVault.syncFromConfig(current)
              },
            }),
          )
          .catch(() => log.warn("secret vault config sync failed"))
      })
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
          maxBytes: ObservabilityConfig.current().storage.retentionBytes,
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
      options.signal?.throwIfAborted()
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
      if (await SessionCompat.isActive())
        stopCompat = SessionCompat.startBackgroundMigrator({
          busy: () => SessionManager.runtimeStats().runningCount > 0,
        })
      if (options.mode === "server")
        stopReclamation = StorageReclamation.start(Storage.current().store, {
          busy: () => SessionManager.activeRuntimeCount() > 0 || LoopJob.activeBackgroundCount() > 0,
        })
      options.signal?.throwIfAborted()
      stopBackground.push(SessionManager.startIdleSweep())
      stopBackground.push(await ProviderCatalog.subscribeModelCatalog())
      if (options.mode === "server") stopBackground.push(startModelCatalogRefresh())
      phase = "ready"
      const boundClose = () => closing ?? instance.run(close)
      return {
        server,
        migration,
        config,
        shutdownTimeoutMs,
        signal: shutdown.signal,
        get status() {
          return phase
        },
        run<T>(body: () => T): T {
          if (phase !== "ready") throw new Error(`Runtime is ${phase}`)
          return instance.run(body)
        },
        bind<A extends unknown[], R>(body: (...args: A) => R) {
          return (...args: A) => {
            if (phase !== "ready") throw new Error(`Runtime is ${phase}`)
            return instance.run(() => body(...args))
          }
        },
        closeAdmission: instance.bind(closeAdmission),
        close: boundClose,
        [Symbol.asyncDispose]: boundClose,
      }
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
