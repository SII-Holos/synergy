import { CodeView, type CodeViewItem, type CodeViewLineSelection, type CodeViewOptions } from "@pierre/diffs"
import { createEffect, createMemo, createSignal, getOwner, onCleanup, onMount, type JSX } from "solid-js"
import { render } from "solid-js/web"
import { ensureSynergyHighlightTheme } from "../context/marked"
import { createDefaultOptions, styleVariables } from "../pierre"
import { getWorkerPool } from "../pierre/worker"
import { useLingui } from "@lingui/solid"

export interface ReviewViewerProps {
  items: CodeViewItem[]
  style: "unified" | "split"
  wrap: boolean
  words: boolean
  full: boolean
  whitespace: boolean
  selected?: string
  renderHeader: (id: string) => JSX.Element
  onVisible?: (id: string) => void
  onSelection: (selection: CodeViewLineSelection | null) => void
  onError: (error: unknown) => void
}

// Provenance: https://github.com/pierrecomputer/diffs (CodeView, version 1.3.3).
// Local adaptation: one virtualized viewer with owned headers, original line selection and scoped cleanup.
export function ReviewViewer(props: ReviewViewerProps) {
  const { _ } = useLingui()
  let root!: HTMLDivElement
  const owner = getOwner()
  const [viewer, setViewer] = createSignal<CodeView>()
  const headers = new Map<string, { element: HTMLDivElement; dispose: () => void }>()
  const interactions = new Map<HTMLElement, () => void>()
  const options = createMemo<CodeViewOptions<undefined>>(() => {
    const expandContext = _({ id: "ui.review.expandContext", message: "Expand unchanged context" })
    const expandAllContext = _({ id: "ui.review.expandAllContext", message: "Expand all context" })
    const before = _({ id: "ui.review.before", message: "before" }),
      after = _({ id: "ui.review.after", message: "after" })
    return {
      ...createDefaultOptions(props.style),
      disableFileHeader: false,
      overflow: props.wrap ? "wrap" : "scroll",
      lineDiffType: props.words ? "word-alt" : "none",
      expandUnchanged: props.full,
      stickyHeaders: true,
      itemMetrics: { lineHeight: 24, diffHeaderHeight: 44 },
      layout: { gap: 0, paddingTop: 0, paddingBottom: 0 },
      enableLineSelection: true,
      tokenizeMaxLength: 32_000,
      onSelectedLinesChange: props.onSelection,
      onPostRender: (node, _instance, phase, context) => {
        interactions.get(node)?.()
        interactions.delete(node)
        if (phase === "unmount" || !node.shadowRoot) return
        const select = (row: HTMLElement, extend: boolean) => {
          const line = Number(row.dataset.columnNumber)
          if (!Number.isInteger(line) || line < 1) return
          const side =
            row.closest("[data-deletions]") || row.dataset.lineType?.includes("deletion") ? "deletions" : "additions"
          const previous = viewer()?.getSelectedLines()
          const start =
            extend && previous?.id === context.item.id && previous.range.side === side ? previous.range.start : line
          const value: CodeViewLineSelection = { id: context.item.id, range: { start, end: line, side } }
          viewer()?.setSelectedLines(value, { notify: false })
          props.onSelection(value)
        }
        const click = (event: Event) => {
          const row = event
            .composedPath()
            .find(
              (target): target is HTMLElement =>
                target instanceof HTMLElement && target.hasAttribute("data-column-number"),
            )
          if (!row) return
          event.stopPropagation()
          select(row, event instanceof MouseEvent && event.shiftKey)
        }
        const shadow = node.shadowRoot
        shadow.addEventListener("click", click, true)
        interactions.set(node, () => shadow.removeEventListener("click", click, true))
        for (const label of node.shadowRoot.querySelectorAll<HTMLElement>("[data-unmodified-lines]")) {
          const count = Number(label.dataset.reviewLines ?? label.textContent?.match(/^\d+/)?.[0])
          if (!Number.isFinite(count)) continue
          label.dataset.reviewLines = String(count)
          label.textContent = _({ id: "ui.review.unchanged", message: "{count} unchanged lines", values: { count } })
        }
        for (const button of node.shadowRoot.querySelectorAll<HTMLElement>("[data-expand-button]")) {
          button.setAttribute("aria-label", expandContext)
          if (button.hasAttribute("data-expand-all-button")) button.textContent = expandAllContext
          button.tabIndex = 0
          button.onkeydown = (event) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault()
              event.stopPropagation()
              button.click()
            }
          }
        }
        for (const gutter of node.shadowRoot.querySelectorAll<HTMLElement>("[data-gutter]")) {
          const rows = [...gutter.querySelectorAll<HTMLElement>("[data-column-number]")]
          rows.forEach((row, index) => {
            const line = Number(row.dataset.columnNumber),
              side =
                row.closest("[data-deletions]") || row.dataset.lineType?.includes("deletion")
                  ? "deletions"
                  : "additions"
            if (!Number.isInteger(line) || line < 1) return
            row.setAttribute("role", "button")
            row.setAttribute(
              "aria-label",
              _({
                id: "ui.review.selectLine",
                message: "Select line {line} in {side}",
                values: { line, side: side === "deletions" ? before : after },
              }),
            )
            row.tabIndex = index === 0 ? 0 : -1
            row.onkeydown = (event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault()
                event.stopPropagation()
                select(row, event.shiftKey)
              } else if (["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) {
                event.preventDefault()
                event.stopPropagation()
                const next =
                  event.key === "Home"
                    ? 0
                    : event.key === "End"
                      ? rows.length - 1
                      : Math.max(0, Math.min(rows.length - 1, index + (event.key === "ArrowDown" ? 1 : -1)))
                rows.forEach((item, index) => {
                  item.tabIndex = index === next ? 0 : -1
                })
                rows[next]?.focus()
              }
            }
          })
        }
      },
      unsafeCSS:
        createDefaultOptions(props.style).unsafeCSS +
        "\n[role=button]:focus-visible { outline: 2px solid var(--border-focus); outline-offset: -2px; }" +
        (props.whitespace
          ? "\n[data-code] { white-space: pre-wrap; } [data-token] { text-decoration-skip-ink: none; }"
          : ""),
      renderCustomHeader: (_file, context) => {
        const id = context.item.id
        let header = headers.get(id)
        if (!header) {
          const element = document.createElement("div")
          element.dataset.reviewHeader = id
          element.style.height = "44px"
          const dispose = render(() => props.renderHeader(id), element, undefined, { owner })
          header = { element, dispose }
          headers.set(id, header)
        }
        queueMicrotask(() => props.onVisible?.(id))
        return header.element
      },
    }
  })
  onMount(() => {
    let alive = true
    void ensureSynergyHighlightTheme()
      .then(() => {
        if (!alive) return
        const next = new CodeView(options(), getWorkerPool(props.style))
        next.setup(root)
        setViewer(next)
      })
      .catch(props.onError)
    onCleanup(() => {
      alive = false
    })
  })
  createEffect(() => viewer()?.setOptions(options()))
  createEffect(() => {
    const next = props.items
    const ids = new Set(next.map((item) => item.id))
    for (const [id, header] of headers)
      if (!ids.has(id)) {
        header.dispose()
        headers.delete(id)
      }
    viewer()?.setItems(next)
  })
  createEffect(() => {
    const id = props.selected
    if (id) viewer()?.scrollTo({ type: "item", id, behavior: "instant", align: "start" })
  })
  onCleanup(() => {
    viewer()?.cleanUp()
    for (const dispose of interactions.values()) dispose()
    interactions.clear()
    for (const header of headers.values()) header.dispose()
    headers.clear()
  })
  return <div data-component="review-viewer" ref={root} style={styleVariables} />
}
