import { WorkspaceEvents } from "@ericsanchezok/synergy-harness/workspace/events"
import { File } from "@ericsanchezok/synergy-local-runtime/file"
import { Log } from "@ericsanchezok/synergy-harness/util/log"
import path from "path"
import { z } from "zod"

import * as Formatter from "./formatter"
import { readConfig } from "../config-schema"
import { mergeDeep } from "remeda"
import { WorkspaceAccess } from "@ericsanchezok/synergy-harness/workspace/access"
import { FileMutation } from "@ericsanchezok/synergy-local-runtime/file/mutation"
import { FormatterProcess } from "./process"
import { WorkspaceState } from "@ericsanchezok/synergy-harness/workspace/state"

export namespace Format {
  const log = Log.create({ service: "format" })

  export const Status = z
    .object({
      name: z.string(),
      extensions: z.string().array(),
      enabled: z.boolean(),
    })
    .meta({
      ref: "FormatterStatus",
    })
  export type Status = z.infer<typeof Status>

  const state = WorkspaceState.create(
    async () => {
      const lifecycle = { controller: new AbortController(), pending: new Set<Promise<void>>() }
      const enabled: Record<string, boolean> = {}
      const cfg = await readConfig()

      const formatters: Record<string, Formatter.Info> = {}
      if (cfg.formatter === false) {
        log.info("all formatters are disabled")
        return {
          ...lifecycle,
          enabled,
          formatters,
        }
      }

      for (const item of Object.values(Formatter)) {
        formatters[item.name] = item
      }
      for (const [name, item] of Object.entries(cfg.formatter ?? {})) {
        if (item.disabled) {
          delete formatters[name]
          continue
        }
        const result: Formatter.Info = mergeDeep(formatters[name] ?? {}, {
          command: [],
          extensions: [],
          ...item,
        })

        if (result.command.length === 0) continue

        result.enabled = async () => true
        result.name = name
        formatters[name] = result
      }

      return {
        ...lifecycle,
        enabled,
        formatters,
      }
    },
    async (state) => {
      state.controller.abort(new DOMException("Formatter resources disposed", "AbortError"))
      await Promise.allSettled([...state.pending])
    },
  )

  export async function reload() {
    log.info("reloading formatter state")
    await state.resetAll()
    log.info("formatter state reloaded")
  }

  async function isEnabled(item: Formatter.Info, signal?: AbortSignal) {
    const s = await state()
    let status = s.enabled[item.name]
    if (status === undefined) {
      status = await item.enabled(signal)
      s.enabled[item.name] = status
    }
    return status
  }

  async function getFormatter(ext: string, signal?: AbortSignal) {
    const formatters = await state().then((x) => x.formatters)
    const result = []
    for (const item of Object.values(formatters)) {
      log.info("checking", { name: item.name, ext })
      if (!item.extensions.includes(ext)) continue
      if (!(await isEnabled(item, signal))) continue
      log.info("enabled", { name: item.name, ext })
      result.push(item)
    }
    return result
  }

  export async function status() {
    const s = await state()
    const result: Status[] = []
    for (const formatter of Object.values(s.formatters)) {
      const enabled = await isEnabled(formatter)
      result.push({
        name: formatter.name,
        extensions: formatter.extensions,
        enabled,
      })
    }
    return result
  }

  const subscription = WorkspaceState.create(
    () => {
      const unsub = WorkspaceEvents.subscribe(File.Event.Edited, async (payload) => {
        const s = await state()
        const file = payload.properties.file
        const formatting = WorkspaceAccess.withinTask(async () => {
          let expectedVersion: string | null = payload.properties.contentVersion
          const target = await FileMutation.canonical(file)
          if ((await FileMutation.snapshot(target))?.version !== expectedVersion) return
          for (const item of await getFormatter(path.extname(file), s.controller.signal)) {
            if (s.controller.signal.aborted) return
            try {
              const result = await FormatterProcess.run({
                command: item.command.map((value) => value.replaceAll("$FILE", target)),
                environment: item.environment,
                signal: s.controller.signal,
                async beforeStart() {
                  return (
                    (await FileMutation.canonical(file)) === target &&
                    ((await FileMutation.snapshot(target))?.version ?? null) === expectedVersion
                  )
                },
              })
              if (!result) return
              expectedVersion = (await FileMutation.snapshot(target))?.version ?? null
              if (result.exitCode !== 0) log.error("formatter failed", { name: item.name, exitCode: result.exitCode })
            } catch (error) {
              if (s.controller.signal.aborted || WorkspaceAccess.signal()?.aborted) return
              log.error("failed to format file", { error, name: item.name, file })
            }
          }
        }, s.controller.signal)
        s.pending.add(formatting)
        try {
          await formatting
        } finally {
          s.pending.delete(formatting)
        }
      })
      return { unsub }
    },
    async (s) => s.unsub(),
  )

  export function init() {
    log.info("init")
    subscription()
  }
}
