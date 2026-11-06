import { Show, createMemo, createSignal, splitProps } from "solid-js"
import { useLingui } from "@lingui/solid"
import { Collapsible } from "./collapsible"
import { createCopyController } from "./clipboard"
import { errorDetailsText, errorInputText, errorPreview } from "./error-card-content"
import { Icon } from "./icon"
import "./error-card.css"
import { getSemanticIcon } from "./semantic-icon"
import type { JSX } from "solid-js"

const errorDetailsLabelDescriptor = { id: "ui.errorCard.detailsTitle", message: "Error details" }
const toolInputLabelDescriptor = { id: "ui.errorCard.toolInput", message: "Tool input" }
const copyDetailsDescriptor = { id: "ui.errorCard.copyDetails", message: "Copy details" }
const copiedDescriptor = { id: "ui.errorCard.copied", message: "Copied" }
const copyFailureDescriptor = { id: "ui.errorCard.copyFailure", message: "Unable to copy the error details." }
const showDetailsDescriptor = { id: "ui.errorCard.showDetails", message: "View details" }

export interface ErrorCardProps {
  error: string
  defaultOpen?: boolean
  input?: Record<string, unknown>
  summary?: string
  description?: string
  actions?: JSX.Element
  role?: JSX.HTMLAttributes<HTMLDivElement>["role"]
  progress?: { value: number; label: string }
}

export function ErrorCard(props: ErrorCardProps) {
  const { _ } = useLingui()
  const [local] = splitProps(props, [
    "error",
    "input",
    "defaultOpen",
    "summary",
    "description",
    "actions",
    "role",
    "progress",
  ])
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
    <div data-component="error-card" data-expanded={open() ? "" : undefined} role={local.role}>
      <Collapsible open={open()} onOpenChange={setOpen} variant="ghost">
        <div data-slot="error-card-header">
          <span data-slot="error-card-leading" aria-hidden="true">
            <Icon name={getSemanticIcon("state.error")} size="small" />
          </span>
          <div data-slot="error-card-copy">
            <span data-slot="error-card-message" role="status">
              {local.summary ?? errorPreview(local.error)}
            </span>
            <Show when={local.description}>
              <p data-slot="error-card-description">{local.description}</p>
            </Show>
          </div>
          <div data-slot="error-card-actions">
            <Collapsible.Trigger data-slot="error-card-details-trigger" type="button">
              <span>{_(showDetailsDescriptor)}</span>
              <Icon name={expandIcon()} size="small" />
            </Collapsible.Trigger>
            <Show when={local.actions}>
              <div data-slot="error-card-recovery-actions">{local.actions}</div>
            </Show>
          </div>
        </div>
        <Show when={local.progress}>
          {(progress) => (
            <div
              data-slot="error-card-progress"
              role="progressbar"
              aria-label={progress().label}
              aria-valuetext={progress().label}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={progress().value}
            >
              <div style={{ width: `${progress().value}%` }} />
            </div>
          )}
        </Show>
        <Collapsible.Content>
          <div data-slot="error-card-content">
            <div data-slot="error-card-details-header">
              <div data-slot="error-card-label">{_(errorDetailsLabelDescriptor)}</div>
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
            <pre data-slot="error-card-text">{local.error}</pre>
            <Show when={errorInputText(local.input)}>
              {(input) => (
                <>
                  <div data-slot="error-card-label">{_(toolInputLabelDescriptor)}</div>
                  <pre data-slot="error-card-text">{input()}</pre>
                </>
              )}
            </Show>
          </div>
        </Collapsible.Content>
      </Collapsible>
    </div>
  )
}
