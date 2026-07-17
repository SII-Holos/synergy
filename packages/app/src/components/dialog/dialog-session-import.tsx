import { createSignal, Show } from "solid-js"
import { useNavigate, useParams } from "@solidjs/router"
import { Dialog } from "@ericsanchezok/synergy-ui/dialog"
import { useDialog } from "@ericsanchezok/synergy-ui/context/dialog"
import { showToast } from "@ericsanchezok/synergy-ui/toast"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { Button } from "@ericsanchezok/synergy-ui/button"
import { useLingui } from "@lingui/solid"
import { dialog } from "@/locales/messages"
import { useSDK } from "@/context/sdk"
import { getSemanticIcon } from "@ericsanchezok/synergy-ui/semantic-icon"
import type { SessionImportResult } from "@ericsanchezok/synergy-sdk/client"
import "./dialog-session-export.css"

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export function DialogSessionImport() {
  const params = useParams()
  const navigate = useNavigate()
  const dialogContext = useDialog()
  const sdk = useSDK()
  const { _ } = useLingui()
  const [file, setFile] = createSignal<File>()
  const [importing, setImporting] = createSignal(false)

  async function handleImport() {
    const selected = file()
    if (!selected) return

    setImporting(true)
    try {
      const response = await sdk.client.session.import({ file: selected })
      const result = response.data as SessionImportResult | undefined
      if (!result) throw new Error("No import result returned")
      const descParts = [
        _(dialog.importSummary.id, {
          sessionCount: result.sessionCount,
          messageCount: result.messageCount,
        }),
      ]
      if (result.warnings.length > 0) {
        descParts.push(_(dialog.importWarningCount.id, { count: result.warnings.length }))
      }
      showToast({
        type: result.warnings.length > 0 ? "warning" : "success",
        title: _(dialog.sessionImported),
        description: descParts.join(" — "),
      })
      if (result.warnings.length > 0) {
        for (const warning of result.warnings) {
          console.warn(`[session-import] ${warning}`)
        }
      }
      dialogContext.close()
      navigate(`/${params.dir}/session/${result.rootSessionID}`)
    } catch (error: any) {
      showToast({ type: "error", title: _(dialog.sessionImportFailed), description: error.message })
    } finally {
      setImporting(false)
    }
  }

  return (
    <Dialog title={_(dialog.importSessionData)} size="wide" class="dialog-session-export dialog-session-import">
      <div class="session-export-body">
        <section class="session-export-summary" aria-label={_(dialog.importTargetAria)}>
          <div class="session-export-summary-title">
            <Icon name={getSemanticIcon("action.import")} size="small" class="session-export-summary-icon" />
            <span>{_(dialog.importIntoScope)}</span>
          </div>
          <div class="session-export-meta">
            <span>{_(dialog.importAcceptedFormats)}</span>
          </div>
        </section>

        <section data-slot="dialog-section">
          <span class="session-export-label">{_(dialog.exportFile)}</span>
          <label class="session-import-file" for="session-import-file">
            <input
              id="session-import-file"
              type="file"
              accept=".json,.json.gz,application/json,application/gzip"
              onChange={(event) => setFile(event.currentTarget.files?.[0])}
            />
            <Icon name={getSemanticIcon("action.import")} size="small" class="session-import-file-icon" />
            <span class="session-import-file-main">
              <Show when={file()} fallback={_(dialog.chooseFile)}>
                {(selected) => selected().name}
              </Show>
            </span>
            <Show when={file()}>
              {(selected) => <span class="session-import-file-meta">{formatFileSize(selected().size)}</span>}
            </Show>
          </label>
        </section>
      </div>

      <div data-slot="dialog-actions" class="session-export-footer">
        <span class="session-export-hint">{_(dialog.importHint)}</span>
        <Button
          type="button"
          variant="primary"
          size="large"
          icon={getSemanticIcon("action.import")}
          disabled={!file() || importing()}
          onClick={handleImport}
        >
          {importing() ? _(dialog.importing) : _(dialog.importAction)}
        </Button>
      </div>
    </Dialog>
  )
}
