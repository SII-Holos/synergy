import { useViewActivity } from "../context/view-activity"
import { OverlayLayerProvider, useOverlayLayer } from "../context/overlay-layer"
import { PortalStyleOwner } from "../context/ui-style"
import { Popover as Kobalte } from "@kobalte/core/popover"
import {
  createSignal,
  createEffect,
  ComponentProps,
  JSXElement,
  ParentProps,
  Show,
  splitProps,
  type Component,
  type JSX,
} from "solid-js"
import { Icon } from "./icon"

export async function restorePopoverFocus(trigger: HTMLElement | undefined, content: HTMLElement | undefined) {
  await Promise.allSettled((content?.getAnimations?.() ?? []).map((animation) => animation.finished))
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
  if (!trigger?.isConnected || trigger.getAttribute("aria-expanded") === "true") return
  const active = trigger.ownerDocument.activeElement
  if (active === trigger.ownerDocument.body || content?.contains(active) || active === trigger)
    trigger.focus({ preventScroll: true })
}

export interface PopoverProps extends ParentProps, Omit<ComponentProps<typeof Kobalte>, "children"> {
  trigger?: JSXElement
  triggerAs?: Component<JSX.ButtonHTMLAttributes<HTMLButtonElement>>
  title?: JSXElement
  description?: JSXElement
  variant?: "default" | "menu"
  portalMount?: HTMLElement
  class?: ComponentProps<"div">["class"]
  classList?: ComponentProps<"div">["classList"]
  contentProps?: Omit<ComponentProps<typeof Kobalte.Content>, "children" | "ref" | "class" | "classList">
}

export function Popover(props: PopoverProps) {
  const active = useViewActivity()
  const [uncontrolledOpen, setUncontrolledOpen] = createSignal(props.defaultOpen ?? false)
  const requestedOpen = () => props.open ?? uncontrolledOpen()
  const changeOpen = (open: boolean) => {
    const next = active() && open
    setUncontrolledOpen(next)
    props.onOpenChange?.(next)
  }
  createEffect(() => {
    if (!active() && requestedOpen()) changeOpen(false)
  })
  const parentLayer = useOverlayLayer()
  const [layer, setLayer] = createSignal<HTMLElement>()
  let triggerElement: HTMLElement | undefined
  const [local, rest] = splitProps(props, [
    "trigger",
    "triggerAs",
    "title",
    "description",
    "variant",
    "portalMount",
    "class",
    "classList",
    "contentProps",
    "children",
  ])

  return (
    <Kobalte gutter={4} {...rest} open={active() && requestedOpen()} onOpenChange={changeOpen}>
      <Show
        when={local.triggerAs}
        fallback={
          <Show when={local.trigger !== undefined}>
            <Kobalte.Trigger ref={triggerElement} as="div" data-slot="popover-trigger">
              {local.trigger}
            </Kobalte.Trigger>
          </Show>
        }
      >
        {(trigger) => <Kobalte.Trigger ref={triggerElement} as={trigger()} data-slot="popover-trigger" />}
      </Show>
      <Kobalte.Portal mount={local.portalMount ?? parentLayer()}>
        <PortalStyleOwner>
          <OverlayLayerProvider layer={layer}>
            <Kobalte.Content
              {...local.contentProps}
              ref={setLayer}
              onCloseAutoFocus={(event) => {
                if (!active()) {
                  event.preventDefault()
                  return
                }
                local.contentProps?.onCloseAutoFocus?.(event)
                if (event.defaultPrevented) return
                event.preventDefault()
                void restorePopoverFocus(triggerElement, layer())
              }}
              onEscapeKeyDown={(event) => {
                local.contentProps?.onEscapeKeyDown?.(event)
                event.stopPropagation()
              }}
              data-component="popover-content"
              data-variant={local.variant ?? "default"}
              classList={{
                ...(local.classList ?? {}),
                [local.class ?? ""]: !!local.class,
              }}
            >
              <Show when={local.title}>
                <div data-slot="popover-header" classList={{ "sr-only": local.variant === "menu" }}>
                  <Kobalte.Title data-slot="popover-title">{local.title}</Kobalte.Title>
                  <Show when={local.variant !== "menu"}>
                    <Kobalte.CloseButton
                      data-slot="popover-close-button"
                      data-component="icon-button"
                      data-variant="ghost"
                    >
                      <Icon name="x" size="small" />
                    </Kobalte.CloseButton>
                  </Show>
                </div>
              </Show>
              <Show when={local.description}>
                <Kobalte.Description data-slot="popover-description">{local.description}</Kobalte.Description>
              </Show>
              <div data-slot="popover-body">{local.children}</div>
            </Kobalte.Content>
          </OverlayLayerProvider>
        </PortalStyleOwner>
      </Kobalte.Portal>
    </Kobalte>
  )
}
