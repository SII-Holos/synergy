import { useLingui } from "@lingui/solid"
import type { MessageDescriptor } from "@lingui/core"
import { browserErrorPresentation } from "./browser-error"
import { Dialog } from "@ericsanchezok/synergy-ui/dialog"
import { Button } from "@ericsanchezok/synergy-ui/button"
import { createCopyController } from "@ericsanchezok/synergy-ui/clipboard"
import { browser as B, rawMessages } from "@/locales/messages"

export function BrowserErrorDetails(props: { error: { code?: string; message: string } }) {
  const { _ } = useLingui()
  const details = () => browserErrorPresentation(props.error).details
  const copy = createCopyController({
    text: details,
    get copyLabel() {
      return _(B.copyErrorDetails)
    },
    get copiedLabel() {
      return _(rawMessages.copied)
    },
    get failedLabel() {
      return _(rawMessages.copyFailed)
    },
  })
  return (
    <Dialog
      title={_(B.errorDetails)}
      size="compact"
      footer={
        <div class="flex items-center justify-end gap-2">
          <span role="status" class="text-12 text-text-weak">
            {copy.state() === "idle" ? "" : copy.tooltip()}
          </span>
          <Button variant="secondary" icon={copy.icon()} disabled={copy.disabled()} onClick={() => void copy.copy()}>
            {_(B.copyErrorDetails)}
          </Button>
        </div>
      }
    >
      <pre class="whitespace-pre-wrap break-words p-4 text-12 text-text-base">{details()}</pre>
    </Dialog>
  )
}

export function BrowserErrorMessage(props: { error: { code?: string; message: string } }) {
  const { _ } = useLingui()
  const presentation = () => browserErrorPresentation(props.error)
  const translate = (message: MessageDescriptor) => _(message)
  return (
    <div class="min-w-0 flex-1 break-words text-text-weak">
      <span>{translate(presentation())}</span>
      <details class="mt-1 text-12">
        <summary class="cursor-pointer">{_({ id: "browser.failure.details", message: "Diagnostic details" })}</summary>
        <pre class="whitespace-pre-wrap break-words">{presentation().details}</pre>
      </details>
    </div>
  )
}
