import { OverlayLayerProvider } from "../context/overlay-layer"
import { Dialog as Kobalte } from "@kobalte/core/dialog"
import { createSignal, ComponentProps, JSXElement, Match, ParentProps, Show, Switch, onCleanup } from "solid-js"
import { useLingui } from "@lingui/solid"
import { Icon } from "./icon"

const dialogCloseDescriptor = { id: "ui.dialog.close", message: "Close dialog" }

export type DialogSize = "compact" | "form" | "list" | "wide" | "command" | "content"
export type DialogPlacement = "center" | "top"

export interface DialogProps extends ParentProps {
  ariaLabel?: string
  title?: JSXElement
  description?: JSXElement
  action?: JSXElement
  initialFocus?: () => HTMLElement | undefined
  footer?: JSXElement
  onEscapeKeyDown?: (event: KeyboardEvent) => void
  dismissible?: boolean
  size?: DialogSize
  placement?: DialogPlacement
  class?: ComponentProps<"div">["class"]
  classList?: ComponentProps<"div">["classList"]
}

export function Dialog(props: DialogProps) {
  const { _ } = useLingui()
  const [layer, setLayer] = createSignal<HTMLElement>()
  let autofocusFrame: number | undefined
  onCleanup(() => {
    if (autofocusFrame !== undefined) cancelAnimationFrame(autofocusFrame)
  })
  return (
    <div data-component="dialog" data-size={props.size ?? "content"} data-placement={props.placement ?? "center"}>
      <div data-slot="dialog-container">
        <OverlayLayerProvider layer={layer}>
          <Kobalte.Content
            ref={setLayer}
            aria-label={props.ariaLabel}
            data-slot="dialog-content"
            onEscapeKeyDown={(e) => {
              if (e.defaultPrevented) return
              if (props.dismissible === false) e.preventDefault()
              props.onEscapeKeyDown?.(e)
            }}
            onPointerDownOutside={(e) => {
              if (props.dismissible === false) e.preventDefault()
            }}
            onInteractOutside={(e) => {
              if (props.dismissible === false) e.preventDefault()
            }}
            classList={{
              ...(props.classList ?? {}),
              [props.class ?? ""]: !!props.class,
            }}
            onOpenAutoFocus={(e) => {
              const target = layer()
              const autofocusEl = props.initialFocus?.() ?? target?.querySelector<HTMLElement>("[autofocus]")
              if (autofocusEl) {
                e.preventDefault()
                autofocusFrame = requestAnimationFrame(() => {
                  if (autofocusEl.isConnected) autofocusEl.focus({ preventScroll: true })
                })
              }
            }}
          >
            <Show when={props.title || props.action}>
              <div data-slot="dialog-header">
                <Show when={props.title}>
                  <Kobalte.Title data-slot="dialog-title">{props.title}</Kobalte.Title>
                </Show>
                <Switch>
                  <Match when={props.action}>{props.action}</Match>
                  <Match when={true}>
                    <Kobalte.CloseButton
                      aria-label={_(dialogCloseDescriptor)}
                      data-slot="dialog-close-button"
                      data-component="icon-button"
                      data-variant="ghost"
                    >
                      <Icon name="x" size="small" />
                    </Kobalte.CloseButton>
                  </Match>
                </Switch>
              </div>
            </Show>
            <Show when={props.description}>
              <Kobalte.Description data-slot="dialog-description">{props.description}</Kobalte.Description>
            </Show>
            <div data-slot="dialog-body">{props.children}</div>
            <Show when={props.footer}>
              <div data-slot="dialog-footer">{props.footer}</div>
            </Show>
          </Kobalte.Content>
        </OverlayLayerProvider>
      </div>
    </div>
  )
}
