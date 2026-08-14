import { createEffect, createMemo, createSignal, createUniqueId, on, onCleanup, Show } from "solid-js"
import { useLingui } from "@lingui/solid"
import { compactReasoningFirstLine, compactReasoningText } from "./compact-reasoning-text"
import { Icon } from "./icon"
import { getSemanticIcon } from "./semantic-icon"
import { Spinner } from "./spinner"
import { SESSION_TURN_DESC } from "./tool-title-descriptors"
import "./compact-reasoning.css"

export function CompactReasoningLine(props: { fullText: string; running: boolean }) {
  const { _ } = useLingui()
  const detailID = createUniqueId()
  const [open, setOpen] = createSignal(false)
  const [userScrolled, setUserScrolled] = createSignal(false)
  let scroller: HTMLElement | undefined
  let scrollFrame: number | undefined

  const summary = createMemo(() =>
    props.running ? compactReasoningText(props.fullText) : compactReasoningFirstLine(props.fullText),
  )

  const flushToTail = () => {
    scrollFrame = undefined
    const el = scroller
    if (!el || userScrolled()) return
    const tail = Math.max(0, el.scrollWidth - el.clientWidth)
    if (tail <= 0 || tail - el.scrollLeft < 2) return
    el.scrollLeft = tail
  }

  createEffect(
    on(summary, () => {
      if (scrollFrame !== undefined) return
      scrollFrame = requestAnimationFrame(flushToTail)
    }),
  )

  onCleanup(() => {
    if (scrollFrame !== undefined) cancelAnimationFrame(scrollFrame)
  })

  const handleScroll = () => {
    const el = scroller
    if (!el) return
    const tail = Math.max(0, el.scrollWidth - el.clientWidth)
    setUserScrolled(tail - el.scrollLeft >= 2)
  }

  return (
    <div data-component="compact-reasoning" data-state={props.running ? "running" : "settled"}>
      <Show
        when={props.running}
        fallback={
          <div data-slot="compact-reasoning-settled">
            <button
              type="button"
              data-slot="compact-reasoning-trigger"
              aria-expanded={open()}
              aria-controls={detailID}
              onClick={() => setOpen((value) => !value)}
            >
              <span data-slot="compact-reasoning-leading" aria-hidden="true">
                <Icon name={getSemanticIcon("performance.trace")} size="small" />
              </span>
              <span data-slot="compact-reasoning-label">{_(SESSION_TURN_DESC.compactReasoningThinking)}</span>
              <span data-slot="compact-reasoning-summary">{summary()}</span>
              <span data-slot="compact-reasoning-chevron" aria-hidden="true">
                <Icon name={getSemanticIcon(open() ? "navigation.collapse" : "navigation.expand")} size="small" />
              </span>
            </button>
            <Show when={open()}>
              <div data-slot="compact-reasoning-detail" id={detailID}>
                <pre data-slot="compact-reasoning-detail-text">{props.fullText}</pre>
              </div>
            </Show>
          </div>
        }
      >
        <span data-slot="compact-reasoning-leading" aria-hidden="true">
          <Spinner />
        </span>
        <span data-slot="compact-reasoning-label">{_(SESSION_TURN_DESC.compactReasoningThinking)}</span>
        <span data-slot="compact-reasoning-scroller" ref={(el) => (scroller = el)} onScroll={handleScroll}>
          <span data-slot="compact-reasoning-text">{summary()}</span>
        </span>
      </Show>
    </div>
  )
}
