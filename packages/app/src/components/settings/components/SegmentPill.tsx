import { For } from "solid-js"

export function SegmentPill(props: {
  value: string
  options: { value: string; label: string }[]
  onChange: (value: string) => void
}) {
  return (
    <div class="ds-segment-wrapper">
      <div class="ds-segment">
        <For each={props.options}>
          {(option) => (
            <button
              type="button"
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
