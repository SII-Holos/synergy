import { useOverlayLayer } from "../context/overlay-layer"
import { PortalStyleOwner } from "../context/ui-style"
import { Tooltip as KobalteTooltip } from "@kobalte/core/tooltip"
import { children, createSignal, onCleanup, onMount, splitProps, type JSX } from "solid-js"
import { attachFocusListeners } from "./tooltip-focus"
import type { ComponentProps } from "solid-js"

export interface TooltipProps extends ComponentProps<typeof KobalteTooltip> {
  value: JSX.Element
  class?: string
  inactive?: boolean
}

export interface TooltipKeybindProps extends Omit<TooltipProps, "value"> {
  title: string
  keybind: string
}

export function TooltipKeybind(props: TooltipKeybindProps) {
  const [local, others] = splitProps(props, ["title", "keybind"])
  return (
    <Tooltip
      {...others}
      value={
        <div data-slot="tooltip-keybind">
          <span>{local.title}</span>
          <span data-slot="tooltip-keybind-key">{local.keybind}</span>
        </div>
      }
    />
  )
}

export function Tooltip(props: TooltipProps) {
  const layer = useOverlayLayer()
  const [open, setOpen] = createSignal(false)
  const [local, others] = splitProps(props, ["children", "class", "inactive"])

  const c = children(() => local.children)
  const enabled = () => !local.inactive && !!others.value

  onMount(() => {
    const childElements = c()
    const elements =
      childElements instanceof HTMLElement ? [childElements] : Array.isArray(childElements) ? childElements : []
    onCleanup(
      attachFocusListeners(
        elements,
        () => setOpen(true),
        () => setOpen(false),
      ),
    )
  })

  return (
    <KobalteTooltip
      gutter={4}
      openDelay={400}
      {...others}
      open={enabled() && (props.open ?? open())}
      onOpenChange={setOpen}
    >
      <KobalteTooltip.Trigger
        as="div"
        data-component="tooltip-trigger"
        data-inactive={!enabled() ? "" : undefined}
        class={local.class}
      >
        {c()}
      </KobalteTooltip.Trigger>
      <KobalteTooltip.Portal mount={layer()}>
        <PortalStyleOwner>
          <KobalteTooltip.Content data-component="tooltip" data-placement={props.placement}>
            {others.value}
          </KobalteTooltip.Content>
        </PortalStyleOwner>
      </KobalteTooltip.Portal>
    </KobalteTooltip>
  )
}
