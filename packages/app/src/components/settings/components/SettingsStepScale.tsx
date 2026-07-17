import { useLingui } from "@lingui/solid"
import { For, Show } from "solid-js"

const customLabel = { id: "settings.stepScale.custom", message: "Custom" }

function customValueLabel(value: string) {
  return { id: "settings.stepScale.customValue", message: "Custom {value}", values: { value } }
}

export type SettingsStepOption = {
  value: string
  label: string
  detail?: string
  tickLabel?: string
}

export function SettingsStepScale(props: {
  value: string
  options: SettingsStepOption[]
  ariaLabel: string
  onChange: (value: string) => void
  summary?: (option: SettingsStepOption) => string
  lowLabel?: string
  highLabel?: string
}) {
  const { _ } = useLingui()
  const currentIndex = () => {
    const index = props.options.findIndex((option) => option.value === props.value)
    return index >= 0 ? index : 0
  }
  const current = () => props.options[currentIndex()]
  const currentSummary = () => {
    const option = current()
    if (!option) return props.value ? _(customValueLabel(props.value)) : _(customLabel)
    return props.summary ? props.summary(option) : option.label
  }

  return (
    <div class="settings-step-scale">
      <div class="settings-step-scale-header">
        <span>{currentSummary()}</span>
      </div>
      <input
        class="settings-step-scale-slider"
        type="range"
        min="0"
        max={String(Math.max(props.options.length - 1, 0))}
        step="1"
        value={currentIndex()}
        aria-label={props.ariaLabel}
        onInput={(event) => {
          const index = Number(event.currentTarget.value)
          const option = props.options[index]
          if (option) props.onChange(option.value)
        }}
      />
      <div class="settings-step-scale-ticks" aria-hidden="true">
        <For each={props.options}>{(option) => <span>{option.tickLabel ?? option.label}</span>}</For>
      </div>
      <Show when={props.lowLabel || current()?.detail || props.highLabel}>
        <div class="settings-step-scale-meta">
          <span>{props.lowLabel}</span>
          <span>{current()?.detail}</span>
          <span>{props.highLabel}</span>
        </div>
      </Show>
    </div>
  )
}
