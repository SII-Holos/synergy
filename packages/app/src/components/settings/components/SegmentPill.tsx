import { For, Show } from "solid-js"

export function SegmentPill(props: {
  value: string
  options: { value: string; label: string }[]
  onChange: (value: string) => void
  /** When true and value differs from default, shows a reset link */
  showReset?: boolean
  defaultValue?: string
  onReset?: () => void
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
      <Show
        when={
          props.showReset && props.defaultValue !== undefined && props.value !== props.defaultValue && props.onReset
        }
      >
        <button type="button" class="ds-segment-reset" onClick={props.onReset}>
          Reset
        </button>
      </Show>
    </div>
  )
}
