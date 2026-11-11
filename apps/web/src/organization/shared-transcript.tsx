import { batch, createEffect, createMemo, createSignal, For, on, onCleanup, onMount, Show } from "solid-js"
import { createStore, reconcile, produce } from "solid-js/store"
import { useLingui } from "@lingui/solid"
import { Virtualizer, type VirtualizerHandle } from "virtua/solid"
import { DataProvider, type Data } from "@ericsanchezok/synergy-ui/context/data"
import { Message } from "@ericsanchezok/synergy-ui/message-part"
import { Button } from "@ericsanchezok/synergy-ui/button"
import type { OrganizationSyncProtocol as Sync } from "@ericsanchezok/synergy-organization-protocol"
import type { OrgPublicationFile } from "@ericsanchezok/synergy-sdk/organization"
import { useSpace } from "@/context/space"
import { WorkspaceError } from "./workspace-error"
import { PublicationFiles, publicationContent } from "./publication-files"
import { streamPublicationDownload } from "./publication-transfer"
import {
  projectOrganizationMessage,
  projectOrganizationPart,
  organizationPartBlobs,
  type OrganizationMessageEvent,
  type OrganizationPartEvent,
} from "./transcript"
import { organizationSessionMessages as messages } from "./session-messages"
import { organizationWorkspaceMessages as common } from "./workspace-messages"
import "./session.css"

export function SharedOrganizationTranscript(props: {
  sessionID: string
  sourceSessionID?: string
  shareGeneration: number
}) {
  const { _ } = useLingui()
  const space = useSpace()
  const api = space.client()!
  const view = space.current()!
  const controller = new AbortController()
  const signal = AbortSignal.any([view.signal, controller.signal])
  const options = { throwOnError: true, signal } as const
  const sourceID = props.sourceSessionID ?? props.sessionID
  const [state, setState] = createStore<{
    order: string[]
    messages: Record<string, OrganizationMessageEvent | undefined>
    parts: Record<string, OrganizationPartEvent[] | undefined>
    cursors: Record<string, string | undefined>
    partWatermarks: Record<string, number | undefined>
    pageStarts: Record<string, string | undefined>
    trimmed: Record<string, boolean | undefined>
    complete: Record<string, boolean | undefined>
    bodies: Record<string, string | undefined>
  }>({
    order: [],
    messages: {},
    parts: {},
    cursors: {},
    partWatermarks: {},
    pageStarts: {},
    trimmed: {},
    complete: {},
    bodies: {},
  })
  const [data, setData] = createStore<Data>({ session: [], session_diff: {}, message: { [sourceID]: [] }, part: {} })
  const [cursor, setCursor] = createSignal<string>()
  const [replaySequence, setReplaySequence] = createSignal<number>()
  const [loading, setLoading] = createSignal(false)
  const [loaded, setLoaded] = createSignal(false)
  const [error, setError] = createSignal<unknown>()
  const [shift, setShift] = createSignal(false)
  const [protectedIDs, setProtectedIDs] = createSignal<string[]>([])
  const [rowEpoch, setRowEpoch] = createSignal(0)
  const protectedRows = createMemo(() =>
    protectedIDs()
      .map((id) => state.order.indexOf(id))
      .filter((index) => index >= 0),
  )
  const inFlight = new Map<string, { signal: AbortSignal; epoch: number }>()
  let windowEpoch = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  let viewport: HTMLDivElement | undefined
  let virtualizer: VirtualizerHandle | undefined
  let bodyBytes = 0
  const bodySizes = new Map<string, number>()
  const bodyOwners = new Map<string, Set<string>>()
  function invalidate() {
    batch(() => {
      setState(
        reconcile({
          order: [],
          messages: {},
          parts: {},
          cursors: {},
          partWatermarks: {},
          pageStarts: {},
          trimmed: {},
          complete: {},
          bodies: {},
        }),
      )
      setData(reconcile({ session: [], session_diff: {}, message: { [sourceID]: [] }, part: {} }))
    })
    bodySizes.clear()
    bodyOwners.clear()
    bodyBytes = 0
  }
  function fail(error: unknown) {
    if (signal.aborted) return
    const code = error && typeof error === "object" && "code" in error ? error.code : undefined
    if (code === "PERMISSION_DENIED" || code === "AUTHENTICATION_REQUIRED" || code === "NOT_FOUND") invalidate()
    setError(error)
  }
  function refresh(messageID: string) {
    const references = new Set(
      (state.parts[messageID] ?? []).flatMap((record) =>
        record.part ? organizationPartBlobs(record.part).map((body) => body.hash) : [],
      ),
    )
    for (const [hash, owners] of bodyOwners)
      if (owners.has(messageID) && !references.has(hash)) releaseBody(hash, messageID)
    for (const hash of references) {
      let owners = bodyOwners.get(hash)
      if (!owners) bodyOwners.set(hash, (owners = new Set()))
      owners.add(messageID)
    }
    setData(
      "part",
      messageID,
      reconcile(
        (state.parts[messageID] ?? [])
          .map((part) => projectOrganizationPart(part, props.sessionID, (body) => state.bodies[body.hash]))
          .filter((part) => part !== undefined),
      ),
    )
  }
  function dropBody(hash: string) {
    bodyBytes -= bodySizes.get(hash) ?? 0
    bodySizes.delete(hash)
    setState(
      "bodies",
      produce((bodies) => {
        delete bodies[hash]
      }),
    )
  }
  function releaseBody(hash: string, messageID: string) {
    const owners = bodyOwners.get(hash)
    owners?.delete(messageID)
    if (owners?.size) return
    bodyOwners.delete(hash)
    dropBody(hash)
  }
  function prune() {
    if (state.order.length <= 128) return
    const retained = new Set(protectedIDs())
    if (virtualizer)
      for (let index = virtualizer.findStartIndex(); index <= virtualizer.findEndIndex(); index++) {
        const id = state.order[index]
        if (id) retained.add(id)
      }
    const candidates = state.order.filter((id) => !retained.has(id))
    const remove = (shift() ? candidates.reverse() : candidates).slice(0, state.order.length - 128)
    const removed = new Set(remove)
    for (const id of remove) {
      setState(
        produce((state) => {
          delete state.messages[id]
          delete state.parts[id]
          delete state.cursors[id]
          delete state.partWatermarks[id]
          delete state.pageStarts[id]
          delete state.trimmed[id]
          delete state.complete[id]
        }),
      )
      setData(
        "part",
        produce((parts) => {
          delete parts[id]
        }),
      )
      for (const [hash, owners] of bodyOwners) if (owners.has(id)) releaseBody(hash, id)
    }
    setState("order", reconcile(state.order.filter((id) => !removed.has(id))))
    setData(
      "message",
      sourceID,
      reconcile((data.message[sourceID] ?? []).filter((message) => !removed.has(message.id))),
    )
  }
  function apply(event: Sync.Event, replaying = false) {
    if (event.type !== "message" && event.type !== "part") return
    if ((event.sessionID ?? props.sessionID) !== sourceID) return
    if (event.type === "message") {
      const previous = state.messages[event.messageID]
      if (previous && previous.sequence >= event.sequence) return
      if (event.removed) {
        if (!previous) return
        release(event.messageID)
        setState(
          "messages",
          produce((messages) => {
            delete messages[event.messageID]
          }),
        )
        setState("order", reconcile(state.order.filter((id) => id !== event.messageID)))
        setData(
          "message",
          sourceID,
          reconcile((data.message[sourceID] ?? []).filter((message) => message.id !== event.messageID)),
        )
        return
      }
      const oldest = state.messages[state.order[0] ?? ""]
      if (replaying && !previous && oldest && event.createdAt < oldest.createdAt) return
      setState("messages", event.messageID, reconcile(event))
      const message = projectOrganizationMessage(event, props.sessionID)
      const order = state.order.filter((id) => id !== event.messageID)
      if (!event.removed) {
        let low = 0
        let high = order.length
        while (low < high) {
          const middle = (low + high) >>> 1
          const current = state.messages[order[middle]!]!
          if (
            current.createdAt < event.createdAt ||
            (current.createdAt === event.createdAt && current.messageID < event.messageID)
          )
            low = middle + 1
          else high = middle
        }
        order.splice(low, 0, event.messageID)
      }
      setState("order", reconcile(order))
      const canonical = data.message[sourceID] ?? []
      const index = canonical.findIndex((value) => value.id === event.messageID)
      if (index !== -1 && message) setData("message", sourceID, index, reconcile(message))
      else if (index !== -1)
        setData("message", sourceID, reconcile(canonical.filter((value) => value.id !== event.messageID)))
      else if (message) {
        const position = order.indexOf(event.messageID)
        const before = new Set(order.slice(0, position))
        const insertion = canonical.findIndex((value) => !before.has(value.id))
        const next = [...canonical]
        next.splice(insertion < 0 ? next.length : insertion, 0, message)
        setData("message", sourceID, reconcile(next))
      }
      prune()
      return
    }
    if (!state.messages[event.messageID]) return
    if (!state.parts[event.messageID] && !inFlight.has(event.messageID)) return
    const parts = state.parts[event.messageID] ?? []
    const index = parts.findIndex((value) => value.partID === event.partID)
    if (index !== -1 && parts[index]!.sequence >= event.sequence) return
    if (replaying && index === -1 && state.complete[event.messageID] === false && !inFlight.has(event.messageID)) return
    const next = [...parts]
    if (index !== -1) next.splice(index, 1)
    if (!event.removed) {
      let low = 0
      let high = next.length
      while (low < high) {
        const middle = (low + high) >>> 1
        if (next[middle]!.partID < event.partID) low = middle + 1
        else high = middle
      }
      next.splice(low, 0, event)
    }
    if (next.length > 64) {
      const selection = document.getSelection()
      const elements = [
        document.activeElement,
        selection?.anchorNode?.parentElement,
        selection?.focusNode?.parentElement,
      ]
      const retained = new Set(
        elements.flatMap((value) =>
          value instanceof Element ? [value.closest<HTMLElement>("[data-part-id]")?.dataset.partId] : [],
        ),
      )
      while (next.length > 64) {
        const removable = next.findIndex((value) => !retained.has(value.partID))
        if (removable < 0) break
        next.splice(removable, 1)
      }
      setState("trimmed", event.messageID, true)
    }
    setState("parts", event.messageID, reconcile(next))
    refresh(event.messageID)
  }
  async function windowPage(more = false) {
    if (loading()) return
    setLoading(true)
    setError(undefined)
    setShift(more)
    const epoch = more ? windowEpoch : ++windowEpoch
    try {
      const result = await api.orgSessionSync.messages(
        {
          sessionID: props.sessionID,
          sourceSessionID: sourceID,
          limit: 32,
          latest: true,
          cursor: more ? cursor() : undefined,
        },
        options,
      )
      if (signal.aborted || epoch !== windowEpoch) return
      if (result.data.shareGeneration !== props.shareGeneration) {
        invalidate()
        throw { code: "REVISION_CONFLICT" }
      }
      if (!more) {
        invalidate()
        setReplaySequence(result.data.watermark)
      }
      batch(() => {
        for (const event of result.data.items) apply(event)
        setCursor(result.data.cursor)
        setLoaded(true)
        if (!more) setRowEpoch(epoch)
      })
    } catch (error) {
      fail(error)
    } finally {
      if (!signal.aborted) setLoading(false)
    }
  }
  async function parts(messageID: string, requestSignal: AbortSignal) {
    const epoch = windowEpoch
    const previous = inFlight.get(messageID)
    if ((previous?.epoch === epoch && !previous.signal.aborted) || state.complete[messageID]) return
    const request = { signal: requestSignal, epoch }
    inFlight.set(messageID, request)
    const pageStart = state.cursors[messageID]
    try {
      const result = await api.orgSessionSync.parts(
        {
          sessionID: props.sessionID,
          sourceSessionID: sourceID,
          messageID,
          limit: 64,
          latest: true,
          cursor: state.cursors[messageID],
        },
        { throwOnError: true, signal: requestSignal },
      )
      if (requestSignal.aborted || epoch !== windowEpoch) return
      if (result.data.shareGeneration !== props.shareGeneration) {
        invalidate()
        throw { code: "REVISION_CONFLICT" }
      }
      batch(() => {
        setState(
          "parts",
          messageID,
          reconcile((state.parts[messageID] ?? []).filter((event) => event.sequence > result.data.watermark)),
        )
        for (const event of result.data.items) apply(event)
        setState("cursors", messageID, result.data.cursor)
        setState("partWatermarks", messageID, result.data.watermark)
        setState("pageStarts", messageID, pageStart)
        setState("complete", messageID, result.data.complete)
      })
    } catch (error) {
      if (!requestSignal.aborted && epoch === windowEpoch) fail(error)
    } finally {
      if (inFlight.get(messageID) === request) inFlight.delete(messageID)
    }
  }
  function release(messageID: string) {
    setState(
      produce((state) => {
        delete state.parts[messageID]
        delete state.cursors[messageID]
        delete state.partWatermarks[messageID]
        delete state.pageStarts[messageID]
        delete state.trimmed[messageID]
        delete state.complete[messageID]
      }),
    )
    setData(
      "part",
      produce((parts) => {
        delete parts[messageID]
      }),
    )
    for (const [hash, owners] of bodyOwners) if (owners.has(messageID)) releaseBody(hash, messageID)
  }
  async function first(messageID: string, requestSignal: AbortSignal) {
    const previous = inFlight.get(messageID)
    if (previous?.epoch === windowEpoch && !previous.signal.aborted) return
    batch(() => {
      setState("cursors", messageID, undefined)
      setState("partWatermarks", messageID, undefined)
      setState("pageStarts", messageID, undefined)
      setState("trimmed", messageID, false)
      setState("complete", messageID, false)
    })
    await parts(messageID, requestSignal)
  }
  async function replay() {
    const sequence = replaySequence()
    const epoch = windowEpoch
    if (sequence === undefined || signal.aborted) return
    try {
      const result = await api.orgSessionSync.events(
        { sessionID: props.sessionID, cursor: sequence, limit: 256 },
        options,
      )
      if (signal.aborted || epoch !== windowEpoch || replaySequence() !== sequence) return
      if (result.data.shareGeneration !== props.shareGeneration) {
        invalidate()
        throw { code: "REVISION_CONFLICT" }
      }
      setShift(false)
      batch(() => {
        for (const event of result.data.items) apply(event, true)
        setReplaySequence(result.data.cursor ?? result.data.nextSeq - 1)
      })
    } catch (error) {
      if (epoch === windowEpoch && replaySequence() === sequence) fail(error)
    } finally {
      if (!signal.aborted) timer = setTimeout(() => void replay(), document.visibilityState === "visible" ? 1000 : 5000)
    }
  }
  async function body(messageID: string, value: Extract<Sync.Content, { kind: "blob" }>, requestSignal: AbortSignal) {
    if (value.bytes > 8 * 1024 * 1024) return
    const epoch = windowEpoch
    const decoder = new TextDecoder("utf-8", { fatal: true })
    const chunks: string[] = []
    await streamPublicationDownload({
      file: { bytes: value.bytes, sha256: value.hash },
      signal: requestSignal,
      read: (start, end) =>
        publicationContent(
          api,
          { kind: "session", sessionID: props.sessionID, shareGeneration: props.shareGeneration },
          value.hash,
          start,
          end,
          requestSignal,
        ),
      async append(bytes) {
        chunks.push(decoder.decode(bytes, { stream: true }))
      },
    })
    chunks.push(decoder.decode())
    if (requestSignal.aborted || epoch !== windowEpoch || !bodyOwners.get(value.hash)?.has(messageID)) return
    const retainedBytes = bodySizes.get(value.hash) ?? 0
    for (const hash of bodySizes.keys()) {
      if (bodyBytes + value.bytes - retainedBytes <= 16 * 1024 * 1024) break
      const owners = bodyOwners.get(hash)
      if (
        hash === value.hash ||
        owners?.has(messageID) ||
        [...(owners ?? [])].some((owner) => protectedIDs().includes(owner))
      )
        continue
      dropBody(hash)
      for (const owner of [...(owners ?? [])]) refresh(owner)
    }
    if (bodyBytes + value.bytes - (bodySizes.get(value.hash) ?? 0) > 32 * 1024 * 1024)
      throw new Error("Selected transcript content fills the reading cache")
    bodyBytes += value.bytes - (bodySizes.get(value.hash) ?? 0)
    bodySizes.set(value.hash, value.bytes)
    setState("bodies", value.hash, chunks.join(""))
    for (const owner of [...(bodyOwners.get(value.hash) ?? [])]) refresh(owner)
  }
  function retainInteractions() {
    const elements = [
      document.activeElement,
      document.getSelection()?.anchorNode?.parentElement,
      document.getSelection()?.focusNode?.parentElement,
    ]
    setProtectedIDs([
      ...new Set(
        elements.flatMap((element) => {
          const id =
            element instanceof Element
              ? element.closest<HTMLElement>("[data-organization-message]")?.dataset.organizationMessage
              : undefined
          const index = id ? state.order.indexOf(id) : -1
          return index >= 0 && id ? [id] : []
        }),
      ),
    ])
  }
  onMount(() => {
    void windowPage().then(() => {
      if (!signal.aborted) void replay()
    })
    document.addEventListener("selectionchange", retainInteractions)
    document.addEventListener("focusin", retainInteractions)
  })
  onCleanup(() => {
    controller.abort()
    if (timer) clearTimeout(timer)
    document.removeEventListener("selectionchange", retainInteractions)
    document.removeEventListener("focusin", retainInteractions)
    invalidate()
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
        <Show when={loading()}>
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
                  <SharedMessageRow
                    event={event()}
                    epoch={rowEpoch()}
                    message={data.message[sourceID]?.find((value) => value.id === id)}
                    parts={data.part[id] ?? []}
                    records={state.parts[id] ?? []}
                    complete={state.complete[id] ?? false}
                    bodyText={(hash) => state.bodies[hash]}
                    load={(signal) => parts(id, signal)}
                    first={(signal) => first(id, signal)}
                    hasPrevious={!!state.pageStarts[id] || !!state.trimmed[id]}
                    release={() => release(id)}
                    body={(value, signal) => body(id, value, signal)}
                    sessionID={props.sessionID}
                    shareGeneration={props.shareGeneration}
                    signal={signal}
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

function SharedMessageRow(props: {
  epoch: number
  event: OrganizationMessageEvent
  message?: import("@ericsanchezok/synergy-sdk").Message
  parts: import("@ericsanchezok/synergy-sdk").Part[]
  records: OrganizationPartEvent[]
  complete: boolean
  hasPrevious: boolean
  bodyText: (hash: string) => string | undefined
  load: (signal: AbortSignal) => Promise<void>
  first: (signal: AbortSignal) => Promise<void>
  release: () => void
  body: (value: Extract<Sync.Content, { kind: "blob" }>, signal: AbortSignal) => Promise<void>
  sessionID: string
  shareGeneration: number
  signal: AbortSignal
}) {
  const { _ } = useLingui()
  const controller = new AbortController()
  const signal = AbortSignal.any([props.signal, controller.signal])
  onCleanup(() => {
    controller.abort()
    props.release()
  })
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal<unknown>()
  let reading = 0
  const blobs = createMemo(() =>
    props.records
      .flatMap((record) => (record.part ? organizationPartBlobs(record.part) : []))
      .filter((value, index, all) => all.findIndex((other) => other.hash === value.hash) === index),
  )
  const files = createMemo<OrgPublicationFile[]>(() => [
    ...blobs().map((value) => ({
      path: `${value.blobID}.txt`,
      fileID: value.hash,
      sha256: value.hash,
      bytes: value.bytes,
      mediaType: value.mediaType,
    })),
    ...props.records.flatMap((record) =>
      record.part?.type === "attachment" && record.part.hash && record.part.bytes !== undefined
        ? [
            {
              path: record.part.filename,
              fileID: record.part.hash,
              sha256: record.part.hash,
              bytes: record.part.bytes,
              mediaType: record.part.mediaType,
            },
          ]
        : [],
    ),
  ])
  async function load(first = false) {
    const version = ++reading
    setBusy(true)
    try {
      await (first ? props.first(signal) : props.load(signal))
    } finally {
      if (!signal.aborted && version === reading) setBusy(false)
    }
  }
  async function body(value: Extract<Sync.Content, { kind: "blob" }>) {
    const version = ++reading
    setBusy(true)
    setError(undefined)
    try {
      await props.body(value, signal)
    } catch (error) {
      if (!signal.aborted && version === reading) setError(error)
    } finally {
      if (!signal.aborted && version === reading) setBusy(false)
    }
  }
  createEffect(
    on(
      () => props.epoch,
      () => void load(),
    ),
  )
  return (
    <article class="organization-transcript-message" data-organization-message={props.event.messageID}>
      <WorkspaceError error={error()} />
      <Show
        when={props.message}
        fallback={
          <>
            <p>{_(messages.historyUnavailable)}</p>
            <p>{props.event.summary}</p>
          </>
        }
      >
        {(message) => <Message message={message()} parts={props.parts} />}
      </Show>
      <Show when={props.hasPrevious}>
        <Button disabled={busy()} onClick={() => void load(true)}>
          {_({ id: "organization.session.firstParts", message: "First message parts" })}
        </Button>
      </Show>
      <Show when={!props.complete}>
        <Button disabled={busy()} onClick={() => void load()}>
          {_(busy() ? common.loading : { id: "organization.session.nextParts", message: "Next message parts" })}
        </Button>
      </Show>
      <For each={blobs().filter((value) => props.bodyText(value.hash) === undefined && value.bytes <= 8 * 1024 * 1024)}>
        {(value) => (
          <Button disabled={busy()} onClick={() => void body(value)}>
            {_(messages.loadContent)}
          </Button>
        )}
      </For>
      <Show when={files().length}>
        <PublicationFiles
          files={files()}
          target={{ kind: "session", sessionID: props.sessionID, shareGeneration: props.shareGeneration }}
        />
      </Show>
    </article>
  )
}
