import { OverlayLayerProvider, useOverlayLayer } from "../context/overlay-layer"
import { PortalStyleOwner } from "../context/ui-style"
import { Popover as Kobalte } from "@kobalte/core/popover"
import {
  createSignal,
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
  if (!trigger?.isConnected) return
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
}

export function Popover(props: PopoverProps) {
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
    "children",
  ])

  return (
    <Kobalte gutter={4} {...rest}>
      <Show
        when={local.triggerAs}
        fallback={
          <Kobalte.Trigger ref={triggerElement} as="div" data-slot="popover-trigger">
            {local.trigger}
          </Kobalte.Trigger>
        }
      >
        {(trigger) => <Kobalte.Trigger ref={triggerElement} as={trigger()} data-slot="popover-trigger" />}
      </Show>
      <Kobalte.Portal mount={local.portalMount ?? parentLayer()}>
        <PortalStyleOwner>
          <OverlayLayerProvider layer={layer}>
            <Kobalte.Content
              ref={setLayer}
              onCloseAutoFocus={(event) => {
                event.preventDefault()
                void restorePopoverFocus(triggerElement, layer())
              }}
              onEscapeKeyDown={(event) => event.stopPropagation()}
              data-component="popover-content"
              data-variant={local.variant ?? "default"}
              classList={{
                ...(local.classList ?? {}),
                [local.class ?? ""]: !!local.class,
              }}
            >
              {/* <Kobalte.Arrow data-slot="popover-arrow" /> */}
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
