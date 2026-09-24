import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import type { SessionWorkspaceSelection, WorkspaceInfo } from "@ericsanchezok/synergy-sdk/client"
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
import { workspaceCopy as copy } from "./workspace-dialog-copy"

export function DialogWorkspace(props: {
  sessionID?: string
  selection?: SessionWorkspaceSelection
  onSelect?: (selection: SessionWorkspaceSelection) => void
}) {
  const sdk = useSDK()
  const sync = useSync()
  const dialog = useDialog()
  const { _ } = useLingui()
  const picker = useProjectDirectoryPicker()
  const scopeID = sdk.scopeID
  const client = sdk.client
  const controller = new AbortController()
  const [records, setRecords] = createStore<{ data: WorkspaceInfo[] }>({ data: [] })
  const initial =
    props.selection?.mode === "workspace"
      ? props.selection.workspaceID
      : props.selection?.mode === "none"
        ? null
        : props.sessionID
          ? sync.session.get(props.sessionID)?.workspaceID
          : sync.data.path.workspace?.id
  const [selected, setSelected] = createSignal<string | null>(initial ?? null)
  const [sharing, setSharing] = createSignal<string[]>([])
  const [sharingRevision, setSharingRevision] = createSignal<number>()
  const [search, setSearch] = createSignal("")
  const [bindingPath, setBindingPath] = createSignal("")
  const [bindingRevision, setBindingRevision] = createSignal<number>()
  const [pending, setPending] = createSignal(false)
  const [loading, setLoading] = createSignal(true)
  const [error, setError] = createSignal("")
  const record = createMemo(() => records.data.find((item) => item.id === selected()))
  const available = (item: WorkspaceInfo) =>
    item.lifecycle === "active" && item.binding.state === "bound" && !!item.binding.path && !!item.binding.physicalID
  const filtered = createMemo(() =>
    records.data.filter((item) =>
      `${item.binding.path ?? item.id} ${item.id}`.toLowerCase().includes(search().toLowerCase()),
    ),
  )
  const sharingDirty = createMemo(() => {
    const current = record()
    return !!current && [...sharing()].sort().join("\n") !== [...current.sharedWritableWorkspaceIDs].sort().join("\n")
  })
  const options = { signal: controller.signal, throwOnError: true as const }
  onCleanup(() => controller.abort())
  createEffect(() => {
    if (sdk.scopeID !== scopeID) dialog.close()
  })

  function upsert(item: WorkspaceInfo) {
    if (item.scopeID !== scopeID || controller.signal.aborted) return
    const index = records.data.findIndex((record) => record.id === item.id)
    if (index < 0) setRecords("data", records.data.length, item)
    else if (records.data[index]!.revision <= item.revision) setRecords("data", index, reconcile(item))
  }
  function select(id: string | null) {
    setSelected(id)
    const item = records.data.find((record) => record.id === id)
    setSharing([...(item?.sharedWritableWorkspaceIDs ?? [])])
    setSharingRevision(item?.revision)
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
  async function reload() {
    await perform(async () => {
      const result = await client.workspace.list({ scopeID }, options)
      for (const item of result.data) upsert(item)
      if (!controller.signal.aborted) select(selected())
    })
    if (!controller.signal.aborted) setLoading(false)
  }
  onMount(() => {
    void reload()
  })
  onCleanup(sdk.event.on("workspace.updated", (event) => upsert(structuredClone(event.properties))))

  async function pick() {
    const chosen = await picker.pickProjectDirectories({ title: _(copy.pick), multiple: false })
    return controller.signal.aborted ? undefined : chosen?.directoryPaths[0]
  }
  const register = () =>
    perform(async () => {
      const path = await pick()
      if (!path) return
      const result = await client.workspace.register({ scopeID, path }, options)
      upsert(result.data)
      if (!controller.signal.aborted) select(result.data.id)
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
  const rebind = () =>
    perform(async () => {
      const current = record()
      const expectedRevision = bindingRevision()
      if (!current || expectedRevision === undefined || !bindingPath().trim()) return
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
    <Dialog title={_(copy.title)} description={_(copy.description)} size="form" dismissible={!pending()}>
      <div data-slot="dialog-form">
        <TextField label={_(copy.search)} value={search()} onChange={setSearch} autofocus />
        <div class="flex gap-2">
          <Button onClick={register} disabled={pending()}>
            {_(copy.register)}
          </Button>
          <Button variant="ghost" onClick={reload} disabled={pending()}>
            {_(copy.reload)}
          </Button>
        </div>
        <Show when={loading()}>
          <p role="status">{_(copy.loading)}</p>
        </Show>
        <div class="flex flex-col gap-1 max-h-64 overflow-auto" aria-label={_(copy.title)}>
          <Button
            variant={selected() === null ? "secondary" : "ghost"}
            aria-pressed={selected() === null}
            onClick={() => select(null)}
            disabled={pending()}
          >
            {_(copy.none)}
          </Button>
          <For each={filtered()}>
            {(item) => (
              <Button
                variant={selected() === item.id ? "secondary" : "ghost"}
                aria-pressed={selected() === item.id}
                onClick={() => select(item.id)}
                disabled={pending()}
                class="h-auto justify-start whitespace-normal break-all text-left"
              >
                <span>
                  {item.binding.path ?? item.id}
                  <Show when={!available(item)}>
                    <span class="block text-small text-text-weak">{_(copy.unavailable)}</span>
                  </Show>
                </span>
              </Button>
            )}
          </For>
          <Show when={!loading() && !filtered().length}>
            <p class="text-small text-text-weak">{_(copy.empty)}</p>
          </Show>
        </div>
        <Show when={record()}>
          {(current) => (
            <>
              <Show when={available(current())}>
                <fieldset class="flex flex-col gap-2" disabled={pending()}>
                  <legend class="text-base font-medium">{_(copy.sharing)}</legend>
                  <p class="text-small text-text-weak">{_(copy.sharingDescription)}</p>
                  <For each={records.data.filter((item) => item.id !== current().id && available(item))}>
                    {(item) => (
                      <Checkbox
                        checked={sharing().includes(item.id)}
                        onChange={(checked) =>
                          setSharing((previous) =>
                            checked ? [...previous, item.id] : previous.filter((id) => id !== item.id),
                          )
                        }
                      >
                        {item.binding.path ?? item.id}
                      </Checkbox>
                    )}
                  </For>
                  <Show when={!records.data.some((item) => item.id !== current().id && available(item))}>
                    <p class="text-small text-text-weak">{_(copy.sharingEmpty)}</p>
                  </Show>
                  <Button onClick={saveSharing} disabled={pending() || !sharingDirty()}>
                    {_(copy.saveSharing)}
                  </Button>
                </fieldset>
              </Show>
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
                    <Button onClick={rebind} disabled={pending() || !bindingPath().trim() || sharingDirty()}>
                      {_(copy.applyBinding)}
                    </Button>
                  </div>
                </div>
              </details>
            </>
          )}
        </Show>
        <p class="text-small text-text-weak">{_(copy.busy)}</p>
        <Show when={error()}>
          <p role="alert" class="text-small text-text-error break-words">
            {error()}
          </p>
        </Show>
        <div data-slot="dialog-actions">
          <Button variant="ghost" onClick={() => dialog.close()} disabled={pending()}>
            {_(copy.cancel)}
          </Button>
          <Button
            variant="primary"
            onClick={choose}
            disabled={
              pending() || loading() || sharingDirty() || (!!selected() && (!record() || !available(record()!)))
            }
          >
            {_(copy.choose)}
          </Button>
        </div>
      </div>
    </Dialog>
  )
}
