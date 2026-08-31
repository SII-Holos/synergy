import { For } from "solid-js"

export function SegmentPill(props: {
  value: string
  options: { value: string; label: string }[]
  onChange: (value: string) => void
  ariaLabel?: string
}) {
  return (
    <div class="ds-segment-wrapper">
      <div class="ds-segment" role="group" aria-label={props.ariaLabel}>
        <For each={props.options}>
          {(option) => (
            <button
              type="button"
              aria-pressed={props.value === option.value}
              classList={{
                "ds-segment-item": true,
                "ds-segment-item-active": props.value === option.value,
              }}
              onClick={() => props.onChange(option.value)}
            >
              {option.label}
            </button>
          )}
        </For>
      </div>
    </div>
  )
}
