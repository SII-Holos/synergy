import { createSignal, type JSXElement } from "solid-js"
import { Button } from "@ericsanchezok/synergy-ui/button"
import { useDialog } from "@ericsanchezok/synergy-ui/context/dialog"
import { Dialog } from "@ericsanchezok/synergy-ui/dialog"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { Spinner } from "@ericsanchezok/synergy-ui/spinner"
import { showToast } from "@ericsanchezok/synergy-ui/toast"
import type { ConfirmTone } from "./confirm-copy"
import "./confirm-dialog.css"
import { getSemanticIcon } from "@ericsanchezok/synergy-ui/semantic-icon"

export type { ConfirmTone } from "./confirm-copy"

export interface ConfirmOptions {
  title: JSXElement
  description: JSXElement
  confirmLabel: string
  cancelLabel?: string
  tone: ConfirmTone
  onConfirm: () => void | Promise<void>
  onConfirmed?: () => void
  onDismiss?: () => void
}

function errorDescription(error: unknown) {
  if (error instanceof Error && error.message) return error.message
  if (typeof error === "string" && error) return error
  return "The action could not be completed."
}

export function ConfirmDialog(props: ConfirmOptions) {
  const dialog = useDialog()
  const [pending, setPending] = createSignal(false)
  let settled = false

  function dismiss() {
    if (pending() || settled) return
    settled = true
    dialog.close()
    props.onDismiss?.()
  }

  async function confirm() {
    if (pending() || settled) return
    setPending(true)
    try {
      await props.onConfirm()
      settled = true
      dialog.close()
      props.onConfirmed?.()
    } catch (error) {
      showToast({
        type: "error",
        title: "Action failed",
        description: errorDescription(error),
      })
      setPending(false)
    }
  }

  return (
    <Dialog
      title={props.title}
      description={props.description}
      class="confirm-dialog"
      action={
        <button
          type="button"
          data-slot="dialog-close-button"
          data-component="icon-button"
          data-variant="ghost"
          disabled={pending()}
          onClick={() => {
            dismiss()
          }}
        >
          <Icon name={getSemanticIcon("action.close")} size="small" />
        </button>
      }
    >
      <div data-slot="dialog-actions" class="confirm-dialog-actions">
        <Button type="button" variant="ghost" size="large" disabled={pending()} onClick={() => dismiss()}>
          {props.cancelLabel ?? "Cancel"}
        </Button>
        <Button
          type="button"
          variant={props.tone === "neutral" ? "primary" : "secondary"}
          size="large"
          class="confirm-dialog-button"
          data-tone={props.tone}
          disabled={pending()}
          onClick={() => void confirm()}
        >
          {pending() ? (
            <>
              <Spinner class="confirm-dialog-spinner" />
              {props.confirmLabel}
            </>
          ) : (
            props.confirmLabel
          )}
        </Button>
      </div>
    </Dialog>
  )
}

export function useConfirm() {
  const dialog = useDialog()

  return {
    show(options: ConfirmOptions) {
      dialog.push(() => <ConfirmDialog {...options} />)
    },
    close() {
      dialog.close()
    },
  }
}
