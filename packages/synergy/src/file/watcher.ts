import { BusEvent } from "@/bus/bus-event"
import { Bus } from "@/bus"
import { GlobalBus } from "@/bus/global"
import z from "zod"
import { Instance } from "../scope/instance"
import { Log } from "../util/log"
import { FileIgnore } from "./ignore"
import { Config } from "../config/config"
import { ConfigSet } from "../config/set"
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

const SUBSCRIBE_TIMEOUT_MS = 10_000

declare const SYNERGY_LIBC: string | undefined

export namespace FileWatcher {
  const log = Log.create({ service: "file.watcher" })

  export const Event = {
    Updated: BusEvent.define(
      "file.watcher.updated",
      z.object({
        file: z.string(),
        event: z.union([z.literal("add"), z.literal("change"), z.literal("unlink")]),
      }),
    ),
  }

  const watcher = lazy(() => {
    const binding = require(
      `@parcel/watcher-${process.platform}-${process.arch}${process.platform === "linux" ? `-${SYNERGY_LIBC || "glibc"}` : ""}`,
    )
    return createWrapper(binding) as typeof import("@parcel/watcher")
  })

  const state = Instance.state(
    async () => {
      log.info("init", { scopeType: Instance.scope.type })
      const cfg = await Config.get().catch(() => null)
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

      // Global scope: watch the global config directory and emit via GlobalBus
      if (Instance.scope.type === "global") {
        const globalConfigDir = path.dirname(ConfigSet.filePath(ConfigSet.activeNameSync()))
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

      // Project scope: existing project-scoped watching logic
      if (Instance.scope.vcs !== "git") return { subs }

      const subscribe: ParcelWatcher.SubscribeCallback = (err, evts) => {
        if (err) return
        for (const evt of evts) {
          if (evt.type === "create") Bus.publish(Event.Updated, { file: evt.path, event: "add" })
          if (evt.type === "update") Bus.publish(Event.Updated, { file: evt.path, event: "change" })
          if (evt.type === "delete") Bus.publish(Event.Updated, { file: evt.path, event: "unlink" })
        }
      }

      const cfgIgnores = cfg?.watcher?.ignore ?? []

      // P7: Watch .synergy/ directory for config/agent/command/skill/tool/plugin changes.
      // These events are emitted to GlobalBus so the auto-reload system can process them,
      // just like global config directory events.
      const synergyDir = path.join(Instance.directory, ".synergy")
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
              directory: Instance.directory,
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

      if (Flag.SYNERGY_EXPERIMENTAL_FILEWATCHER) {
        const pending = watcher().subscribe(Instance.directory, subscribe, {
          ignore: [...FileIgnore.PATTERNS, ...cfgIgnores],
          backend,
        })
        const sub = await withTimeout(pending, SUBSCRIBE_TIMEOUT_MS).catch((err) => {
          log.error("failed to subscribe to Instance.directory", { error: err })
          pending.then((s) => s.unsubscribe()).catch(() => {})
          return undefined
        })
        if (sub) subs.push(sub)
      }

      const vcsDir = await $`git rev-parse --git-dir`
        .quiet()
        .nothrow()
        .cwd(Instance.directory)
        .text()
        .then((x) => path.resolve(Instance.directory, x.trim()))
        .catch(() => undefined)
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

      return { subs }
    },
    async (state) => {
      if (!state.subs) return
      await Promise.all(state.subs.map((sub) => sub?.unsubscribe()))
    },
  )

  export async function reload() {
    log.info("reloading file watcher state")
    await state.resetAll()
    log.info("file watcher state reloaded")
  }

  export function init() {
    if (Flag.SYNERGY_EXPERIMENTAL_DISABLE_FILEWATCHER) {
      return
    }
    state()
  }
}
