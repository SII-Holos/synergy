import { createRenderEffect, on, type JSX } from "solid-js"
import { createFlipRunner } from "./flip-list-model"

export function FlipList(props: {
  entries: readonly unknown[]
  children: JSX.Element
  class?: string
  selector?: string
  dataKey?: string
}) {
  let container: HTMLDivElement | undefined
  const reduceMotion = typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches
  const runFlip = createFlipRunner({
    selector: props.selector,
    dataKey: props.dataKey,
    reduceMotion,
  })

  createRenderEffect(
    on(
      () => props.entries,
      () => runFlip(container),
    ),
  )

  return (
    <div ref={container!} class={props.class}>
      {props.children}
    </div>
  )
}
