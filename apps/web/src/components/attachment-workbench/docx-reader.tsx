import { renderAsync } from "docx-preview"
import { createEffect, createMemo, createResource, createSignal, onCleanup, Show } from "solid-js"
import { useLingui } from "@lingui/solid"
import { Spinner } from "@ericsanchezok/synergy-ui/spinner"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { getSemanticIcon } from "@ericsanchezok/synergy-ui/semantic-icon"
import { attachmentWorkbench as A } from "@/locales/messages"
import { createOfficeWorkerReader } from "./office-worker-client"
import { OfficePreviewError } from "./office-contract"
import { OfficeDocumentFrame } from "./office-frame"
import { OfficeErrorState, OfficeNotice } from "./office-state"

export async function renderDocxPages(bytes: Uint8Array) {
  const inert = document.implementation.createHTMLDocument()
  const body = inert.createElement("div"),
    styles = inert.createElement("div")
  await renderAsync(bytes, body, styles, {
    className: "office-docx",
    renderAltChunks: false,
    useBase64URL: true,
    breakPages: true,
    ignoreLastRenderedPageBreak: false,
    renderHeaders: true,
    renderFooters: true,
    ignoreFonts: false,
  })
  const pages = Array.from(body.querySelectorAll<HTMLElement>("section.office-docx")).map((section) => ({
    html: section.outerHTML,
    text: section.textContent ?? "",
    width: parseFloat(section.style.width || "595") * (section.style.width.endsWith("px") ? 1 : 4 / 3),
  }))
  if (!pages.length) throw new OfficePreviewError("corrupt")
  return {
    pages,
    css: Array.from(styles.querySelectorAll("style"))
      .map((style) => style.textContent ?? "")
      .join("\n"),
  }
}

export function DocxReader(props: { bytes: Uint8Array; filename?: string }) {
  const lingui = useLingui()
  const reader = createOfficeWorkerReader()
  let generation = 0,
    stage!: HTMLDivElement
  const [page, setPage] = createSignal(0),
    [scale, setScale] = createSignal(1),
    [query, setQuery] = createSignal("")
  const [width, setWidth] = createSignal(0)
  const [content] = createResource(
    () => props.bytes,
    async (bytes) => {
      const current = ++generation
      const checked = await reader.read(bytes, "docx")
      const result = await renderDocxPages(checked.bytes)
      if (current !== generation) throw new DOMException("Cancelled", "AbortError")
      return result
    },
  )
  createEffect(() => {
    const observer = new ResizeObserver((entries) => setWidth(entries[0]?.contentRect.width ?? 0))
    observer.observe(stage)
    onCleanup(() => observer.disconnect())
  })
  onCleanup(() => {
    generation++
    reader.cancel()
  })
  const pages = () => (content.error ? [] : (content()?.pages ?? []))
  const current = () => pages()[Math.min(page(), pages().length - 1)]
  const hits = createMemo(() =>
    query().trim()
      ? pages().flatMap((value, index) =>
          value.text.toLocaleLowerCase().includes(query().toLocaleLowerCase()) ? [index] : [],
        )
      : [],
  )
  createEffect(() => {
    if (hits().length) setPage(hits()[0]!)
  })
  const fit = () => setScale(Math.max(0.1, Math.min(2, (width() - 32) / (current()?.width ?? 800))))
  return (
    <div class="office-reader" ref={stage}>
      <OfficeNotice />
      <div class="office-reader-toolbar">
        <button
          type="button"
          aria-label={lingui._(A.previousPage)}
          disabled={!page()}
          onClick={() => setPage((v) => v - 1)}
        >
          <Icon name={getSemanticIcon("navigation.back")} size="small" />
        </button>
        <span>{lingui._({ ...A.pagePosition, values: { page: page() + 1, count: pages().length } })}</span>
        <button
          type="button"
          aria-label={lingui._(A.nextPage)}
          disabled={page() >= pages().length - 1}
          onClick={() => setPage((v) => v + 1)}
        >
          <Icon name={getSemanticIcon("navigation.forward")} size="small" />
        </button>
        <button type="button" aria-label={lingui._(A.zoomOut)} onClick={() => setScale((v) => Math.max(0.1, v - 0.1))}>
          <Icon name={getSemanticIcon("action.zoomOut")} size="small" />
        </button>
        <button type="button" onClick={fit}>
          {lingui._(A.fitWidth)}
        </button>
        <button type="button" aria-label={lingui._(A.zoomIn)} onClick={() => setScale((v) => Math.min(4, v + 0.1))}>
          <Icon name={getSemanticIcon("action.zoomIn")} size="small" />
        </button>
        <label class="office-reader-find">
          <Icon name={getSemanticIcon("action.search")} size="small" />
          <input
            aria-label={lingui._({ id: "app.attachment.office.find", message: "Find in document" })}
            value={query()}
            onInput={(e) => setQuery(e.currentTarget.value)}
          />
        </label>
        <Show when={query().trim()}>
          <span role="status">
            {lingui._({
              id: "app.attachment.office.matches",
              message: "{count} matching pages",
              values: { count: hits().length },
            })}
          </span>
          <button
            type="button"
            disabled={!hits().length}
            aria-label={lingui._({ id: "app.attachment.office.nextMatch", message: "Next match" })}
            onClick={() => setPage(hits().find((index) => index > page()) ?? hits()[0] ?? page())}
          >
            <Icon name={getSemanticIcon("navigation.forward")} size="small" />
          </button>
        </Show>
      </div>
      <Show when={!content.error} fallback={<OfficeErrorState error={content.error} />}>
        <Show
          when={!content.loading && current()}
          fallback={
            <div class="attachment-workbench-loading">
              <Spinner />
            </div>
          }
        >
          {(value) => (
            <OfficeDocumentFrame
              html={value().html}
              css={content()!.css}
              scale={scale()}
              search={query()}
              title={props.filename ?? lingui._(A.preview)}
            />
          )}
        </Show>
      </Show>
    </div>
  )
}
