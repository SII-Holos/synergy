import { Dialog as Kobalte } from "@kobalte/core/dialog"
import { ComponentProps, JSXElement, Match, ParentProps, Show, Switch } from "solid-js"
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
  dismissible?: boolean
  size?: DialogSize
  placement?: DialogPlacement
  class?: ComponentProps<"div">["class"]
  classList?: ComponentProps<"div">["classList"]
}

export function Dialog(props: DialogProps) {
  const { _ } = useLingui()
  return (
    <div data-component="dialog" data-size={props.size ?? "content"} data-placement={props.placement ?? "center"}>
      <div data-slot="dialog-container">
        <Kobalte.Content
          aria-label={props.ariaLabel}
          data-slot="dialog-content"
          onEscapeKeyDown={(e) => {
            if (props.dismissible === false) e.preventDefault()
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
            const target = e.currentTarget as HTMLElement | null
            const autofocusEl = target?.querySelector("[autofocus]") as HTMLElement | null
            if (autofocusEl) {
              e.preventDefault()
              autofocusEl.focus()
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
        </Kobalte.Content>
      </div>
    </div>
  )
}
