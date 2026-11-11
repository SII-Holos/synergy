import { createSignal, onCleanup } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import {
  OrganizationReadProtocol as Read,
  type OrganizationProtocol as Protocol,
} from "@ericsanchezok/synergy-organization-protocol"
import type { createOrganizationSessionReader } from "./private-read"
import { organizationOwnerFailure } from "./owner-error"

class AttachmentDirectoryError extends Error {
  readonly code = "invalid_response"
  constructor() {
    super("File metadata could not be verified")
  }
}

export function createOrganizationAttachmentDirectory(input: {
  sessionID: string
  sourceSessionID?: string
  messageID: string
  partID: string
  binding: Protocol.SessionBinding
  signal: AbortSignal
  read: ReturnType<typeof createOrganizationSessionReader>
  invalidated?: (error: unknown) => void
}) {
  const binding = { ...input.binding }
  const controller = new AbortController()
  const signal = AbortSignal.any([input.signal, controller.signal])
  const [state, setState] = createStore({ items: [] as Extract<Read.Result, { operation: "attachments" }>["items"] })
  const [cursor, setCursor] = createSignal<string>()
  const [start, setStart] = createSignal<string>()
  const [version, setVersion] = createSignal<string>()
  const [total, setTotal] = createSignal(0)
  const [loading, setLoading] = createSignal(false)
  const [loaded, setLoaded] = createSignal(false)
  const [error, setError] = createSignal<unknown>()
  let revision = 0
  function clear() {
    setState("items", reconcile([], { key: "ordinal" }))
    setCursor(undefined)
    setStart(undefined)
    setVersion(undefined)
    setTotal(0)
    setLoaded(false)
  }
  function abort() {
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
  async function load(more = false) {
    if (loading() || signal.aborted || (more && !cursor())) return
    const current = ++revision
    const after = more ? cursor() : undefined
    const expected = more ? version() : undefined
    setLoading(true)
    setError(undefined)
    try {
      const query = Read.Query.parse({
        operation: "attachments",
        rootSessionID: input.sessionID,
        sourceSessionID: input.sourceSessionID ?? input.sessionID,
        messageID: input.messageID,
        partID: input.partID,
        cursor: after,
        limit: 32,
      })
      const page = Read.Result.safeParse(await input.read(query, signal))
      signal.throwIfAborted()
      if (current !== revision) return
      if (
        !page.success ||
        page.data.operation !== "attachments" ||
        !Read.matches(query, page.data, binding) ||
        (more && page.data.version !== expected) ||
        (after !== undefined && page.data.cursor === after)
      )
        throw new AttachmentDirectoryError()
      setState("items", reconcile(page.data.items, { key: "ordinal" }))
      setCursor(page.data.cursor)
      setStart(after)
      setVersion(page.data.version)
      setTotal(page.data.total)
      setLoaded(true)
    } catch (error) {
      if (signal.aborted || current !== revision) return
      if (organizationOwnerFailure(error)) {
        clear()
        input.invalidated?.(error)
      }
      if (!signal.aborted) setError(error)
    } finally {
      if (!signal.aborted && current === revision) setLoading(false)
    }
  }
  return { state, cursor, version, total, loading, loaded, error, earlier: () => start() !== undefined, load }
}
