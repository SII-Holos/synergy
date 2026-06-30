import type { JSX } from "solid-js"

export function SettingRow(props: { title: string; description: string; trailing: JSX.Element }) {
  return (
    <div class="ds-setting-row">
      <div class="flex flex-col gap-0.5 flex-1 min-w-0">
        <span class="settings-row-title">{props.title}</span>
        <span class="settings-row-description">{props.description}</span>
      </div>
      <div class="flex-shrink-0">{props.trailing}</div>
    </div>
  )
}
