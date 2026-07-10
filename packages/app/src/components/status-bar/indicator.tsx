import { Show } from "solid-js"
import { Icon, type IconName } from "@ericsanchezok/synergy-ui/icon"
import { Tooltip } from "@ericsanchezok/synergy-ui/tooltip"

export interface StatusBarIndicatorProps {
  icon: IconName
  value: string | number
  secondary?: string | number
  tooltip?: string
  onClick?: () => void
  iconClass?: string
  valueClass?: string
  secondaryClass?: string
}

export function StatusBarIndicator(props: StatusBarIndicatorProps) {
  const interactive = () => !!props.onClick

  function inner() {
    return (
      <>
        <Icon name={props.icon} size="small" class={props.iconClass} />
        <span class={`statusbar-indicator-value ${props.valueClass ?? "text-text-weak"}`}>{props.value}</span>
        <Show when={props.secondary !== undefined}>
          <span class={`statusbar-indicator-value ${props.secondaryClass ?? "text-text-subtle"}`}>
            {props.secondary}
          </span>
        </Show>
      </>
    )
  }

  const content = (
    <Show
      when={interactive()}
      fallback={<div class="flex items-center h-7 gap-1.5 px-2 rounded-full select-none cursor-default">{inner()}</div>}
    >
      <button
        type="button"
        class="flex items-center h-7 gap-1.5 px-2 rounded-full select-none bg-transparent border-0 p-0 m-0 cursor-pointer hover:bg-surface-raised-base-hover transition-colors"
        onClick={props.onClick}
      >
        {inner()}
      </button>
    </Show>
  )

  return (
    <Show when={props.tooltip} fallback={content}>
      <Tooltip placement="top" value={props.tooltip!}>
        {content}
      </Tooltip>
    </Show>
  )
}
