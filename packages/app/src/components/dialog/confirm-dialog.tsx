import { createSignal, type JSXElement } from "solid-js"
import { Button } from "@ericsanchezok/synergy-ui/button"
import { useDialog } from "@ericsanchezok/synergy-ui/context/dialog"
import { Dialog } from "@ericsanchezok/synergy-ui/dialog"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { Spinner } from "@ericsanchezok/synergy-ui/spinner"
import { showToast } from "@ericsanchezok/synergy-ui/toast"
import type { ConfirmTone } from "./confirm-copy"
import "./confirm-dialog.css"

export type { ConfirmTone } from "./confirm-copy"

export interface ConfirmOptions {
  title: JSXElement
  description: JSXElement
  confirmLabel: string
  cancelLabel?: string
  tone: ConfirmTone
  onConfirm: () => void | Promise<void>
}

function errorDescription(error: unknown) {
  if (error instanceof Error && error.message) return error.message
  if (typeof error === "string" && error) return error
  return "The action could not be completed."
}

export function ConfirmDialog(props: ConfirmOptions) {
  const dialog = useDialog()
  const [pending, setPending] = createSignal(false)

  async function confirm() {
    if (pending()) return
    setPending(true)
    try {
      await props.onConfirm()
      dialog.close()
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
            if (!pending()) dialog.close()
          }}
        >
          <Icon name="x" size="small" />
        </button>
      }
    >
      <div class="confirm-dialog-actions">
        <Button type="button" variant="ghost" size="small" disabled={pending()} onClick={() => dialog.close()}>
          {props.cancelLabel ?? "Cancel"}
        </Button>
        <Button
          type="button"
          variant={props.tone === "neutral" ? "primary" : "secondary"}
          size="small"
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
