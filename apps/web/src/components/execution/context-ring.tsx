import { createEffect, createSignal, For, onCleanup, onMount, Show } from "solid-js"

export function ContextRing(props: {
  segments: { key: string; value: number; color: string }[]
  total: number | null | undefined
  label: string
  value: string
  caption: string
  fitValue?: { alternatives: string[]; accessible: string }
  highlight?: string
  onHighlight?: (key: string) => void
}) {
  let ring: HTMLDivElement | undefined
  let measure: HTMLSpanElement | undefined
  let frame: number | undefined
  let observer: ResizeObserver | undefined
  let disposed = false
  const [fitted, setFitted] = createSignal<{ value: string; size: number }>()
  const candidates = () => [props.value, ...(props.fitValue?.alternatives ?? [])]
  const schedule = () => {
    if (disposed || !props.fitValue || frame != null) return
    frame = requestAnimationFrame(() => {
      frame = undefined
      if (!ring || !measure) return
      const diameter = ring.getBoundingClientRect().width
      if (!diameter) return
      const radius = diameter * 0.38
      const offset = diameter * 0.07
      const sizes = [...measure.children].map((node) => {
        const { width, height } = node.getBoundingClientRect()
        const a = (width * width + height * height) / 4
        const b = height * offset
        const c = offset * offset - radius * radius
        const scale = (-b + Math.sqrt(b * b - 4 * a * c)) / (2 * a)
        return Math.min(18, Math.floor(Math.min((diameter * 0.7) / width, scale) * 180) / 10)
      })
      const index = sizes.findIndex((size) => size >= 12)
      const chosen = index < 0 ? sizes.length - 1 : index
      const size = Math.max(12, sizes[chosen])
      const value = candidates()[chosen]
      setFitted((current) => (current?.value === value && current.size === size ? current : { value, size }))
    })
  }
  createEffect(() => {
    candidates()
    queueMicrotask(() => {
      if (disposed) return
      observer?.disconnect()
      if (ring) observer?.observe(ring)
      for (const node of measure?.children ?? []) observer?.observe(node)
      schedule()
    })
  })
  onMount(() => {
    if (!props.fitValue || !ring) return
    observer = new ResizeObserver(schedule)
    observer.observe(ring)
    document.fonts.addEventListener("loadingdone", schedule)
    void document.fonts.ready.then(schedule)
    schedule()
    onCleanup(() => {
      observer?.disconnect()
      document.fonts.removeEventListener("loadingdone", schedule)
    })
  })
  onCleanup(() => {
    disposed = true
    if (frame != null) cancelAnimationFrame(frame)
  })
  const arc = (key: string) => {
    const index = props.segments.findIndex((entry) => entry.key === key)
    const start = props.segments.slice(0, index).reduce((sum, entry) => sum + entry.value, 0)
    const value = props.segments[index]?.value ?? 0
    return { start: props.total ? (start / props.total) * 100 : 0, size: props.total ? (value / props.total) * 100 : 0 }
  }
  return (
    <div
      ref={ring}
      class="context-ring"
      data-fit={!!props.fitValue}
      role="img"
      aria-label={props.label + ": " + (props.fitValue?.accessible ?? props.value)}
    >
      <svg viewBox="0 0 160 160" aria-hidden="true">
        <circle class="context-ring-track" cx="80" cy="80" r="68" stroke-width="12" fill="none" />
        <For each={props.segments.map((entry) => entry.key)}>
          {(key) => (
            <circle
              cx="80"
              cy="80"
              r="68"
              pathLength="100"
              fill="none"
              stroke-width={props.highlight === key ? 16 : 12}
              opacity={props.highlight && props.highlight !== key ? 0.3 : 1}
              stroke={props.segments.find((entry) => entry.key === key)?.color}
              stroke-dasharray={`${arc(key).size} ${100 - arc(key).size}`}
              stroke-dashoffset={-arc(key).start}
              transform="rotate(-90 80 80)"
              onMouseEnter={() => props.onHighlight?.(key)}
              onMouseLeave={() => props.onHighlight?.("")}
            />
          )}
        </For>
      </svg>
      <div>
        <strong style={props.fitValue ? { "font-size": (fitted()?.size ?? 18) + "px" } : undefined}>
          {props.fitValue ? (fitted()?.value ?? props.value) : props.value}
        </strong>
        <span>{props.caption}</span>
      </div>
      <Show when={props.fitValue}>
        <span ref={measure} class="context-ring-measure" aria-hidden="true">
          <For each={candidates()}>{(value) => <strong>{value}</strong>}</For>
        </span>
      </Show>
    </div>
  )
}
