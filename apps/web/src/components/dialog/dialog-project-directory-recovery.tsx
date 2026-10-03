import { createEffect, createSignal, For, onCleanup, onMount, Show } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import type { ProjectDirectories, ProjectFolder } from "@ericsanchezok/synergy-sdk/client"
import { useLingui } from "@lingui/solid"
import { Dialog } from "@ericsanchezok/synergy-ui/dialog"
import { Button } from "@ericsanchezok/synergy-ui/button"
import { useDialog } from "@ericsanchezok/synergy-ui/context/dialog"
import { useSDK } from "@/context/sdk"
import { useGlobalSDK } from "@/context/global-sdk"
import { requestErrorMessage } from "@/utils/error"
import { useProjectDirectoryPicker } from "./project-directory-picker"
import { projectEntryCopy as copy } from "./project-entry-copy"
import {
  loadProjectDirectoryRecovery,
  recoverProjectDirectories,
  sameProjectDirectories,
  ProjectDirectoryRecoveryChanged,
  ProjectDirectoryRecoveryUnavailable,
  type ProjectDirectoryRecovery,
} from "./project-directory-recovery"
import "./project-flow.css"

export function DialogProjectDirectoryRecovery(props: {
  directories: ProjectDirectories
  isCurrent: () => boolean
  onRecovered: (directories: ProjectDirectories) => void | Promise<void>
}) {
  const { _ } = useLingui()
  const sdk = useSDK()
  const globalSDK = useGlobalSDK()
  const dialog = useDialog()
  const picker = useProjectDirectoryPicker()
  const client = sdk.client
  const scopeID = sdk.scopeID
  const url = globalSDK.url
  const expected = props.directories
  const controller = new AbortController()
  const [plan, setPlan] = createSignal<ProjectDirectoryRecovery>()
  const [rows, setRows] = createStore<{ items: ProjectFolder[] }>({
    items: expected.folders.filter((folder) => !folder.available).map((folder) => ({ ...folder })),
  })
  const [paths, setPaths] = createStore<Record<string, string>>({})
  const [loading, setLoading] = createSignal(true)
  const [pending, setPending] = createSignal(false)
  const [picking, setPicking] = createSignal(false)
  const [error, setError] = createSignal("")
  const [details, setDetails] = createSignal("")
  onCleanup(() => controller.abort())
  createEffect(() => {
    if (
      sdk.client !== client ||
      sdk.scopeID !== scopeID ||
      globalSDK.url !== url ||
      !props.isCurrent() ||
      !sameProjectDirectories(expected, props.directories)
    ) {
      controller.abort()
      dialog.close()
    }
  })
  function close() {
    controller.abort()
    dialog.close()
  }
  function showError(failure: unknown) {
    setError(
      _(
        failure instanceof ProjectDirectoryRecoveryChanged
          ? copy.changed
          : failure instanceof ProjectDirectoryRecoveryUnavailable
            ? copy.recoverUnavailable
            : copy.recoverFailed,
      ),
    )
    setDetails(
      failure instanceof ProjectDirectoryRecoveryChanged || failure instanceof ProjectDirectoryRecoveryUnavailable
        ? ""
        : requestErrorMessage(failure, ""),
    )
  }
  async function load() {
    setLoading(true)
    try {
      const next = await loadProjectDirectoryRecovery(client, scopeID, expected, controller.signal)
      if (controller.signal.aborted) return
      setPlan(next)
      setRows(
        "items",
        reconcile(
          next.directories.folders.filter(
            (folder) => !folder.available || rows.items.some((row) => row.workspaceID === folder.workspaceID),
          ),
          { key: "workspaceID" },
        ),
      )
    } catch (failure) {
      if (!controller.signal.aborted) showError(failure)
    } finally {
      if (!controller.signal.aborted) setLoading(false)
    }
  }
  onMount(() => void load())
  async function choose(folder: ProjectFolder) {
    if (pending() || picking() || loading()) return
    setPicking(true)
    try {
      const result = await picker.pickProjectDirectories({ title: _(copy.chooseFolder), multiple: false })
      if (result && !controller.signal.aborted) setPaths(folder.workspaceID, result.directoryPaths[0]!)
    } finally {
      if (!controller.signal.aborted) setPicking(false)
    }
  }
  async function restore() {
    if (pending() || picking() || loading() || controller.signal.aborted) return
    if (!plan()) return load()
    setPending(true)
    setError("")
    setDetails("")
    try {
      const result = await recoverProjectDirectories(client, plan()!, {
        signal: controller.signal,
        paths: { ...paths },
        onRecovered(id, path) {
          const index = rows.items.findIndex((item) => item.workspaceID === id)
          if (index >= 0) setRows("items", index, "available", true)
          setPaths(id, path)
        },
      })
      if (controller.signal.aborted || !props.isCurrent()) return
      await props.onRecovered(result)
      if (!controller.signal.aborted) dialog.close()
    } catch (failure) {
      if (controller.signal.aborted) return
      showError(failure)
      await load()
    } finally {
      if (!controller.signal.aborted) setPending(false)
    }
  }
  const guidance = (folder: ProjectFolder) =>
    folder.available
      ? copy.recovered
      : folder.unavailable?.data.reason === "directory_unavailable"
        ? copy.folderMissing
        : folder.unavailable?.data.reason === "binding_unavailable"
          ? copy.folderUnbound
          : copy.confirmFolder
  return (
    <Dialog
      title={_(copy.recoverTitle)}
      size="form"
      class="project-create-dialog"
      dismissible={false}
      onEscapeKeyDown={(event) => {
        event.preventDefault()
        if (!picking()) close()
      }}
      footer={
        <div data-slot="dialog-actions">
          <Button variant="ghost" size="large" disabled={picking()} onClick={close}>
            {_(copy.cancel)}
          </Button>
          <Button
            variant="primary"
            size="large"
            disabled={loading() || pending() || picking()}
            onClick={() => void restore()}
          >
            {_(loading() ? copy.loading : pending() ? copy.recovering : !plan() ? copy.retry : copy.recoverAction)}
          </Button>
        </div>
      }
    >
      <div class="project-form">
        <p class="project-inline-note">{_(copy.recoverDescription)}</p>
        <div class="project-recovery-folders" aria-busy={loading() || pending()}>
          <For each={rows.items}>
            {(folder) => (
              <div class="project-recovery-folder">
                <strong>
                  {_(folder.workspaceID === expected.mainWorkspaceID ? copy.main : copy.additionalFolder)}
                </strong>
                <span class="project-recovery-path">{paths[folder.workspaceID] ?? folder.path}</span>
                <p class="project-inline-note">{_(guidance(folder))}</p>
                <Show
                  when={
                    !folder.available &&
                    (!folder.path ||
                      folder.unavailable?.data.reason === "directory_unavailable" ||
                      folder.unavailable?.data.reason === "binding_unavailable")
                  }
                >
                  <Button
                    size="small"
                    variant="secondary"
                    disabled={loading() || pending() || picking()}
                    onClick={() => void choose(folder)}
                  >
                    {_(copy.chooseFolder)}
                  </Button>
                </Show>
              </div>
            )}
          </For>
        </div>
        <Show when={error()}>
          <div class="project-inline-error" role="alert">
            <p>{error()}</p>
            <Show when={details()}>
              <p>{details()}</p>
            </Show>
          </div>
        </Show>
      </div>
    </Dialog>
  )
}
