import { Show, splitProps } from "solid-js"
import { useLingui } from "@lingui/solid"
import { useDialog } from "../context/dialog"
import { Button } from "./button"
import { Card } from "./card"
import { createCopyController } from "./clipboard"
import { Dialog } from "./dialog"
import { errorDetailsText, errorInputText, errorPreview } from "./error-card-content"
import { Icon } from "./icon"
import "./error-card.css"
import { getSemanticIcon } from "./semantic-icon"

const errorDetailsTitleDescriptor = { id: "ui.errorCard.detailsTitle", message: "Error details" }
const errorMessageLabelDescriptor = { id: "ui.errorCard.errorMessage", message: "Error message" }
const toolInputLabelDescriptor = { id: "ui.errorCard.toolInput", message: "Tool input" }
const copyDetailsDescriptor = { id: "ui.errorCard.copyDetails", message: "Copy details" }
const copiedDescriptor = { id: "ui.errorCard.copied", message: "Copied" }
const copyFailureDescriptor = { id: "ui.errorCard.copyFailure", message: "Unable to copy the error details." }
const viewDetailsDescriptor = { id: "ui.errorCard.viewDetails", message: "View details" }

export interface ErrorCardProps {
  error: string
  compact?: boolean
  input?: Record<string, unknown>
}

function ErrorDetailsDialog(props: Pick<ErrorCardProps, "error" | "input">) {
  const { _ } = useLingui()
  const copy = createCopyController({
    text: () => errorDetailsText(props.error, props.input),
    copyLabel: _(copyDetailsDescriptor),
    copiedLabel: _(copiedDescriptor),
    failureDescription: _(copyFailureDescriptor),
    copyIcon: getSemanticIcon("action.copy"),
    copiedIcon: getSemanticIcon("state.success"),
    failedIcon: getSemanticIcon("state.error"),
  })

  return (
    <Dialog title={_(errorDetailsTitleDescriptor)} size="wide" class="error-details-dialog">
      <section data-slot="error-details-section">
        <div data-slot="error-details-label">{_(errorMessageLabelDescriptor)}</div>
        <pre data-slot="error-details-content">{props.error}</pre>
      </section>
      <Show when={errorInputText(props.input)}>
        {(input) => (
          <section data-slot="error-details-section">
            <div data-slot="error-details-label">{_(toolInputLabelDescriptor)}</div>
            <pre data-slot="error-details-content">{input()}</pre>
          </section>
        )}
      </Show>
      <div data-slot="dialog-actions">
        <Button
          type="button"
          variant="secondary"
          size="large"
          icon={copy.icon()}
          data-copy-state={copy.state()}
          disabled={copy.disabled()}
          onClick={() => void copy.copy()}
        >
          {copy.tooltip()}
        </Button>
      </div>
    </Dialog>
  )
}

export function ErrorCard(props: ErrorCardProps) {
  const { _ } = useLingui()
  const [local] = splitProps(props, ["error", "input"])
  const dialog = useDialog()

  const openDetails = () => {
    dialog.show(() => <ErrorDetailsDialog error={local.error} input={local.input} />)
  }

  return (
    <Card variant="error" class="error-card-shell">
      <button type="button" data-component="error-card" onClick={openDetails}>
        <Icon name={getSemanticIcon("state.error")} size="small" />
        <div data-slot="error-card-content">
          <span data-slot="error-card-message">{errorPreview(local.error)}</span>
        </div>
        <span data-slot="error-card-details">
          {_(viewDetailsDescriptor)}
          <Icon name={getSemanticIcon("navigation.expand")} size="small" />
        </span>
      </button>
    </Card>
  )
}
