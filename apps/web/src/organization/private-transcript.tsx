import { batch, createEffect, createMemo, createSignal, For, on, onCleanup, onMount, Show } from "solid-js"
import { createStore, reconcile, produce } from "solid-js/store"
import { useLingui } from "@lingui/solid"
import { Virtualizer, type VirtualizerHandle } from "virtua/solid"
import { sha256 } from "@noble/hashes/sha256"
import { bytesToHex } from "@noble/hashes/utils"
import { DataProvider, type Data } from "@ericsanchezok/synergy-ui/context/data"
import { Message } from "@ericsanchezok/synergy-ui/message-part"
import { Button } from "@ericsanchezok/synergy-ui/button"
import {
  OrganizationReadContent,
  type OrganizationReadProtocol as Read,
  type OrganizationProtocol as Protocol,
  type OrganizationSyncProtocol as Sync,
} from "@ericsanchezok/synergy-organization-protocol"
import { useSpace } from "@/context/space"
import { usePlatform } from "@/context/platform"
import { createOrganizationSessionReader, OrganizationSessionReadError } from "./private-read"
import { projectOrganizationMessage, projectOrganizationPart } from "./transcript"
import { OrganizationTranscriptPart } from "./transcript-part"
import { WorkspaceError } from "./workspace-error"
import { organizationOwnerFailure } from "./owner-error"
import { organizationSessionMessages as messages } from "./session-messages"
import { organizationWorkspaceMessages as common } from "./workspace-messages"
import { PrivateContentDownload } from "./private-content"
import "./session.css"

type Native = Extract<Read.Content, { kind: "native" }>
type Summary = Extract<Read.Result, { operation: "parts" }>["items"][number]
const fieldLimit = 8 * 1024 * 1024
const residentLimit = 16 * 1024 * 1024
function references(part: Read.Part["part"]): Native[] {
  const fields =
    part.type === "tool"
      ? [part.input, part.output, part.error]
      : part.type === "text" || part.type === "reasoning" || part.type === "notice"
        ? [part.content]
        : []
  return fields.filter((field): field is Native => field?.kind === "native")
}
function fieldKey(messageID: string, partID: string, reference: Native) {
  return JSON.stringify([messageID, partID, reference.version, reference.field, reference.sha256])
}

export function PrivateOrganizationTranscript(props: {
  sessionID: string
  sourceSessionID?: string
  binding: Protocol.SessionBinding
  title?: (value: string) => void
  observed?: (value: Sync.Status) => void
  invalidated?: (error: unknown) => void
  read?: ReturnType<typeof createOrganizationSessionReader>
}) {
  const { _ } = useLingui()
  const space = useSpace()
  const platform = usePlatform()
  const view = space.current()!
  const controller = new AbortController()
  const signal = AbortSignal.any([view.signal, controller.signal])
  const sourceID = props.sourceSessionID ?? props.sessionID
  const connection = space.connection()!
  const dispatch =
    props.read ??
    createOrganizationSessionReader({
      api: space.client()!,
      bridge: platform.organization,
      connectionID: connection.transport === "desktop" ? connection.id : undefined,
      binding: props.binding,
      signal,
      authorizationRequired: () => space.authorizationRequired(view),
    })
  const read: ReturnType<typeof createOrganizationSessionReader> = (query, requestSignal = signal) =>
    dispatch(query, AbortSignal.any([signal, requestSignal]))
  const [state, setState] = createStore<{
    order: string[]
    messages: Record<string, Read.Message | undefined>
    records: Record<string, Read.Part[] | undefined>
    bodies: Record<string, string | undefined>
  }>({ order: [], messages: {}, records: {}, bodies: {} })
  const [data, setData] = createStore<Data>({ session: [], session_diff: {}, message: { [sourceID]: [] }, part: {} })
  const [cursor, setCursor] = createSignal<string>()
  const [loading, setLoading] = createSignal(false)
  const [loaded, setLoaded] = createSignal(false)
  const [error, setError] = createSignal<unknown>()
  const [shift, setShift] = createSignal(false)
  const [epoch, setEpoch] = createSignal(0)
  const [protectedIDs, setProtectedIDs] = createSignal<string[]>([])
  const protectedRows = createMemo(() =>
    protectedIDs()
      .map((id) => state.order.indexOf(id))
      .filter((index) => index >= 0),
  )
  let viewport: HTMLDivElement | undefined
  let virtualizer: VirtualizerHandle | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let revision = 0
  let residentBytes = 0
  const bodies = new Map<string, { bytes: number; messageID: string }>()

  function refresh(messageID: string) {
    setData(
      "part",
      messageID,
      reconcile(
        (state.records[messageID] ?? []).flatMap((record) => {
          const part = projectOrganizationPart(record, sourceID, (body) =>
            body.kind === "native" ? state.bodies[fieldKey(messageID, record.partID, body)] : undefined,
          )
          return part ? [part] : []
        }),
      ),
    )
  }
  function dropBody(key: string) {
    const value = bodies.get(key)
    if (!value) return
    residentBytes -= value.bytes
    bodies.delete(key)
    setState(
      "bodies",
      produce((values) => {
        delete values[key]
      }),
    )
    refresh(value.messageID)
  }
  function release(messageID: string) {
    for (const [key, body] of bodies) if (body.messageID === messageID) dropBody(key)
    setState(
      "records",
      produce((values) => {
        delete values[messageID]
      }),
    )
    setData(
      "part",
      produce((values) => {
        delete values[messageID]
      }),
    )
  }
  function fail(error: unknown) {
    if (signal.aborted) return
    if (organizationOwnerFailure(error)) {
      for (const id of state.order) release(id)
      setState(reconcile({ order: [], messages: {}, records: {}, bodies: {} }))
      setData(reconcile({ session: [], session_diff: {}, message: { [sourceID]: [] }, part: {} }))
      props.invalidated?.(error)
    }
    if (!signal.aborted) setError(error)
  }
  function retainInteractions() {
    const selection = document.getSelection()
    const elements = [document.activeElement, selection?.anchorNode?.parentElement, selection?.focusNode?.parentElement]
    setProtectedIDs([
      ...new Set(
        elements.flatMap((element) => {
          const id =
            element instanceof Element
              ? element.closest<HTMLElement>("[data-organization-message]")?.dataset.organizationMessage
              : undefined
          return id && state.order.includes(id) ? [id] : []
        }),
      ),
    ])
  }
  async function windowPage(older = false, polling = false) {
    if (loading()) return
    const version = ++revision
    setLoading(true)
    try {
      const result = await read({
        operation: "timeline",
        rootSessionID: props.sessionID,
        sourceSessionID: props.sourceSessionID,
        cursor: older ? cursor() : undefined,
        limit: 32,
      })
      if (signal.aborted || version !== revision || result.operation !== "timeline") return
      setShift(older)
      const previous = new Set(state.order)
      batch(() => {
        for (const item of [...result.referencedRoots, ...result.items]) {
          setState("messages", item.messageID, reconcile(item))
          const message = projectOrganizationMessage(item, sourceID)
          if (!message) continue
          const index = data.message[sourceID]?.findIndex((value) => value.id === item.messageID) ?? -1
          if (index < 0) setData("message", sourceID, (values = []) => [...values, message])
          else setData("message", sourceID, index, reconcile(message))
        }
        const latest = new Set(result.items.map((item) => item.messageID))
        const first = result.items[0]?.order
        const retained = polling
          ? state.order.filter((id) => latest.has(id) || (first !== undefined && state.messages[id]!.order < first))
          : older
            ? state.order
            : []
        let order = [...new Set([...retained, ...result.items.map((item) => item.messageID)])].sort((a, b) =>
          state.messages[a]!.order < state.messages[b]!.order
            ? -1
            : state.messages[a]!.order > state.messages[b]!.order
              ? 1
              : a.localeCompare(b),
        )
        if (order.length > 128) {
          const protectedSet = new Set(protectedIDs())
          const candidates = older ? [...order].reverse() : order
          for (const id of candidates) {
            if (order.length <= 128) break
            if (!protectedSet.has(id)) order = order.filter((value) => value !== id)
          }
        }
        setState("order", reconcile(order))
        for (const id of previous) if (!order.includes(id)) release(id)
        const kept = new Set([...order, ...result.referencedRoots.map((item) => item.messageID)])
        setData("message", sourceID, reconcile((data.message[sourceID] ?? []).filter((item) => kept.has(item.id))))
        setState(
          "messages",
          produce((values) => {
            for (const id of Object.keys(values)) if (!kept.has(id)) delete values[id]
          }),
        )
        if (!polling) setCursor(result.cursor)
        setLoaded(true)
        setError(undefined)
        setEpoch((value) => value + 1)
      })
      if (!older && !polling)
        requestAnimationFrame(() => {
          if (!signal.aborted && state.order.length)
            virtualizer?.scrollToIndex(state.order.length - 1, { align: "end" })
        })
    } catch (error) {
      fail(error)
    } finally {
      if (!signal.aborted && version === revision) setLoading(false)
    }
  }
  async function poll() {
    try {
      if (!props.read) {
        const [session, status] = await Promise.all([
          read({ operation: "session", rootSessionID: props.sessionID, sourceSessionID: props.sourceSessionID }),
          read({ operation: "status", rootSessionID: props.sessionID, sourceSessionID: props.sourceSessionID }),
        ])
        if (signal.aborted) return
        if (session.operation === "session") props.title?.(session.session.title)
        if (status.operation === "status") props.observed?.(status.status)
      }
      await windowPage(false, true)
    } catch (error) {
      fail(error)
    }
    if (!signal.aborted) timer = setTimeout(() => void poll(), document.visibilityState === "visible" ? 5000 : 15000)
  }
  async function body(messageID: string, partID: string, reference: Native, requestSignal: AbortSignal) {
    if (reference.bytes > fieldLimit) throw new OrganizationSessionReadError("CONTENT_TOO_LARGE")
    const key = fieldKey(messageID, partID, reference)
    if (state.bodies[key] !== undefined) return
    const decoder = new TextDecoder("utf-8", { fatal: true })
    const hash = sha256.create()
    let text = ""
    const result = await OrganizationReadContent.stream({
      rootSessionID: props.sessionID,
      sourceSessionID: props.sourceSessionID,
      messageID,
      partID,
      reference,
      expectedBinding: props.binding,
      signal: requestSignal,
      read,
      append: async (bytes) => {
        text += decoder.decode(bytes, { stream: true })
      },
      hash: { update: (bytes) => hash.update(bytes), digest: () => bytesToHex(hash.digest()) },
    })
    if (requestSignal.aborted) return
    if (result.state === "preparing") return result.pending
    text += decoder.decode()
    const record = state.records[messageID]?.find((value) => value.partID === partID)
    if (!record || !references(record.part).some((value) => fieldKey(messageID, partID, value) === key)) return
    for (const [candidate, entry] of bodies) {
      if (residentBytes + reference.bytes <= residentLimit) break
      if (!protectedIDs().includes(entry.messageID)) dropBody(candidate)
    }
    if (residentBytes + reference.bytes > 32 * 1024 * 1024) throw new OrganizationSessionReadError("CONTENT_TOO_LARGE")
    const previous = bodies.get(key)
    if (previous) residentBytes -= previous.bytes
    bodies.set(key, { bytes: reference.bytes, messageID })
    residentBytes += reference.bytes
    setState("bodies", key, text)
    refresh(messageID)
  }
  onMount(() => {
    void windowPage().then(() => {
      if (!signal.aborted) void poll()
    })
    document.addEventListener("selectionchange", retainInteractions)
    document.addEventListener("focusin", retainInteractions)
  })
  onCleanup(() => {
    controller.abort()
    clearTimeout(timer)
    document.removeEventListener("selectionchange", retainInteractions)
    document.removeEventListener("focusin", retainInteractions)
    bodies.clear()
  })
  return (
    <DataProvider data={data} directory={null} serverUrl={space.connection()!.issuer}>
      <div class="organization-transcript">
        <WorkspaceError error={error()} retry={() => void windowPage()} />
        <div class="organization-actions">
          <Show when={cursor()}>
            <Button disabled={loading()} onClick={() => void windowPage(true)}>
              {_({ id: "organization.session.older", message: "Load older messages" })}
            </Button>
          </Show>
          <Show when={loaded()}>
            <Button disabled={loading()} onClick={() => void windowPage()}>
              {_({ id: "organization.session.latest", message: "Latest messages" })}
            </Button>
          </Show>
        </div>
        <Show when={loading() && !loaded()}>
          <p role="status">{_(common.loading)}</p>
        </Show>
        <div class="organization-transcript-viewport" ref={viewport} data-scroll-viewport="vertical">
          <Virtualizer
            ref={(value) => {
              virtualizer = value
            }}
            data={state.order}
            itemKey={(id) => id}
            scrollRef={viewport}
            shift={shift()}
            keepMounted={protectedRows()}
            observeContent={() => "sync"}
          >
            {(id) => (
              <Show when={state.messages[id]}>
                {(event) => (
                  <PrivateMessageRow
                    message={data.message[sourceID]?.find((value) => value.id === id)}
                    event={event()}
                    epoch={epoch()}
                    signal={signal}
                    sessionID={props.sessionID}
                    sourceSessionID={props.sourceSessionID}
                    read={read}
                    binding={props.binding}
                    parts={data.part[id] ?? []}
                    records={state.records[id] ?? []}
                    store={(records) => {
                      setState("records", id, reconcile(records, { key: "partID" }))
                      const kept = new Set(
                        records.flatMap((record) =>
                          references(record.part).map((reference) => fieldKey(id, record.partID, reference)),
                        ),
                      )
                      for (const [key, value] of bodies) if (value.messageID === id && !kept.has(key)) dropBody(key)
                      refresh(id)
                    }}
                    release={() => release(id)}
                    body={(partID, reference, current) => body(id, partID, reference, current)}
                    fail={fail}
                    cached={(partID, reference) => state.bodies[fieldKey(id, partID, reference)] !== undefined}
                  />
                )}
              </Show>
            )}
          </Virtualizer>
        </div>
      </div>
    </DataProvider>
  )
}

function PrivateMessageRow(props: {
  event: Read.Message
  message?: import("@ericsanchezok/synergy-sdk").Message
  parts: import("@ericsanchezok/synergy-sdk").Part[]
  records: Read.Part[]
  epoch: number
  sessionID: string
  sourceSessionID?: string
  binding: Protocol.SessionBinding
  signal: AbortSignal
  read: ReturnType<typeof createOrganizationSessionReader>
  store: (records: Read.Part[]) => void
  release: () => void
  fail: (error: unknown) => void
  cached: (partID: string, reference: Native) => boolean
  body: (
    partID: string,
    reference: Native,
    signal: AbortSignal,
  ) => Promise<Extract<Read.Result, { operation: "partContent"; state: "preparing" }> | undefined>
}) {
  const { _ } = useLingui()
  const controller = new AbortController()
  const signal = AbortSignal.any([props.signal, controller.signal])
  const [state, setState] = createStore({ summaries: [] as Summary[] })
  const [cursor, setCursor] = createSignal<string>()
  const [pageStart, setPageStart] = createSignal<string>()
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal<unknown>()
  const [pending, setPending] = createSignal(false)
  let revision = 0
  let loading = false
  async function load(more = false, refresh = false) {
    if (loading) return
    loading = true
    const version = ++revision
    setBusy(true)
    setError(undefined)
    setPending(false)
    try {
      const start = more ? cursor() : refresh ? pageStart() : undefined
      const page = await props.read(
        {
          operation: "parts",
          rootSessionID: props.sessionID,
          sourceSessionID: props.sourceSessionID,
          messageID: props.event.messageID,
          cursor: start,
          limit: 64,
        },
        signal,
      )
      if (signal.aborted || version !== revision || page.operation !== "parts") return
      const summaries = page.items
      setState("summaries", reconcile(summaries, { key: "partID" }))
      setCursor(page.cursor)
      setPageStart(start)
      const records: Read.Part[] = []
      const queue = [...summaries.filter((item) => item.render !== false)]
      await Promise.all(
        Array.from({ length: Math.min(4, queue.length) }, async () => {
          while (queue.length) {
            const summary = queue.shift()!
            const result = await props.read(
              {
                operation: "partContent",
                rootSessionID: props.sessionID,
                sourceSessionID: props.sourceSessionID,
                messageID: props.event.messageID,
                partID: summary.partID,
                version: summary.content.version,
                field: "text",
                offset: 0,
                length: 1,
              },
              signal,
            )
            if (signal.aborted || version !== revision || result.operation !== "partContent") return
            if (result.state === "preparing") {
              setPending(true)
              continue
            }
            records.push(result.value)
          }
        }),
      )
      if (signal.aborted || version !== revision) return
      records.sort(
        (a, b) =>
          summaries.findIndex((value) => value.partID === a.partID) -
          summaries.findIndex((value) => value.partID === b.partID),
      )
      props.store(records)
      for (const record of records)
        for (const reference of references(record.part)) {
          if (reference.bytes > 256 * 1024 || props.cached(record.partID, reference)) continue
          const pending = await props.body(record.partID, reference, signal)
          if (pending) setPending(true)
        }
    } catch (error) {
      if (!signal.aborted && version === revision) {
        setError(error)
        props.fail(error)
      }
    } finally {
      loading = false
      if (!signal.aborted && version === revision) setBusy(false)
    }
  }
  async function body(partID: string, reference: Native) {
    setBusy(true)
    setError(undefined)
    try {
      setPending(!!(await props.body(partID, reference, signal)))
    } catch (error) {
      if (!signal.aborted) {
        setError(error)
        props.fail(error)
      }
    } finally {
      if (!signal.aborted) setBusy(false)
    }
  }
  createEffect(
    on(
      () => props.epoch,
      () => void load(false, true),
    ),
  )
  onCleanup(() => {
    controller.abort()
    props.release()
  })
  return (
    <article class="organization-transcript-message" data-organization-message={props.event.messageID}>
      <WorkspaceError error={error()} retry={() => void load()} />
      <Show when={props.message} fallback={<p>{props.event.summary}</p>}>
        {(message) => (
          <Show when={message().role === "assistant"} fallback={<Message message={message()} parts={props.parts} />}>
            <For each={props.records}>
              {(record) => (
                <OrganizationTranscriptPart
                  record={record}
                  part={props.parts.find((part) => part.id === record.partID)}
                  message={message()}
                />
              )}
            </For>
          </Show>
        )}
      </Show>
      <For
        each={state.summaries.filter(
          (summary) => summary.render !== false && !props.records.some((record) => record.partID === summary.partID),
        )}
      >
        {(summary) => <p>{summary.preview}</p>}
      </For>
      <Show when={pending()}>
        <div role="status">
          <p>
            {_({
              id: "organization.session.preparing",
              message: "Content is preparing. Retry to load its verified bytes.",
            })}
          </p>
          <Button disabled={busy()} onClick={() => void load()}>
            {_(common.retry)}
          </Button>
        </div>
      </Show>
      <For each={props.records}>
        {(record) => (
          <For
            each={references(record.part).filter(
              (reference) => reference.bytes > 256 * 1024 || reference.original === "partial",
            )}
          >
            {(reference) => (
              <div class="organization-native-field">
                <span>
                  {new Intl.NumberFormat().format(reference.bytes)}{" "}
                  {_({ id: "organization.session.bytes", message: "bytes" })}
                </span>
                <Show when={reference.original === "partial"}>
                  <span>{_({ id: "organization.session.partial", message: "Only retained output is available" })}</span>
                </Show>
                <Show when={!props.cached(record.partID, reference) && reference.bytes <= fieldLimit}>
                  <Button disabled={busy()} onClick={() => void body(record.partID, reference)}>
                    {_(messages.loadContent)}
                  </Button>
                </Show>
                <PrivateContentDownload
                  rootSessionID={props.sessionID}
                  sourceSessionID={props.sourceSessionID}
                  messageID={props.event.messageID}
                  partID={record.partID}
                  reference={reference}
                  binding={props.binding}
                  read={props.read}
                  invalidated={props.fail}
                />
              </div>
            )}
          </For>
        )}
      </For>
      <Show when={cursor()}>
        <Button disabled={busy()} onClick={() => void load(true)}>
          {_({ id: "organization.session.nextParts", message: "Next message parts" })}
        </Button>
      </Show>
      <Show when={pageStart()}>
        <Button disabled={busy()} onClick={() => void load()}>
          {_({ id: "organization.session.firstParts", message: "First message parts" })}
        </Button>
      </Show>
    </article>
  )
}
