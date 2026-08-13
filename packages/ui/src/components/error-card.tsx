import { Show, createMemo, createSignal, splitProps } from "solid-js"
import { useLingui } from "@lingui/solid"
import { Collapsible } from "./collapsible"
import { createCopyController } from "./clipboard"
import { errorDetailsText, errorInputText, errorPreview } from "./error-card-content"
import { Icon } from "./icon"
import "./error-card.css"
import { getSemanticIcon } from "./semantic-icon"

const errorDetailsLabelDescriptor = { id: "ui.errorCard.detailsTitle", message: "Error details" }
const toolInputLabelDescriptor = { id: "ui.errorCard.toolInput", message: "Tool input" }
const copyDetailsDescriptor = { id: "ui.errorCard.copyDetails", message: "Copy details" }
const copiedDescriptor = { id: "ui.errorCard.copied", message: "Copied" }
const copyFailureDescriptor = { id: "ui.errorCard.copyFailure", message: "Unable to copy the error details." }

export interface ErrorCardProps {
  error: string
  defaultOpen?: boolean
  input?: Record<string, unknown>
}

export function ErrorCard(props: ErrorCardProps) {
  const { _ } = useLingui()
  const [local] = splitProps(props, ["error", "input", "defaultOpen"])
  const copy = createCopyController({
    text: () => errorDetailsText(local.error, local.input),
    get copyLabel() {
      return _(copyDetailsDescriptor)
    },
    get copiedLabel() {
      return _(copiedDescriptor)
    },
    get failureDescription() {
      return _(copyFailureDescriptor)
    },
    copyIcon: getSemanticIcon("action.copy"),
    copiedIcon: getSemanticIcon("state.success"),
    failedIcon: getSemanticIcon("state.error"),
  })
  const [open, setOpen] = createSignal(local.defaultOpen ?? false)
  const expandIcon = createMemo(() =>
    open() ? getSemanticIcon("navigation.collapse") : getSemanticIcon("navigation.expand"),
  )

  return (
    <div data-component="error-card" data-expanded={open() ? "" : undefined}>
      <Collapsible open={open()} onOpenChange={setOpen} variant="ghost">
        <Collapsible.Trigger data-slot="error-card-header" type="button">
          <span data-slot="error-card-leading" aria-hidden="true">
            <Icon name={getSemanticIcon("state.error")} size="small" />
          </span>
          <div data-slot="error-card-copy">
            <span data-slot="error-card-message">{errorPreview(local.error)}</span>
          </div>
          <span data-slot="error-card-arrow" aria-hidden="true">
            <Icon name={expandIcon()} size="small" />
          </span>
        </Collapsible.Trigger>
        <Collapsible.Content>
          <div data-slot="error-card-content">
            <div data-slot="error-card-label">{_(errorDetailsLabelDescriptor)}</div>
            <pre data-slot="error-card-text">{local.error}</pre>
            <Show when={errorInputText(local.input)}>
              {(input) => (
                <>
                  <div data-slot="error-card-label">{_(toolInputLabelDescriptor)}</div>
                  <pre data-slot="error-card-text">{input()}</pre>
                </>
              )}
            </Show>
            <div data-slot="error-card-actions">
              <button
                type="button"
                data-slot="error-card-copy-button"
                data-copy-state={copy.state()}
                disabled={copy.disabled()}
                aria-label={copy.tooltip()}
                onClick={() => void copy.copy()}
              >
                <Icon name={copy.icon()} size="small" />
                <span>{copy.tooltip()}</span>
              </button>
            </div>
          </div>
        </Collapsible.Content>
      </Collapsible>
    </div>
  )
}
