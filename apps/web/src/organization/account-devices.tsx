import { createEffect, createSignal, For, onCleanup, onMount, Show } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import { useLingui } from "@lingui/solid"
import { OrganizationRuntimeProtocol as Runtime } from "@ericsanchezok/synergy-organization-protocol"
import { Button } from "@ericsanchezok/synergy-ui/button"
import { Dialog } from "@ericsanchezok/synergy-ui/dialog"
import { useDialog } from "@ericsanchezok/synergy-ui/context/dialog"
import { useSpace } from "@/context/space"
import { WorkspaceError } from "./workspace-error"
import { organizationOwnerFailure } from "./owner-error"
import { OrganizationNativeCleanup } from "./handoff-native-cleanup"
import { organizationNativeHandoffMessages as native } from "./handoff-native-messages"
import { organizationHandoffMessages as handoff } from "./handoff-messages"
import { organizationWorkspaceMessages as common } from "./workspace-messages"
import { organizationDeviceMessages as messages } from "./account-device-messages"
import {
  organizationOwnDevices,
  organizationDeviceCleanupPage,
  type OrganizationDeviceCleanupEntry,
} from "./account-devices-state"
import "./account-devices.css"
import "./handoff.css"

export function OrganizationAccountDevices() {
  const { _ } = useLingui()
  const space = useSpace()
  const dialog = useDialog()
  const owner = space.current()!
  const connection = space.connection()!
  const api = space.client()!
  const identity = {
    orgID: connection.orgID,
    deploymentIncarnation: connection.deploymentIncarnation,
    accountID: connection.account.accountID,
  }
  const authRevision = connection.account.authRevision
  const controller = new AbortController()
  const signal = AbortSignal.any([owner.signal, controller.signal])
  const options = { throwOnError: true, signal } as const
  const [state, setState] = createStore<{
    devices: Runtime.MemberRegistrationRecord[]
    entries: OrganizationDeviceCleanupEntry[]
    selected?: Runtime.MemberRegistrationRecord
  }>({ devices: [], entries: [] })
  const [cursor, setCursor] = createSignal<string>()
  const [pageCursor, setPageCursor] = createSignal<string>()
  const [moveCursor, setMoveCursor] = createSignal<string>()
  const [movePageCursor, setMovePageCursor] = createSignal<string>()
  const [loading, setLoading] = createSignal(false)
  const [finding, setFinding] = createSignal(false)
  const [error, setError] = createSignal<unknown>()
  const [moveError, setMoveError] = createSignal<unknown>()
  let listVersion = 0
  let moveVersion = 0
  let moves = new AbortController()
  let dialogID: string | undefined
  const current = () =>
    !signal.aborted &&
    space.current() === owner &&
    space.connection()?.state === "ready" &&
    space.connection()?.orgID === identity.orgID &&
    space.connection()?.deploymentIncarnation === identity.deploymentIncarnation &&
    space.connection()?.account.accountID === identity.accountID &&
    space.connection()?.account.authRevision === authRevision &&
    space.connection()?.account.state === "active"
  function close() {
    if (dialogID) dialog.close(dialogID)
    dialogID = undefined
  }
  function retireMoves() {
    moveVersion++
    moves.abort()
    moves = new AbortController()
    close()
    setState("selected", undefined)
    setState("entries", reconcile([]))
    setMoveCursor(undefined)
    setMovePageCursor(undefined)
    setMoveError(undefined)
    setFinding(false)
  }
  function failed(value: unknown) {
    if (!current()) return
    if (organizationOwnerFailure(value) === "authentication") {
      close()
      space.authorizationRequired(owner)
    }
  }
  const deviceCurrent = (runtime: Runtime.MemberRegistrationRecord) => {
    const record = state.devices.find((item) => item.runtimeID === runtime.runtimeID)
    return (
      current() &&
      runtime.accountID === identity.accountID &&
      runtime.orgID === identity.orgID &&
      runtime.deploymentIncarnation === identity.deploymentIncarnation &&
      runtime.state === "active" &&
      record?.state === "active" &&
      record.publicKey === runtime.publicKey
    )
  }
  async function load(at?: string) {
    if (!current() || loading()) return
    const version = ++listVersion
    retireMoves()
    setLoading(true)
    setError(undefined)
    try {
      const response = await api.orgRuntime.list({ limit: 50, cursor: at }, options)
      if (!current() || version !== listVersion) return
      const page = organizationOwnDevices(identity, response.data)
      setState("devices", reconcile(page.items))
      setCursor(page.cursor)
      setPageCursor(at)
    } catch (value) {
      if (current() && version === listVersion) {
        setError(value)
        failed(value)
      }
    } finally {
      if (current() && version === listVersion) setLoading(false)
    }
  }
  async function find(runtime: Runtime.MemberRegistrationRecord, at?: string) {
    if (!deviceCurrent(runtime) || loading() || finding()) return
    retireMoves()
    setState("selected", reconcile(runtime))
    const version = ++moveVersion
    const requestSignal = AbortSignal.any([signal, moves.signal])
    setFinding(true)
    try {
      const response = await api.orgHandoff.cleanups(
        { runtimeID: runtime.runtimeID, limit: 50, cursor: at },
        { throwOnError: true, signal: requestSignal },
      )
      if (!deviceCurrent(runtime) || version !== moveVersion) return
      const page = organizationDeviceCleanupPage(identity, runtime, response.data)
      setState("entries", reconcile(page.items))
      setMoveCursor(page.cursor)
      setMovePageCursor(at)
    } catch (value) {
      if (current() && version === moveVersion) {
        setMoveError(value)
        failed(value)
      }
    } finally {
      if (current() && version === moveVersion) setFinding(false)
    }
  }
  function inspect(entry: OrganizationDeviceCleanupEntry, trigger: HTMLButtonElement) {
    const runtime = entry.handle.runtime
    if (!deviceCurrent(runtime) || finding() || loading() || state.selected?.runtimeID !== runtime.runtimeID) return
    const version = moveVersion
    const active = () =>
      deviceCurrent(runtime) && version === moveVersion && state.selected?.runtimeID === runtime.runtimeID
    close()
    const context = new AbortController()
    const requestSignal = AbortSignal.any([signal, moves.signal, context.signal])
    let initial: HTMLButtonElement | undefined
    trigger.focus({ preventScroll: true })
    dialogID = dialog.push(
      () => (
        <Dialog
          title={_(native.cleanup)}
          size="form"
          initialFocus={() => initial}
          footer={
            <Button ref={initial} variant="ghost" onClick={close}>
              {_(handoff.close)}
            </Button>
          }
        >
          <div class="organization-handoff">
            <OrganizationNativeCleanup
              handle={entry.handle}
              heading={false}
              disabled={!active()}
              current={active}
              read={async (requestID) => {
                if (!active()) throw new DOMException("The cleanup owner was retired", "AbortError")
                const response = await api.orgHandoff.drive(
                  {
                    handoffID: entry.descriptor.handoffID,
                    orgHandoffDrive: { operation: "inspect-target", requestID },
                  },
                  { throwOnError: true, signal: requestSignal },
                )
                if (!active()) throw new DOMException("The cleanup owner was retired", "AbortError")
                return response.data
              }}
              failed={(value) => {
                if (active()) {
                  setMoveError(value)
                  failed(value)
                }
              }}
            />
          </div>
        </Dialog>
      ),
      () => {
        context.abort()
        dialogID = undefined
      },
    )
  }
  createEffect(() => {
    if (!current()) close()
  })
  onCleanup(() => {
    listVersion++
    moveVersion++
    controller.abort()
    moves.abort()
    close()
  })
  onMount(() => void load())
  return (
    <section class="organization-devices">
      <p>{_(messages.hint)}</p>
      <Show when={current()} fallback={<WorkspaceError error={{ code: "PERMISSION_DENIED" }} />}>
        <WorkspaceError error={error()} retry={!loading() ? () => void load(pageCursor()) : undefined} />
        <Show when={loading()}>
          <p role="status">{_(common.loading)}</p>
        </Show>
        <Show when={!loading() && !error() && !state.devices.length}>
          <p>{_(messages.empty)}</p>
        </Show>
        <ul class="organization-device-list">
          <For each={state.devices}>
            {(runtime) => (
              <li>
                <div>
                  <strong>{runtime.deviceID}</strong>
                  <span>{_(messages[runtime.state])}</span>
                  <Show when={runtime.state === "revoked"}>
                    <p>{_(messages.recovery)}</p>
                  </Show>
                </div>
                <Show when={runtime.state === "active"}>
                  <Button variant="ghost" disabled={loading() || finding()} onClick={() => void find(runtime)}>
                    {_(messages.find)}
                  </Button>
                </Show>
              </li>
            )}
          </For>
        </ul>
        <div class="organization-device-controls">
          <Show when={pageCursor()}>
            <Button variant="ghost" disabled={loading()} onClick={() => void load()}>
              {_(messages.first)}
            </Button>
          </Show>
          <Show when={cursor()}>
            <Button variant="ghost" disabled={loading()} onClick={() => void load(cursor())}>
              {_(messages.next)}
            </Button>
          </Show>
          <Button variant="ghost" disabled={loading()} onClick={() => void load()}>
            {_(messages.refresh)}
          </Button>
        </div>
        <Show when={state.selected}>
          {(runtime) => (
            <section class="organization-device-moves" aria-label={_(messages.moves)}>
              <h3>{_(messages.moves)}</h3>
              <p>{runtime().deviceID}</p>
              <WorkspaceError
                error={moveError()}
                retry={!finding() ? () => void find(runtime(), movePageCursor()) : undefined}
              />
              <Show when={finding()}>
                <p role="status">{_(common.loading)}</p>
              </Show>
              <Show when={!finding() && !moveError() && !state.entries.length}>
                <p>{_(messages.noMoves)}</p>
              </Show>
              <ul class="organization-device-list">
                <For each={state.entries}>
                  {(entry) => (
                    <li>
                      <div>
                        <strong>
                          {_({ ...messages.move, values: { reference: entry.descriptor.handoffID.slice(0, 12) } })}
                        </strong>
                        <details>
                          <summary>{_(messages.details)}</summary>
                          <dl>
                            <dt>{_(messages.handoff)}</dt>
                            <dd>{entry.descriptor.handoffID}</dd>
                            <dt>{_(messages.session)}</dt>
                            <dd>{entry.descriptor.sessionID}</dd>
                          </dl>
                        </details>
                      </div>
                      <Button
                        variant="ghost"
                        disabled={finding() || loading()}
                        onClick={(event: MouseEvent & { currentTarget: HTMLButtonElement }) =>
                          inspect(entry, event.currentTarget)
                        }
                      >
                        {_(messages.inspect)}
                      </Button>
                    </li>
                  )}
                </For>
              </ul>
              <div class="organization-device-controls">
                <Show when={movePageCursor()}>
                  <Button variant="ghost" disabled={finding()} onClick={() => void find(runtime())}>
                    {_(messages.firstMoves)}
                  </Button>
                </Show>
                <Show when={moveCursor()}>
                  <Button variant="ghost" disabled={finding()} onClick={() => void find(runtime(), moveCursor())}>
                    {_(messages.nextMoves)}
                  </Button>
                </Show>
              </div>
            </section>
          )}
        </Show>
      </Show>
    </section>
  )
}
