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
import { useGlobalSync } from "@/context/global-sync"
import type { LocalScope } from "@/context/layout"
import { getScopeLabel } from "@/utils/scope"
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

export function DialogScopeEdit(props: { scope: LocalScope; onSaved?: () => void | Promise<unknown> }) {
  const dialog = useDialog()
  const sdk = useGlobalSDK()
  const sync = useGlobalSync()
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
  const [pending, setPending] = createSignal<"load" | "save">()
  const [error, setError] = createSignal<{ section: string; message: string }>()
  const [saved, setSaved] = createSignal<string[]>([])
  const [refreshError, setRefreshError] = createSignal("")
  const initialFolders = () => loadedFolders()?.folders.map((folder) => folder.path) ?? []
  const initialMain = () =>
    loadedFolders()?.folders.find((folder) => folder.workspaceID === loadedFolders()?.mainWorkspaceID)?.path ?? ""
  const basicsDirty = () => name() !== savedName()
  const invalidName = () => basicsDirty() && !name().trim()
  const filesDirty = () => JSON.stringify(folders()) !== JSON.stringify(initialFolders()) || main() !== initialMain()
  const defaultsDirty = () => JSON.stringify(defaults()) !== JSON.stringify(loaded()?.defaults ?? {})
  const dirty = () => basicsDirty() || filesDirty() || defaultsDirty()
  const mainGit = createMemo(() => loadedFolders()?.folders.find((folder) => folder.path === main())?.git)
  const selectedStart = () =>
    defaults().defaultSessionWorkspace ?? loaded()?.effective.defaultSessionWorkspace ?? "main"
  const invalidStart = () => selectedStart() === "worktree" && mainGit() === false
  const canSave = () =>
    !pending() &&
    (dirty() || !!refreshError()) &&
    !invalidName() &&
    !!loadedFolders() &&
    !!loaded() &&
    !!main() &&
    !invalidStart() &&
    (!defaultsDirty() || loaded()!.editable)
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
  async function save() {
    if (!canSave() || controller.signal.aborted) return
    const completed = refreshError() ? [...saved()] : []
    setPending("save")
    setError(undefined)
    setSaved([])
    setRefreshError("")
    let section = "folders"
    try {
      if (filesDirty()) {
        const result = await client.project.updateDirectories(
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
        if (controller.signal.aborted) return
        setLoadedFolders(result.data)
        setFolders(result.data.folders.map((folder) => folder.path))
        setMain(result.data.folders.find((folder) => folder.workspaceID === result.data.mainWorkspaceID)?.path ?? "")
        completed.push(_(copy.folders))
      }
      section = "defaults"
      if (invalidStart()) return
      if (defaultsDirty()) {
        const result = await client.project.taskDefaults.update(
          { scopeID: props.scope.id, projectTaskDefaultsInput: { defaults: defaults(), expected: loaded()!.defaults } },
          options,
        )
        if (controller.signal.aborted) return
        setLoaded(result.data)
        setDefaults(result.data.defaults)
        completed.push(_(copy.start))
      }
      section = "name"
      if (basicsDirty()) {
        const submittedName = name().trim()
        await client.scope.update({ ...scopeUpdateRequest(props.scope, {}), name: submittedName }, options)
        if (controller.signal.aborted) return
        setSavedName(submittedName)
        setName(submittedName)
        completed.push(_(copy.name))
      }
    } catch (failure) {
      if (!controller.signal.aborted) setError({ section, message: scopeUpdateErrorMessage(failure, _(copy.failed)) })
    } finally {
      if (!controller.signal.aborted && completed.length) {
        const results = await Promise.allSettled([
          Promise.resolve().then(() => sync.refreshConfig(props.scope.id)),
          Promise.resolve().then(() => props.onSaved?.()),
        ])
        const failure = results.find((result) => result.status === "rejected")
        if (failure && !controller.signal.aborted)
          setRefreshError(scopeUpdateErrorMessage(failure.reason, _(copy.failed)))
      }
      if (!controller.signal.aborted) {
        setSaved([...new Set(completed)])
        setPending(undefined)
      }
    }
  }
  async function load() {
    if (pending() || controller.signal.aborted) return
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
    setPending("load")
    setError(undefined)
    if (!refreshError()) setSaved([])
    try {
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
    } catch (failure) {
      if (!controller.signal.aborted)
        setError({ section: "load", message: scopeUpdateErrorMessage(failure, _(copy.failed)) })
    } finally {
      if (!controller.signal.aborted) setPending(undefined)
    }
  }
  onMount(() => void load())
  const feedback = (section: string) => (
    <Show when={error()?.section === section}>
      <p role="alert" class="project-inline-error">
        {error()?.message}
      </p>
    </Show>
  )
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
        <div class="project-settings-footer">
          <p role="status" class="project-inline-note">
            {!pending() &&
              saved().length > 0 &&
              (error() || invalidStart()
                ? _({
                    id: "project.entry.partialSave",
                    message: "Some changes were saved: {sections}. Save again to retry the remaining changes.",
                    values: { sections: saved().join(", ") },
                  })
                : refreshError()
                  ? _({
                      id: "project.entry.refreshSavedFailed",
                      message: "Changes were saved, but the updated settings could not be loaded. Save again to retry.",
                    })
                  : !dirty() && _(common.saved))}
          </p>
          <div data-slot="dialog-actions">
            <Button variant="secondary" size="large" disabled={!!pending()} onClick={() => void close()}>
              {_(common.cancel)}
            </Button>
            <Button variant="primary" size="large" disabled={!canSave()} onClick={() => void save()}>
              {_(pending() === "save" ? copy.loading : common.save)}
            </Button>
          </div>
        </div>
      }
    >
      <div class="project-form">
        <section class="project-settings-section">
          <TextField
            label={_(copy.name)}
            value={name()}
            placeholder={getScopeLabel(props.scope)}
            onChange={setName}
            disabled={!!pending()}
            validationState={invalidName() ? "invalid" : "valid"}
            error={invalidName() ? _(copy.namePlaceholder) : undefined}
          />
          {feedback("name")}
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
              <Show when={selectedStart() === "main"}>
                <Icon name={getSemanticIcon("state.success")} size="small" />
              </Show>
            </button>
            <button
              type="button"
              aria-pressed={selectedStart() === "worktree"}
              disabled={!!pending() || !loaded()?.editable || !mainGit()}
              onClick={() => setDefaults((previous) => ({ ...previous, defaultSessionWorkspace: "worktree" }))}
            >
              {_(copy.newWorktree)}
              <Show when={selectedStart() === "worktree"}>
                <Icon name={getSemanticIcon("state.success")} size="small" />
              </Show>
            </button>
          </div>
          <Show when={invalidStart()}>
            <p role="alert" class="project-inline-error">
              {_({
                id: "project.entry.worktreeRequiresGit",
                message: "Worktree needs a Git folder. Choose Main folder or select a Git main folder before saving.",
              })}
            </p>
          </Show>
          {feedback("defaults")}
        </section>
        <Button
          variant="ghost"
          disabled={!!pending()}
          onClick={() => dialog.push(() => <DialogWorktrees scopeID={props.scope.id} />)}
        >
          {_(copy.manageWorktrees)}
        </Button>
        {feedback("load")}
        <Show when={refreshError()}>
          <p role="alert" class="project-inline-error">
            {refreshError()}
          </p>
        </Show>
        <Show when={error()}>
          <Button variant="ghost" disabled={!!pending()} onClick={() => void load()}>
            {_(copy.retry)}
          </Button>
        </Show>
      </div>
    </Dialog>
  )
}
