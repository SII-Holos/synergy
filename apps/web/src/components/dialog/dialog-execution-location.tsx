import { IconButton } from "@ericsanchezok/synergy-ui/icon-button"
import { createEffect, createSignal, For, onCleanup, onMount, Show } from "solid-js"
import { useLingui } from "@lingui/solid"
import type { ResourceProfiles } from "@ericsanchezok/synergy-sdk/client"
import { generateUUID } from "@ericsanchezok/synergy-util/uuid"
import { Dialog } from "@ericsanchezok/synergy-ui/dialog"
import { useDialog } from "@ericsanchezok/synergy-ui/context/dialog"
import { Button } from "@ericsanchezok/synergy-ui/button"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { getSemanticIcon } from "@ericsanchezok/synergy-ui/semantic-icon"
import { useSDK } from "@/context/sdk"
import { useSync } from "@/context/sync"
import { requestErrorMessage } from "@/utils/error"
import { locationCopy as copy } from "./task-location-copy"
import "./project-flow.css"

export function DialogExecutionLocation(props: {
  sessionID?: string
  running?: boolean
  profile?: string | null
  nativeFiles: boolean
  onSelect?: (profile: string | null | undefined) => void
}) {
  const sdk = useSDK()
  const sync = useSync()
  const dialog = useDialog()
  const { _ } = useLingui()
  const client = sdk.client
  const scopeID = sdk.scopeID
  const controller = new AbortController()
  const options = { signal: controller.signal, throwOnError: true as const }
  const [profile, setProfile] = createSignal<string | null | undefined>(props.profile)
  const [keepCurrent, setKeepCurrent] = createSignal(!!props.sessionID)
  const [pending, setPending] = createSignal(false)
  const [loading, setLoading] = createSignal(true)
  const [error, setError] = createSignal("")
  const [profiles, setProfiles] = createSignal<ResourceProfiles>()
  const baseline = props.sessionID ? (sync.session.get(props.sessionID)?.environmentID ?? null) : undefined
  const requests = new Map<string, string>()
  onCleanup(() => controller.abort())
  createEffect(() => {
    if (sdk.scopeID !== scopeID || sdk.client !== client) dialog.close()
  })
  async function load() {
    setLoading(true)
    setError("")
    try {
      const result = await client.environment.profiles({ scopeID }, options)
      if (!controller.signal.aborted) setProfiles(result.data)
    } catch (error) {
      if (!controller.signal.aborted) setError(requestErrorMessage(error, _(copy.unavailable)))
    } finally {
      if (!controller.signal.aborted) setLoading(false)
    }
  }
  onMount(() => void load())
  const resolved = (name: string | null | undefined) =>
    name === undefined
      ? sync.data.config.defaultSessionEnvironmentProfile === undefined
        ? profiles()?.defaultEnvironment
        : sync.data.config.defaultSessionEnvironmentProfile
      : name
  const compatible = (name: string | null | undefined) => {
    const target = resolved(name)
    if (!target) return true
    const item = profiles()?.environments.find((row) => row.name === target)
    return !!item && (!props.nativeFiles || item.provider === "native")
  }
  async function apply() {
    if (pending() || props.running || controller.signal.aborted) return
    if (keepCurrent()) {
      dialog.close()
      return
    }
    if (!compatible(profile())) return
    setPending(true)
    setError("")
    try {
      if (props.sessionID) {
        const selected = resolved(profile())
        const requestID = selected ? (requests.get(selected) ?? generateUUID()) : undefined
        if (selected && requestID) requests.set(selected, requestID)
        const id = selected
          ? (await client.environment.create({ scopeID, profile: selected, requestID: requestID! }, options)).data.id
          : null
        await client.session.setEnvironment(
          {
            scopeID,
            sessionID: props.sessionID,
            sessionEnvironmentSelection: { environmentID: id, expectedEnvironmentID: baseline ?? null },
          },
          options,
        )
      } else props.onSelect?.(profile())
      if (!controller.signal.aborted) dialog.close()
    } catch (error) {
      if (!controller.signal.aborted) setError(requestErrorMessage(error, _(copy.failed)))
    } finally {
      if (!controller.signal.aborted) setPending(false)
    }
  }
  return (
    <Dialog
      title={_(copy.execution)}
      description={_(copy.executionDescription)}
      footer={
        <div data-slot="dialog-actions">
          <Button variant="ghost" disabled={pending()} onClick={() => dialog.close()}>
            {_(copy.cancel)}
          </Button>
          <Button
            disabled={
              pending() || props.running || loading() || !profiles() || (!keepCurrent() && !compatible(profile()))
            }
            onClick={() => void apply()}
          >
            {_(copy.apply)}
          </Button>
        </div>
      }
      size="form"
      dismissible={!pending()}
      action={
        <IconButton
          icon={getSemanticIcon("action.close")}
          aria-label={_(copy.cancel)}
          disabled={pending()}
          onClick={() => dialog.close()}
        />
      }
    >
      <div data-slot="dialog-form" class="project-flow">
        <Show when={loading()}>
          <p role="status">{_(copy.loading)}</p>
        </Show>
        <div class="project-flow-list">
          <Show when={props.sessionID}>
            <button
              type="button"
              class="project-flow-row"
              aria-pressed={keepCurrent()}
              onClick={() => setKeepCurrent(true)}
            >
              <span class="project-flow-row-copy">{_(copy.current)}</span>
              <span class="project-flow-check">
                <Show when={keepCurrent()}>
                  <Icon name={getSemanticIcon("state.success")} size="small" />
                </Show>
              </span>
            </button>
          </Show>
          <For
            each={[
              { name: undefined, label: _(copy.default) },
              { name: null, label: _(copy.none) },
              ...(profiles()?.environments ?? []).map((item) => ({ ...item, label: item.name })),
            ]}
          >
            {(item) => (
              <button
                type="button"
                class="project-flow-row"
                aria-pressed={!keepCurrent() && profile() === item.name}
                disabled={pending() || !compatible(item.name)}
                onClick={() => {
                  setKeepCurrent(false)
                  setProfile(item.name)
                }}
              >
                <Icon name={getSemanticIcon("providers.main")} size="small" />
                <span class="project-flow-row-copy">
                  <strong>{item.label}</strong>
                  <Show when={!compatible(item.name)}>
                    <small>{_(copy.incompatible)}</small>
                  </Show>
                </span>
                <span class="project-flow-check">
                  <Show when={!keepCurrent() && profile() === item.name}>
                    <Icon name={getSemanticIcon("state.success")} size="small" />
                  </Show>
                </span>
              </button>
            )}
          </For>
        </div>
        <Show when={error()}>
          <p role="alert">{error()}</p>
          <Show when={!profiles()}>
            <Button variant="ghost" onClick={() => void load()}>
              {_(copy.retry)}
            </Button>
          </Show>
        </Show>
      </div>
    </Dialog>
  )
}
