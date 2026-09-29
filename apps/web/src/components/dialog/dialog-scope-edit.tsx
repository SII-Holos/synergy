import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js"
import type {
  ProjectTaskDefaults,
  ProjectTaskDefaultsResult,
  ResourceProfiles,
} from "@ericsanchezok/synergy-sdk/client"
import { Dialog } from "@ericsanchezok/synergy-ui/dialog"
import { Button } from "@ericsanchezok/synergy-ui/button"
import { IconButton } from "@ericsanchezok/synergy-ui/icon-button"
import { TextField } from "@ericsanchezok/synergy-ui/text-field"
import { useDialog } from "@ericsanchezok/synergy-ui/context/dialog"
import { useLingui } from "@lingui/solid"
import { dialog as messages } from "@/locales/messages"
import { useGlobalSDK } from "@/context/global-sdk"
import { getScopeLabel } from "@/utils/scope"
import type { LocalScope } from "@/context/layout"
import { getSemanticIcon } from "@ericsanchezok/synergy-ui/semantic-icon"
import { useProjectDirectoryPicker } from "./project-directory-picker"
import { scopeUpdateErrorMessage, scopeUpdateRequest } from "./project-scope-edit-model"
import { useConfirm } from "./confirm-dialog"
import { locationCopy as copy } from "./task-location-copy"
import "./project-flow.css"

export function DialogScopeEdit(props: { scope: LocalScope }) {
  const dialog = useDialog()
  const sdk = useGlobalSDK()
  const client = sdk.client
  createEffect(() => {
    if (sdk.client !== client) dialog.close()
  })
  const confirm = useConfirm()
  const { _ } = useLingui()
  const picker = useProjectDirectoryPicker()
  const controller = new AbortController()
  const options = { signal: controller.signal, throwOnError: true as const }
  onCleanup(() => controller.abort())
  const [name, setName] = createSignal(props.scope.name ?? "")
  const [savedName, setSavedName] = createSignal(name())
  const [folders, setFolders] = createSignal<string[]>([...(props.scope.local?.sandboxes ?? [])])
  const [savedFolders, setSavedFolders] = createSignal([...folders()])
  const [defaults, setDefaults] = createSignal<ProjectTaskDefaults>({})
  const [loaded, setLoaded] = createSignal<ProjectTaskDefaultsResult>()
  const [profiles, setProfiles] = createSignal<ResourceProfiles>()
  const [pending, setPending] = createSignal<string>()
  const [error, setError] = createSignal<{ section: string; message: string }>()
  const [saved, setSaved] = createSignal<string>()
  const basicsDirty = () => name() !== savedName()
  const filesDirty = () => JSON.stringify(folders()) !== JSON.stringify(savedFolders())
  const defaultsDirty = () => JSON.stringify(defaults()) !== JSON.stringify(loaded()?.defaults ?? {})
  const dirty = () => basicsDirty() || filesDirty() || defaultsDirty()
  async function close() {
    if (pending()) return
    if (
      dirty() &&
      !(await confirm.ask({
        title: copy.discard,
        description: copy.discardDescription,
        confirmLabel: copy.discard,
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
      if (!controller.signal.aborted && section !== "load") setSaved(section)
    } catch (error) {
      if (!controller.signal.aborted) setError({ section, message: scopeUpdateErrorMessage(error, _(copy.failed)) })
    } finally {
      if (!controller.signal.aborted) setPending(undefined)
    }
  }
  async function loadDefaults() {
    if (
      defaultsDirty() &&
      loaded() &&
      !(await confirm.ask({
        title: copy.discard,
        description: copy.discardDescription,
        confirmLabel: copy.discard,
        tone: "warning",
      }))
    )
      return
    await perform("load", async () => {
      const [result, catalog] = await Promise.all([
        client.project.taskDefaults.get({ scopeID: props.scope.id }, options),
        client.environment.profiles({ scopeID: props.scope.id }, options),
      ])
      if (controller.signal.aborted) return
      setLoaded(result.data)
      setDefaults(result.data.defaults)
      setProfiles(catalog.data)
    })
  }
  onMount(() => void loadDefaults())
  const saveBasics = () =>
    perform("basic", async () => {
      await client.scope.update({ ...scopeUpdateRequest(props.scope, {}), name: name().trim() }, options)
      if (!controller.signal.aborted) setSavedName(name())
    })
  const saveFiles = () =>
    perform("files", async () => {
      await client.scope.update(scopeUpdateRequest(props.scope, { sandboxes: folders() }), options)
      if (!controller.signal.aborted) setSavedFolders([...folders()])
    })
  const saveDefaults = () =>
    perform("defaults", async () => {
      const result = await client.project.taskDefaults.update(
        { scopeID: props.scope.id, projectTaskDefaultsInput: { defaults: defaults(), expected: loaded()!.defaults } },
        options,
      )
      if (!controller.signal.aborted) {
        setLoaded(result.data)
        setDefaults(result.data.defaults)
      }
    })
  const executionOptions = createMemo(() => [
    { value: "inherit", label: _(copy.inherit) },
    { value: "none", label: _(copy.none) },
    ...(profiles()?.environments ?? []).map((profile) => ({ value: `profile:${profile.name}`, label: profile.name })),
  ])
  function feedback(section: string) {
    return (
      <>
        <Show when={error()?.section === section}>
          <p role="alert">{error()?.message}</p>
        </Show>
        <Show when={saved() === section}>
          <p role="status">{_(copy.saved)}</p>
        </Show>
      </>
    )
  }
  return (
    <Dialog
      title={_(messages.editProject)}
      footer={
        <div data-slot="dialog-actions">
          <Button variant="ghost" disabled={!!pending()} onClick={() => void close()}>
            {_(copy.cancel)}
          </Button>
        </div>
      }
      size="form"
      dismissible={false}
      onEscapeKeyDown={(event) => {
        event.preventDefault()
        void close()
      }}
      action={
        <IconButton
          icon={getSemanticIcon("action.close")}
          aria-label={_(copy.cancel)}
          disabled={!!pending()}
          onClick={() => void close()}
        />
      }
    >
      <div data-slot="dialog-form" class="project-flow">
        <section class="project-flow-section">
          <h3>{_(copy.basic)}</h3>
          <TextField
            label={_(messages.projectName)}
            value={name()}
            onChange={setName}
            placeholder={getScopeLabel(props.scope)}
            disabled={!!pending()}
          />
          {feedback("basic")}
          <div class="project-flow-actions">
            <Button disabled={!!pending() || !basicsDirty()} onClick={() => void saveBasics()}>
              {_(copy.save)}
            </Button>
          </div>
        </section>
        <section class="project-flow-section">
          <h3>{_(copy.files)}</h3>
          <p class="project-flow-path">{props.scope.local?.worktree ?? _(copy.noFiles)}</p>
          <For each={folders()}>
            {(folder) => (
              <div class="project-flow-folder">
                <span>{folder}</span>
                <IconButton
                  icon={getSemanticIcon("action.remove")}
                  aria-label={`${_(messages.projectFoldersRemove)}: ${folder}`}
                  disabled={!!pending()}
                  onClick={() => setFolders((previous) => previous.filter((item) => item !== folder))}
                />
              </div>
            )}
          </For>
          <p>{_(messages.projectFoldersHint)}</p>
          <Button
            variant="secondary"
            disabled={!!pending() || !props.scope.local}
            onClick={async () => {
              const result = await picker.pickProjectDirectories({
                title: _(messages.projectFoldersAddTitle),
                multiple: true,
              })
              if (result && !controller.signal.aborted)
                setFolders((previous) => [...new Set([...previous, ...result.directoryPaths])])
            }}
          >
            {_(messages.projectFoldersAdd)}
          </Button>
          {feedback("files")}
          <div class="project-flow-actions">
            <Button disabled={!!pending() || !filesDirty()} onClick={() => void saveFiles()}>
              {_(copy.save)}
            </Button>
          </div>
        </section>
        <section class="project-flow-section">
          <h3>{_(copy.defaults)}</h3>
          <p>{_(copy.defaultsDescription)}</p>
          <Show
            when={loaded()}
            fallback={
              <Button variant="ghost" disabled={!!pending()} onClick={() => void loadDefaults()}>
                {_(copy.retry)}
              </Button>
            }
          >
            <Show when={loaded()?.editable} fallback={<p>{_(copy.readOnlyDefaults)}</p>}>
              <label class="project-flow-field">
                <span>{_(copy.files)}</span>
                <select
                  disabled={!!pending()}
                  value={defaults().defaultSessionWorkspace ?? "inherit"}
                  aria-label={_(copy.files)}
                  onChange={(event) =>
                    setDefaults((previous) => {
                      const next = { ...previous }
                      const value = event.currentTarget.value
                      if (value === "inherit") delete next.defaultSessionWorkspace
                      else next.defaultSessionWorkspace = value as "main" | "worktree"
                      return next
                    })
                  }
                >
                  <option value="inherit">{_(copy.inherit)}</option>
                  <option value="main">{_(copy.files)}</option>
                  <option value="worktree" disabled={props.scope.local?.vcs !== "git"}>
                    {_(copy.planned)}
                  </option>
                </select>
              </label>
              <label class="project-flow-field">
                <span>{_(copy.execution)}</span>
                <select
                  aria-label={_(copy.execution)}
                  disabled={!!pending()}
                  value={
                    defaults().defaultSessionEnvironmentProfile === undefined
                      ? "inherit"
                      : defaults().defaultSessionEnvironmentProfile === null
                        ? "none"
                        : `profile:${defaults().defaultSessionEnvironmentProfile}`
                  }
                  onChange={(event) =>
                    setDefaults((previous) => {
                      const next = { ...previous }
                      const value = event.currentTarget.value
                      if (value === "inherit") delete next.defaultSessionEnvironmentProfile
                      else next.defaultSessionEnvironmentProfile = value === "none" ? null : value.slice(8)
                      return next
                    })
                  }
                >
                  <For each={executionOptions()}>
                    {(option) => <option value={option.value}>{option.label}</option>}
                  </For>
                  <Show
                    when={
                      defaults().defaultSessionEnvironmentProfile &&
                      !profiles()?.environments.some(
                        (item) => item.name === defaults().defaultSessionEnvironmentProfile,
                      )
                    }
                  >
                    <option value={`profile:${defaults().defaultSessionEnvironmentProfile}`} disabled>
                      {defaults().defaultSessionEnvironmentProfile} · {_(copy.unavailable)}
                    </option>
                  </Show>
                </select>
              </label>
              <div class="project-flow-actions">
                <Button disabled={!!pending() || !defaultsDirty()} onClick={() => void saveDefaults()}>
                  {_(copy.save)}
                </Button>
              </div>
            </Show>
          </Show>
          {feedback("defaults")}
          {feedback("load")}
          <Show when={error()?.section === "defaults"}>
            <Button variant="ghost" disabled={!!pending()} onClick={() => void loadDefaults()}>
              {_(copy.retry)}
            </Button>
          </Show>
        </section>
        <details>
          <summary>{_(copy.advanced)}</summary>
          <dl class="project-flow-section">
            <dt>{_(messages.scopeID)}</dt>
            <dd>{props.scope.id}</dd>
            <dt>{_(messages.scopeType)}</dt>
            <dd>{props.scope.type}</dd>
            <dt>{_(messages.directory)}</dt>
            <dd class="project-flow-path">{props.scope.local?.directory}</dd>
          </dl>
        </details>
      </div>
    </Dialog>
  )
}
