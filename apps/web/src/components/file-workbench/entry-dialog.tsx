import { createSignal, createUniqueId, onCleanup, Show } from "solid-js"
import { useLingui } from "@lingui/solid"
import type { WorkspaceFileNode } from "@ericsanchezok/synergy-sdk"
import { Button } from "@ericsanchezok/synergy-ui/button"
import { Dialog } from "@ericsanchezok/synergy-ui/dialog"
import { TextField } from "@ericsanchezok/synergy-ui/text-field"
import { useDialog } from "@ericsanchezok/synergy-ui/context/dialog"
import type { useFile } from "@/context/file"
import { fileWriteErrorMessage } from "@/context/file/errors"
import { fileEntries as M } from "@/locales/messages"

export type FileEntryOperation = "createFile" | "createDirectory" | "move" | "copy" | "remove"
export function FileEntryDialog(props: {
  actions: ReturnType<typeof useFile>["entries"]
  node?: WorkspaceFileNode
  workspacePath: string
  operation?: FileEntryOperation
  dirty?: boolean
}) {
  const { _ } = useLingui()
  const dialog = useDialog()
  const source = props.node ? { ...props.node } : undefined
  const actions = props.actions
  const operationID = createUniqueId()
  const [operation, setOperation] = createSignal<FileEntryOperation>(props.operation ?? "createFile")
  const parent =
    source?.type === "directory" && !source.symlink ? source.path : source?.path.split("/").slice(0, -1).join("/")
  const initialPath = (op: FileEntryOperation) =>
    op === "move" || op === "copy" ? (source?.path ?? "") : parent ? `${parent}/` : ""
  const [destination, setDestination] = createSignal(initialPath(operation()))
  const [pending, setPending] = createSignal(false)
  const [error, setError] = createSignal<string>()
  const controller = new AbortController()
  let disposed = false
  onCleanup(() => {
    disposed = true
    controller.abort()
  })
  const canApply = () =>
    !pending() &&
    (operation() === "remove" ? !!source?.entryVersion : destination().length > 0 && !destination().endsWith("/"))
  async function apply() {
    if (!canApply()) return
    const dialogID = dialog.active?.id
    setPending(true)
    setError(undefined)
    try {
      if (operation() === "createFile") await actions.createFile(destination(), controller.signal)
      else if (operation() === "createDirectory") await actions.createDirectory(destination(), controller.signal)
      else {
        if (!source?.entryVersion) throw new Error(_(M.refreshRequired))
        if (operation() === "remove")
          await actions.remove(
            {
              path: source.path,
              expectedVersion: source.entryVersion,
              recursive: source.type === "directory" && !source.symlink,
            },
            controller.signal,
          )
        else {
          const input = { from: source.path, to: destination(), expectedVersion: source.entryVersion }
          if (operation() === "copy") await actions.copy(input, controller.signal)
          else await actions.move(input, controller.signal)
        }
      }
      if (!disposed) dialog.close(dialogID)
    } catch (cause) {
      if (!disposed) setError(fileWriteErrorMessage(cause) ?? (cause instanceof Error ? cause.message : _(M.failed)))
    } finally {
      if (!disposed) setPending(false)
    }
  }
  return (
    <Dialog title={_(M.title)} size="compact" description={props.workspacePath}>
      <form
        data-slot="dialog-form"
        onSubmit={(event) => {
          event.preventDefault()
          void apply()
        }}
        aria-busy={pending()}
      >
        <div class="flex flex-col gap-2 text-12-medium">
          <label for={operationID}>{_(M.operation)}</label>
          <select
            id={operationID}
            class="rounded-md border border-border-base bg-surface-base text-text-base p-2"
            value={operation()}
            disabled={pending()}
            onChange={(event) => {
              const value = event.currentTarget.value as FileEntryOperation
              setOperation(value)
              setDestination(initialPath(value))
              setError(undefined)
            }}
          >
            <option value="createFile">{_(M.createFile)}</option>
            <option value="createDirectory">{_(M.createDirectory)}</option>
            <option value="move" disabled={!source?.entryVersion}>
              {_(M.move)}
            </option>
            <option value="copy" disabled={!source?.entryVersion}>
              {_(M.copy)}
            </option>
            <option value="remove" disabled={!source?.entryVersion}>
              {_(M.remove)}
            </option>
          </select>
        </div>
        <Show when={source && ["move", "copy", "remove"].includes(operation())}>
          <p class="break-all text-12-regular text-text-weak">{source?.path}</p>
        </Show>
        <Show when={operation() !== "remove"} fallback={<p class="text-12-regular">{_(M.deleteWarning)}</p>}>
          <TextField label={_(M.path)} value={destination()} onChange={setDestination} disabled={pending()} autofocus />
        </Show>
        <Show when={props.dirty && (operation() === "move" || operation() === "remove")}>
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
            {pending() ? _(M.working) : operation() === "remove" ? _(M.remove) : _(M.apply)}
          </Button>
        </div>
      </form>
    </Dialog>
  )
}
