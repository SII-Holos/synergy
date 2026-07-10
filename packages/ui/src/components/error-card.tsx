import { Show, splitProps } from "solid-js"
import { Card } from "./card"
import { createCopyController } from "./clipboard"
import { Icon } from "./icon"
import { Tooltip } from "./tooltip"
import "./error-card.css"
import { getSemanticIcon } from "./semantic-icon"

export interface ErrorCardProps {
  /** Full raw error text — copy button copies this exactly */
  error: string
  /** Compact single-line mode for session-level errors. Default false. */
  compact?: boolean
  /** Optional tool input args to display alongside the error */
  input?: Record<string, unknown>
}

function parseError(raw: string): { title: string | null; message: string } {
  const stripped = raw.replace(/^error:\s*/i, "")
  const colonSpace = stripped.indexOf(": ")
  if (colonSpace > 0 && colonSpace < 30) {
    return { title: stripped.slice(0, colonSpace), message: stripped.slice(colonSpace + 2) }
  }
  return { title: null, message: stripped }
}

export function ErrorCard(props: ErrorCardProps) {
  const [local] = splitProps(props, ["error", "compact", "input"])
  const parsed = () => parseError(local.error)
  const inputText = () => (local.input ? JSON.stringify(local.input, null, 2) : null)
  const copy = createCopyController({
    text: () => local.error,
    copyLabel: "Copy error",
    failureDescription: "Unable to copy the error.",
  })

  return (
    <Card variant="error">
      <div data-component="error-card" data-compact={local.compact ? "" : undefined}>
        <Icon name={getSemanticIcon("state.error")} size="small" />
        <div data-slot="error-card-content">
          <Show when={local.compact}>
            <span data-slot="error-card-message">{local.error}</span>
          </Show>
          <Show when={!local.compact}>
            <Show when={parsed().title}>
              <span data-slot="error-card-title">{parsed().title}</span>
            </Show>
            <span data-slot="error-card-message">{parsed().message}</span>
            <Show when={inputText()}>
              <pre data-slot="error-card-input">{inputText()}</pre>
            </Show>
          </Show>
        </div>
        <Tooltip value={copy.tooltip()} placement="top" gutter={4}>
          <button
            type="button"
            data-slot="error-card-copy"
            data-copy-state={copy.state()}
            disabled={copy.disabled()}
            onClick={() => void copy.copy()}
          >
            <Icon name={copy.icon()} size="small" />
          </button>
        </Tooltip>
      </div>
    </Card>
  )
}
