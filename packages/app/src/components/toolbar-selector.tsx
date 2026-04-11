import { Popover as KobaltePopover } from "@kobalte/core/popover"
import { createSignal, type JSX } from "solid-js"
import { Icon, type IconName } from "@ericsanchezok/synergy-ui/icon"

export function ToolbarSelectorPopover(props: {
  trigger: JSX.Element
  children: (close: () => void) => JSX.Element
  title?: string
  placement?: "top-start" | "top" | "top-end" | "bottom-start" | "bottom" | "bottom-end"
  contentClass?: string
}) {
  const [open, setOpen] = createSignal(false)
  const close = () => setOpen(false)

  return (
    <KobaltePopover open={open()} onOpenChange={setOpen} placement={props.placement ?? "top-start"} gutter={8}>
      <KobaltePopover.Trigger as="div">{props.trigger}</KobaltePopover.Trigger>
      <KobaltePopover.Portal>
        <KobaltePopover.Content
          class={`flex flex-col rounded-2xl border border-border-base bg-surface-raised-stronger-non-alpha shadow-lg z-50 outline-none overflow-hidden ${props.contentClass ?? "w-56 max-h-64"}`}
        >
          <KobaltePopover.Title class="sr-only">{props.title ?? "Select"}</KobaltePopover.Title>
          {props.children(close)}
        </KobaltePopover.Content>
      </KobaltePopover.Portal>
    </KobaltePopover>
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
      <Icon name="chevron-down" size="small" class="text-icon-weak" />
    </button>
  )
}
