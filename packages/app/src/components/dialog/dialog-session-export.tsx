import { createResource, createSignal, Show } from "solid-js"
import { Dialog } from "@ericsanchezok/synergy-ui/dialog"
import { useDialog } from "@ericsanchezok/synergy-ui/context/dialog"
import { showToast } from "@ericsanchezok/synergy-ui/toast"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { Button } from "@ericsanchezok/synergy-ui/button"
import { useLingui } from "@lingui/solid"
import { dialog } from "@/locales/messages"
import { useGlobalSDK } from "@/context/global-sdk"
import { useGlobalSync } from "@/context/global-sync"
import { base64Decode } from "@ericsanchezok/synergy-util/encode"
import { useParams } from "@solidjs/router"
import type { Session, SessionExportMode } from "@ericsanchezok/synergy-sdk/client"
import "./dialog-session-export.css"
import { getSemanticIcon } from "@ericsanchezok/synergy-ui/semantic-icon"

function formatBytes(bytes?: number): string {
  if (typeof bytes !== "number" || Number.isNaN(bytes)) return "—"
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

const MODE_OPTIONS: SessionExportMode[] = ["compact", "standard", "full"]

function modeLabel(mode: SessionExportMode, _: (descriptor: { id: string; message: string }) => string): string {
  if (mode === "compact") return _(dialog.compact)
  if (mode === "standard") return _(dialog.standard)
  return _(dialog.full)
}

function modeDescription(mode: SessionExportMode, _: (descriptor: { id: string; message: string }) => string): string {
  if (mode === "compact") return _(dialog.compactDesc)
  if (mode === "standard") return _(dialog.standardDesc)
  return _(dialog.fullDesc)
}

export function DialogSessionExport() {
  const params = useParams()
  const dialogContext = useDialog()
  const globalSDK = useGlobalSDK()
  const globalSync = useGlobalSync()
  const { _ } = useLingui()

  const [mode, setMode] = createSignal<SessionExportMode>("standard")
  const [exporting, setExporting] = createSignal(false)

  const sessionID = () => params.id
  const directory = () => (params.dir ? base64Decode(params.dir) : "")

  const currentSession = () => {
    const dir = directory()
    if (!dir) return undefined
    const [store] = globalSync.ensureScopeState(dir)
    return store.session.find((s: Session) => s.id === sessionID())
  }

  const childSessions = () => {
    const dir = directory()
    const id = sessionID()
    if (!dir || !id) return []
    const [store] = globalSync.ensureScopeState(dir)
    return store.session.filter((s: Session) => s.parentID === id)
  }

  const [estimate] = createResource(
    () => {
      const id = sessionID()
      const dir = directory()
      if (!id || !dir) return undefined
      return { sessionID: id, directory: dir }
    },
    async (params) => {
      const res = await globalSDK.client.session.export.estimate({
        sessionID: params.sessionID,
        directory: params.directory,
      })
      return res.data!
    },
  )

  async function handleExport() {
    const id = sessionID()
    const dir = directory()
    if (!id || !dir) return
    setExporting(true)
    try {
      const params = new URLSearchParams({ directory: dir, mode: mode() })
      const url = `${globalSDK.url}/session/${encodeURIComponent(id)}/export?${params}`
      const a = document.createElement("a")
      a.href = url
      a.download = ""
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      showToast({ type: "info", title: _(dialog.sessionExportDownloading) })
      dialogContext.close()
    } catch (e: any) {
      showToast({ type: "error", title: _(dialog.sessionExportFailed), description: e.message })
    } finally {
      setExporting(false)
    }
  }

  return (
    <Dialog title={_(dialog.exportSessionData)} size="wide" class="dialog-session-export">
      <div class="session-export-body">
        <Show when={currentSession()}>
          {(session) => (
            <section class="session-export-summary" aria-label={_(dialog.sessionSummaryAria)}>
              <div class="session-export-summary-title">
                <Icon name={getSemanticIcon("session.default")} size="small" class="session-export-summary-icon" />
                <span>{session().title || _(dialog.untitledSession)}</span>
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
                        <span>{_(dialog.exportSessionCount.id, { count: sessionCount })}</span>
                        <span>{_(dialog.exportMessageCount.id, { count: messageCount })}</span>
                        <span>{formatBytes(estimatedBytes)}</span>
                      </>
                    )
                  }}
                </Show>
                <Show when={childSessions().length > 0}>
                  <span>{_(dialog.exportSubsessionCount.id, { count: childSessions().length })}</span>
                </Show>
              </div>
            </section>
          )}
        </Show>

        <section data-slot="dialog-section">
          <span class="session-export-label">{_(dialog.detailLevel)}</span>
          <div data-slot="dialog-option-list" class="session-export-mode-group">
            {MODE_OPTIONS.map((opt) => (
              <button
                type="button"
                data-slot="dialog-option"
                data-selected={mode() === opt}
                onClick={() => setMode(opt)}
              >
                <span class="session-export-mode-title">{modeLabel(opt, _)}</span>
                <span class="session-export-mode-desc">{modeDescription(opt, _)}</span>
              </button>
            ))}
          </div>
        </section>
      </div>

      <div data-slot="dialog-actions" class="session-export-footer">
        <span class="session-export-hint">{_(dialog.exportHint)}</span>
        <Button
          type="button"
          variant="primary"
          size="large"
          icon={getSemanticIcon("action.download")}
          disabled={exporting()}
          onClick={handleExport}
        >
          {exporting() ? _(dialog.downloading) : _(dialog.downloadExport)}
        </Button>
      </div>
    </Dialog>
  )
}
