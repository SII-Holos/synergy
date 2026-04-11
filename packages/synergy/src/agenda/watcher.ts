import { GlobalBus } from "../bus/global"
import { AgendaStore } from "./store"
import { AgendaTypes } from "./types"
import { Log } from "../util/log"

const DEFAULT_DEBOUNCE_MS = 500

export namespace AgendaWatcher {
  const log = Log.create({ service: "agenda.watcher" })

  type Handler = (signal: AgendaTypes.FiredSignal, scopeID: string) => Promise<void>

  interface PollEntry {
    scopeID: string
    itemID: string
    command: string
    trigger: "change" | "match"
    match?: string
    lastOutput?: string
    timer: Timer
  }

  interface FileEntry {
    scopeID: string
    itemID: string
    glob: InstanceType<typeof Bun.Glob>
    event?: "add" | "change" | "unlink"
    debounceMs: number
  }

  const polls = new Map<string, PollEntry[]>()
  const files = new Map<string, FileEntry[]>()
  const debounceTimers = new Map<string, Timer>()
  let handler: Handler | null = null
  let globalBusHandler: ((event: { directory?: string; payload: unknown }) => void) | null = null
  let started = false

  export function start(onFire: Handler, items: AgendaTypes.Item[]): void {
    handler = onFire
    for (const item of items) {
      register(item.id, item.origin.scope.id, item.triggers)
    }

    globalBusHandler = (event) => {
      if (!started) return
      const payload = event.payload as Record<string, unknown> | undefined
      if (!payload || payload.type !== "file.watcher.updated") return
      const properties = payload.properties as Record<string, unknown> | undefined
      if (!properties) return
      const filePath = properties.file as string
      const fileEvent = properties.event as string
      if (!filePath || !fileEvent) return
      handleFileEvent(filePath, fileEvent)
    }
    GlobalBus.on("event", globalBusHandler)

    started = true
    log.info("started", { polls: countPolls(), files: countFiles() })
  }

  export function stop(): void {
    for (const entries of polls.values()) {
      for (const entry of entries) clearInterval(entry.timer)
    }
    polls.clear()
    files.clear()

    for (const timer of debounceTimers.values()) clearTimeout(timer)
    debounceTimers.clear()

    if (globalBusHandler) {
      GlobalBus.off("event", globalBusHandler)
      globalBusHandler = null
    }

    started = false
    handler = null
  }

  export function register(itemID: string, scopeID: string, triggers: AgendaTypes.Trigger[]): void {
    unregister(itemID)

    const newPolls: PollEntry[] = []
    const newFiles: FileEntry[] = []

    for (const trigger of triggers) {
      if (trigger.type !== "watch") continue
      const watch = trigger.watch

      if (watch.kind === "poll") {
        const intervalMs = AgendaStore.parseDuration(watch.interval ?? "1m")
        const entry: PollEntry = {
          scopeID,
          itemID,
          command: watch.command,
          trigger: watch.trigger,
          match: watch.match,
          lastOutput: undefined,
          timer: setInterval(() => executePoll(entry), intervalMs),
        }
        newPolls.push(entry)
      } else if (watch.kind === "file") {
        const debounceMs = watch.debounce ? AgendaStore.parseDuration(watch.debounce) : DEFAULT_DEBOUNCE_MS
        newFiles.push({
          scopeID,
          itemID,
          glob: new Bun.Glob(watch.glob),
          event: watch.event,
          debounceMs,
        })
      }
    }

    if (newPolls.length > 0) polls.set(itemID, newPolls)
    if (newFiles.length > 0) files.set(itemID, newFiles)
  }

  export function unregister(itemID: string): void {
    const itemPolls = polls.get(itemID)
    if (itemPolls) {
      for (const entry of itemPolls) clearInterval(entry.timer)
      polls.delete(itemID)
    }
    files.delete(itemID)

    const timer = debounceTimers.get(itemID)
    if (timer) {
      clearTimeout(timer)
      debounceTimers.delete(itemID)
    }
  }

  export function active(): { polls: number; files: number } {
    return { polls: countPolls(), files: countFiles() }
  }

  function countPolls(): number {
    let n = 0
    for (const entries of polls.values()) n += entries.length
    return n
  }

  function countFiles(): number {
    let n = 0
    for (const entries of files.values()) n += entries.length
    return n
  }

  function handleFileEvent(filePath: string, fileEvent: string): void {
    for (const entries of files.values()) {
      for (const entry of entries) {
        if (!entry.glob.match(filePath)) continue
        if (entry.event && entry.event !== fileEvent) continue
        scheduleFileSignal(entry, filePath, fileEvent)
      }
    }
  }

  function scheduleFileSignal(entry: FileEntry, filePath: string, fileEvent: string): void {
    if (!handler) return

    const existing = debounceTimers.get(entry.itemID)
    if (existing) clearTimeout(existing)

    const timer = setTimeout(() => {
      debounceTimers.delete(entry.itemID)
      const signal: AgendaTypes.FiredSignal = {
        type: "watch",
        source: entry.itemID,
        payload: { file: filePath, event: fileEvent },
        timestamp: Date.now(),
      }
      handler!(signal, entry.scopeID).catch((err) => {
        log.error("file handler failed", {
          itemID: entry.itemID,
          error: err instanceof Error ? err : new Error(String(err)),
        })
      })
    }, entry.debounceMs)

    debounceTimers.set(entry.itemID, timer)
  }

  async function executePoll(entry: PollEntry): Promise<void> {
    if (!started || !handler) return

    try {
      const proc = Bun.spawn(["sh", "-c", entry.command], { stdout: "pipe", stderr: "pipe" })
      const timeout = setTimeout(() => proc.kill(), 30_000)
      const output = await new Response(proc.stdout).text()
      clearTimeout(timeout)
      const trimmed = output.trim()

      if (entry.trigger === "change") {
        const changed = entry.lastOutput !== undefined && entry.lastOutput !== trimmed
        entry.lastOutput = trimmed
        if (!changed) return
      } else if (entry.trigger === "match") {
        if (!entry.match) return
        const regex = new RegExp(entry.match)
        if (!regex.test(trimmed)) return
      }

      const signal: AgendaTypes.FiredSignal = {
        type: "watch",
        source: entry.itemID,
        payload: { output: trimmed },
        timestamp: Date.now(),
      }
      await handler(signal, entry.scopeID)
    } catch (err) {
      log.error("poll execution failed", {
        itemID: entry.itemID,
        error: err instanceof Error ? err : new Error(String(err)),
      })
    }
  }
}
