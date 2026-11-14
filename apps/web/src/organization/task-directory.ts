import { createSignal, onCleanup } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import type { z } from "zod"
import {
  OrganizationReadProtocol as Read,
  OrganizationSyncProtocol as Sync,
  OrganizationProtocol as Protocol,
} from "@ericsanchezok/synergy-organization-protocol"
import type { createOrganizationSessionReader } from "./private-read"
import { organizationOwnerFailure } from "./owner-error"

export class OrganizationTaskDirectoryError extends Error {
  readonly code = "invalid_response"
  constructor() {
    super("Task metadata could not be verified")
  }
}
export function createOrganizationTaskDirectory(input: {
  sessionID: string
  sourceSessionID?: string
  binding: Protocol.SessionBinding
  signal: AbortSignal
  read: ReturnType<typeof createOrganizationSessionReader>
  shared?: {
    generation: number
    load(query: Sync.TaskQuery, signal: AbortSignal): Promise<z.infer<typeof Sync.TaskPage>>
  }
  invalidated?: (error: unknown) => void
}) {
  const sourceID = input.sourceSessionID ?? input.sessionID
  const binding = Protocol.SessionBinding.parse(input.binding)
  const generation = input.shared?.generation
  const controller = new AbortController()
  const signal = AbortSignal.any([input.signal, controller.signal])
  const [state, setState] = createStore({ items: [] as Sync.TaskSummary[] })
  const [cursor, setCursor] = createSignal<string>()
  const [start, setStart] = createSignal<string>()
  const [watermark, setWatermark] = createSignal<number>()
  const [loading, setLoading] = createSignal(false)
  const [loaded, setLoaded] = createSignal(false)
  const [error, setError] = createSignal<unknown>()
  let revision = 0
  function clear() {
    setState("items", reconcile([]))
    setCursor(undefined)
    setStart(undefined)
    setWatermark(undefined)
  }
  const abort = () => {
    revision++
    clear()
    setLoading(false)
    setError(undefined)
  }
  signal.addEventListener("abort", abort, { once: true })
  if (signal.aborted) abort()
  onCleanup(() => {
    controller.abort()
    signal.removeEventListener("abort", abort)
  })
  function valid(items: Sync.TaskSummary[]) {
    return (
      items.length <= 32 &&
      new Set(items.map((row) => row.sessionID)).size === items.length &&
      items.every((row) => row.parentSessionID === sourceID && row.sessionID !== sourceID)
    )
  }
  async function load(more = false, polling = false) {
    if (loading() || signal.aborted || (more && !cursor()) || (polling && start())) return
    const version = ++revision
    const after = more ? cursor() : undefined
    setLoading(true)
    try {
      let items: Sync.TaskSummary[]
      let next: string | undefined
      let checkpoint: number | undefined
      if (input.shared) {
        const page = Sync.TaskPage.safeParse(
          await input.shared.load(
            { sourceSessionID: sourceID, limit: 32, cursor: after, watermark: more ? watermark() : undefined },
            signal,
          ),
        )
        signal.throwIfAborted()
        if (
          !page.success ||
          page.data.sessionID !== input.sessionID ||
          page.data.sourceSessionID !== sourceID ||
          page.data.shareGeneration !== generation ||
          (more && page.data.watermark !== watermark())
        )
          throw new OrganizationTaskDirectoryError()
        items = page.data.items
        next = page.data.cursor
        checkpoint = page.data.watermark
      } else {
        const query = Read.Query.parse({
          operation: "tasks",
          rootSessionID: input.sessionID,
          sourceSessionID: sourceID,
          limit: 32,
          cursor: after,
        })
        const page = Read.Result.safeParse(await input.read(query, signal))
        signal.throwIfAborted()
        if (!page.success || page.data.operation !== "tasks" || !Read.matches(query, page.data, binding))
          throw new OrganizationTaskDirectoryError()
        items = page.data.items
        next = page.data.cursor
      }
      if (version !== revision) return
      if (!valid(items) || (after !== undefined && next === after)) throw new OrganizationTaskDirectoryError()
      setState("items", reconcile(items, { key: "sessionID" }))
      setCursor(next)
      setStart(after)
      setWatermark(checkpoint)
      setLoaded(true)
      setError(undefined)
    } catch (error) {
      if (signal.aborted || version !== revision) return
      if (organizationOwnerFailure(error)) {
        clear()
        input.invalidated?.(error)
      }
      if (!signal.aborted) setError(error)
    } finally {
      if (!signal.aborted && version === revision) setLoading(false)
    }
  }
  return { state, sourceID, cursor, earlier: () => start() !== undefined, loading, loaded, error, watermark, load }
}
