import { BusEvent } from "@/bus/bus-event"
import { Bus } from "@/bus"
import { GlobalBus } from "@/bus/global"
import z from "zod"
import { ScopeContext } from "../scope/context"
import { ScopedState } from "../scope/scoped-state"
import { Log } from "../util/log"
import { FileIgnore } from "./ignore"
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

const SUBSCRIBE_TIMEOUT_MS = 10_000

declare const SYNERGY_LIBC: string | undefined

export namespace FileWatcher {
  const log = Log.create({ service: "file.watcher" })
  type WorkspaceFileEvent = "added" | "changed" | "deleted" | "renamed"

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
      }),
    ),
  }

  function indexerEvent(event: Exclude<WorkspaceFileEvent, "renamed">): "add" | "change" | "unlink" {
    if (event === "added") return "add"
    if (event === "deleted") return "unlink"
    return "change"
  }

  async function publishWorkspaceFileEvent(file: string, event: WorkspaceFileEvent, options?: { oldPath?: string }) {
    try {
      const relative = WorkspaceFileService.relative(file)
      WorkspaceFileStatus.invalidate()
      const oldRelative = options?.oldPath ? WorkspaceFileService.relative(options.oldPath) : undefined
      if (event === "renamed" && oldRelative) {
        await WorkspaceFileIndexer.applyRename({ from: oldRelative, to: relative }).catch(() =>
          WorkspaceFileIndexer.invalidate(),
        )
      } else {
        const changeEvent = event === "renamed" ? "added" : event
        await WorkspaceFileIndexer.applyChange({ path: relative, event: indexerEvent(changeEvent) }).catch(() =>
          WorkspaceFileIndexer.invalidate(),
        )
      }
      const node = event === "deleted" ? undefined : await WorkspaceFileService.maybeNode(relative)
      Bus.publish(Event.Updated, {
        file: relative,
        event,
        absolute: file,
        oldPath: oldRelative,
        oldAbsolute: options?.oldPath,
        parent: path.dirname(relative) === "." ? "" : path.dirname(relative),
        node,
      })
    } catch (error) {
      log.warn("failed to publish workspace file event", { file, event, error: String(error) })
      WorkspaceFileIndexer.invalidate()
      WorkspaceFileStatus.invalidate()
    }
  }

  function parentOf(input: string) {
    return path.dirname(input)
  }

  function normalizeWorkspaceEvents(evts: ParcelWatcher.Event[]) {
    const deletes = evts.filter((evt) => evt.type === "delete")
    const creates = evts.filter((evt) => evt.type === "create")
    const updates = evts.filter((evt) => evt.type === "update")
    const usedDeletes = new Set<number>()
    const result: Array<{ path: string; event: WorkspaceFileEvent; oldPath?: string }> = []

    for (const create of creates) {
      const deleteIndex = deletes.findIndex((item, index) => {
        if (usedDeletes.has(index)) return false
        if (parentOf(item.path) === parentOf(create.path)) return true
        return deletes.length === 1 && creates.length === 1
      })
      if (deleteIndex === -1) {
        result.push({ path: create.path, event: "added" })
        continue
      }
      usedDeletes.add(deleteIndex)
      result.push({ path: create.path, event: "renamed", oldPath: deletes[deleteIndex]!.path })
    }

    for (const update of updates) {
      result.push({ path: update.path, event: "changed" })
    }

    for (const [index, deleted] of deletes.entries()) {
      if (usedDeletes.has(index)) continue
      result.push({ path: deleted.path, event: "deleted" })
    }

    return result
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

      // Project scopes always watch the workspace. Git scopes additionally watch
      // their VCS directory below so index-only changes are observed.
      const pendingByParent = new Map<string, Array<{ path: string; event: WorkspaceFileEvent; oldPath?: string }>>()
      const timers = new Map<string, ReturnType<typeof setTimeout>>()

      const enqueue = (events: ReturnType<typeof normalizeWorkspaceEvents>) => {
        for (const event of events) {
          const parent = parentOf(event.path)
          const queued = pendingByParent.get(parent) ?? []
          queued.push(event)
          pendingByParent.set(parent, queued)
          const existing = timers.get(parent)
          if (existing) clearTimeout(existing)
          timers.set(
            parent,
            setTimeout(() => {
              timers.delete(parent)
              const batch = pendingByParent.get(parent) ?? []
              pendingByParent.delete(parent)
              for (const item of batch) {
                void publishWorkspaceFileEvent(item.path, item.event, { oldPath: item.oldPath })
              }
            }, 50),
          )
        }
      }

      const subscribe: ParcelWatcher.SubscribeCallback = (err, evts) => {
        if (err) return
        enqueue(normalizeWorkspaceEvents(evts))
      }

      const cfgIgnores = cfg?.watcher?.ignore ?? []

      // P7: Watch .synergy/ directory for config/agent/command/skill/tool/plugin changes.
      // These events are emitted to GlobalBus so the auto-reload system can process them,
      // just like global config directory events.
      const synergyDir = path.join(ScopeContext.current.directory, ".synergy")
      if (existsSync(synergyDir)) {
        const synergySubscribe: ParcelWatcher.SubscribeCallback = (err, evts) => {
          if (err) return
          for (const evt of evts) {
            const eventType =
              evt.type === "create" ? "add" : evt.type === "update" ? "change" : evt.type === "delete" ? "unlink" : null
            if (!eventType) continue
            // Skip node_modules and other non-config files
            if (evt.path.includes("node_modules")) continue
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
        const pending = watcher().subscribe(synergyDir, synergySubscribe, { backend, ignore: ["node_modules"] })
        const sub = await withTimeout(pending, SUBSCRIBE_TIMEOUT_MS).catch((err) => {
          log.error("failed to subscribe to project .synergy directory", { error: err })
          pending.then((s) => s.unsubscribe()).catch(() => {})
          return undefined
        })
        if (sub) subs.push(sub)
      }

      const pending = watcher().subscribe(ScopeContext.current.directory, subscribe, {
        ignore: [...FileIgnore.PATTERNS, ...cfgIgnores],
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
      if (vcsDir && !cfgIgnores.includes(".git") && !cfgIgnores.includes(vcsDir)) {
        const gitDirContents = await readdir(vcsDir).catch(() => [])
        const ignoreList = gitDirContents.filter((entry) => entry !== "HEAD")
        const pending = watcher().subscribe(vcsDir, subscribe, {
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

      return { subs, timers }
    },
    async (state) => {
      if (!state.subs) return
      if ("timers" in state) {
        const timers = state.timers
        if (timers) for (const timer of timers.values()) clearTimeout(timer)
      }
      await Promise.all(state.subs.map((sub) => sub?.unsubscribe()))
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
