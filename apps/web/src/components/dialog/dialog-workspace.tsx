import { IconButton } from "@ericsanchezok/synergy-ui/icon-button"
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

export function DialogWorkspace(props: {
  recoveryID?: string
  mode?: "select" | "manage"
  copiesOnly?: boolean
  environmentProfile?: string | null
  environmentID?: string | null
  sessionID?: string
  selection?: SessionWorkspaceSelection
  onSelect?: (selection: SessionWorkspaceSelection) => void
}) {
  const sdk = useSDK()
  const sync = useSync()
  const dialog = useDialog()
  const { _ } = useLingui()
  const confirm = useConfirm()
  const picker = useProjectDirectoryPicker()
  const scopeID = sdk.scopeID
  const client = sdk.client
  const controller = new AbortController()
  const [records, setRecords] = createStore<{ data: WorkspaceInfo[] }>({ data: [] })
  const initial =
    props.recoveryID ??
    (props.selection?.mode === "workspace"
      ? props.selection.workspaceID
      : props.selection?.mode === "none"
        ? null
        : props.sessionID
          ? sync.session.get(props.sessionID)?.workspaceID
          : sync.data.path.workspace?.id)
  const [directoryBrowsing, setDirectoryBrowsing] = createSignal(props.mode === "manage")
  const [sessions, setSessions] = createSignal<Session[]>([])
  const [sessionsLoaded, setSessionsLoaded] = createSignal(false)
  const [selected, setSelected] = createSignal<string | null>(initial ?? null)
  const [sharing, setSharing] = createSignal<string[]>([])
  const [sharingRevision, setSharingRevision] = createSignal<number>()
  const [stores, setStores] = createSignal<ResourceProfiles["stores"]>([])
  const [storeProfile, setStoreProfile] = createSignal("")
  const [workspaceName, setWorkspaceName] = createSignal("")
  const [savedRevision, setSavedRevision] = createSignal<number>()
  const label = (item: WorkspaceInfo) =>
    typeof item.metadata.name === "string" ? item.metadata.name : (item.binding.path ?? item.id)
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
    item.lifecycle === "active" &&
    item.binding.state === "bound" &&
    item.activeMount?.state !== "unavailable" &&
    (item.backend?.provider === "objects" || (!!item.binding.path && !!item.binding.physicalID))
  const filtered = createMemo(() =>
    records.data.filter(
      (item) =>
        (!props.copiesOnly || item.type === "git_worktree") &&
        `${label(item)} ${item.id}`.toLowerCase().includes(search().toLowerCase()),
    ),
  )
  const sharingDirty = createMemo(() => {
    const current = record()
    return !!current && [...sharing()].sort().join("\n") !== [...current.sharedWritableWorkspaceIDs].sort().join("\n")
  })
  const options = { signal: controller.signal, throwOnError: true as const }
  const shareable = (item: WorkspaceInfo) => available(item) && !!item.binding.path && !!item.binding.physicalID
  onCleanup(() => controller.abort())
  createEffect(() => {
    if (sdk.scopeID !== scopeID || sdk.client !== client) dialog.close()
  })

  function upsert(item: WorkspaceInfo) {
    if (item.scopeID !== scopeID || controller.signal.aborted) return
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
    if (pending() || !(await discard())) return
    dialog.close()
  }
  async function changeSelection(id: string | null) {
    if (!(await discard())) return
    select(id)
  }
  function select(id: string | null) {
    setSelected(id)
    const item = records.data.find((record) => record.id === id)
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
    if (pending() || controller.signal.aborted) return
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
      if (props.mode === "manage") await loadSessions()
      const result = await client.workspace.list({ scopeID }, options)
      for (const item of result.data) upsert(item)
      if (!controller.signal.aborted) select(selected())
      const profiles = await client.environment.profiles({ scopeID }, options)
      const id = props.sessionID ? (sync.session.get(props.sessionID)?.environmentID ?? null) : props.environmentID
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
      if (!controller.signal.aborted) select(result.data.id)
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
      if (!controller.signal.aborted) select(result.data.id)
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
      if (!controller.signal.aborted) select(result.data.id)
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
      if (!controller.signal.aborted) select(result.data.id)
    })
  const choose = () =>
    perform(async () => {
      const current = record()
      if (selected() && (!current || !available(current))) return
      const selection: SessionWorkspaceSelection = current
        ? { mode: "workspace", workspaceID: current.id, workspaceGeneration: current.binding.generation }
        : { mode: "none" }
      if (props.sessionID)
        await client.session.selectWorkspace(
          { scopeID, sessionID: props.sessionID, sessionWorkspaceSelection: selection },
          options,
        )
      if (controller.signal.aborted) return
      props.onSelect?.(selection)
      dialog.close()
    })

  return (
    <Dialog
      title={_(
        props.mode === "manage"
          ? locationCopy.manageFiles
          : props.copiesOnly
            ? locationCopy.continueCopy
            : locationCopy.chooseFiles,
      )}
      description={
        props.recoveryID
          ? _({
              id: "workspace.dialog.recovery",
              message:
                "This directory could not be verified. Confirm its location and rebind it to continue. Your conversation and draft are preserved.",
            })
          : _(locationCopy.fileDescription)
      }
      footer={
        <div data-slot="dialog-actions">
          <Button variant="ghost" onClick={() => void close()} disabled={pending()}>
            {_(copy.cancel)}
          </Button>
          <Show when={props.mode !== "manage" || props.sessionID || props.onSelect}>
            <Button
              variant="primary"
              onClick={choose}
              disabled={
                pending() || loading() || sharingDirty() || (!!selected() && (!record() || !available(record()!)))
              }
            >
              {_(props.mode === "manage" ? copy.choose : locationCopy.useFiles)}
            </Button>
          </Show>
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
          disabled={pending()}
          onClick={() => void close()}
        />
      }
    >
      <div data-slot="dialog-form" class="project-flow">
        <TextField
          label={_(props.mode === "manage" ? copy.search : locationCopy.searchFiles)}
          value={search()}
          onChange={setSearch}
          autofocus
        />
        <div class="flex gap-2">
          <Button onClick={register} disabled={pending() || props.copiesOnly || !directoryBrowsing()}>
            {_(props.mode === "manage" ? copy.register : locationCopy.browse)}
          </Button>
          <Button variant="ghost" onClick={reload} disabled={pending()}>
            {_(copy.reload)}
          </Button>
        </div>
        <Show when={!loading() && !directoryBrowsing()}>
          <p>{_(locationCopy.cannotBrowse)}</p>
        </Show>
        <Show when={props.mode === "manage" && stores().length}>
          <details>
            <summary class="cursor-pointer text-base font-medium">{_(copy.createStored)}</summary>
            <div class="flex flex-col gap-2 pt-2">
              <TextField
                label={_(copy.name)}
                value={workspaceName()}
                onChange={setWorkspaceName}
                disabled={pending()}
              />
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
              <Button onClick={createStored} disabled={pending() || !storeProfile() || !workspaceName().trim()}>
                {_(copy.create)}
              </Button>
            </div>
          </details>
        </Show>
        <Show when={loading()}>
          <p role="status">{_(copy.loading)}</p>
        </Show>
        <div class="project-flow-list" aria-label={_(copy.title)}>
          <Button
            variant={selected() === null ? "secondary" : "ghost"}
            aria-pressed={selected() === null}
            onClick={() => void changeSelection(null)}
            disabled={pending()}
          >
            {_(locationCopy.noFiles)}
          </Button>
          <For each={filtered()}>
            {(item) => (
              <Button
                variant={selected() === item.id ? "secondary" : "ghost"}
                aria-pressed={selected() === item.id}
                onClick={() => void changeSelection(item.id)}
                disabled={pending()}
                class="project-flow-row"
              >
                <span>
                  {label(item)}
                  <Show when={!available(item)}>
                    <span class="block text-small text-text-weak">
                      {_(compatible(item) ? copy.unavailable : locationCopy.incompatible)}
                    </span>
                  </Show>
                </span>
              </Button>
            )}
          </For>
          <Show when={!loading() && !filtered().length}>
            <p class="text-small text-text-weak">{_(copy.empty)}</p>
          </Show>
        </div>
        <Show when={props.mode === "manage" && record()}>
          {(current) => (
            <>
              <section class="project-flow-section">
                <h3>{_(locationCopy.associated)}</h3>
                <Show when={sessionsLoaded()} fallback={<p role="alert">{_(locationCopy.associatedFailed)}</p>}>
                  <For each={affected()}>{(session) => <p>{session.title}</p>}</For>
                  <Show when={!affected().length}>
                    <p>{_(locationCopy.noAssociated)}</p>
                  </Show>
                </Show>
              </section>
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
                        {label(item)}
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
                <details>
                  <summary class="cursor-pointer text-base font-medium">{_(copy.rebind)}</summary>
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
                </details>
              </Show>
            </>
          )}
        </Show>
        <Show when={props.sessionID}>
          <p class="text-small text-text-weak">{_(copy.busy)}</p>
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
