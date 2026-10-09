import { For } from "solid-js"

export function ContextRing(props: {
  segments: { key: string; value: number; color: string }[]
  total: number | null | undefined
  label: string
  value: string
  caption: string
  highlight?: string
  onHighlight?: (key: string) => void
}) {
  const arc = (key: string) => {
    const index = props.segments.findIndex((entry) => entry.key === key)
    const start = props.segments.slice(0, index).reduce((sum, entry) => sum + entry.value, 0)
    const value = props.segments[index]?.value ?? 0
    return { start: props.total ? (start / props.total) * 100 : 0, size: props.total ? (value / props.total) * 100 : 0 }
  }
  return (
    <div class="context-ring" role="img" aria-label={props.label + ": " + props.value}>
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
        <strong>{props.value}</strong>
        <span>{props.caption}</span>
      </div>
    </div>
  )
}
