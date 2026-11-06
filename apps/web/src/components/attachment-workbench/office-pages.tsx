import { createEffect, createMemo, createSignal, on, onCleanup, Show } from "solid-js"
import { useLingui } from "@lingui/solid"
import { Spinner } from "@ericsanchezok/synergy-ui/spinner"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { getSemanticIcon } from "@ericsanchezok/synergy-ui/semantic-icon"
import { attachmentWorkbench as A } from "@/locales/messages"
import { OfficeDocumentFrame } from "./office-frame"
import { OfficeErrorState, OfficeNotice } from "./office-state"
import type { OfficeRenderedDocument } from "./office-contract"

export function OfficePaginatedReader(props: {
  document?: OfficeRenderedDocument
  error?: unknown
  loading: boolean
  filename?: string
}) {
  const lingui = useLingui()
  let stage!: HTMLDivElement
  const [page, setPage] = createSignal(0),
    [scale, setScale] = createSignal(1),
    [query, setQuery] = createSignal("")
  const [width, setWidth] = createSignal(0)
  createEffect(
    on(
      () => props.document,
      () => setPage(0),
    ),
  )
  createEffect(() => {
    const observer = new ResizeObserver((entries) => setWidth(entries[0]?.contentRect.width ?? 0))
    observer.observe(stage)
    onCleanup(() => observer.disconnect())
  })
  const pages = () => (props.error ? [] : (props.document?.pages ?? []))
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
  const [fitting, setFitting] = createSignal(true)
  const displayScale = () =>
    fitting() ? Math.max(0.1, Math.min(2, (width() - 32) / (current()?.width ?? 800))) : scale()
  const fit = () => setFitting(true)
  const zoom = (delta: number) => {
    setScale(Math.max(0.1, Math.min(4, displayScale() + delta)))
    setFitting(false)
  }
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
        <span>
          {lingui._({ ...A.pagePosition, values: { page: pages().length ? page() + 1 : 0, count: pages().length } })}
        </span>
        <button
          type="button"
          aria-label={lingui._(A.nextPage)}
          disabled={page() >= pages().length - 1}
          onClick={() => setPage((v) => v + 1)}
        >
          <Icon name={getSemanticIcon("navigation.forward")} size="small" />
        </button>
        <button type="button" aria-label={lingui._(A.zoomOut)} onClick={() => zoom(-0.1)}>
          <Icon name={getSemanticIcon("action.zoomOut")} size="small" />
        </button>
        <button type="button" aria-pressed={fitting()} onClick={fit}>
          {lingui._(A.fitWidth)}
        </button>
        <button type="button" aria-label={lingui._(A.zoomIn)} onClick={() => zoom(0.1)}>
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
      <Show when={!props.error} fallback={<OfficeErrorState error={props.error} />}>
        <Show
          when={!props.loading && current()}
          fallback={
            <Show
              when={props.loading}
              fallback={
                <div class="attachment-workbench-state">
                  {lingui._({ id: "app.attachment.office.empty", message: "This document has no pages to preview." })}
                </div>
              }
            >
              <div class="attachment-workbench-loading">
                <Spinner />
              </div>
            </Show>
          }
        >
          {(value) => (
            <OfficeDocumentFrame
              html={value().html}
              css={props.document?.css}
              scale={displayScale()}
              search={query()}
              title={props.filename ?? lingui._(A.preview)}
            />
          )}
        </Show>
      </Show>
    </div>
  )
}
