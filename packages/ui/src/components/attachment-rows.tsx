import { For, Show, createEffect, createSignal, onCleanup, type JSX } from "solid-js"
import { useLingui } from "@lingui/solid"
import { attachmentRowBoundary } from "./attachment-row-model"

export function AttachmentRows<T>(props: {
  items: T[]
  children: (item: T) => JSX.Element
  expanded?: boolean
  onExpandedChange?: (value: boolean) => void
}) {
  const { _ } = useLingui()
  const [root, setRoot] = createSignal<HTMLDivElement>()
  const [internalExpanded, setInternalExpanded] = createSignal(false)
  const expanded = () => props.expanded ?? internalExpanded()
  const [boundary, setBoundary] = createSignal<{ visible: number; height?: number }>({ visible: Infinity })
  createEffect(() => {
    const element = root()
    props.items
    if (!element) return
    const measure = () => {
      if (!element.isConnected) return
      const rect = element.getBoundingClientRect()
      setBoundary(
        attachmentRowBoundary(
          Array.from(element.children).map((child) => {
            const box = child.getBoundingClientRect()
            return { top: box.top - rect.top + element.scrollTop, bottom: box.bottom - rect.top + element.scrollTop }
          }),
        ),
      )
    }
    if (typeof ResizeObserver === "undefined") return
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    for (const child of element.children) observer.observe(child)
    queueMicrotask(measure)
    onCleanup(() => observer.disconnect())
  })
  return (
    <div data-component="attachment-rows">
      <div
        ref={setRoot}
        data-slot="attachment-row-layout"
        style={{ "max-height": !expanded() && boundary().height !== undefined ? `${boundary().height}px` : undefined }}
      >
        <For each={props.items}>
          {(item, index) => (
            <div
              data-slot="attachment-row-entry"
              inert={!expanded() && index() >= boundary().visible}
              aria-hidden={!expanded() && index() >= boundary().visible ? true : undefined}
            >
              {props.children(item)}
            </div>
          )}
        </For>
      </div>
      <Show when={boundary().visible < props.items.length}>
        <button
          type="button"
          data-slot="attachment-rows-toggle"
          aria-expanded={expanded()}
          onClick={() => {
            const next = !expanded()
            setInternalExpanded(next)
            props.onExpandedChange?.(next)
          }}
        >
          {expanded()
            ? _({ id: "ui.attachment.collapseAll", message: "Collapse attachments" })
            : _({
                id: "ui.attachment.expandAll",
                message: "Expand all {count} attachments",
                values: { count: props.items.length },
              })}
        </button>
      </Show>
    </div>
  )
}
