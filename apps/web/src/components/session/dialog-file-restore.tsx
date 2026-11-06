import { createEffect, createResource, createSignal, For, onCleanup, Show } from "solid-js"
import { useSDK } from "@/context/sdk"
import { useDialog } from "@ericsanchezok/synergy-ui/context/dialog"
import { Dialog } from "@ericsanchezok/synergy-ui/dialog"
import { Button } from "@ericsanchezok/synergy-ui/button"
import { Diff } from "@ericsanchezok/synergy-ui/diff"
import { useLingui } from "@lingui/solid"
import { showToast } from "@ericsanchezok/synergy-ui/toast"
import type { SessionFilesPreviewData } from "@ericsanchezok/synergy-sdk/client"
import { fileRestoreFeedback } from "./file-restore-feedback"
import "./dialog-file-restore.css"

export type FileRestoreSelection = NonNullable<SessionFilesPreviewData["body"]>
export function DialogFileRestore(props: { sessionID: string; selection?: FileRestoreSelection }) {
  const sdk = useSDK()
  const dialog = useDialog()
  const { _, i18n } = useLingui()
  const client = sdk.client
  const context = { server: sdk.url, scope: sdk.scopeKey, session: props.sessionID }
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal<string>()
  const [refreshRequired, setRefreshRequired] = createSignal(false)
  const [selected, setSelected] = createSignal<string>()
  let controller: AbortController | undefined
  const [preview, { refetch }] = createResource(
    async () => {
      controller?.abort()
      controller = new AbortController()
      setError(undefined)
      setRefreshRequired(false)
      const response = await client.session.files.preview(
        { sessionID: context.session, ...props.selection },
        { signal: controller.signal, throwOnError: true },
      )
      if (
        controller.signal.aborted ||
        sdk.url !== context.server ||
        sdk.scopeKey !== context.scope ||
        props.sessionID !== context.session
      )
        throw new DOMException("Aborted", "AbortError")
      return response.data
    },
    { initialValue: undefined },
  )
  createEffect(() => {
    if (sdk.url !== context.server || sdk.scopeKey !== context.scope || props.sessionID !== context.session) {
      controller?.abort()
      dialog.close()
    }
  })
  onCleanup(() => controller?.abort())
  const value = () => (preview.error ? undefined : preview.latest)
  const confirm = async () => {
    const current = value()
    if (!current || preview.loading || busy()) return
    setBusy(true)
    setError(undefined)
    try {
      const response = await client.session.files.restore(
        { sessionID: context.session, previewID: current.id },
        { throwOnError: true },
      )
      if (sdk.url !== context.server || sdk.scopeKey !== context.scope) return
      const result = response.data!
      if (result.failedFiles.length) {
        setRefreshRequired(true)
        setError(result.failedFiles.map((file) => `${file.file}: ${file.message}`).join("\n"))
        return
      }
      showToast(fileRestoreFeedback(result, i18n()))
      dialog.close()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }
  const action = (kind: "create" | "replace" | "delete") =>
    kind === "create"
      ? _({ id: "session.restore.create", message: "Restore deleted file" })
      : kind === "delete"
        ? _({ id: "session.restore.delete", message: "Delete added file" })
        : _({ id: "session.restore.replace", message: "Restore file content" })
  return (
    <Dialog
      size="wide"
      title={_({ id: "session.restore.title", message: "Undo file changes" })}
      description={_({
        id: "session.restore.description",
        message:
          "Compare current content with the version to restore. New changes after this preview will require confirmation again.",
      })}
      dismissible={!busy()}
      class="file-restore-dialog"
      footer={
        <div class="file-restore-actions">
          <Button variant="ghost" disabled={busy()} onClick={() => dialog.close()}>
            {_({ id: "session.restore.cancel", message: "Cancel" })}
          </Button>
          <Show when={error() || preview.error}>
            <Button variant="secondary" disabled={busy() || preview.loading} onClick={() => void refetch()}>
              {_({ id: "session.restore.refresh", message: "Refresh preview" })}
            </Button>
          </Show>
          <Button
            variant="primary"
            disabled={busy() || preview.loading || !value()?.files.length || refreshRequired()}
            onClick={() => void confirm()}
          >
            {busy()
              ? _({ id: "session.restore.restoring", message: "Restoring…" })
              : _({ id: "session.restore.confirm", message: "Confirm restoration" })}
          </Button>
        </div>
      }
    >
      <div class="file-restore-files">
        <Show when={preview.loading}>
          <p role="status">{_({ id: "session.restore.loading", message: "Preparing restore preview…" })}</p>
        </Show>
        <Show when={error() || preview.error}>
          <p role="alert" class="file-restore-error">
            {error() ?? String(preview.error)}
          </p>
        </Show>
        <p class="file-restore-direction">
          {_({ id: "session.restore.direction", message: "Current content → Content to restore" })}
        </p>
        <For each={value()?.files}>
          {(file, index) => {
            const key = JSON.stringify([file.workspace.id, file.file])
            const expanded = () => selected() === key || (selected() === undefined && index() === 0)
            return (
              <section class="file-restore-file">
                <button type="button" aria-expanded={expanded()} onClick={() => setSelected(expanded() ? "" : key)}>
                  <span>
                    {file.workspace.root ? `${file.workspace.root}/` : ""}
                    {file.file.startsWith(file.workspace.root + "/")
                      ? file.file.slice(file.workspace.root.length + 1)
                      : file.file}
                  </span>
                  <span>{action(file.action)}</span>
                </button>
                <Show when={expanded()}>
                  <Show when={file.truncated}>
                    <p>
                      {_({
                        id: "session.restore.truncated",
                        message: "Preview shortened. Restoration uses the complete saved file.",
                      })}
                    </p>
                  </Show>
                  <Show
                    when={!file.binary}
                    fallback={
                      <p>{_({ id: "session.restore.binary", message: "Binary file. Text preview is unavailable." })}</p>
                    }
                  >
                    <Diff
                      before={{ name: file.file, contents: file.before }}
                      after={{ name: file.file, contents: file.after }}
                      diffStyle="unified"
                    />
                  </Show>
                </Show>
              </section>
            )
          }}
        </For>
      </div>
    </Dialog>
  )
}
