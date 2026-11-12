import { batch, createSignal, For, onCleanup, onMount, Show } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import { useLingui } from "@lingui/solid"
import { Button } from "@ericsanchezok/synergy-ui/button"
import { TextField } from "@ericsanchezok/synergy-ui/text-field"
import { MenuField } from "@ericsanchezok/synergy-ui/menu-field"
import type { OrgResourceAdminView, OrgResourceCreate } from "@ericsanchezok/synergy-sdk/organization"
import { useSpace } from "@/context/space"
import { useConfirm } from "@/components/dialog/confirm-dialog"
import { WorkspaceError } from "./workspace-error"
import { ResourceAccess } from "./resource-access"
import { organizationOwnerFailure } from "./owner-error"
import { organizationResourceMessages as messages } from "./resource-messages"
import { organizationWorkspaceMessages as common } from "./workspace-messages"

export function OrganizationResources() {
  const space = useSpace()
  const { _ } = useLingui()
  const confirm = useConfirm()
  const view = space.current()!
  const api = space.client()!
  const controller = new AbortController()
  const signal = AbortSignal.any([view.signal, controller.signal])
  onCleanup(() => controller.abort())
  const options = { throwOnError: true, signal } as const
  const [state, setState] = createStore({ resources: [] as OrgResourceAdminView[] })
  const [cursor, setCursor] = createSignal<string>()
  const [editing, setEditing] = createSignal(false)
  const [access, setAccess] = createSignal<OrgResourceAdminView>()
  const [loading, setLoading] = createSignal(false)
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal<unknown>()
  const [blocked, setBlocked] = createSignal(false)
  let generation = 0
  const current = (version = generation) => !signal.aborted && version === generation
  function failed(error: unknown) {
    const failure = organizationOwnerFailure(error)
    batch(() => {
      if (failure) {
        generation++
        confirm.closeOwned()
        setBlocked(true)
        setState("resources", reconcile([]))
        setCursor(undefined)
        setEditing(false)
        setAccess(undefined)
        setLoading(false)
        setBusy(false)
      }
      setError(error)
    })
    if (failure === "authentication") space.authorizationRequired(view)
  }
  async function load(more = false) {
    if (!current()) return
    const version = generation
    setLoading(true)
    setError(undefined)
    try {
      const result = await api.orgResources.list({ limit: 50, cursor: more ? cursor() : undefined }, options)
      if (!current(version)) return
      setBlocked(false)
      setState("resources", reconcile(more ? [...state.resources, ...result.data.items] : result.data.items))
      setCursor(result.data.cursor)
    } catch (error) {
      if (current(version)) failed(error)
    } finally {
      if (current(version)) setLoading(false)
    }
  }
  function toggle(resource: OrgResourceAdminView) {
    if (!current() || blocked()) return
    const version = generation
    const target = {
      resourceID: resource.resourceID,
      expectedRevision: resource.revision,
      state: resource.state === "enabled" ? ("disabled" as const) : ("enabled" as const),
    }
    const perform = async () => {
      if (!current(version) || blocked()) return
      setBusy(true)
      setError(undefined)
      try {
        const result = await api.orgResources.update(
          {
            resourceID: target.resourceID,
            orgResourceChange: { expectedRevision: target.expectedRevision, state: target.state },
          },
          options,
        )
        if (current(version))
          setState("resources", (entry) => entry.resourceID === target.resourceID, reconcile(result.data))
      } catch (error) {
        if (current(version)) failed(error)
      } finally {
        if (current(version)) setBusy(false)
      }
    }
    if (target.state === "enabled") {
      void perform()
      return
    }
    confirm.show({
      title: messages.disable,
      description: messages.disableHint,
      confirmLabel: messages.disable,
      tone: "warning",
      onConfirm: perform,
    })
  }
  onMount(() => void load())
  return (
    <section class="organization-resource-view">
      <div class="organization-page-heading">
        <div>
          <h2>{_(messages.title)}</h2>
          <p>{_(messages.hint)}</p>
        </div>
        <Show when={!blocked() && !editing()}>
          <Button size="large" variant="primary" onClick={() => setEditing(true)}>
            {_(messages.add)}
          </Button>
        </Show>
      </div>
      <WorkspaceError error={error()} retry={() => void load()} />
      <Show when={loading()}>
        <p role="status">{_(common.loading)}</p>
      </Show>
      <Show when={!blocked()}>
        <Show when={editing()}>
          <ResourceEditor
            invalidated={failed}
            onCancel={() => setEditing(false)}
            onSave={() => {
              setEditing(false)
              void load()
            }}
          />
        </Show>
        <Show when={!loading() && !editing() && !state.resources.length}>
          <div class="organization-empty">
            <h3>{_(messages.empty)}</h3>
            <p>{_(messages.emptyHint)}</p>
          </div>
        </Show>
        <ul class="organization-resource-list">
          <For each={state.resources}>
            {(resource) => (
              <li>
                <div class="organization-member-identity">
                  <strong>{resource.name}</strong>
                  <span>
                    {resource.configuration.protocol} ·{" "}
                    {_(resource.state === "enabled" ? messages.enabled : messages.disabled)}
                  </span>
                </div>
                <Button onClick={() => setAccess(access()?.resourceID === resource.resourceID ? undefined : resource)}>
                  {_(messages.access)}
                </Button>
                <Button disabled={busy()} onClick={() => toggle(resource)}>
                  {_(resource.state === "enabled" ? messages.disable : messages.enable)}
                </Button>
                <Show when={access()?.resourceID === resource.resourceID}>
                  <div class="organization-resource-access">
                    <ResourceAccess resource={resource} invalidated={failed} />
                  </div>
                </Show>
              </li>
            )}
          </For>
        </ul>
        <Show when={cursor()}>
          <Button disabled={loading()} onClick={() => void load(true)}>
            {_(common.more)}
          </Button>
        </Show>
      </Show>
    </section>
  )
}

function ResourceEditor(props: { onCancel: () => void; onSave: () => void; invalidated: (error: unknown) => void }) {
  const space = useSpace()
  const { _ } = useLingui()
  const api = space.client()!
  const view = space.current()!
  const controller = new AbortController()
  const signal = AbortSignal.any([view.signal, controller.signal])
  type Protocol = OrgResourceCreate["configuration"]["protocol"]
  const [protocol, setProtocol] = createSignal<Protocol>("openai-compatible")
  const [name, setName] = createSignal("")
  const [endpoint, setEndpoint] = createSignal("")
  const [model, setModel] = createSignal("")
  const [profile, setProfile] = createSignal("")
  const [method, setMethod] = createSignal<"GET" | "POST" | "PUT" | "PATCH" | "DELETE">("POST")
  const [context, setContext] = createSignal("128000")
  const [output, setOutput] = createSignal("8192")
  const [key, setKey] = createSignal("")
  onCleanup(() => {
    controller.abort()
    setKey("")
  })
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal<unknown>()
  const isModel = () => protocol() === "openai-compatible" || protocol() === "anthropic-compatible"
  const isCloud = () => protocol() === "environment" || protocol() === "workspace-storage"
  async function save() {
    if (busy() || signal.aborted) return
    setBusy(true)
    setError(undefined)
    const selected = protocol()
    const configuration: OrgResourceCreate["configuration"] =
      selected === "openai-compatible" || selected === "anthropic-compatible"
        ? {
            protocol: selected,
            endpoint: endpoint().trim(),
            model: {
              id: model().trim(),
              name: name().trim(),
              limit: { context: Number(context()), output: Number(output()) },
            },
          }
        : selected === "fixed-http"
          ? { protocol: selected, endpoint: endpoint().trim(), method: method() }
          : selected === "environment" || selected === "workspace-storage"
            ? { protocol: selected, profile: profile().trim() }
            : { protocol: selected, endpoint: endpoint().trim() }
    try {
      await api.orgResources.create(
        {
          orgResourceCreate: {
            name: name().trim(),
            scope: { kind: "organization" },
            configuration,
            credential: !isCloud() && key() ? { kind: "bearer", value: key() } : { kind: "none" },
          },
        },
        { throwOnError: true, signal },
      )
      setKey("")
      if (!signal.aborted) props.onSave()
    } catch (error) {
      if (!signal.aborted) {
        if (organizationOwnerFailure(error)) props.invalidated(error)
        else setError(error)
      }
    } finally {
      if (!signal.aborted) setBusy(false)
    }
  }
  return (
    <form
      class="organization-editor"
      onSubmit={(event) => {
        event.preventDefault()
        void save()
      }}
    >
      <WorkspaceError error={error()} />
      <TextField label={_(messages.name)} value={name()} onChange={setName} required maxLength={200} />
      <label>{_(messages.protocol)}</label>
      <MenuField
        ariaLabel={_(messages.protocol)}
        value={protocol()}
        onChange={setProtocol}
        options={[
          { value: "openai-compatible", label: _(messages.openai) },
          { value: "anthropic-compatible", label: _(messages.anthropic) },
          { value: "mcp-http", label: _(messages.mcpHttp) },
          { value: "mcp-sse", label: _(messages.mcpSse) },
          { value: "fixed-http", label: _(messages.fixedHttp) },
          { value: "workspace-storage", label: _(messages.workspace) },
          { value: "environment", label: _(messages.environment) },
        ]}
      />
      <Show
        when={isCloud()}
        fallback={
          <TextField
            label={_(messages.endpoint)}
            value={endpoint()}
            onChange={setEndpoint}
            type="url"
            required
            placeholder={_({ ...messages.endpointPlaceholder, values: { url: "https://service.example.com/v1" } })}
          />
        }
      >
        <TextField
          label={_(messages.profile)}
          value={profile()}
          onChange={setProfile}
          description={_(messages.profileHint)}
          required
        />
      </Show>
      <Show when={protocol() === "fixed-http"}>
        <label>{_(messages.method)}</label>
        <MenuField
          ariaLabel={_(messages.method)}
          value={method()}
          onChange={setMethod}
          options={(["GET", "POST", "PUT", "PATCH", "DELETE"] as const).map((value) => ({ value, label: value }))}
        />
      </Show>
      <Show when={isModel()}>
        <TextField label={_(messages.model)} value={model()} onChange={setModel} required />
        <div class="organization-field-pair">
          <TextField
            label={_(messages.context)}
            value={context()}
            onChange={setContext}
            type="number"
            min={1}
            required
          />
          <TextField label={_(messages.output)} value={output()} onChange={setOutput} type="number" min={1} required />
        </div>
      </Show>
      <Show when={!isCloud()}>
        <TextField
          label={_(messages.key)}
          value={key()}
          onChange={setKey}
          type="password"
          autocomplete="off"
          description={_(messages.keyHint)}
        />
      </Show>
      <div class="organization-actions">
        <Button size="large" variant="primary" type="submit" disabled={busy()}>
          {_(messages.save)}
        </Button>
        <Button size="large" variant="ghost" type="button" onClick={props.onCancel}>
          {_(common.cancel)}
        </Button>
      </div>
    </form>
  )
}
