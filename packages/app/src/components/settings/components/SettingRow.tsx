import { Show, type JSX } from "solid-js"

export function SettingRow(props: {
  title: string
  description: string
  trailing: JSX.Element
  leading?: JSX.Element
  stateLabel?: string
}) {
  return (
    <div class="ds-setting-row">
      <div class="flex items-center gap-3 flex-1 min-w-0">
        <Show when={props.leading}>
          <div class="flex-shrink-0">{props.leading}</div>
        </Show>
        <div class="flex flex-col gap-0.5 flex-1 min-w-0">
          <span class="settings-row-title">{props.title}</span>
          <span class="settings-row-description">{props.description}</span>
        </div>
      </div>
      <div class="flex-shrink-0 flex items-center gap-2">
        <Show when={props.stateLabel}>
          <span class="settings-row-state">{props.stateLabel}</span>
        </Show>
        {props.trailing}
      </div>
    </div>
  )
}
