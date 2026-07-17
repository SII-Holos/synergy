import { createResource, createSignal, Show } from "solid-js"
import { Dialog } from "@ericsanchezok/synergy-ui/dialog"
import { useDialog } from "@ericsanchezok/synergy-ui/context/dialog"
import { showToast } from "@ericsanchezok/synergy-ui/toast"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { Button } from "@ericsanchezok/synergy-ui/button"
import { useSync } from "@/context/sync"
import { useSDK } from "@/context/sdk"
import { useParams } from "@solidjs/router"
import type { SessionExportMode } from "@ericsanchezok/synergy-sdk/client"
import "./dialog-session-export.css"
import { getSemanticIcon } from "@ericsanchezok/synergy-ui/semantic-icon"
import { sessionScopeRequest } from "@/components/session/session-actions"

function formatBytes(bytes?: number): string {
  if (typeof bytes !== "number" || Number.isNaN(bytes)) return "—"
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

const MODE_OPTIONS: Array<{ value: SessionExportMode; label: string; desc: string }> = [
  { value: "compact", label: "Compact", desc: "Truncated tool output, minimal thinking" },
  { value: "standard", label: "Standard", desc: "Full messages, truncated large outputs" },
  { value: "full", label: "Full", desc: "Everything included, no truncation" },
]

export function DialogSessionExport() {
  const params = useParams()
  const dialog = useDialog()
  const sdk = useSDK()
  const sync = useSync()

  const [mode, setMode] = createSignal<SessionExportMode>("standard")
  const [exporting, setExporting] = createSignal(false)

  const sessionID = () => params.id

  const currentSession = () => {
    const id = sessionID()
    if (!id) return undefined
    return sync.session.get(id)
  }

  const childSessions = () => {
    const id = sessionID()
    if (!id) return []
    return sync.data.session.filter((session) => session.parentID === id)
  }

  const [estimate] = createResource(
    () => {
      const id = sessionID()
      if (!id) return undefined
      return id
    },
    async (sessionID) => {
      const res = await sdk.client.session.export.estimate({ sessionID })
      return res.data!
    },
  )

  async function handleExport() {
    const id = sessionID()
    if (!id) return
    setExporting(true)
    try {
      const query = new URLSearchParams({ ...sessionScopeRequest(sdk.scopeKey), mode: mode() })
      const url = `${sdk.url}/session/${encodeURIComponent(id)}/export?${query}`
      const a = document.createElement("a")
      a.href = url
      a.download = ""
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      showToast({ type: "info", title: "Session export downloading" })
      dialog.close()
    } catch (e: any) {
      showToast({ type: "error", title: "Export failed", description: e.message })
    } finally {
      setExporting(false)
    }
  }

  return (
    <Dialog title="Export session data" size="wide" class="dialog-session-export">
      <div class="session-export-body">
        <Show when={currentSession()}>
          {(session) => (
            <section class="session-export-summary" aria-label="Session summary">
              <div class="session-export-summary-title">
                <Icon name={getSemanticIcon("session.default")} size="small" class="session-export-summary-icon" />
                <span>{session().title || "Untitled session"}</span>
              </div>
              <div class="session-export-meta">
                <span>{session().id.slice(0, 16)}…</span>
                <Show when={estimate()}>
                  {(est) => {
                    const value = est()
                    const sessionCount = Number.isFinite(value.sessionCount) ? value.sessionCount : 0
                    const messageCount = Number.isFinite(value.messageCount) ? value.messageCount : 0
                    const estimatedBytes = Number.isFinite(value.estimatedBytes) ? value.estimatedBytes : undefined
                    return (
                      <>
                        <span>
                          {sessionCount} session{sessionCount > 1 ? "s" : ""}
                        </span>
                        <span>{messageCount} messages</span>
                        <span>{formatBytes(estimatedBytes)}</span>
                      </>
                    )
                  }}
                </Show>
                <Show when={childSessions().length > 0}>
                  <span>
                    {childSessions().length} subsession{childSessions().length > 1 ? "s" : ""}
                  </span>
                </Show>
              </div>
            </section>
          )}
        </Show>

        <section data-slot="dialog-section">
          <span class="session-export-label">Detail level</span>
          <div data-slot="dialog-option-list" class="session-export-mode-group">
            {MODE_OPTIONS.map((opt) => (
              <button
                type="button"
                data-slot="dialog-option"
                data-selected={mode() === opt.value}
                onClick={() => setMode(opt.value)}
              >
                <span class="session-export-mode-title">{opt.label}</span>
                <span class="session-export-mode-desc">{opt.desc}</span>
              </button>
            ))}
          </div>
        </section>
      </div>

      <div data-slot="dialog-actions" class="session-export-footer">
        <span class="session-export-hint">Save session data as .json.gz</span>
        <Button
          type="button"
          variant="primary"
          size="large"
          icon={getSemanticIcon("action.download")}
          disabled={exporting()}
          onClick={handleExport}
        >
          {exporting() ? "Downloading..." : "Download export"}
        </Button>
      </div>
    </Dialog>
  )
}
