import { createSignal, onCleanup, onMount, Show } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import { useLingui } from "@lingui/solid"
import type { OrgRuntimeRegistration, OrgCommandView } from "@ericsanchezok/synergy-sdk/organization"
import { Button } from "@ericsanchezok/synergy-ui/button"
import { TextField } from "@ericsanchezok/synergy-ui/text-field"
import { MenuField } from "@ericsanchezok/synergy-ui/menu-field"
import { generateSecureUUID } from "@ericsanchezok/synergy-util/uuid"
import { useSpace } from "@/context/space"
import { usePlatform } from "@/context/platform"
import { WorkspaceError } from "./workspace-error"
import { organizationSessionMessages as messages } from "./session-messages"
import { organizationWorkspaceMessages as common } from "./workspace-messages"
import { createOrganizationCommandState, type OrganizationPendingCommand } from "./command-state"
import { OrganizationLocalProject } from "./local-project"
import { organizationCommandAccepted, OrganizationCommandReceiptError } from "./command-receipt"

export function OrganizationSessionCreate(props: { projectID: string; cancel: () => void }) {
  const { _ } = useLingui()
  const space = useSpace()
  const api = space.client()!
  const view = space.current()!
  const platform = usePlatform()
  const controller = new AbortController()
  const signal = AbortSignal.any([view.signal, controller.signal])
  onCleanup(() => controller.abort())
  const options = { throwOnError: true, signal } as const
  const command = createOrganizationCommandState(localStorage, view.key, `project:${props.projectID}:create`)
  const [state, setState] = createStore({ runtimes: [] as OrgRuntimeRegistration[] })
  const [runtime, setRuntime] = createSignal(platform.organization ? "local" : "")
  const [cursor, setCursor] = createSignal<string>()
  const [title, setTitle] = createSignal("")
  const [busy, setBusy] = createSignal(false)
  const [loading, setLoading] = createSignal(false)
  const [pending, setPending] = createSignal<OrganizationPendingCommand>()
  const [receipt, setReceipt] = createSignal<OrgCommandView>()
  const [canRetry, setCanRetry] = createSignal(false)
  const [error, setError] = createSignal<unknown>()
  const [blocked, setBlocked] = createSignal(false)
  const [needsBinding, setNeedsBinding] = createSignal(false)
  try {
    const saved = command.pending()
    setPending(saved)
    if (saved && "creation" in saved) {
      setTitle(saved.creation.title ?? "")
      setRuntime(saved.runtimeID)
    }
  } catch (error) {
    setError(error)
    setBlocked(true)
  }
  async function load(more = false) {
    if (loading()) return
    setLoading(true)
    try {
      const result = await api.orgRuntime.list({ limit: 50, cursor: more ? cursor() : undefined }, options)
      if (!signal.aborted) {
        setState("runtimes", reconcile(more ? [...state.runtimes, ...result.data.items] : result.data.items))
        setCursor(result.data.cursor)
      }
    } catch (error) {
      if (!signal.aborted) setError(error)
    } finally {
      if (!signal.aborted) setLoading(false)
    }
  }
  function accept(result: OrgCommandView) {
    const request = pending()
    if (!request || result.requestID !== request.requestID) throw new OrganizationCommandReceiptError()
    setReceipt(result)
    setCanRetry(result.state === "not_dispatched")
    const accepted = result.accepted ?? result.result?.accepted
    if (accepted?.effect.kind === "session") {
      organizationCommandAccepted(request, accepted, space.connection()!.account.accountID)
      command.clear(result.requestID)
      setPending(undefined)
      space.page("sessions", props.projectID, accepted.effect.sessionID)
      return
    }
    if (result.state === "rejected") {
      command.clear(result.requestID)
      setPending(undefined)
    }
  }
  async function check() {
    const request = pending()
    if (!request || busy()) return
    setBusy(true)
    setError(undefined)
    try {
      const result = await api.orgCommands.lookup({ requestID: request.requestID }, options)
      if (!signal.aborted) accept(result.data)
    } catch (error) {
      if (!signal.aborted) setError(error)
    } finally {
      if (!signal.aborted) setBusy(false)
    }
  }
  async function create() {
    if (busy() || blocked()) return
    const retained = pending()
    if (retained && !canRetry()) return
    setBusy(true)
    setError(undefined)
    try {
      let runtimeID = runtime()
      let startedLocal = false
      if (!retained && runtimeID === "local") {
        const connection = space.connection()!
        if (!platform.organization || connection.transport !== "desktop")
          throw new Error("Desktop organization runtime is unavailable")
        const requestID = generateSecureUUID()
        const cancel = () => void platform.organization!.cancel({ requestID }).catch(() => {})
        signal.addEventListener("abort", cancel, { once: true })
        try {
          const started = await platform.organization.startMember({ connectionID: connection.id, requestID })
          if (!started.ok) {
            if (started.error.code === "reauthorization_required" || started.error.code === "signed_out")
              space.authorizationRequired(view)
            throw started.error
          }
          if (started.value.state !== "running" || !started.value.runtimeID)
            throw new Error("Member runtime is not running")
          runtimeID = started.value.runtimeID
          startedLocal = true
          const bindingID = generateSecureUUID()
          const cancelBinding = () => {
            void platform.organization!.cancel({ requestID: bindingID }).catch(() => {})
          }
          signal.addEventListener("abort", cancelBinding, { once: true })
          const project = await platform.organization
            .projectBinding({ connectionID: connection.id, requestID: bindingID, projectID: props.projectID })
            .finally(() => signal.removeEventListener("abort", cancelBinding))
          signal.throwIfAborted()
          if (!project.ok) {
            if (project.error.code === "reauthorization_required" || project.error.code === "signed_out")
              space.authorizationRequired(view)
            throw project.error
          }
          const summary = project.value.kind === "ready" ? project.value.summary : project.value.current
          if (!summary.binding) {
            setNeedsBinding(true)
            return
          }
          setNeedsBinding(false)
        } finally {
          signal.removeEventListener("abort", cancel)
        }
      }
      signal.throwIfAborted()
      if (!retained) {
        let connection = await api.orgRuntime.connection({ runtimeID }, options)
        const deadline = Date.now() + 5000
        while (startedLocal && connection.data.state !== "online" && Date.now() < deadline) {
          await new Promise<void>((resolve, reject) => {
            const done = () => {
              signal.removeEventListener("abort", abort)
              resolve()
            }
            const timeout = setTimeout(done, 250)
            const abort = () => {
              clearTimeout(timeout)
              reject(signal.reason)
            }
            signal.addEventListener("abort", abort, { once: true })
            if (signal.aborted) abort()
          })
          connection = await api.orgRuntime.connection({ runtimeID }, options)
        }
        if (connection.data.state !== "online") throw { code: "RUNTIME_OFFLINE" }
      }
      const request =
        retained ??
        command.begin({
          schemaVersion: 1,
          orgID: space.connection()!.orgID,
          requestID: generateSecureUUID(),
          projectID: props.projectID,
          runtimeID,
          creation: { operation: "create", ...(title().trim() ? { title: title().trim() } : {}) },
        })
      if (!("creation" in request)) throw new Error("A different operation is awaiting its receipt")
      setPending(request)
      const result = await api.orgSessions.create({ orgCommandCreateRequest: request }, options)
      if (!signal.aborted) {
        organizationCommandAccepted(request, result.data, space.connection()!.account.accountID)
        command.clear(request.requestID)
        setPending(undefined)
        space.page("sessions", props.projectID, result.data.effect.sessionID)
      }
    } catch (error) {
      if (!signal.aborted) {
        setError(error)
        if (error && typeof error === "object" && "outcome" in error && error.outcome === "not_dispatched")
          setCanRetry(true)
      }
    } finally {
      if (!signal.aborted) setBusy(false)
    }
  }
  onMount(() => void load())
  const runtimeOptions = () => [
    ...(platform.organization ? [{ value: "local", label: _(messages.computer) }] : []),
    ...state.runtimes
      .filter((runtime) => runtime.state === "active")
      .map((runtime) => ({
        value: runtime.runtimeID,
        label:
          runtime.runtimeKind === "hosted"
            ? `${_(messages.hosted)} · ${runtime.name}`
            : `${_(messages.computer)} · ${runtime.deviceID}`,
      })),
  ]
  return (
    <form
      class="organization-editor"
      onSubmit={(event) => {
        event.preventDefault()
        void create()
      }}
    >
      <h3>{_(messages.new)}</h3>
      <WorkspaceError error={error()} />
      <Show when={needsBinding()}>
        <OrganizationLocalProject
          projectID={props.projectID}
          changed={(summary) => {
            if (summary.binding) setNeedsBinding(false)
          }}
        />
      </Show>
      <TextField
        label={_(messages.title)}
        value={title()}
        onChange={setTitle}
        maxLength={512}
        disabled={busy() || !!pending()}
      />
      <MenuField
        ariaLabel={_(messages.execution)}
        value={runtime()}
        onChange={setRuntime}
        options={runtimeOptions()}
        triggerLabel={!runtime() ? _(messages.chooseRuntime) : undefined}
        disabled={busy() || !!pending()}
      />
      <Show when={runtime() === "local"}>
        <p>{_(messages.computerHint)}</p>
      </Show>
      <Show when={cursor()}>
        <Button type="button" disabled={loading()} onClick={() => void load(true)}>
          {_(common.more)}
        </Button>
      </Show>
      <Show when={pending()}>
        <p role="status">{_(messages.pending)}</p>
        <Button type="button" disabled={busy()} onClick={() => void check()}>
          {_(messages.checkStatus)}
        </Button>
      </Show>
      <Show when={receipt()?.state === "rejected"}>
        <p role="alert">{_(messages.rejected)}</p>
      </Show>
      <div class="organization-actions">
        <Button
          size="large"
          type="submit"
          variant="primary"
          disabled={busy() || blocked() || !runtime() || (!!pending() && !canRetry())}
        >
          {_(busy() ? messages.starting : pending() ? common.retry : messages.new)}
        </Button>
        <Button size="large" variant="ghost" type="button" onClick={props.cancel}>
          {_(common.cancel)}
        </Button>
      </div>
    </form>
  )
}
