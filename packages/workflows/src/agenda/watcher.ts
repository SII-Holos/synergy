import { RuntimeContext } from "@ericsanchezok/synergy-harness/lifecycle/context"
import { GlobalBus } from "@ericsanchezok/synergy-harness/bus/global"
import { AgendaStore } from "./store"
import { AgendaTypes } from "./types"
import { Log } from "@ericsanchezok/synergy-harness/util/log"

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

  const runtimeState = RuntimeContext.state(() => ({
    files: new Map<string, FileEntry[]>(),
    debounceTimers: new Map<string, Timer>(),
    handler: null as Handler | null,
    globalBusHandler: null as ((event: { directory?: string; payload: unknown }) => void) | null,
    started: false,
  }))

  function normalizeFileEvent(event: string): FileEntry["event"] | undefined {
    if (event === "add" || event === "added") return "add"
    if (event === "change" || event === "changed" || event === "renamed") return "change"
    if (event === "unlink" || event === "deleted") return "unlink"
    return undefined
  }

  export function start(onFire: Handler, items: AgendaTypes.Item[]): void {
    const instanceState = runtimeState()

    instanceState.handler = onFire
    for (const item of items) {
      register(item.id, item.origin.scope.id, item.triggers)
    }

    instanceState.globalBusHandler = (event) => {
      const instanceState = runtimeState()

      if (!instanceState.started) return
      const payload = event.payload as Record<string, unknown> | undefined
      if (!payload || payload.type !== "file.watcher.updated") return
      const properties = payload.properties as Record<string, unknown> | undefined
      if (!properties) return
      const filePath = properties.file as string
      const fileEvent = normalizeFileEvent(properties.event as string)
      if (!filePath || !fileEvent) return
      handleFileEvent(filePath, fileEvent)
    }
    GlobalBus().on("event", instanceState.globalBusHandler)

    instanceState.started = true
    log.info("started", { files: countFiles() })
  }

  export function stop(): void {
    const instanceState = runtimeState()

    instanceState.files.clear()

    for (const timer of instanceState.debounceTimers.values()) clearTimeout(timer)
    instanceState.debounceTimers.clear()

    if (instanceState.globalBusHandler) {
      GlobalBus().off("event", instanceState.globalBusHandler)
      instanceState.globalBusHandler = null
    }

    instanceState.started = false
    instanceState.handler = null
  }

  export function register(
    itemID: string,
    scopeID: string,
    triggers: AgendaTypes.Trigger[],
    opts?: { autoDone?: boolean; maxChecks?: number },
  ): void {
    const instanceState = runtimeState()

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

    if (newFiles.length > 0) instanceState.files.set(itemID, newFiles)
  }

  export function unregister(itemID: string): void {
    const instanceState = runtimeState()

    instanceState.files.delete(itemID)

    const timer = instanceState.debounceTimers.get(itemID)
    if (timer) {
      clearTimeout(timer)
      instanceState.debounceTimers.delete(itemID)
    }
  }

  export function active(): { files: number } {
    return { files: countFiles() }
  }

  function countFiles(): number {
    const instanceState = runtimeState()

    let n = 0
    for (const entries of instanceState.files.values()) n += entries.length
    return n
  }

  function handleFileEvent(filePath: string, fileEvent: string): void {
    const instanceState = runtimeState()

    for (const entries of instanceState.files.values()) {
      for (const entry of entries) {
        if (!entry.glob.match(filePath)) continue
        if (entry.event && entry.event !== fileEvent) continue
        scheduleFileSignal(entry, filePath, fileEvent)
      }
    }
  }

  function scheduleFileSignal(entry: FileEntry, filePath: string, fileEvent: string): void {
    const instanceState = runtimeState()

    if (!instanceState.handler) return

    const existing = instanceState.debounceTimers.get(entry.itemID)
    if (existing) clearTimeout(existing)

    const timer = setTimeout(() => {
      const instanceState = runtimeState()

      instanceState.debounceTimers.delete(entry.itemID)
      const signal: AgendaTypes.FiredSignal = {
        type: "watch",
        source: entry.itemID,
        payload: { file: filePath, event: fileEvent },
        timestamp: Date.now(),
      }
      instanceState.handler!(signal, entry.scopeID).catch((err) => {
        log.error("file handler failed", {
          itemID: entry.itemID,
          error: err instanceof Error ? err : new Error(String(err)),
        })
      })
    }, entry.debounceMs)

    instanceState.debounceTimers.set(entry.itemID, timer)
  }
}
