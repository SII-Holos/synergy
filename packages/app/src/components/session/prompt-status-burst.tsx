import { For, createMemo, createSignal, onCleanup, onMount } from "solid-js"

export type PromptStatusBurstItem = {
  id: string
  text: string
  startY: number
  vx: number
  vy: number
  ax: number
  ay: number
  startScale: number
  peakScale: number
  endScale: number
  delayMs: number
  durationMs: number
}

function lerp(from: number, to: number, progress: number) {
  return from + (to - from) * progress
}

function easeOutSine(progress: number) {
  return Math.sin((progress * Math.PI) / 2)
}

function easeInQuad(progress: number) {
  return progress * progress
}

function PromptStatusParticle(props: { item: PromptStatusBurstItem; zIndex: number }) {
  const [elapsedMs, setElapsedMs] = createSignal(0)
  let rafId: number | undefined
  let timeoutId: number | undefined
  let startedAt = 0

  const progress = createMemo(() => Math.min(1, elapsedMs() / props.item.durationMs))

  const style = createMemo(() => {
    const seconds = elapsedMs() / 1000
    const x = props.item.vx * seconds + 0.5 * props.item.ax * seconds * seconds
    const y = props.item.startY + props.item.vy * seconds + 0.5 * props.item.ay * seconds * seconds

    const currentProgress = progress()
    const scale =
      currentProgress < 0.42
        ? lerp(props.item.startScale, props.item.peakScale, easeOutSine(currentProgress / 0.42))
        : lerp(props.item.peakScale, props.item.endScale, easeInQuad((currentProgress - 0.42) / 0.58))

    const opacity =
      currentProgress < 0.14
        ? lerp(0, 0.92, currentProgress / 0.14)
        : currentProgress < 0.78
          ? lerp(0.92, 0.7, (currentProgress - 0.14) / 0.64)
          : lerp(0.7, 0, (currentProgress - 0.78) / 0.22)

    const blur =
      currentProgress < 0.12
        ? lerp(7, 1, currentProgress / 0.12)
        : currentProgress < 0.84
          ? 0
          : lerp(0, 6, (currentProgress - 0.84) / 0.16)

    return {
      transform: `translate3d(${x}px, ${y}px, 0) scale(${scale})`,
      opacity: String(Math.max(0, opacity)),
      filter: `blur(${Math.max(0, blur)}px)`,
      "z-index": String(props.zIndex),
    }
  })

  const tick = (timestamp: number) => {
    if (!startedAt) startedAt = timestamp
    const nextElapsed = timestamp - startedAt
    setElapsedMs(nextElapsed)
    if (nextElapsed < props.item.durationMs) {
      rafId = window.requestAnimationFrame(tick)
    }
  }

  onMount(() => {
    timeoutId = window.setTimeout(() => {
      rafId = window.requestAnimationFrame(tick)
    }, props.item.delayMs)
  })

  onCleanup(() => {
    if (timeoutId) window.clearTimeout(timeoutId)
    if (rafId) window.cancelAnimationFrame(rafId)
  })

  return (
    <div class="absolute left-0 top-0 overflow-visible will-change-transform pointer-events-none" style={style()}>
      <div class="inline-flex items-center rounded-full bg-background-base/38 px-2.5 py-0.5 shadow-[0_8px_20px_-22px_rgba(0,0,0,0.16)] backdrop-blur-sm">
        <span class="text-12-medium text-text-weak whitespace-nowrap truncate max-w-[24rem]">{props.item.text}</span>
      </div>
    </div>
  )
}

export function PromptStatusBurst(props: { items: PromptStatusBurstItem[] }) {
  return (
    <div class="pointer-events-none absolute left-4 top-3 z-0 overflow-visible">
      <div class="relative h-0 w-0 overflow-visible">
        <For each={props.items}>{(item, index) => <PromptStatusParticle item={item} zIndex={index() + 1} />}</For>
      </div>
    </div>
  )
}
