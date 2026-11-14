import { createSignal, For, onCleanup, onMount, Show } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import { useLingui } from "@lingui/solid"
import type { OrgResourceView, OrgSessionResourceContract } from "@ericsanchezok/synergy-sdk/organization"
import { Button } from "@ericsanchezok/synergy-ui/button"
import { MenuField } from "@ericsanchezok/synergy-ui/menu-field"
import { Checkbox } from "@ericsanchezok/synergy-ui/checkbox"
import { useSpace } from "@/context/space"
import { WorkspaceError } from "./workspace-error"
import { organizationSessionMessages as messages } from "./session-messages"
import { organizationWorkspaceMessages as common } from "./workspace-messages"

export function OrganizationSessionResources(props: {
  sessionID: string
  projectID: string
  canExecute: boolean
  changed?: () => void
}) {
  const { _ } = useLingui()
  const space = useSpace()
  const api = space.client()!
  const controller = new AbortController()
  const signal = AbortSignal.any([space.current()!.signal, controller.signal])
  onCleanup(() => controller.abort())
  const options = { throwOnError: true, signal } as const
  const [state, setState] = createStore<{
    resources: OrgResourceView[]
    selection?: OrgSessionResourceContract
    connections: string[]
  }>({ resources: [], connections: [] })
  const [model, setModel] = createSignal("")
  const [loading, setLoading] = createSignal(false)
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal<unknown>()
  const [cursor, setCursor] = createSignal<string>()
  let draftInitialized = false
  async function load(more = false) {
    if (loading()) return
    setLoading(true)
    setError(undefined)
    try {
      const resource = await api.orgProjectResources.list(
        { projectID: props.projectID, limit: 50, cursor: more ? cursor() : undefined },
        options,
      )
      if (signal.aborted) return
      setState("resources", reconcile(more ? [...state.resources, ...resource.data.items] : resource.data.items))
      setCursor(resource.data.cursor)
      if (!more) {
        const result = await api.orgSessionResources.get({ sessionID: props.sessionID }, options)
        if (signal.aborted) return
        setState("selection", reconcile(result.data))
        if (!draftInitialized) {
          setModel(result.data.selection?.modelResourceID ?? "")
          setState("connections", reconcile(result.data.selection?.connectionResourceIDs ?? []))
          draftInitialized = true
        }
      }
    } catch (error) {
      if (!signal.aborted) setError(error)
    } finally {
      if (!signal.aborted) setLoading(false)
    }
  }
  async function save() {
    if (busy() || !state.selection || !model()) return
    setBusy(true)
    setError(undefined)
    try {
      const result = await api.orgSessionResources.set(
        {
          sessionID: props.sessionID,
          orgSessionResourceChange: {
            expectedRevision: state.selection.revision,
            selection: {
              infrastructure: state.selection.selection
                ? state.selection.selection.infrastructure
                : { workspace: null, environment: null },
              modelResourceID: model(),
              connectionResourceIDs: [...state.connections],
            },
          },
        },
        options,
      )
      if (!signal.aborted) {
        setState("selection", reconcile(result.data))
        props.changed?.()
      }
    } catch (error) {
      if (!signal.aborted) setError(error)
    } finally {
      if (!signal.aborted) setBusy(false)
    }
  }
  const models = () => state.resources.filter((resource) => resource.kind === "model" && resource.state === "enabled")
  const connections = () =>
    state.resources.filter((resource) => resource.kind === "connection" && resource.state === "enabled")
  const missingModel = () => model() && !models().some((resource) => resource.resourceID === model())
  const missingConnections = () =>
    !cursor() && state.connections.some((id) => !connections().some((resource) => resource.resourceID === id))
  onMount(() => void load())
  return (
    <section class="organization-editor">
      <h3>{_(messages.resources)}</h3>
      <p>{_(messages.resourcesHint)}</p>
      <WorkspaceError error={error()} retry={() => void load()} />
      <Show when={loading()}>
        <p role="status">{_(common.loading)}</p>
      </Show>
      <Show when={!loading() && !models().length && !cursor()}>
        <p>{_(messages.noModels)}</p>
      </Show>
      <MenuField
        ariaLabel={_(messages.model)}
        value={model()}
        onChange={(model) => {
          draftInitialized = true
          setModel(model)
        }}
        disabled={!props.canExecute || busy()}
        triggerLabel={!model() ? _(messages.chooseModel) : missingModel() ? _(messages.selectedModel) : undefined}
        options={models().map((resource) => ({ value: resource.resourceID, label: resource.name }))}
      />
      <Show when={missingModel() && !cursor() && !loading()}>
        <p role="status">{_(messages.unavailableModel)}</p>
      </Show>
      <Show when={connections().length}>
        <h4>{_(messages.connections)}</h4>
        <For each={connections()}>
          {(resource) => (
            <Checkbox
              checked={state.connections.includes(resource.resourceID)}
              disabled={!props.canExecute || busy()}
              onChange={(checked) => {
                draftInitialized = true
                setState(
                  "connections",
                  reconcile(
                    checked
                      ? [...state.connections, resource.resourceID]
                      : state.connections.filter((id) => id !== resource.resourceID),
                  ),
                )
              }}
            >
              {resource.name}
            </Checkbox>
          )}
        </For>
      </Show>
      <Show when={cursor()}>
        <Button disabled={loading()} onClick={() => void load(true)}>
          {_(common.more)}
        </Button>
      </Show>
      <Show when={missingConnections() && props.canExecute}>
        <Button
          disabled={busy()}
          onClick={() => {
            draftInitialized = true
            setState(
              "connections",
              reconcile(state.connections.filter((id) => connections().some((resource) => resource.resourceID === id))),
            )
          }}
        >
          {_(messages.unavailableConnections)}
        </Button>
      </Show>
      <Show when={props.canExecute}>
        <Button size="large" variant="primary" disabled={loading() || busy() || !model()} onClick={() => void save()}>
          {_(busy() ? common.working : common.save)}
        </Button>
      </Show>
    </section>
  )
}
