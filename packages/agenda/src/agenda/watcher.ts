import { RuntimeContext } from "@ericsanchezok/synergy-harness/lifecycle/context"
import { GlobalBus } from "@ericsanchezok/synergy-harness/bus/global"
import { AgendaStore } from "./store"
import { AgendaTypes } from "./types"
import { Log } from "@ericsanchezok/synergy-harness/util/log"
import { WorkspaceCatalog, WorkspaceBinding } from "@ericsanchezok/synergy-harness/workspace"
import { Scope } from "@ericsanchezok/synergy-harness/scope"
import { ScopeRuntime } from "@ericsanchezok/synergy-harness/scope/runtime"

const DEFAULT_DEBOUNCE_MS = 500

export namespace AgendaWatcher {
  const log = Log.create({ service: "agenda.watcher" })

  type Handler = (signal: AgendaTypes.FiredSignal, scopeID: string) => Promise<void>

  interface FileEntry {
    scopeID: string
    sourceScopeID: string
    workspaceID: string
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
    globalBusHandler: null as ((event: { scopeID: string | null; payload: unknown }) => void) | null,
    started: false,
  }))

  function normalizeFileEvent(event: string): FileEntry["event"] | undefined {
    if (event === "add" || event === "added") return "add"
    if (event === "change" || event === "changed" || event === "renamed") return "change"
    if (event === "unlink" || event === "deleted") return "unlink"
    return undefined
  }

  export function start(onFire: Handler, items: AgendaTypes.Item[]): void {
    stop()
    const instanceState = runtimeState()

    instanceState.handler = onFire
    for (const item of items) {
      register(item.id, item.global ? "home" : item.origin.scope.id, item.triggers, {
        workspaceID: item.origin.workspaceID,
        sourceScopeID: item.origin.scope.id,
      })
    }

    instanceState.globalBusHandler = (event) => {
      const instanceState = runtimeState()

      if (!instanceState.started) return
      const payload = event.payload as Record<string, unknown> | undefined
      if (payload?.type === WorkspaceCatalog.Event.Updated.type) {
        const workspace = WorkspaceCatalog.Info.safeParse(payload.properties)
        if (!workspace.success) return
        for (const entries of instanceState.files.values()) {
          const entry = entries[0]
          if (entry?.workspaceID !== workspace.data.id || entry.sourceScopeID !== event.scopeID) continue
          const pending = instanceState.debounceTimers.get(entry.itemID)
          if (pending) clearTimeout(pending)
          instanceState.debounceTimers.delete(entry.itemID)
          startNativeWatch(entry)
        }
        return
      }
      if (!payload || payload.type !== "file.watcher.updated") return
      const properties = payload.properties as Record<string, unknown> | undefined
      if (!properties) return
      const filePath = properties.file
      const fileEvent = normalizeFileEvent(properties.event as string)
      const workspaceID = properties.workspaceID
      const generation = properties.workspaceGeneration
      if (
        typeof filePath !== "string" ||
        !filePath ||
        !fileEvent ||
        !event.scopeID ||
        typeof workspaceID !== "string" ||
        typeof generation !== "number"
      )
        return
      handleFileEvent(filePath, fileEvent, { scopeID: event.scopeID, workspaceID, generation })
    }
    GlobalBus().on("event", instanceState.globalBusHandler)

    instanceState.started = true
    for (const entries of instanceState.files.values()) startNativeWatch(entries[0]!)
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
    opts: { workspaceID: string | null | undefined; sourceScopeID: string },
  ): void {
    const instanceState = runtimeState()

    unregister(itemID)
    if (!opts.workspaceID) return

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
          sourceScopeID: opts.sourceScopeID,
          workspaceID: opts.workspaceID,
          itemID,
          glob: new Bun.Glob(watch.glob),
          event: watch.event,
          debounceMs,
        })
      }
    }

    if (newFiles.length > 0) {
      instanceState.files.set(itemID, newFiles)
      if (instanceState.started) startNativeWatch(newFiles[0]!)
    }
  }

  function startNativeWatch(entry: FileEntry) {
    const state = runtimeState()
    const start = async () => {
      const workspace = await WorkspaceBinding.validate(entry.workspaceID, entry.sourceScopeID)
      const scope = await Scope.resolve({ scopeID: entry.sourceScopeID })
      if (!state.started || !state.files.get(entry.itemID)?.includes(entry)) return
      await ScopeRuntime.provide({ scope, workspace, fn: () => {} })
    }
    void start().catch((error) => {
      log.error("file watch Workspace unavailable", { itemID: entry.itemID, error })
    })
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

  function handleFileEvent(
    filePath: string,
    fileEvent: string,
    source: { scopeID: string; workspaceID: string; generation: number },
  ): void {
    const instanceState = runtimeState()

    for (const entries of instanceState.files.values()) {
      for (const entry of entries) {
        if (entry.sourceScopeID !== source.scopeID || entry.workspaceID !== source.workspaceID) continue
        if (!entry.glob.match(filePath)) continue
        if (entry.event && entry.event !== fileEvent) continue
        scheduleFileSignal(entry, filePath, fileEvent, source.generation)
      }
    }
  }

  function scheduleFileSignal(entry: FileEntry, filePath: string, fileEvent: string, generation: number): void {
    const instanceState = runtimeState()

    if (!instanceState.handler) return

    const existing = instanceState.debounceTimers.get(entry.itemID)
    if (existing) clearTimeout(existing)

    const timer = setTimeout(() => {
      const fire = async () => {
        await WorkspaceBinding.validate(entry.workspaceID, entry.sourceScopeID, generation)
        if (
          !instanceState.started ||
          !instanceState.files.get(entry.itemID)?.includes(entry) ||
          instanceState.debounceTimers.get(entry.itemID) !== timer
        )
          return
        instanceState.debounceTimers.delete(entry.itemID)
        const signal: AgendaTypes.FiredSignal = {
          type: "watch",
          source: entry.itemID,
          payload: {
            file: filePath,
            event: fileEvent,
            workspaceID: entry.workspaceID,
            workspaceGeneration: generation,
          },
          timestamp: Date.now(),
        }
        await instanceState.handler!(signal, entry.scopeID)
      }
      void fire().catch((err) => {
        if (instanceState.debounceTimers.get(entry.itemID) === timer) instanceState.debounceTimers.delete(entry.itemID)
        log.error("file handler failed", {
          itemID: entry.itemID,
          error: err instanceof Error ? err : new Error(String(err)),
        })
      })
    }, entry.debounceMs)

    instanceState.debounceTimers.set(entry.itemID, timer)
  }
}
