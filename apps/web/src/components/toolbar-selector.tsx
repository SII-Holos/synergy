import { Popover } from "@ericsanchezok/synergy-ui/popover"
import { createSignal, type Component, type JSX } from "solid-js"
import { Icon, type IconName } from "@ericsanchezok/synergy-ui/icon"
import { getSemanticIcon } from "@ericsanchezok/synergy-ui/semantic-icon"

export function ToolbarSelectorPopover(props: {
  triggerAs: Component<JSX.ButtonHTMLAttributes<HTMLButtonElement>>
  children: (close: () => void) => JSX.Element
  title: string
  placement?: "top-start" | "top" | "top-end" | "bottom-start" | "bottom" | "bottom-end"
  contentClass?: string
}) {
  const [open, setOpen] = createSignal(false)
  const close = () => setOpen(false)

  return (
    <Popover
      open={open()}
      onOpenChange={setOpen}
      placement={props.placement ?? "top-start"}
      gutter={8}
      shift={12}
      variant="menu"
      triggerAs={props.triggerAs}
      title={props.title}
      class={props.contentClass ?? "w-60"}
    >
      {props.children(close)}
    </Popover>
  )
}

export function ToolbarSelectorTrigger(props: { icon: IconName; label: string }) {
  return (
    <button
      type="button"
      class="flex items-center gap-1.5 px-2.5 h-7 rounded-full bg-surface-base border border-border-weak-base hover:bg-surface-raised-base-hover transition-colors text-12-medium text-text-base"
    >
      <Icon name={props.icon} size="small" class="text-icon-base" />
      <span>{props.label}</span>
      <Icon name={getSemanticIcon("navigation.collapse")} size="small" class="text-icon-weak-base" />
    </button>
  )
}
