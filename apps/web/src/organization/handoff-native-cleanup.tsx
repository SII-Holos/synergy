import { createSignal, onCleanup, Show } from "solid-js"
import { useLingui } from "@lingui/solid"
import { OrganizationHandoffProtocol as Handoff } from "@ericsanchezok/synergy-organization-protocol"
import { generateSecureUUID } from "@ericsanchezok/synergy-util/uuid"
import { Button } from "@ericsanchezok/synergy-ui/button"
import { WorkspaceError } from "./workspace-error"
import { organizationNativeHandoffMessages as messages } from "./handoff-native-messages"
import { organizationNativeCleanupResult, type OrganizationNativeCleanupHandle } from "./handoff-native-cleanup-state"

export function OrganizationNativeCleanup(props: {
  handle: OrganizationNativeCleanupHandle
  heading: boolean
  disabled: boolean
  current: () => boolean
  read: (requestID: string) => Promise<Handoff.MachineResult>
  complete: () => void
  failed: (error: unknown) => void
}) {
  const { _ } = useLingui()
  const [loading, setLoading] = createSignal(false)
  const [released, setReleased] = createSignal(false)
  const [error, setError] = createSignal<unknown>()
  let generation = 0
  let disposed = false
  const current = (value: number) => !disposed && props.current() && generation === value
  async function inspect() {
    if (props.disabled || loading() || !props.current()) return
    const original = ++generation
    const handle = props.handle
    const requestID = generateSecureUUID()
    setLoading(true)
    setError(undefined)
    try {
      const result = await props.read(requestID)
      if (!current(original) || props.handle !== handle) return
      const value = organizationNativeCleanupResult(handle, requestID, result)
      setReleased(value.complete)
      if (value.complete) props.complete()
    } catch (error) {
      if (current(original)) {
        setError(error)
        props.failed(error)
      }
    } finally {
      if (current(original)) setLoading(false)
    }
  }
  onCleanup(() => {
    disposed = true
    generation++
  })
  return (
    <section class="organization-handoff-native" aria-label={_(messages.cleanup)}>
      <Show when={props.heading}>
        <h3>{_(messages.cleanup)}</h3>
      </Show>
      <p>{props.handle.runtime.deviceID}</p>
      <p>{_(messages.cleanupHint)}</p>
      <p>{_(messages.cleanupScope)}</p>
      <WorkspaceError error={error()} retry={!loading() && !props.disabled ? () => void inspect() : undefined} />
      <p role="status">{_(released() ? messages.cleanupComplete : messages.cleanupUnknown)}</p>
      <Show when={!released()}>
        <Button disabled={props.disabled || loading()} onClick={() => void inspect()}>
          {_(messages.checkCleanup)}
        </Button>
      </Show>
    </section>
  )
}
