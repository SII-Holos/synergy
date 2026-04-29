import { GlobalBus } from "../bus/global"
import { AgendaStore } from "./store"
import { AgendaTypes } from "./types"
import { Log } from "../util/log"

const DEFAULT_DEBOUNCE_MS = 500

export namespace AgendaWatcher {
  const log = Log.create({ service: "agenda.watcher" })

  type Handler = (signal: AgendaTypes.FiredSignal, scopeID: string) => Promise<void>

  interface FileEntry {
    scopeID: string
    itemID: string
    glob: InstanceType<typeof Bun.Glob>
    event?: "add" | "change" | "unlink"
    debounceMs: number
  }

  // TODO: poll and tool watch infrastructure was removed. When re-enabling
  // condition-based watches, add PollEntry/ToolEntry types and their execution
  // loops back here. See git history for the previous implementation.

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
    log.info("started", { files: countFiles() })
  }

  export function stop(): void {
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

  export function register(
    itemID: string,
    scopeID: string,
    triggers: AgendaTypes.Trigger[],
    opts?: { autoDone?: boolean; maxChecks?: number },
  ): void {
    unregister(itemID)

    const newFiles: FileEntry[] = []

    for (const trigger of triggers) {
      if (trigger.type !== "watch") continue
      const watch = trigger.watch

      // TODO: poll and tool watch kinds are disabled until we design a stable
      // condition-checking mechanism. Only file watching is active.
      // See types.ts TriggerWatch for details.

      if (watch.kind === "file") {
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

    if (newFiles.length > 0) files.set(itemID, newFiles)
  }

  export function unregister(itemID: string): void {
    files.delete(itemID)

    const timer = debounceTimers.get(itemID)
    if (timer) {
      clearTimeout(timer)
      debounceTimers.delete(itemID)
    }
  }

  export function active(): { files: number } {
    return { files: countFiles() }
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
}
