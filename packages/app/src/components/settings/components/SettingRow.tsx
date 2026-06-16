import type { JSX } from "solid-js"

export function SettingRow(props: { title: string; description: string; trailing: JSX.Element }) {
  return (
    <div class="ds-setting-row">
      <div class="flex flex-col gap-0.5 flex-1 min-w-0">
        <span class="text-13-medium text-text-base">{props.title}</span>
        <span class="text-12-regular text-text-weak">{props.description}</span>
      </div>
      <div class="flex-shrink-0">{props.trailing}</div>
    </div>
  )
}
