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

export interface PopoverProps extends ParentProps, Omit<ComponentProps<typeof Kobalte>, "children"> {
  trigger?: JSXElement
  triggerAs?: Component<JSX.ButtonHTMLAttributes<HTMLButtonElement>>
  title?: JSXElement
  description?: JSXElement
  class?: ComponentProps<"div">["class"]
  classList?: ComponentProps<"div">["classList"]
}

export function Popover(props: PopoverProps) {
  const parentLayer = useOverlayLayer()
  const [layer, setLayer] = createSignal<HTMLElement>()
  const [local, rest] = splitProps(props, [
    "trigger",
    "triggerAs",
    "title",
    "description",
    "class",
    "classList",
    "children",
  ])

  return (
    <Kobalte gutter={4} {...rest}>
      <Show
        when={local.triggerAs}
        fallback={
          <Kobalte.Trigger as="div" data-slot="popover-trigger">
            {local.trigger}
          </Kobalte.Trigger>
        }
      >
        {(trigger) => <Kobalte.Trigger as={trigger()} data-slot="popover-trigger" />}
      </Show>
      <Kobalte.Portal mount={parentLayer()}>
        <PortalStyleOwner>
          <OverlayLayerProvider layer={layer}>
            <Kobalte.Content
              ref={setLayer}
              data-component="popover-content"
              classList={{
                ...(local.classList ?? {}),
                [local.class ?? ""]: !!local.class,
              }}
            >
              {/* <Kobalte.Arrow data-slot="popover-arrow" /> */}
              <Show when={local.title}>
                <div data-slot="popover-header">
                  <Kobalte.Title data-slot="popover-title">{local.title}</Kobalte.Title>
                  <Kobalte.CloseButton
                    data-slot="popover-close-button"
                    data-component="icon-button"
                    data-variant="ghost"
                  >
                    <Icon name="x" size="small" />
                  </Kobalte.CloseButton>
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
