import { createSignal, onCleanup, Show } from "solid-js"
import { useLingui } from "@lingui/solid"
import type { WorkspaceFileNode } from "@ericsanchezok/synergy-sdk"
import { Button } from "@ericsanchezok/synergy-ui/button"
import { Dialog } from "@ericsanchezok/synergy-ui/dialog"
import { useDialog } from "@ericsanchezok/synergy-ui/context/dialog"
import type { useFile } from "@/context/file"
import { fileWriteErrorMessage } from "@/context/file/errors"
import { fileEntries as M } from "@/locales/messages"

export function FileDeleteDialog(props: {
  actions: ReturnType<typeof useFile>["entries"]
  node: WorkspaceFileNode
  workspacePath: string
  dirty?: boolean
}) {
  const { _ } = useLingui()
  const dialog = useDialog()
  const source = { ...props.node }
  const actions = props.actions
  const [pending, setPending] = createSignal(false)
  const [error, setError] = createSignal<string>()
  const controller = new AbortController()
  let disposed = false
  onCleanup(() => {
    disposed = true
    controller.abort()
  })
  const canApply = () => !pending() && !!source.entryVersion
  async function apply() {
    if (!canApply()) return
    const dialogID = dialog.active?.id
    setPending(true)
    setError(undefined)
    try {
      await actions.remove(
        {
          path: source.path,
          expectedVersion: source.entryVersion!,
          recursive: source.type === "directory" && !source.symlink,
        },
        controller.signal,
      )
      if (!disposed) dialog.close(dialogID)
    } catch (cause) {
      if (!disposed) setError(fileWriteErrorMessage(cause) ?? (cause instanceof Error ? cause.message : _(M.failed)))
    } finally {
      if (!disposed) setPending(false)
    }
  }
  return (
    <Dialog title={_(M.remove)} size="compact" description={props.workspacePath}>
      <form
        data-slot="dialog-form"
        onSubmit={(event) => {
          event.preventDefault()
          void apply()
        }}
        aria-busy={pending()}
      >
        <p class="break-all text-12-medium">{source.path}</p>
        <p class="text-12-regular">{_(M.deleteWarning)}</p>
        <Show when={!source.entryVersion}>
          <p class="text-12-regular">{_(M.refreshRequired)}</p>
        </Show>
        <Show when={props.dirty}>
          <p class="text-12-regular text-text-weak">{_(M.draftsKept)}</p>
        </Show>
        <Show when={error()}>
          {(value) => (
            <p role="alert" class="text-12-regular break-words">
              {value()}
            </p>
          )}
        </Show>
        <div data-slot="dialog-actions">
          <Button type="button" variant="ghost" size="large" onClick={() => dialog.close()}>
            {_(M.cancel)}
          </Button>
          <Button type="submit" variant="primary" size="large" disabled={!canApply()}>
            {pending() ? _(M.working) : _(M.remove)}
          </Button>
        </div>
      </form>
    </Dialog>
  )
}
