import { BusEvent } from "@/bus/bus-event"
import { Bus } from "@/bus"
import { GlobalBus } from "@/bus/global"
import z from "zod"
import { ScopeContext } from "../scope/context"
import { ScopedState } from "../scope/scoped-state"
import { Log } from "../util/log"
import { Config } from "../config/config"
import { Global } from "../global"
import path from "path"
// @ts-ignore
import { createWrapper } from "@parcel/watcher/wrapper"
import { lazy } from "@/util/lazy"
import { withTimeout } from "@/util/timeout"
import type ParcelWatcher from "@parcel/watcher"
import { $ } from "bun"
import { Flag } from "@/flag/flag"
import { readdir } from "fs/promises"

import { existsSync } from "fs"
import { WorkspaceFileIndexer } from "../workspace-file/indexer"
import { WorkspaceFileService } from "../workspace-file/service"
import { WorkspaceFileStatus } from "../workspace-file/status"
import { FileWatcherEvents } from "./watcher-events"
import { FileWatcherBinding } from "./watcher-binding"

export namespace FileWatcher {
  const log = Log.create({ service: "file.watcher" })
  type WorkspaceFileEvent = FileWatcherEvents.WorkspaceEvent

  export const Event = {
    Updated: BusEvent.define(
      "file.watcher.updated",
      z.object({
        file: z.string(),
        event: z.enum(["added", "changed", "deleted", "renamed"]),
        absolute: z.string().optional(),
        oldPath: z.string().optional(),
        oldAbsolute: z.string().optional(),
        parent: z.string().optional(),
        node: z.any().optional(),
        resync: z.boolean().optional(),
      }),
    ),
  }

  function indexerEvent(event: Exclude<WorkspaceFileEvent, "renamed">): "add" | "change" | "unlink" {
    if (event === "added") return "add"
    if (event === "deleted") return "unlink"
    return "change"
  }

  function workspaceRelative(file: string) {
    try {
      return WorkspaceFileService.relative(file)
    } catch (error) {
      if (error instanceof WorkspaceFileService.AccessDeniedError && path.basename(file) === "HEAD") return ".git/HEAD"
      throw error
    }
  }

  async function publishWorkspaceBatch(batch: FileWatcherEvents.WorkspaceChange[]) {
    const changes = batch.map((item) => ({
      ...item,
      relative: workspaceRelative(item.path),
      oldRelative: item.oldPath ? workspaceRelative(item.oldPath) : undefined,
    }))
    WorkspaceFileStatus.invalidate()
    const indexChanges = changes.flatMap((item) => {
      if (item.relative.startsWith(".git/")) return []
      if (item.event === "renamed") {
        return [
          ...(item.oldRelative ? [{ path: item.oldRelative, event: "unlink" as const }] : []),
          { path: item.relative, event: "add" as const },
        ]
      }
      return [{ path: item.relative, event: indexerEvent(item.event) }]
    })
    const nodes = await WorkspaceFileIndexer.applyChanges(indexChanges).catch((error) => {
      log.warn("failed to apply workspace file batch", { count: batch.length, error: String(error) })
      WorkspaceFileIndexer.invalidate()
      return new Map()
    })

    for (const item of changes) {
      await Bus.publish(Event.Updated, {
        file: item.relative,
        event: item.event,
        absolute: item.path,
        oldPath: item.oldRelative,
        oldAbsolute: item.oldPath,
        parent: path.dirname(item.relative) === "." ? "" : path.dirname(item.relative),
        node: nodes.get(item.relative),
      })
    }
  }

  async function publishWorkspaceResync() {
    WorkspaceFileIndexer.invalidate()
    WorkspaceFileStatus.invalidate()
    await Bus.publish(Event.Updated, {
      file: "",
      event: "changed",
      parent: "",
      resync: true,
    })
  }

  const watcher = lazy(() => {
    const binding = FileWatcherBinding.load()
    return createWrapper(binding) as typeof import("@parcel/watcher")
  })

  // Serializes native Linux subscribe scans process-wide. The kernel watch
  // budget is shared, so concurrent scans (a project's .synergy + workspace +
  // VCS subscriptions, or several scopes starting at once) can each hit
  // ENOSPC and retain a partial native tree before the first failure trips
  // the breaker. Queuing the scans keeps at most one in flight; the first
  // failure trips the breaker, and the queued scans then fail fast at the
  // connect guard instead of scanning again.
  const nativeSubscribeGate = process.platform === "linux" ? FileWatcherEvents.createSerialQueue() : undefined

  // Scope IDs whose watcher state is live. FileWatcher.reload() tears down and
  // re-creates exactly these so the advertised remediation actually restores
  // live file events.
  const liveWatcherScopeIDs = new Set<string>()

  type SubscriptionRecovery = {
    start(): Promise<void>
    fail(error: unknown): Promise<void>
    dispose(): Promise<void>
    active(): boolean
  }

  async function subscribeWithRecovery(input: {
    directory: string
    label: string
    options: ParcelWatcher.Options
    onEvents: (events: ParcelWatcher.Event[]) => void
    resync?: () => void | Promise<void>
  }): Promise<SubscriptionRecovery> {
    // The native inotify backend and its kernel watch budget are process-wide:
    // once one subscription exhausts the table, any further native scan can
    // fail before registration and leak its partial tree into the shared
    // backend. Subsequent subscriptions are skipped until FileWatcher.reload()
    // (which resets the breaker) or a process restart.
    if (FileWatcherEvents.isLinuxInotifyCapacityTripped()) {
      log.warn("skipping watcher subscription after Linux inotify capacity trip", {
        directory: input.directory,
        label: input.label,
      })
      return {
        start: async () => {},
        fail: async () => {},
        dispose: async () => {},
        active: () => false,
      }
    }

    const recovery = FileWatcherEvents.createSubscriptionRecovery({
      connect: async (context) => {
        // Fast path: refuse before queueing once a trip has already happened.
        if (process.platform === "linux" && FileWatcherEvents.isLinuxInotifyCapacityTripped()) {
          throw FileWatcherEvents.linuxInotifyCapacityError()
        }
        const callback: ParcelWatcher.SubscribeCallback = (error, events) => {
          if (!context.isCurrent()) return
          if (error) {
            void context.fail(error)
            return
          }
          try {
            input.onEvents(events)
          } catch (error) {
            void context.fail(error)
          }
        }
        const subscribe = async () => {
          // Guard again under the gate: a trip can land while this attempt was
          // queued behind an earlier scan, and refusing here beats letting a
          // doomed scan leak its partial tree into the shared backend again.
          if (process.platform === "linux" && FileWatcherEvents.isLinuxInotifyCapacityTripped()) {
            throw FileWatcherEvents.linuxInotifyCapacityError()
          }
          const pending = watcher().subscribe(input.directory, callback, input.options)
          const timeoutMs = FileWatcherEvents.nativeSubscribeTimeoutMs()
          if (timeoutMs === undefined) {
            // Linux inotify scans cannot be cancelled: abandoning the attempt
            // at a generic timeout lets a retry overlap the still-running
            // native scan, and a scan that later fails mid-way leaks its
            // partial watches into the shared backend. Wait for the attempt to
            // settle so recovery stays serial and bounded.
            return FileWatcherEvents.warnOnStall({
              task: pending,
              onStall: (elapsedMs) =>
                log.warn("native watcher scan stalled; later Linux subscriptions are queued behind it", {
                  directory: input.directory,
                  label: input.label,
                  elapsedMs,
                  hint: "a hung scan usually indicates a network filesystem (NFS/autofs) subtree; live events are not required for correctness",
                }),
              onSettledAfterStall: (elapsedMs) =>
                log.info("stalled native watcher scan settled", {
                  directory: input.directory,
                  label: input.label,
                  elapsedMs,
                }),
            })
          }
          return withTimeout(pending, timeoutMs).catch((error) => {
            pending
              .then((subscription) => subscription.unsubscribe())
              .catch((unsubscribeError) => {
                log.error("failed to unsubscribe timed out watcher subscription", {
                  directory: input.directory,
                  label: input.label,
                  error: unsubscribeError,
                })
              })
            throw error
          })
        }
        // Linux serializes the native scans process-wide so concurrent
        // subscriptions (a project's .synergy + workspace + VCS, or several
        // scopes starting at once) cannot each exhaust the shared kernel watch
        // table and retain a partial tree before the breaker trips. The first
        // scan that fails trips the breaker; queued scans then fail fast at
        // the guard instead of scanning.
        return nativeSubscribeGate ? nativeSubscribeGate(subscribe) : subscribe()
      },
      shouldRetry: (error) => !FileWatcherEvents.isLinuxInotifyTerminalError(error),
      disconnect: (subscription) => subscription.unsubscribe(),
      onError: async (error) => {
        const terminalError = FileWatcherEvents.isLinuxInotifyTerminalError(error)
        if (!terminalError) {
          log.error("file watcher subscription failed", {
            directory: input.directory,
            label: input.label,
            error,
          })
          await input.resync?.()
          return
        }
        // The breaker is process-wide: only the first capacity failure logs
        // the full remediation. Subscriptions that hit the guard afterwards
        // (queued scans, other scopes) report one bounded warn each.
        const alreadyTripped = FileWatcherEvents.isLinuxInotifyCapacityTripped()
        FileWatcherEvents.tripLinuxInotifyCapacity()
        if (alreadyTripped) {
          log.warn("file watcher subscription skipped: Linux inotify capacity already exhausted", {
            directory: input.directory,
            label: input.label,
            error,
          })
          return
        }
        log.error("file watcher disabled after Linux inotify watch capacity exhaustion", {
          directory: input.directory,
          label: input.label,
          error,
          hint: "raise fs.inotify.max_user_watches or open a smaller workspace, then reload watcher state or restart the process to restore live file events",
        })
      },
    })

    const starting = recovery.start()
    if (process.platform === "linux") {
      // Never block watcher state initialization on an uncancellable native
      // settle: recovery.dispose() does not await an in-flight connect, so the
      // scope state must be published before the first scan completes. Failure
      // reporting and retry still run inside the recovery.
      starting.catch((error) => {
        log.error("file watcher subscription start failed", {
          directory: input.directory,
          label: input.label,
          error,
        })
      })
      return recovery
    }
    await starting
    return recovery
  }

  const state = ScopedState.create(
    async () => {
      log.info("init", { scopeType: ScopeContext.current.scope.type })
      liveWatcherScopeIDs.add(ScopeContext.current.scope.id)
      const cfg = await Config.current().catch(() => null)
      const backend = (() => {
        if (process.platform === "win32") return "windows"
        if (process.platform === "darwin") return "fs-events"
        if (process.platform === "linux") return "inotify"
      })()
      if (!backend) {
        log.error("watcher backend not supported", { platform: process.platform })
        return { subs: [], scopeID: ScopeContext.current.scope.id }
      }
      log.info("watcher backend", { platform: process.platform, backend })

      const subs: SubscriptionRecovery[] = []

      // Home context in GlobalRuntime watches global config and emits via GlobalBus.
      if (ScopeContext.current.scope.type === "home") {
        const globalConfigDir = Global.Path.config
        const globalRecovery = await subscribeWithRecovery({
          directory: globalConfigDir,
          label: "global config",
          options: { backend },
          resync: async () => {
            const { RuntimeReloadExecutor } = await import("../config/reload-executor")
            await RuntimeReloadExecutor.reloadGlobal({
              targets: ["config", "agent", "command", "skill", "tool_registry"],
              reason: "global config watcher recovery",
            })
          },
          onEvents: (evts) => {
            for (const evt of evts) {
              const eventType =
                evt.type === "create"
                  ? "add"
                  : evt.type === "update"
                    ? "change"
                    : evt.type === "delete"
                      ? "unlink"
                      : null
              if (!eventType) continue
              log.info("global config file event", { file: evt.path, event: eventType })
              GlobalBus.emit("event", {
                directory: "global",
                payload: {
                  type: "global.config.file.changed",
                  properties: { file: evt.path, event: eventType },
                },
              })
            }
          },
        })
        subs.push(globalRecovery)
        return { subs, scopeID: ScopeContext.current.scope.id }
      }

      // Project scopes watch workspace files. Git scopes additionally watch HEAD
      // so branch updates do not depend on ordinary workspace file traffic.
      const drain = FileWatcherEvents.createDrain({
        debounceMs: 50,
        maxPending: 4_096,
        process: publishWorkspaceBatch,
        overflow: publishWorkspaceResync,
      })

      const cfgIgnores = cfg?.watcher?.ignore ?? []

      // Project runtime inputs have a dedicated subscription; generated worktrees,
      // caches, and other .synergy state remain outside the workspace hot path.
      const synergyDir = path.join(ScopeContext.current.directory, ".synergy")
      if (existsSync(synergyDir)) {
        const synergyRecovery = await subscribeWithRecovery({
          directory: synergyDir,
          label: "project .synergy",
          options: {
            backend,
            ignore: FileWatcherEvents.projectRuntimeSubscriptionIgnores(),
          },
          resync: async () => {
            const { RuntimeReloadExecutor } = await import("../config/reload-executor")
            await RuntimeReloadExecutor.reload({
              targets: ["config", "agent", "command", "skill", "tool_registry"],
              scope: "project",
              reason: "project config watcher recovery",
            })
          },
          onEvents: (evts) => {
            for (const evt of evts) {
              const eventType =
                evt.type === "create"
                  ? "add"
                  : evt.type === "update"
                    ? "change"
                    : evt.type === "delete"
                      ? "unlink"
                      : null
              if (!eventType || !FileWatcherEvents.isProjectRuntimeInput(evt.path)) continue
              log.info("project .synergy file event", { file: evt.path, event: eventType })
              GlobalBus.emit("event", {
                directory: ScopeContext.current.directory,
                payload: {
                  type: "global.config.file.changed",
                  properties: { file: evt.path, event: eventType },
                },
              })
            }
          },
        })
        subs.push(synergyRecovery)
      }

      const workspaceRecovery = await subscribeWithRecovery({
        directory: ScopeContext.current.directory,
        label: "workspace",
        options: {
          ignore: FileWatcherEvents.workspaceSubscriptionIgnores(cfgIgnores),
          backend,
        },
        resync: () => drain.resync(),
        onEvents: (events) => drain.enqueue(FileWatcherEvents.normalize(events)),
      })
      subs.push(workspaceRecovery)

      const vcsDir =
        ScopeContext.current.scope.vcs === "git"
          ? await $`git rev-parse --git-dir`
              .quiet()
              .nothrow()
              .cwd(ScopeContext.current.directory)
              .text()
              .then((x) => path.resolve(ScopeContext.current.directory, x.trim()))
              .catch(() => undefined)
          : undefined
      if (vcsDir && !cfgIgnores.includes(".git") && !cfgIgnores.includes(vcsDir)) {
        const gitDirContents = await readdir(vcsDir).catch(() => [])
        const ignoreList = gitDirContents.filter((entry) => entry !== "HEAD")
        const vcsRecovery = await subscribeWithRecovery({
          directory: vcsDir,
          label: "vcs HEAD",
          options: {
            ignore: ignoreList,
            backend,
          },
          resync: () => drain.resync(),
          onEvents: (events) =>
            drain.enqueue(
              FileWatcherEvents.normalize(
                events.filter(
                  (event) =>
                    path.basename(event.path).toLowerCase() === "head" ||
                    path.win32.basename(event.path).toLowerCase() === "head",
                ),
              ),
            ),
        })
        subs.push(vcsRecovery)
      }

      return { subs, drain, scopeID: ScopeContext.current.scope.id }
    },
    async (state) => {
      liveWatcherScopeIDs.delete(state.scopeID)
      await Promise.all(state.subs.map((sub) => sub.dispose()))
      if ("drain" in state) await state.drain?.dispose()
    },
  )

  export async function reload() {
    if (!bindingAvailable()) return
    log.info("reloading file watcher state")
    // A capacity trip is process-wide but operator-fixable: reloading watcher
    // state (e.g. after raising fs.inotify.max_user_watches) re-arms Linux
    // subscriptions.
    FileWatcherEvents.resetLinuxInotifyCapacity()
    // Known snapshot race: a scope torn down between this snapshot and the
    // re-creation below can be re-created here. The orphaned watcher state is
    // bounded (that scope's subscriptions) and is cleared by the next reload
    // or process restart; reload is an operator-triggered action, so the
    // window is accepted.
    const scopeIDs = [...liveWatcherScopeIDs]
    await state.resetAll()
    // resetAll() disposed every watcher state; re-create the live ones so the
    // advertised remediation actually restores live file events instead of
    // leaving the watcher disabled until the next scope startup.
    const { Scope } = await import("../scope")
    for (const scopeID of scopeIDs) {
      const scope = await Scope.fromID(scopeID).catch(() => undefined)
      if (!scope) continue
      await ScopeContext.provide({ scope, fn: () => state() }).catch((error) => {
        log.error("failed to re-create watcher state after reload", { scopeID, error })
      })
    }
    log.info("file watcher state reloaded", { recreated: scopeIDs.length })
  }

  export function init() {
    if (Flag.SYNERGY_DISABLE_FILEWATCHER) {
      return
    }
    if (!bindingAvailable()) return
    state()
  }

  let reportedMissingBinding = false

  function bindingAvailable(): boolean {
    if (FileWatcherBinding.available()) return true
    if (!reportedMissingBinding) {
      reportedMissingBinding = true
      log.error("file watcher binding unavailable; file watching disabled", {
        package: FileWatcherBinding.packageName(),
        packaged: FileWatcherBinding.packagedPath(),
      })
    }
    return false
  }
}
