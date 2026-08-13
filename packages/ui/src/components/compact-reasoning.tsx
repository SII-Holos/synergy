import { createEffect, createSignal, on, onCleanup } from "solid-js"
import { useLingui } from "@lingui/solid"
import { Spinner } from "./spinner"
import { SESSION_TURN_DESC } from "./tool-title-descriptors"
import "./compact-reasoning.css"

export function CompactReasoningLine(props: { text: string }) {
  const { _ } = useLingui()
  const [userScrolled, setUserScrolled] = createSignal(false)
  let scroller: HTMLElement | undefined
  let scrollFrame: number | undefined

  const flushToTail = () => {
    scrollFrame = undefined
    const el = scroller
    if (!el || userScrolled()) return
    const tail = Math.max(0, el.scrollWidth - el.clientWidth)
    if (tail <= 0 || tail - el.scrollLeft < 2) return
    el.scrollLeft = tail
  }

  createEffect(
    on(
      () => props.text,
      () => {
        if (scrollFrame !== undefined) return
        scrollFrame = requestAnimationFrame(flushToTail)
      },
    ),
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
    <div data-component="compact-reasoning" aria-live="off">
      <span data-slot="compact-reasoning-leading" aria-hidden="true">
        <Spinner />
      </span>
      <span data-slot="compact-reasoning-label">{_(SESSION_TURN_DESC.compactReasoningThinking)}</span>
      <span data-slot="compact-reasoning-scroller" ref={(el) => (scroller = el)} onScroll={handleScroll}>
        <span data-slot="compact-reasoning-text">{props.text}</span>
      </span>
    </div>
  )
}
