import { createSignal, Show, splitProps } from "solid-js"
import { Card } from "./card"
import { Icon } from "./icon"
import { Tooltip } from "./tooltip"
import "./error-card.css"

export interface ErrorCardProps {
  /** Full raw error text — copy button copies this exactly */
  error: string
  /** Compact single-line mode for session-level errors. Default false. */
  compact?: boolean
}

const copyResetDelay = 2000

/** Copy text to clipboard, falling back to execCommand for insecure contexts */
async function copyToClipboard(text: string): Promise<boolean> {
  if (navigator.clipboard && window.isSecureContext) {
    await navigator.clipboard.writeText(text)
    return true
  }
  try {
    const ta = document.createElement("textarea")
    ta.value = text
    ta.style.position = "fixed"
    ta.style.opacity = "0"
    ta.style.pointerEvents = "none"
    document.body.appendChild(ta)
    ta.focus()
    ta.select()
    const ok = document.execCommand("copy")
    document.body.removeChild(ta)
    return ok
  } catch {
    return false
  }
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
  const [local] = splitProps(props, ["error", "compact"])
  const [copied, setCopied] = createSignal(false)
  const parsed = () => parseError(local.error)

  async function handleCopy() {
    const ok = await copyToClipboard(local.error)
    if (ok) {
      setCopied(true)
      setTimeout(() => setCopied(false), copyResetDelay)
    }
  }

  return (
    <Card variant="error">
      <div data-component="error-card" data-compact={local.compact ? "" : undefined}>
        <Icon name="ban" size="small" />
        <div data-slot="error-card-content">
          <Show when={local.compact}>
            <span data-slot="error-card-message">{local.error}</span>
          </Show>
          <Show when={!local.compact}>
            <Show when={parsed().title}>
              <span data-slot="error-card-title">{parsed().title}</span>
            </Show>
            <span data-slot="error-card-message">{parsed().message}</span>
          </Show>
        </div>
        <Tooltip value={copied() ? "Copied" : "Copy error"} placement="top" gutter={4}>
          <button type="button" data-slot="error-card-copy" onClick={handleCopy}>
            <Icon name={copied() ? "check" : "copy"} size="small" />
          </button>
        </Tooltip>
      </div>
    </Card>
  )
}
