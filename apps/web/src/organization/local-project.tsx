import { createSignal, onCleanup, onMount, Show } from "solid-js"
import { useLingui } from "@lingui/solid"
import { Button } from "@ericsanchezok/synergy-ui/button"
import {
  OrganizationDesktop as Desktop,
  type OrganizationLocalProjectProtocol as LocalProject,
} from "@ericsanchezok/synergy-organization-protocol"
import { generateSecureUUID } from "@ericsanchezok/synergy-util/uuid"
import { useSpace } from "@/context/space"
import { usePlatform } from "@/context/platform"
import { DesktopOrganizationClientError } from "./desktop"
import { WorkspaceError } from "./workspace-error"

const messages = {
  title: { id: "organization.projectBinding.title", message: "Project folder on this computer" },
  hint: {
    id: "organization.projectBinding.hint",
    message: "New conversations use this folder. Existing conversations keep their workspace.",
  },
  choose: { id: "organization.projectBinding.choose", message: "Choose project folder" },
  start: { id: "organization.projectBinding.start", message: "Start this computer and choose folder" },
  empty: { id: "organization.projectBinding.empty", message: "No project folder selected." },
  stopped: {
    id: "organization.projectBinding.stopped",
    message: "Start this organization's runtime to choose a local folder.",
  },
  refresh: { id: "organization.projectBinding.refresh", message: "Refresh folder binding" },
  loading: { id: "organization.projectBinding.loading", message: "Checking project folder…" },
}

export function OrganizationLocalProject(props: {
  projectID: string
  changed?: (summary: LocalProject.Summary) => void
}) {
  const { _ } = useLingui()
  const space = useSpace()
  const bridge = usePlatform().organization!
  const connection = space.connection()!
  if (connection.transport !== "desktop") throw new DesktopOrganizationClientError("unavailable")
  const connectionID = connection.id
  const view = space.current()!
  const controller = new AbortController()
  const signal = AbortSignal.any([space.current()!.signal, controller.signal])
  onCleanup(() => controller.abort())
  const [summary, setSummary] = createSignal<LocalProject.Summary>()
  const [running, setRunning] = createSignal(false)
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal<unknown>()
  async function native<T>(run: (requestID: string) => Promise<Desktop.Result<T>>) {
    const requestID = generateSecureUUID()
    const abort = () => {
      void bridge.cancel({ requestID }).catch(() => {})
    }
    signal.addEventListener("abort", abort, { once: true })
    try {
      if (signal.aborted) throw new DesktopOrganizationClientError("cancelled")
      const result = await run(requestID)
      if (signal.aborted) throw new DesktopOrganizationClientError("cancelled")
      if (!result.ok) {
        if (result.error.code === "reauthorization_required" || result.error.code === "signed_out")
          space.authorizationRequired(view)
        throw new DesktopOrganizationClientError(result.error.code)
      }
      return result.value
    } finally {
      signal.removeEventListener("abort", abort)
    }
  }
  function receive(value: unknown) {
    const result = Desktop.ProjectBindingOutcome.parse(value)
    const valueSummary = result.kind === "ready" ? result.summary : result.current
    if (valueSummary.projectID !== props.projectID) throw new DesktopOrganizationClientError("identity_changed")
    setSummary(valueSummary)
    props.changed?.(valueSummary)
    if (result.kind === "revision_conflict") setError({ code: "REVISION_CONFLICT" })
    return valueSummary
  }
  async function inspect() {
    const status = await bridge.memberStatus({ connectionID })
    if (signal.aborted) return
    if (!status.ok) {
      if (status.error.code === "reauthorization_required" || status.error.code === "signed_out")
        space.authorizationRequired(view)
      throw new DesktopOrganizationClientError(status.error.code)
    }
    setRunning(status.value.state === "running")
    if (status.value.state !== "running") return
    return receive(
      await native((requestID) => bridge.projectBinding({ requestID, connectionID, projectID: props.projectID })),
    )
  }
  async function load() {
    if (busy()) return
    setBusy(true)
    setError(undefined)
    try {
      await inspect()
    } catch (error) {
      if (!signal.aborted) setError(error)
    } finally {
      if (!signal.aborted) setBusy(false)
    }
  }
  async function choose() {
    if (busy()) return
    setBusy(true)
    setError(undefined)
    try {
      if (!running()) await native((requestID) => bridge.startMember({ requestID, connectionID }))
      const current = await inspect()
      if (!current || signal.aborted) return
      receive(
        await native((requestID) =>
          bridge.bindProject({
            requestID,
            connectionID,
            projectID: props.projectID,
            expectedRevision: current.revision,
          }),
        ),
      )
    } catch (error) {
      if (!signal.aborted && !(error instanceof DesktopOrganizationClientError && error.code === "cancelled"))
        setError(error)
    } finally {
      if (!signal.aborted) setBusy(false)
    }
  }
  onMount(() => void load())
  return (
    <section class="organization-editor">
      <h3>{_(messages.title)}</h3>
      <p>{_(messages.hint)}</p>
      <WorkspaceError error={error()} retry={() => void load()} />
      <Show when={busy()}>
        <p role="status">{_(messages.loading)}</p>
      </Show>
      <Show when={!busy()}>
        <Show when={running()} fallback={<p>{_(messages.stopped)}</p>}>
          <strong>{summary()?.binding?.label ?? _(messages.empty)}</strong>
        </Show>
      </Show>
      <div class="organization-actions">
        <Button type="button" disabled={busy()} onClick={() => void choose()}>
          {_(running() ? messages.choose : messages.start)}
        </Button>
        <Button type="button" variant="ghost" disabled={busy()} onClick={() => void load()}>
          {_(messages.refresh)}
        </Button>
      </div>
    </section>
  )
}
