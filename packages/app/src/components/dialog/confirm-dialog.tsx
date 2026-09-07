import { createSignal } from "solid-js"
import type { I18n, MessageDescriptor } from "@lingui/core"
import { useLingui } from "@lingui/solid"
import { Button } from "@ericsanchezok/synergy-ui/button"
import { useDialog } from "@ericsanchezok/synergy-ui/context/dialog"
import { Dialog } from "@ericsanchezok/synergy-ui/dialog"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { Spinner } from "@ericsanchezok/synergy-ui/spinner"
import { showToast } from "@ericsanchezok/synergy-ui/toast"
import { dialog } from "@/locales/messages"
import { translateDescriptor } from "@/locales/translate"
import type { ConfirmTone } from "./confirm-copy"
import "./confirm-dialog.css"
import { getSemanticIcon } from "@ericsanchezok/synergy-ui/semantic-icon"

export type { ConfirmTone } from "./confirm-copy"

export type ConfirmContent = string | MessageDescriptor

export interface ConfirmOptions {
  title: ConfirmContent
  description: ConfirmContent
  confirmLabel: ConfirmContent
  cancelLabel?: ConfirmContent
  tone: ConfirmTone
  onConfirm: () => void | Promise<void>
  onConfirmed?: () => void
  onDismiss?: () => void
}
function errorDescription(error: unknown, _: (descriptor: { id: string; message: string }) => string): string {
  if (error instanceof Error && error.message) return error.message
  if (typeof error === "string" && error) return error
  return _(dialog.actionNotCompleted)
}
function resolveContent(content: ConfirmContent, translate: I18n["_"]): string {
  return typeof content === "string" ? content : translateDescriptor(content, { _: translate })
}

export function ConfirmDialog(props: ConfirmOptions & { close?: () => void }) {
  const { _ } = useLingui()
  const dialogContext = useDialog()
  const [pending, setPending] = createSignal(false)
  let settled = false
  const close = () => (props.close ?? dialogContext.close)()

  function dismiss() {
    if (pending() || settled) return
    settled = true
    close()
    props.onDismiss?.()
  }

  async function confirm() {
    if (pending() || settled) return
    setPending(true)
    try {
      await props.onConfirm()
      settled = true
      close()
      props.onConfirmed?.()
    } catch (error) {
      showToast({
        type: "error",
        title: _(dialog.actionFailed),
        description: errorDescription(error, _),
      })
      setPending(false)
    }
  }

  return (
    <Dialog
      dismissible={!pending()}
      title={resolveContent(props.title, _)}
      description={resolveContent(props.description, _)}
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
          {props.cancelLabel ? resolveContent(props.cancelLabel, _) : _(dialog.cancel)}
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
              {resolveContent(props.confirmLabel, _)}
            </>
          ) : (
            resolveContent(props.confirmLabel, _)
          )}
        </Button>
      </div>
    </Dialog>
  )
}

export function useConfirm() {
  const dialogContext = useDialog()

  function show(options: ConfirmOptions) {
    let confirmed = false
    let dismissed = false
    let id: string | undefined
    const dismiss = () => {
      if (confirmed || dismissed) return
      dismissed = true
      options.onDismiss?.()
    }
    id = dialogContext.push(
      () => (
        <ConfirmDialog
          {...options}
          close={() => dialogContext.close(id)}
          onConfirm={async () => {
            await options.onConfirm()
            confirmed = true
          }}
          onDismiss={dismiss}
        />
      ),
      dismiss,
      { protected: true },
    )
    return id
  }

  return {
    show,
    ask(options: Omit<ConfirmOptions, "onConfirm" | "onConfirmed" | "onDismiss">): Promise<boolean> {
      return new Promise((resolve) =>
        show({ ...options, onConfirm() {}, onConfirmed: () => resolve(true), onDismiss: () => resolve(false) }),
      )
    },
    close(id?: string) {
      dialogContext.close(id)
    },
  }
}
