import { createEffect, createMemo, createSignal, onCleanup, onMount, Show } from "solid-js"
import type {
  ProjectDirectories,
  ProjectTaskDefaults,
  ProjectTaskDefaultsResult,
} from "@ericsanchezok/synergy-sdk/client"
import { Dialog } from "@ericsanchezok/synergy-ui/dialog"
import { Button } from "@ericsanchezok/synergy-ui/button"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { TextField } from "@ericsanchezok/synergy-ui/text-field"
import { useDialog } from "@ericsanchezok/synergy-ui/context/dialog"
import { useLingui } from "@lingui/solid"
import { useGlobalSDK } from "@/context/global-sdk"
import type { LocalScope } from "@/context/layout"
import { getSemanticIcon } from "@ericsanchezok/synergy-ui/semantic-icon"
import { useProjectDirectoryPicker } from "./project-directory-picker"
import { scopeUpdateErrorMessage, scopeUpdateRequest } from "./project-scope-edit-model"
import { useConfirm } from "./confirm-dialog"
import { locationCopy as common } from "./task-location-copy"
import { projectEntryCopy as copy } from "./project-entry-copy"
import { DialogWorktrees } from "./dialog-worktrees"
import { ProjectFolderFields } from "./project-folder-fields"
import { useComputerLabel } from "./computer-menu"
import "./project-flow.css"

export function DialogScopeEdit(props: { scope: LocalScope; onSaved?: () => void }) {
  const dialog = useDialog()
  const sdk = useGlobalSDK()
  const client = sdk.client
  createEffect(() => {
    if (sdk.client !== client) dialog.close()
  })
  const confirm = useConfirm()
  const { _ } = useLingui()
  const label = useComputerLabel()
  const picker = useProjectDirectoryPicker()
  const controller = new AbortController()
  const options = { signal: controller.signal, throwOnError: true as const }
  onCleanup(() => controller.abort())
  const [name, setName] = createSignal(props.scope.name ?? "")
  const [savedName, setSavedName] = createSignal(name())
  const [folders, setFolders] = createSignal<string[]>([])
  const [main, setMain] = createSignal("")
  const [loadedFolders, setLoadedFolders] = createSignal<ProjectDirectories>()
  const [defaults, setDefaults] = createSignal<ProjectTaskDefaults>({})
  const [loaded, setLoaded] = createSignal<ProjectTaskDefaultsResult>()
  const [pending, setPending] = createSignal<string>()
  const [error, setError] = createSignal<{ section: string; message: string }>()
  const [saved, setSaved] = createSignal<string>()
  const initialFolders = () => loadedFolders()?.folders.map((folder) => folder.path) ?? []
  const initialMain = () =>
    loadedFolders()?.folders.find((folder) => folder.workspaceID === loadedFolders()?.mainWorkspaceID)?.path ?? ""
  const basicsDirty = () => name() !== savedName()
  const filesDirty = () => JSON.stringify(folders()) !== JSON.stringify(initialFolders()) || main() !== initialMain()
  const defaultsDirty = () => JSON.stringify(defaults()) !== JSON.stringify(loaded()?.defaults ?? {})
  const dirty = () => basicsDirty() || filesDirty() || defaultsDirty()
  const mainGit = createMemo(() => loadedFolders()?.folders.find((folder) => folder.path === main())?.git)
  async function close() {
    if (pending()) return
    if (
      dirty() &&
      !(await confirm.ask({
        title: common.discard,
        description: common.discardDescription,
        confirmLabel: common.discard,
        tone: "warning",
      }))
    )
      return
    dialog.close()
  }
  async function perform(section: string, action: () => Promise<void>) {
    if (pending() || controller.signal.aborted) return
    setPending(section)
    setError(undefined)
    setSaved(undefined)
    try {
      await action()
      if (!controller.signal.aborted && section !== "load") {
        setSaved(section)
        props.onSaved?.()
      }
    } catch (failure) {
      if (!controller.signal.aborted) setError({ section, message: scopeUpdateErrorMessage(failure, _(copy.failed)) })
    } finally {
      if (!controller.signal.aborted) setPending(undefined)
    }
  }
  async function load() {
    if (
      dirty() &&
      !(await confirm.ask({
        title: common.discard,
        description: common.discardDescription,
        confirmLabel: common.discard,
        tone: "warning",
      }))
    )
      return
    await perform("load", async () => {
      const [configuration, result] = await Promise.all([
        sdk.client.project.directories({ scopeID: props.scope.id }, options),
        sdk.client.project.taskDefaults.get({ scopeID: props.scope.id }, options),
      ])
      if (controller.signal.aborted) return
      setLoadedFolders(configuration.data)
      setFolders(configuration.data.folders.map((folder) => folder.path))
      setMain(
        configuration.data.folders.find((folder) => folder.workspaceID === configuration.data.mainWorkspaceID)?.path ??
          "",
      )
      setLoaded(result.data)
      setDefaults(result.data.defaults)
    })
  }
  onMount(() => void load())
  const saveName = () =>
    perform("name", async () => {
      await sdk.client.scope.update({ ...scopeUpdateRequest(props.scope, {}), name: name().trim() }, options)
      setSavedName(name())
    })
  const saveFolders = () =>
    perform("folders", async () => {
      const result = await sdk.client.project.updateDirectories(
        {
          scopeID: props.scope.id,
          projectDirectoriesUpdate: {
            directories: folders(),
            mainDirectory: main(),
            revision: loadedFolders()!.revision,
          },
        },
        options,
      )
      setLoadedFolders(result.data)
      setFolders(result.data.folders.map((folder) => folder.path))
      setMain(result.data.folders.find((folder) => folder.workspaceID === result.data.mainWorkspaceID)?.path ?? "")
    })
  const saveDefaults = () =>
    perform("defaults", async () => {
      const result = await sdk.client.project.taskDefaults.update(
        { scopeID: props.scope.id, projectTaskDefaultsInput: { defaults: defaults(), expected: loaded()!.defaults } },
        options,
      )
      setLoaded(result.data)
      setDefaults(result.data.defaults)
    })
  const feedback = (section: string) => (
    <>
      <Show when={error()?.section === section}>
        <p role="alert" class="project-inline-error">
          {error()?.message}
        </p>
      </Show>
      <Show when={saved() === section}>
        <p role="status" class="project-inline-note">
          {_(common.saved)}
        </p>
      </Show>
    </>
  )
  const selectedStart = () =>
    defaults().defaultSessionWorkspace ?? loaded()?.effective.defaultSessionWorkspace ?? "main"
  return (
    <Dialog
      title={_(copy.settings)}
      description={label(sdk.url)}
      size="list"
      class="project-settings-dialog"
      dismissible={false}
      onEscapeKeyDown={(event) => {
        event.preventDefault()
        void close()
      }}
      action={
        <button
          type="button"
          class="project-icon-button"
          aria-label={_(common.cancel)}
          disabled={!!pending()}
          onClick={() => void close()}
        >
          <Icon name={getSemanticIcon("action.close")} size="small" />
        </button>
      }
      footer={
        <div data-slot="dialog-actions">
          <Button variant="secondary" size="large" disabled={!!pending()} onClick={() => void close()}>
            {_(common.cancel)}
          </Button>
        </div>
      }
    >
      <div class="project-form">
        <section class="project-settings-section">
          <TextField label={_(copy.name)} value={name()} onChange={setName} disabled={!!pending()} />
          {feedback("name")}
          <div class="project-flow-actions">
            <Button
              variant="secondary"
              disabled={!!pending() || !basicsDirty() || !name().trim()}
              onClick={() => void saveName()}
            >
              {_(pending() === "name" ? copy.loading : common.save)}
            </Button>
          </div>
        </section>
        <section class="project-settings-section">
          <ProjectFolderFields
            folders={folders()}
            main={main()}
            disabled={!!pending() || !loadedFolders()}
            onChange={(values, value) => {
              setFolders(values)
              setMain(value)
            }}
            onAdd={async () => {
              const result = await picker.pickProjectDirectories({ title: _(copy.chooseFolders), multiple: true })
              if (result && !controller.signal.aborted) {
                setFolders((previous) => [...new Set([...previous, ...result.directoryPaths])])
                if (!main()) setMain(result.directoryPaths[0])
              }
            }}
          />
          {feedback("folders")}
          <Show when={filesDirty()}>
            <p class="project-inline-note">{_(copy.folderImpact)}</p>
          </Show>
          <div class="project-flow-actions">
            <Button
              variant="secondary"
              disabled={!!pending() || !loadedFolders() || !filesDirty() || !main()}
              onClick={() => void saveFolders()}
            >
              {_(pending() === "folders" ? copy.loading : common.save)}
            </Button>
          </div>
        </section>
        <section class="project-settings-section">
          <label>{_(copy.start)}</label>
          <div class="project-start-options" role="group" aria-label={_(copy.start)}>
            <button
              type="button"
              aria-pressed={selectedStart() === "main"}
              disabled={!!pending() || !loaded()?.editable}
              onClick={() => setDefaults((previous) => ({ ...previous, defaultSessionWorkspace: "main" }))}
            >
              {_(copy.main)}
            </button>
            <button
              type="button"
              aria-pressed={selectedStart() === "worktree"}
              disabled={!!pending() || !loaded()?.editable || !mainGit()}
              onClick={() => setDefaults((previous) => ({ ...previous, defaultSessionWorkspace: "worktree" }))}
            >
              {_(copy.newWorktree)}
            </button>
          </div>
          {feedback("defaults")}
          <div class="project-flow-actions">
            <Button variant="secondary" disabled={!!pending() || !defaultsDirty()} onClick={() => void saveDefaults()}>
              {_(pending() === "defaults" ? copy.loading : common.save)}
            </Button>
          </div>
        </section>
        <Button variant="ghost" onClick={() => dialog.push(() => <DialogWorktrees scopeID={props.scope.id} />)}>
          {_(copy.manageWorktrees)}
        </Button>
        {feedback("load")}
        <Show when={error()}>
          <Button variant="ghost" disabled={!!pending()} onClick={() => void load()}>
            {_(copy.retry)}
          </Button>
        </Show>
      </div>
    </Dialog>
  )
}
