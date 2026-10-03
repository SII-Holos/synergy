import { IconButton } from "@ericsanchezok/synergy-ui/icon-button"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { getSemanticIcon } from "@ericsanchezok/synergy-ui/semantic-icon"
import { useConfirm } from "./confirm-dialog"
import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import type {
  ResourceProfiles,
  Session,
  SessionWorkspaceSelection,
  WorkspaceInfo,
} from "@ericsanchezok/synergy-sdk/client"
import { useLingui } from "@lingui/solid"
import { Dialog } from "@ericsanchezok/synergy-ui/dialog"
import { Button } from "@ericsanchezok/synergy-ui/button"
import { Checkbox } from "@ericsanchezok/synergy-ui/checkbox"
import { TextField } from "@ericsanchezok/synergy-ui/text-field"
import { useDialog } from "@ericsanchezok/synergy-ui/context/dialog"
import { useSDK } from "@/context/sdk"
import { useSync } from "@/context/sync"
import { requestErrorMessage } from "@/utils/error"
import { useProjectDirectoryPicker } from "./project-directory-picker"
import { locationCopy } from "./task-location-copy"
import "./project-flow.css"
import { workspaceCopy as copy } from "./workspace-dialog-copy"
import {
  sortWorkspaces,
  workspaceAvailable,
  workspaceBranch,
  workspaceLabel,
  type WorkspaceDialogTarget,
  type WorkspaceRecovery,
} from "./workspace-dialog-model"

type WorkspaceDialogProps = {
  copiesOnly?: boolean
  mainWorkspaceID?: string | null
  environmentProfile?: string | null
  environmentID?: string | null
} & (
  | { mode?: "select"; target: WorkspaceDialogTarget }
  | { mode: "recover"; target: WorkspaceDialogTarget; recovery: WorkspaceRecovery }
  | { mode: "manage"; initialID?: string }
)

export function DialogWorkspace(props: WorkspaceDialogProps) {
  const sdk = useSDK()
  const sync = useSync()
  const dialog = useDialog()
  const { _, i18n } = useLingui()
  const confirm = useConfirm()
  const picker = useProjectDirectoryPicker()
  const scopeID = sdk.scopeID
  const client = sdk.client
  const controller = new AbortController()
  const [records, setRecords] = createStore<{ data: WorkspaceInfo[] }>({ data: [] })
  const target = () => (props.mode === "manage" ? undefined : props.target)
  const sessionID = () => {
    const destination = target()
    return destination?.kind === "session" ? destination.sessionID : undefined
  }
  const draftSelection = () => {
    const destination = target()
    return destination?.kind === "draft" ? destination.selection : undefined
  }
  const initialSelection = draftSelection()
  const initialSession = sessionID() ? sync.session.get(sessionID()!) : undefined
  const defaultWorkspaceID = props.mainWorkspaceID ?? sync.data.path.workspace?.id
  const currentID = createMemo(() =>
    props.mode === "manage"
      ? undefined
      : initialSelection?.mode === "workspace"
        ? initialSelection.workspaceID
        : initialSelection?.mode === "none"
          ? null
          : initialSelection?.mode === "existing"
            ? records.data.find(
                (item) =>
                  item.type === "git_worktree" &&
                  [item.id, item.metadata.worktreeID, item.binding.path].includes(initialSelection.target),
              )?.id
            : sessionID()
              ? initialSession?.workspaceID
              : defaultWorkspaceID,
  )
  const initial =
    props.mode === "recover"
      ? props.recovery.workspaceID
      : props.mode === "manage"
        ? (props.initialID ?? sync.data.path.workspace?.id)
        : initialSelection?.mode === "existing"
          ? initialSelection.target
          : currentID()
  let resolveInitialExisting =
    props.mode !== "manage" && props.mode !== "recover" && initialSelection?.mode === "existing"
  const mainID = () => props.mainWorkspaceID ?? sync.data.path.workspace?.id
  const [view, setView] = createSignal<"list" | "manage" | "create">("list")
  const [directoryBrowsing, setDirectoryBrowsing] = createSignal(props.mode === "manage")
  const [sessions, setSessions] = createSignal<Session[]>([])
  const [sessionsLoaded, setSessionsLoaded] = createSignal(false)
  const [selected, setSelected] = createSignal<string | null>(initial ?? null)
  const [selectedGeneration, setSelectedGeneration] = createSignal(
    initialSelection?.mode === "workspace" && initialSelection.workspaceID === initial
      ? initialSelection.workspaceGeneration
      : initialSession?.workspaceID === initial
        ? initialSession?.workspace?.generation
        : sync.data.path.workspace?.id === initial
          ? sync.data.path.workspace?.generation
          : undefined,
  )
  const [failedBinding, setFailedBinding] = createSignal<{ workspaceID: string; generation: number }>()
  const [sharing, setSharing] = createSignal<string[]>([])
  const [sharingRevision, setSharingRevision] = createSignal<number>()
  const [stores, setStores] = createSignal<ResourceProfiles["stores"]>([])
  const [storeProfile, setStoreProfile] = createSignal("")
  const [workspaceName, setWorkspaceName] = createSignal("")
  const [savedRevision, setSavedRevision] = createSignal<number>()
  const label = workspaceLabel
  const [search, setSearch] = createSignal("")
  const [bindingPath, setBindingPath] = createSignal("")
  const [bindingRevision, setBindingRevision] = createSignal<number>()
  const [pending, setPending] = createSignal(false)
  const [loading, setLoading] = createSignal(true)
  const [error, setError] = createSignal("")
  const record = createMemo(() => records.data.find((item) => item.id === selected()))
  const affected = () => sessions().filter((item) => item.workspaceID === selected())
  const compatible = (item: WorkspaceInfo) =>
    props.mode === "manage" || directoryBrowsing() || item.backend?.provider === "objects"
  const available = (item: WorkspaceInfo) =>
    compatible(item) &&
    (!props.copiesOnly || item.type === "git_worktree") &&
    workspaceAvailable(item) &&
    !(failedBinding()?.workspaceID === item.id && failedBinding()?.generation === item.binding.generation)
  const bindingChanged = () =>
    !!record() && selectedGeneration() !== undefined && selectedGeneration() !== record()!.binding.generation
  const filtered = createMemo(() =>
    sortWorkspaces(
      records.data.filter(
        (item) =>
          (!props.copiesOnly || item.type === "git_worktree") &&
          `${label(item)} ${item.binding.path ?? ""} ${workspaceBranch(item) ?? ""} ${item.id}`
            .toLowerCase()
            .includes(search().trim().toLowerCase()),
      ),
      { currentID: currentID(), mainID: mainID() ?? undefined, available, locale: i18n().locale },
    ),
  )
  const sharingDirty = createMemo(() => {
    const current = record()
    return !!current && [...sharing()].sort().join("\n") !== [...current.sharedWritableWorkspaceIDs].sort().join("\n")
  })
  const options = { signal: controller.signal, throwOnError: true as const }
  const active = () =>
    !controller.signal.aborted &&
    sdk.scopeID === scopeID &&
    sdk.client === client &&
    (props.mode !== "recover" || (props.recovery.isCurrent?.() ?? true))
  const shareable = (item: WorkspaceInfo) => available(item) && !!item.binding.path && !!item.binding.physicalID
  onCleanup(() => controller.abort())
  createEffect(() => {
    if (!controller.signal.aborted && !active()) dialog.close()
  })

  function upsert(item: WorkspaceInfo) {
    if (item.scopeID !== scopeID || !active()) return
    const index = records.data.findIndex((record) => record.id === item.id)
    if (index < 0) setRecords("data", records.data.length, item)
    else if (records.data[index]!.revision <= item.revision) setRecords("data", index, reconcile(item))
  }
  async function discard() {
    return (
      !(sharingDirty() || bindingPath()) ||
      (await confirm.ask({
        title: locationCopy.discard,
        description: locationCopy.discardDescription,
        confirmLabel: locationCopy.discard,
        tone: "warning",
      }))
    )
  }
  async function close() {
    if (pending() || !(await discard()) || !active()) return
    dialog.close()
  }
  async function changeSelection(id: string | null) {
    if (pending() || !(await discard()) || !active()) return
    select(id)
  }
  function select(id: string | null, retainGeneration = false) {
    setSelected(id)
    const item = records.data.find((record) => record.id === id)
    if (!retainGeneration || selectedGeneration() === undefined) setSelectedGeneration(item?.binding.generation)
    setSharing([...(item?.sharedWritableWorkspaceIDs ?? [])])
    setSharingRevision(item?.revision)
    setSavedRevision(item?.revision)
    setBindingPath("")
    setBindingRevision(undefined)
    setError("")
  }
  function editBinding(value: string) {
    if (bindingRevision() === undefined) setBindingRevision(record()?.revision)
    setBindingPath(value)
  }
  async function perform(fn: () => Promise<void>) {
    if (pending() || !active()) return
    setPending(true)
    setError("")
    try {
      await fn()
    } catch (error) {
      if (!controller.signal.aborted) setError(requestErrorMessage(error, _(copy.failed)))
    } finally {
      if (!controller.signal.aborted) setPending(false)
    }
  }
  async function loadSessions() {
    setSessionsLoaded(false)
    const all: Session[] = []
    for (let offset = 0; ; offset += 100) {
      const result = await client.session.list({ scopeID, offset, limit: 100 }, options)
      all.push(...result.data.data)
      if (!result.data.data.length || all.length >= result.data.total) break
    }
    if (controller.signal.aborted) return
    setSessions(all)
    setSessionsLoaded(true)
  }
  async function reload() {
    if (!(await discard())) return
    await perform(async () => {
      if (view() === "manage") await loadSessions()
      const result = await client.workspace.list({ scopeID }, options)
      for (const item of result.data) upsert(item)
      if (!controller.signal.aborted) {
        if (props.mode === "recover" && !failedBinding()) {
          const failed = records.data.find((item) => item.id === props.recovery.workspaceID)
          if (failed)
            setFailedBinding({ workspaceID: failed.id, generation: selectedGeneration() ?? failed.binding.generation })
        }
        const initialID = resolveInitialExisting ? (currentID() ?? selected()) : selected()
        resolveInitialExisting = false
        select(initialID, true)
      }
      const profiles = await client.environment.profiles({ scopeID }, options)
      const id = sessionID() ? (sync.session.get(sessionID()!)?.environmentID ?? null) : props.environmentID
      const name =
        props.environmentProfile === undefined
          ? sync.data.config?.defaultSessionEnvironmentProfile === undefined
            ? profiles.data.defaultEnvironment
            : sync.data.config.defaultSessionEnvironmentProfile
          : props.environmentProfile
      const provider = id
        ? (await client.environment.get({ scopeID, environmentID: id }, options)).data.provider
        : name
          ? profiles.data.environments.find((item) => item.name === name)?.provider
          : undefined
      if (!controller.signal.aborted)
        setDirectoryBrowsing(
          props.mode === "manage" || (id ? provider === "native" : id === null || !name || provider === "native"),
        )
      if (!controller.signal.aborted) {
        setStores(profiles.data.stores)
        if (!profiles.data.stores.some((item) => item.name === storeProfile()))
          setStoreProfile(profiles.data.stores[0]?.name ?? "")
      }
    })
    if (!controller.signal.aborted) setLoading(false)
  }
  onMount(() => void reload())
  onCleanup(sdk.event.on("workspace.updated", (event) => upsert(structuredClone(event.properties))))

  async function manage() {
    if (pending() || !record()) return
    setView("manage")
    await perform(loadSessions)
  }
  async function back() {
    if (pending() || !(await discard())) return
    select(selected(), true)
    setView("list")
  }

  async function pick() {
    const chosen = await picker.pickProjectDirectories({ title: _(copy.pick), multiple: false })
    return controller.signal.aborted ? undefined : chosen?.directoryPaths[0]
  }
  const register = () =>
    perform(async () => {
      if (!directoryBrowsing()) return
      if (!(await discard())) return
      const path = await pick()
      if (!path) return
      const result = await client.workspace.register({ scopeID, path }, options)
      upsert(result.data)
      if (!controller.signal.aborted) {
        select(result.data.id)
        setView("list")
      }
    })
  const createStored = () =>
    perform(async () => {
      if (!storeProfile() || !workspaceName().trim()) return
      if (!(await discard())) return
      const result = await client.workspace.createObjects(
        { scopeID, profile: storeProfile(), name: workspaceName().trim() },
        options,
      )
      upsert(result.data)
      if (!controller.signal.aborted) {
        select(result.data.id)
        setWorkspaceName("")
        setView("list")
      }
    })
  const saveSharing = () =>
    perform(async () => {
      const current = record()
      const expectedRevision = sharingRevision()
      if (!current || expectedRevision === undefined) return
      const result = await client.workspace.setSharing(
        { scopeID, workspaceID: current.id, expectedRevision, workspaceIDs: sharing() },
        options,
      )
      upsert(result.data)
      if (!controller.signal.aborted) select(result.data.id, true)
    })
  const recoverSaved = () =>
    perform(async () => {
      const current = record()
      const expectedRevision = savedRevision()
      if (!current || expectedRevision === undefined || !storeProfile()) return
      const result = await client.workspace.recoverSaved(
        {
          scopeID,
          workspaceID: current.id,
          expectedRevision,
          profile: storeProfile(),
          name: workspaceName().trim() || undefined,
        },
        options,
      )
      upsert(result.data)
      if (!controller.signal.aborted) {
        select(result.data.id)
        setView("list")
      }
    })
  const rebind = () =>
    perform(async () => {
      const current = record()
      const expectedRevision = bindingRevision()
      if (!current || expectedRevision === undefined || !bindingPath().trim()) return
      await loadSessions()
      if (
        !(await confirm.ask({
          title: copy.rebind,
          description: `${_(copy.rebindDescription)}\n${
            affected()
              .map((item) => item.title)
              .join("\n") || _(locationCopy.noAssociated)
          }`,
          confirmLabel: copy.applyBinding,
          tone: "warning",
        }))
      )
        return
      const result = await client.workspace.rebind(
        { scopeID, workspaceID: current.id, expectedRevision, path: bindingPath().trim() },
        options,
      )
      upsert(result.data)
      if (!controller.signal.aborted) {
        select(result.data.id)
        setView("list")
      }
    })
  const choose = () =>
    perform(async () => {
      const current = record()
      const destination = target()
      if (!destination || bindingChanged() || (selected() && (!current || !available(current)))) return
      const selection: SessionWorkspaceSelection = current
        ? { mode: "workspace", workspaceID: current.id, workspaceGeneration: selectedGeneration()! }
        : { mode: "none" }
      if (destination.kind === "session") {
        await client.session.selectWorkspace(
          { scopeID, sessionID: destination.sessionID, sessionWorkspaceSelection: selection },
          options,
        )
        if (active()) await destination.onApplied?.(selection)
      } else if (active()) await destination.onSelect(selection)
      if (!active()) return
      dialog.close()
    })

  return (
    <Dialog
      title={_(
        view() === "create"
          ? copy.createStored
          : view() === "manage" || props.mode === "manage"
            ? locationCopy.manageFiles
            : copy.title,
      )}
      description={
        props.mode === "recover" && view() === "list" && (!record() || !available(record()!))
          ? _(copy.recovery)
          : undefined
      }
      footer={
        <div data-slot="dialog-actions">
          <Button variant="ghost" onClick={() => void close()} disabled={pending()}>
            {_(props.mode === "manage" ? copy.close : copy.cancel)}
          </Button>
          <Show when={props.mode !== "manage" || view() === "create"}>
            <Button
              variant="primary"
              onClick={() => (view() === "create" ? createStored() : choose())}
              disabled={
                pending() ||
                loading() ||
                (view() === "create"
                  ? !storeProfile() || !workspaceName().trim()
                  : sharingDirty() ||
                    !!bindingPath() ||
                    bindingChanged() ||
                    (!!selected() && (!record() || !available(record()!))))
              }
            >
              {_(
                view() === "create"
                  ? copy.create
                  : selected() === null
                    ? copy.useNone
                    : record()?.backend?.provider === "objects"
                      ? copy.useObjects
                      : copy.choose,
              )}
            </Button>
          </Show>
        </div>
      }
      size="form"
      class="workspace-directory-dialog"
      dismissible={false}
      onEscapeKeyDown={(event) => {
        event.preventDefault()
        void close()
      }}
      action={
        <IconButton
          icon={getSemanticIcon("action.close")}
          aria-label={_(props.mode === "manage" ? copy.close : copy.cancel)}
          disabled={pending()}
          onClick={() => void close()}
        />
      }
    >
      <div data-slot="dialog-form" class="project-flow">
        <Show when={view() !== "list"}>
          <Button variant="ghost" onClick={() => void back()} disabled={pending()}>
            {_(copy.back)}
          </Button>
        </Show>
        <Show when={view() === "list"}>
          <TextField label={_(copy.search)} value={search()} onChange={setSearch} autofocus />
        </Show>
        <div class="flex flex-wrap gap-2">
          <Button onClick={register} disabled={pending() || props.copiesOnly || !directoryBrowsing()}>
            {_(copy.register)}
          </Button>
          <Show when={view() === "list"}>
            <Button variant="ghost" onClick={() => void manage()} disabled={pending() || !record()}>
              {_(copy.manage)}
            </Button>
            <Show when={props.mode === "manage" && stores().length}>
              <Button variant="ghost" onClick={() => setView("create")} disabled={pending()}>
                {_(copy.createStored)}
              </Button>
            </Show>
          </Show>
          <Button variant="ghost" onClick={reload} disabled={pending()}>
            {_(copy.reload)}
          </Button>
        </div>
        <Show when={!loading() && !directoryBrowsing()}>
          <p>{_(locationCopy.cannotBrowse)}</p>
        </Show>
        <Show when={loading()}>
          <p role="status">{_(copy.loading)}</p>
        </Show>
        <Show when={view() === "list"}>
          <div class="workspace-directory-list" aria-label={_(copy.title)}>
            <button
              type="button"
              class="project-flow-row"
              aria-pressed={selected() === null}
              onClick={() => void changeSelection(null)}
              disabled={pending()}
            >
              <span class="project-flow-row-copy">{_(locationCopy.noFiles)}</span>
              <span class="project-flow-check">
                <Show when={selected() === null}>
                  <Icon name={getSemanticIcon("state.success")} size="small" />
                </Show>
              </span>
            </button>
            <For each={filtered()}>
              {(item) => (
                <button
                  type="button"
                  aria-pressed={selected() === item.id}
                  onClick={() => void changeSelection(item.id)}
                  disabled={pending()}
                  class="project-flow-row workspace-directory-row"
                  data-workspace-id={item.id}
                >
                  <Icon
                    name={getSemanticIcon(item.type === "git_worktree" ? "workspace.worktree" : "workspace.main")}
                    size="small"
                  />
                  <span class="project-flow-row-copy workspace-directory-copy">
                    <strong>{label(item)}</strong>
                    <Show when={item.binding.path}>
                      <small>{item.binding.path}</small>
                    </Show>
                    <Show when={workspaceBranch(item)}>
                      <small>{workspaceBranch(item)}</small>
                    </Show>
                    <Show when={item.id === currentID() || item.id === mainID()}>
                      <small>{_(item.id === currentID() ? copy.current : copy.main)}</small>
                    </Show>
                    <Show when={!available(item)}>
                      <span class="block text-small text-text-weak">
                        {_(compatible(item) ? copy.unavailable : locationCopy.incompatible)}
                      </span>
                    </Show>
                  </span>
                  <span class="project-flow-check">
                    <Show when={selected() === item.id}>
                      <Icon name={getSemanticIcon("state.success")} size="small" />
                    </Show>
                  </span>
                </button>
              )}
            </For>
            <Show when={!loading() && !filtered().length}>
              <p class="text-small text-text-weak">{_(copy.empty)}</p>
            </Show>
          </div>
        </Show>
        <Show when={view() === "create"}>
          <TextField label={_(copy.name)} value={workspaceName()} onChange={setWorkspaceName} disabled={pending()} />
          <fieldset disabled={pending()} class="flex flex-wrap gap-2">
            <legend class="text-small text-text-weak">{_(copy.store)}</legend>
            <For each={stores()}>
              {(profile) => (
                <Button
                  variant={profile.name === storeProfile() ? "secondary" : "ghost"}
                  aria-pressed={profile.name === storeProfile()}
                  onClick={() => setStoreProfile(profile.name)}
                >
                  {profile.name}
                </Button>
              )}
            </For>
          </fieldset>
        </Show>
        <Show when={view() === "manage" && record()}>
          {(current) => (
            <>
              <p class="project-flow-path">{current().binding.path ?? label(current())}</p>
              <section class="project-flow-section">
                <h3>{_(locationCopy.associated)}</h3>
                <Show when={sessionsLoaded()} fallback={<p role="alert">{_(locationCopy.associatedFailed)}</p>}>
                  <For each={affected()}>{(session) => <p>{session.title}</p>}</For>
                  <Show when={!affected().length}>
                    <p>{_(locationCopy.noAssociated)}</p>
                  </Show>
                </Show>
              </section>
              <Show when={stores().length}>
                <Button
                  variant="ghost"
                  onClick={async () => {
                    if (await discard()) {
                      select(selected(), true)
                      setView("create")
                    }
                  }}
                  disabled={pending()}
                >
                  {_(copy.createStored)}
                </Button>
              </Show>
              <Show
                when={
                  current().backend?.provider === "objects" && current().binding.state === "bound" && stores().length
                }
              >
                <div class="flex flex-col gap-2">
                  <p class="text-small text-text-weak">
                    {_(copy.recoverDescription)} {storeProfile()}
                  </p>
                  <Button
                    onClick={recoverSaved}
                    disabled={pending() || savedRevision() === undefined || !storeProfile()}
                  >
                    {_(copy.recoverSaved)}
                  </Button>
                </div>
              </Show>
              <Show when={shareable(current())}>
                <fieldset class="flex flex-col gap-2" disabled={pending()}>
                  <legend class="text-base font-medium">{_(copy.sharing)}</legend>
                  <p class="text-small text-text-weak">{_(copy.sharingDescription)}</p>
                  <For each={records.data.filter((item) => item.id !== current().id && shareable(item))}>
                    {(item) => (
                      <Checkbox
                        checked={sharing().includes(item.id)}
                        onChange={(checked) =>
                          setSharing((previous) =>
                            checked ? [...previous, item.id] : previous.filter((id) => id !== item.id),
                          )
                        }
                      >
                        <span class="workspace-directory-copy">
                          <span>{label(item)}</span>
                          <Show when={item.binding.path}>
                            <span class="block text-small text-text-weak">{item.binding.path}</span>
                          </Show>
                        </span>
                      </Checkbox>
                    )}
                  </For>
                  <Show when={!records.data.some((item) => item.id !== current().id && shareable(item))}>
                    <p class="text-small text-text-weak">{_(copy.sharingEmpty)}</p>
                  </Show>
                  <Button onClick={saveSharing} disabled={pending() || !sharingDirty()}>
                    {_(copy.saveSharing)}
                  </Button>
                </fieldset>
              </Show>
              <Show when={current().backend?.provider !== "objects"}>
                <section class="project-flow-section">
                  <h3>{_(copy.rebind)}</h3>
                  <div class="flex flex-col gap-2 pt-2">
                    <p class="text-small text-text-weak">{_(copy.rebindDescription)}</p>
                    <TextField
                      label={_(copy.rebindPath)}
                      value={bindingPath()}
                      onChange={editBinding}
                      disabled={pending()}
                    />
                    <div class="flex gap-2">
                      <Button
                        variant="ghost"
                        onClick={() =>
                          perform(async () => {
                            const value = await pick()
                            if (value) editBinding(value)
                          })
                        }
                        disabled={pending()}
                      >
                        {_(copy.pick)}
                      </Button>
                      <Button
                        onClick={rebind}
                        disabled={pending() || !sessionsLoaded() || !bindingPath().trim() || sharingDirty()}
                      >
                        {_(copy.applyBinding)}
                      </Button>
                    </div>
                  </div>
                </section>
              </Show>
            </>
          )}
        </Show>
        <Show when={bindingChanged()}>
          <p role="status" class="text-small text-text-weak">
            {_(copy.changed)}
          </p>
        </Show>
        <Show when={error()}>
          <p role="alert" class="text-small text-text-error break-words">
            {error()}
          </p>
        </Show>
      </div>
    </Dialog>
  )
}
