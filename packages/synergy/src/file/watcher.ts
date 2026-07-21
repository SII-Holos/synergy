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

const SUBSCRIBE_TIMEOUT_MS = 10_000

declare const SYNERGY_LIBC: string | undefined

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
    const binding = require(
      `@parcel/watcher-${process.platform}-${process.arch}${process.platform === "linux" ? `-${SYNERGY_LIBC || "glibc"}` : ""}`,
    )
    return createWrapper(binding) as typeof import("@parcel/watcher")
  })

  const state = ScopedState.create(
    async () => {
      log.info("init", { scopeType: ScopeContext.current.scope.type })
      const cfg = await Config.current().catch(() => null)
      const backend = (() => {
        if (process.platform === "win32") return "windows"
        if (process.platform === "darwin") return "fs-events"
        if (process.platform === "linux") return "inotify"
      })()
      if (!backend) {
        log.error("watcher backend not supported", { platform: process.platform })
        return {}
      }
      log.info("watcher backend", { platform: process.platform, backend })

      const subs: ParcelWatcher.AsyncSubscription[] = []

      // Home context in GlobalRuntime watches global config and emits via GlobalBus.
      if (ScopeContext.current.scope.type === "home") {
        const globalConfigDir = Global.Path.config
        const globalSubscribe: ParcelWatcher.SubscribeCallback = (err, evts) => {
          if (err) return
          for (const evt of evts) {
            const eventType =
              evt.type === "create" ? "add" : evt.type === "update" ? "change" : evt.type === "delete" ? "unlink" : null
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
        }
        const pending = watcher().subscribe(globalConfigDir, globalSubscribe, { backend })
        const sub = await withTimeout(pending, SUBSCRIBE_TIMEOUT_MS).catch((err) => {
          log.error("failed to subscribe to global config directory", { error: err })
          pending.then((s) => s.unsubscribe()).catch(() => {})
          return undefined
        })
        if (sub) subs.push(sub)
        return { subs }
      }

      // Project scopes watch workspace files. Git scopes additionally watch HEAD
      // so branch updates do not depend on ordinary workspace file traffic.
      const drain = FileWatcherEvents.createDrain({
        debounceMs: 50,
        maxPending: 4_096,
        process: publishWorkspaceBatch,
        overflow: publishWorkspaceResync,
      })

      const subscribe: ParcelWatcher.SubscribeCallback = (err, events) => {
        if (err) return
        drain.enqueue(FileWatcherEvents.normalize(events))
      }

      const cfgIgnores = cfg?.watcher?.ignore ?? []

      // Project runtime inputs have a dedicated subscription; generated worktrees,
      // caches, and other .synergy state remain outside the workspace hot path.
      const synergyDir = path.join(ScopeContext.current.directory, ".synergy")
      if (existsSync(synergyDir)) {
        const synergySubscribe: ParcelWatcher.SubscribeCallback = (err, evts) => {
          if (err) return
          for (const evt of evts) {
            const eventType =
              evt.type === "create" ? "add" : evt.type === "update" ? "change" : evt.type === "delete" ? "unlink" : null
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
        }
        const pending = watcher().subscribe(synergyDir, synergySubscribe, {
          backend,
          ignore: FileWatcherEvents.projectRuntimeSubscriptionIgnores(),
        })
        const sub = await withTimeout(pending, SUBSCRIBE_TIMEOUT_MS).catch((err) => {
          log.error("failed to subscribe to project .synergy directory", { error: err })
          pending.then((s) => s.unsubscribe()).catch(() => {})
          return undefined
        })
        if (sub) subs.push(sub)
      }

      const pending = watcher().subscribe(ScopeContext.current.directory, subscribe, {
        ignore: FileWatcherEvents.workspaceSubscriptionIgnores(cfgIgnores),
        backend,
      })
      const sub = await withTimeout(pending, SUBSCRIBE_TIMEOUT_MS).catch((err) => {
        log.error("failed to subscribe to workspace directory", { error: err })
        pending.then((s) => s.unsubscribe()).catch(() => {})
        return undefined
      })
      if (sub) subs.push(sub)

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
      const vcsSubscribe: ParcelWatcher.SubscribeCallback = (err, events) => {
        if (err) return
        drain.enqueue(FileWatcherEvents.normalize(events.filter((event) => path.basename(event.path) === "HEAD")))
      }
      if (vcsDir && !cfgIgnores.includes(".git") && !cfgIgnores.includes(vcsDir)) {
        const gitDirContents = await readdir(vcsDir).catch(() => [])
        const ignoreList = gitDirContents.filter((entry) => entry !== "HEAD")
        const pending = watcher().subscribe(vcsDir, vcsSubscribe, {
          ignore: ignoreList,
          backend,
        })
        const sub = await withTimeout(pending, SUBSCRIBE_TIMEOUT_MS).catch((err) => {
          log.error("failed to subscribe to vcsDir", { error: err })
          pending.then((s) => s.unsubscribe()).catch(() => {})
          return undefined
        })
        if (sub) subs.push(sub)
      }

      return { subs, drain }
    },
    async (state) => {
      if (!state.subs) return
      await Promise.all(state.subs.map((sub) => sub?.unsubscribe()))
      if ("drain" in state) await state.drain?.dispose()
    },
  )

  export async function reload() {
    log.info("reloading file watcher state")
    await state.resetAll()
    log.info("file watcher state reloaded")
  }

  export function init() {
    if (Flag.SYNERGY_DISABLE_FILEWATCHER) {
      return
    }
    state()
  }
}
