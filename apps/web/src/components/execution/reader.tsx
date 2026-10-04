import { createEffect, createMemo, createSignal, For, on, onCleanup, Show, type JSX } from "solid-js"
import { useLingui } from "@lingui/solid"
import { VList, type VListHandle } from "virtua/solid"
import type { ExecutionContentSearch, RolloutEvidenceContent } from "@ericsanchezok/synergy-sdk/client"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { getSemanticIcon } from "@ericsanchezok/synergy-ui/semantic-icon"
import { Popover } from "@ericsanchezok/synergy-ui/popover"
import { copyTextToClipboard } from "@ericsanchezok/synergy-ui/clipboard"
import { useSDK } from "@/context/sdk"
import { EvidencePages } from "./reader-state"
import { E } from "./i18n"

type Row = { offset: number; text: string }
function lines(text: string, offset: number) {
  const result: Row[] = []
  for (let start = 0; start < text.length; ) {
    let end = Math.min(text.length, start + 1024)
    let last = start
    for (let line = 0; line < 32; line++) {
      const newline = text.indexOf("\n", last)
      if (newline < 0 || newline >= end) break
      last = newline + 1
      if (line === 31) end = last
    }
    if (end < text.length && /[\uDC00-\uDFFF]/.test(text[end])) end--
    const value = text.slice(start, end)
    result.push({ offset, text: value })
    offset += new TextEncoder().encode(value).byteLength
    start = end
  }
  return result
}
function save(blob: Blob, field: string, json: boolean) {
  const url = URL.createObjectURL(blob)
  const link = document.createElement("a")
  link.href = url
  link.download = "execution-" + field + (json ? ".json" : ".txt")
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export function EvidenceReader(props: {
  sessionID: string
  nodeID: string
  field: string
  runID?: string
  revision: number
  label?: string
}) {
  const { _ } = useLingui()
  const sdk = useSDK()
  const pages = new EvidencePages(2 * 1024 * 1024)
  const rowCache = new Map<number, Row[]>()
  const checkpoints = new Map<number, number | null>()
  const [stamp, setStamp] = createSignal(0)
  const [meta, setMeta] = createSignal<RolloutEvidenceContent>()
  const [menu, setMenu] = createSignal(false)
  const [wrap, setWrap] = createSignal(true)
  const [loading, setLoading] = createSignal(false)
  const [error, setError] = createSignal(false)
  const [search, setSearch] = createSignal("")
  const [searchOpen, setSearchOpen] = createSignal(false)
  const [matches, setMatches] = createSignal<ExecutionContentSearch>()
  const [searching, setSearching] = createSignal(false)
  const [progress, setProgress] = createSignal<number>()
  const [feedback, setFeedback] = createSignal<"copied" | "copyFailed">()
  const [openedAt, setOpenedAt] = createSignal(props.revision)
  let readAbort: AbortController | undefined
  let searchAbort: AbortController | undefined
  let copyAbort: AbortController | undefined
  let sequence = 0
  let searchSequence = 0
  let copySequence = 0
  let disposed = false
  let list: VListHandle | undefined
  let protectedPage: number | undefined
  let debounce: ReturnType<typeof setTimeout> | undefined
  const params = () => ({
    sessionID: props.sessionID,
    nodeID: props.nodeID,
    field: props.field,
    runID: props.runID,
    version: meta()?.contentVersion,
  })
  const rows = createMemo(() => {
    stamp()
    const values = pages.pages()
    const valid = new Set(values.map((value) => value.offset))
    for (const offset of rowCache.keys()) if (!valid.has(offset)) rowCache.delete(offset)
    for (const page of values) {
      if (!rowCache.has(page.offset)) {
        rowCache.set(page.offset, lines(page.text, page.offset))
      }
    }
    let bytes = [...rowCache.values()].reduce(
      (sum, rows) => sum + rows.reduce((sum, row) => sum + row.text.length * 2 + 72, 0),
      0,
    )
    for (const page of values.filter((page) => page.offset !== protectedPage)) {
      if (bytes <= 3 * 1024 * 1024) break
      bytes -= rowCache.get(page.offset)!.reduce((sum, row) => sum + row.text.length * 2 + 72, 0)
      rowCache.delete(page.offset)
      pages.delete(page.offset)
    }
    return pages.pages().flatMap((page) => rowCache.get(page.offset) ?? [])
  })
  const read = async (offset: number, reset = false, before?: number) => {
    if ((loading() && !reset) || disposed) return
    readAbort?.abort()
    readAbort = new AbortController()
    const controller = readAbort
    const version = ++sequence
    const first = list?.findStartIndex() ?? 0
    const anchor = reset ? undefined : rows()[first]?.offset
    const relative = reset || !list ? 0 : list.scrollOffset - list.getItemOffset(first)
    const visible = anchor === undefined ? undefined : pages.pages().findLast((page) => page.offset <= anchor)
    if (visible) {
      protectedPage = visible.offset
      pages.touch(visible.offset)
    }
    if (reset) {
      pages.clear()
      rowCache.clear()
      setStamp((value) => value + 1)
    }
    setLoading(true)
    setError(false)
    try {
      const end = before
      if (end !== undefined && offset >= end) return
      let content: RolloutEvidenceContent | undefined
      for (let shift = 0; shift <= (before === undefined ? 0 : 3); shift++) {
        const response = await sdk.client.session.executionContent(
          {
            ...params(),
            offset: offset + shift,
            limit: Math.min(65_536, end === undefined ? 65_536 : end - offset - shift),
          },
          { signal: controller.signal },
        )
        if (response.data) {
          content = response.data
          break
        }
        if (before === undefined || response.response.status !== 400 || shift === 3)
          throw new Error("Execution range could not be read")
      }
      if (!content) throw new Error("Execution range could not be aligned")
      if (disposed || version !== sequence) return
      pages.put(content)
      checkpoints.set(content.offset, content.nextOffset)
      if (checkpoints.size > 8192) checkpoints.delete(checkpoints.keys().next().value!)
      setMeta(content)
      setStamp((value) => value + 1)
      requestAnimationFrame(() => {
        if (disposed || version !== sequence || !list) return
        if (reset) list.scrollTo(0)
        else if (anchor !== undefined) {
          const index = rows().findIndex((row) => row.offset === anchor)
          if (index >= 0) {
            list.scrollToIndex(index, { align: "start" })
            list.scrollBy(relative)
          }
        }
        if (list.scrollSize <= list.viewportSize && next() !== undefined) void read(next()!)
      })
    } catch {
      if (!disposed && version === sequence && !controller.signal.aborted) setError(true)
    } finally {
      if (!disposed && version === sequence) setLoading(false)
    }
  }
  const reset = async () => {
    readAbort?.abort()
    searchAbort?.abort()
    copyAbort?.abort()
    sequence++
    searchSequence++
    copySequence++
    pages.clear()
    rowCache.clear()
    checkpoints.clear()
    setStamp((value) => value + 1)
    setMeta(undefined)
    setMatches(undefined)
    setLoading(false)
    setProgress(undefined)
    setOpenedAt(props.revision)
    await read(0, true)
  }
  createEffect(on([() => props.nodeID, () => props.field], () => void reset()))
  const next = () => {
    const last = pages.pages().at(-1)
    const end = meta()?.bytes
    return last?.nextOffset !== null && last?.nextOffset !== undefined && last.nextOffset < (end ?? Infinity)
      ? last.nextOffset
      : undefined
  }
  const previous = () => {
    const first = pages.pages()[0]
    const start = 0
    if (!first || first.offset <= start) return undefined
    return (
      [...checkpoints].find(([offset, next]) => next === first.offset && offset >= start)?.[0] ??
      Math.max(start, first.offset - 65_536)
    )
  }
  const query = async (cursor?: string) => {
    const value = search().trim()
    if (!value || !meta()) {
      setMatches(undefined)
      return
    }
    searchAbort?.abort()
    searchAbort = new AbortController()
    const controller = searchAbort
    const version = ++searchSequence
    setSearching(true)
    try {
      const response = await sdk.client.session.executionContentSearch(
        { ...params(), query: value, cursor },
        { signal: controller.signal, throwOnError: true },
      )
      if (!disposed && version === searchSequence) setMatches(response.data)
    } catch {
      if (!controller.signal.aborted && !disposed) setError(true)
    } finally {
      if (!disposed && version === searchSequence) setSearching(false)
    }
  }
  createEffect(
    on(search, () => {
      clearTimeout(debounce)
      debounce = setTimeout(() => void query(), 250)
    }),
  )
  const complete = async (copy: boolean) => {
    const source = meta()
    if (!source || progress() !== undefined || (copy && source.status !== "complete")) return
    copyAbort?.abort()
    copyAbort = new AbortController()
    const controller = copyAbort
    const generation = ++copySequence
    const chunks: Uint8Array<ArrayBuffer>[] = []
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
    setProgress(0)
    setFeedback(undefined)
    setError(false)
    try {
      const response = await sdk.client.session.executionContentDownload(params(), {
        signal: controller.signal,
        parseAs: "stream",
        throwOnError: true,
      })
      const stream: unknown = response.data
      if (!(stream instanceof ReadableStream)) throw new Error("Execution download is not a stream")
      reader = stream.getReader()
      let bytes = 0
      for (;;) {
        controller.signal.throwIfAborted()
        const item = await reader.read()
        if (item.done) break
        bytes += item.value.byteLength
        chunks.push(new Uint8Array(item.value))
        if (bytes > source.bytes) throw new Error("Execution download byte count changed")
        setProgress(Math.min(99, Math.round((bytes / Math.max(1, source.bytes)) * 100)))
      }
      if (bytes !== source.bytes || meta()?.contentVersion !== source.contentVersion)
        throw new Error("Execution download version changed")
      const blob = new Blob(chunks, { type: source.mediaType })
      if (source.sha256) {
        const hash = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer())
        const hex = [...new Uint8Array(hash)].map((value) => value.toString(16).padStart(2, "0")).join("")
        if (hex !== source.sha256) throw new Error("Execution download integrity check failed")
      } else if (source.status === "complete") throw new Error("Execution content checksum was not recorded")
      controller.signal.throwIfAborted()
      if (!copy) {
        save(blob, props.field, source.mediaType.includes("json"))
        return
      }
      const text = await blob.text()
      if (source.mediaType.includes("json")) JSON.parse(text)
      controller.signal.throwIfAborted()
      if ((await copyTextToClipboard(text, { notifyFailure: false })).ok) setFeedback("copied")
      else {
        save(blob, props.field, source.mediaType.includes("json"))
        setFeedback("copyFailed")
      }
    } catch {
      if (!disposed && !controller.signal.aborted) setError(true)
    } finally {
      chunks.length = 0
      await reader?.cancel().catch(() => {})
      reader?.releaseLock()
      if (!disposed && generation === copySequence) setProgress(undefined)
    }
  }
  onCleanup(() => {
    disposed = true
    sequence++
    searchSequence++
    clearTimeout(debounce)
    readAbort?.abort()
    searchAbort?.abort()
    copyAbort?.abort()
    pages.clear()
    rowCache.clear()
  })
  const fieldLabel = () => {
    switch (props.field) {
      case "request":
        return _(E.savedRequest)
      case "response":
        return _(E.response)
      case "input":
        return _(E.toolInput)
      case "rawResult":
        return _(E.toolOutput)
      case "observation":
        return _(E.observation)
      case "stream":
        return _(E.output)
      case "initialHistory":
        return _(E.context)
      default:
        return _(E.message)
    }
  }
  const label = () => props.label ?? fieldLabel()
  const small = () =>
    meta() && meta()!.bytes <= 65_536 && pages.pages()[0]?.offset === 0 && pages.pages()[0]?.nextOffset === null
  const text = () => {
    stamp()
    const value = pages.pages()[0]?.text ?? ""
    if (!small() || !meta()?.mediaType.includes("json")) return value
    try {
      return JSON.stringify(JSON.parse(value), null, 2)
    } catch {
      return value
    }
  }
  const MenuTrigger = (button: JSX.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button
      {...button}
      type="button"
      class="execution-icon-button"
      aria-label={_(E.contentActions)}
      title={_(E.contentActions)}
    >
      <Icon name={getSemanticIcon("action.more")} size="small" />
    </button>
  )
  return (
    <section class="execution-evidence-block execution-reader" aria-label={label()}>
      <header class="execution-evidence-header">
        <h3>{label()}</h3>
        <span>{meta()?.mediaType.includes("json") ? "JSON" : "text"}</span>
        <Popover
          open={menu()}
          onOpenChange={setMenu}
          triggerAs={MenuTrigger}
          title={_(E.contentActions)}
          variant="menu"
          class="execution-content-menu"
        >
          <div
            class="execution-content-menu-actions"
            on:keydown={(event) => {
              if (event.key !== "Escape") return
              event.preventDefault()
              event.stopPropagation()
              setMenu(false)
            }}
          >
            <button
              type="button"
              onClick={() => {
                setMenu(false)
                setSearchOpen(!searchOpen())
              }}
            >
              <Icon name={getSemanticIcon("action.search")} size="small" />
              {_(E.searchContent)}
            </button>
            <button
              type="button"
              aria-pressed={wrap()}
              onClick={() => {
                setWrap(!wrap())
                setMenu(false)
              }}
            >
              {_(E.wrap)}
            </button>
            <button
              type="button"
              disabled={!meta() || progress() !== undefined}
              onClick={() => {
                setMenu(false)
                void complete(false)
              }}
            >
              <Icon name={getSemanticIcon("action.export")} size="small" />
              {_(meta()?.status === "partial" ? E.downloadPartial : E.download)}
            </button>
          </div>
        </Popover>
        <button
          type="button"
          class="execution-icon-button"
          aria-label={_(meta()?.mediaType.includes("json") ? E.copyFull : E.copyText)}
          title={_(meta()?.mediaType.includes("json") ? E.copyFull : E.copyText)}
          disabled={!meta() || meta()?.status !== "complete" || progress() !== undefined}
          onClick={() => void complete(true)}
        >
          <Icon name={getSemanticIcon(feedback() === "copied" ? "state.success" : "action.copy")} size="small" />
        </button>
      </header>
      <Show when={searchOpen()}>
        <label class="execution-search execution-content-search">
          <Icon name={getSemanticIcon("action.search")} size="small" />
          <input
            value={search()}
            onInput={(event) => setSearch(event.currentTarget.value)}
            placeholder={_(E.searchContent)}
            aria-label={_(E.searchContent)}
          />
        </label>
      </Show>
      <Show when={matches()}>
        <div class="execution-content-matches" aria-label={_(E.matches)}>
          <For each={matches()!.items}>
            {(match) => (
              <button
                type="button"
                onClick={() => {
                  rowCache.clear()
                  void read(match.offset, true)
                }}
              >
                {match.preview}
              </button>
            )}
          </For>
          <Show when={!matches()!.items.length}>
            <p class="execution-help">{_(E.noMatches)}</p>
          </Show>
          <Show when={matches()!.nextCursor}>
            <button type="button" disabled={searching()} onClick={() => void query(matches()!.nextCursor!)}>
              {_(E.next)}
            </button>
          </Show>
        </div>
      </Show>
      <Show when={meta()?.status === "partial"}>
        <p class="execution-help">{_(E.partialContent)}</p>
      </Show>
      <Show when={props.revision > openedAt()}>
        <div class="execution-reader-update">
          <span>{_(E.newOutput)}</span>
          <button type="button" onClick={() => void reset()}>
            {_(E.refreshContent)}
          </button>
        </div>
      </Show>
      <Show when={progress() !== undefined}>
        <div class="execution-reader-progress" role="status">
          <span>{_({ ...E.copying, values: { percent: progress() } })}</span>
          <button type="button" onClick={() => copyAbort?.abort()}>
            {_(E.cancelRead)}
          </button>
        </div>
      </Show>
      <Show when={feedback()}>
        <p class="execution-help" role="status">
          {_(E[feedback()!])}
        </p>
      </Show>
      <Show when={error()}>
        <p class="execution-help" role="alert">
          {_(E.contentError)}{" "}
          <button type="button" onClick={() => void reset()}>
            {_(E.refreshContent)}
          </button>
        </p>
      </Show>
      <div
        class="execution-content-viewport"
        classList={{ "execution-content-viewport--nowrap": !wrap(), "execution-content-viewport--small": !!small() }}
      >
        <Show
          when={small()}
          fallback={
            <VList
              ref={(value) => (list = value)}
              data={rows()}
              itemSize={44}
              overscan={2}
              style={{ height: "100%" }}
              aria-label={label()}
              onScroll={(offset) => {
                if (offset < 100 && previous() !== undefined) void read(previous()!, false, pages.pages()[0]?.offset)
                else if (list && offset > list.scrollSize - list.viewportSize - 400 && next() !== undefined)
                  void read(next()!)
              }}
            >
              {(row) => (
                <pre class="execution-content-row">
                  <code>{row.text}</code>
                </pre>
              )}
            </VList>
          }
        >
          <pre class="execution-content-row">
            <code>{text()}</code>
          </pre>
        </Show>
      </div>
      <Show when={loading()}>
        <p class="execution-reader-loading" role="status">
          {_(E.loading)}
        </p>
      </Show>
    </section>
  )
}
