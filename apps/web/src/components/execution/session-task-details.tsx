import { createMemo, createResource, onCleanup, Show } from "solid-js"
import { useLingui } from "@lingui/solid"
import { useParams } from "@solidjs/router"
import { useDialog } from "@ericsanchezok/synergy-ui/context/dialog"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { getSemanticIcon } from "@ericsanchezok/synergy-ui/semantic-icon"
import { useSDK } from "@/context/sdk"
import { useSync } from "@/context/sync"
import { useGlobalSDK } from "@/context/global-sdk"
import { useSessionDataView } from "@/context/session-data-view"
import { useWorkbenchPanels } from "@/context/workbench"
import { DialogWorkspace } from "@/components/dialog/dialog-workspace"
import { DialogEnvironment } from "@/components/dialog/dialog-environment"
import { workspaceCopy } from "@/components/dialog/workspace-dialog-copy"
import { environmentCopy } from "@/components/dialog/environment-dialog-copy"
import { workspaceLocation } from "@/components/top-bar/workspace-location"
import { SessionInbox } from "@/components/session/session-inbox"
import { SessionAgendaWakeIndicator } from "@/components/session/wake-indicator"
import { TaskDetailsPopover } from "./popover"
import { E } from "./i18n"

export function SessionTaskDetails(props: { hasCanonicalRoot?: boolean; inboxFrozen?: boolean }) {
  const params = useParams()
  return (
    <Show when={params.id} keyed>
      {(id) => <Details {...props} sessionID={id} />}
    </Show>
  )
}

function Details(props: { sessionID: string; hasCanonicalRoot?: boolean; inboxFrozen?: boolean }) {
  const sdk = useSDK()
  const sync = useSync()
  const view = useSessionDataView()
  const globalSDK = useGlobalSDK()
  return (
    <TaskDetailsPopover
      inboxCount={view().inboxFor(props.sessionID).length}
      inbox={(active) => (
        <SessionInbox
          sessionID={props.sessionID}
          sdk={sdk}
          sync={sync}
          active={active()}
          hasCanonicalRoot={props.hasCanonicalRoot}
          freezeHint={props.inboxFrozen}
        />
      )}
      context={(active, close) => (
        <>
          <TaskResources sessionID={props.sessionID} active={active()} close={close} />
          <Show when={globalSDK.capabilities.has("workflows")}>
            <SessionAgendaWakeIndicator sessionID={props.sessionID} active={active()} />
          </Show>
        </>
      )}
    />
  )
}

function TaskResources(props: { sessionID: string; active: boolean; close: () => void }) {
  const sdk = useSDK()
  const sync = useSync()
  const view = useSessionDataView()
  const workbench = useWorkbenchPanels()
  const dialog = useDialog()
  const { _ } = useLingui()
  const session = () => sync.session.get(props.sessionID)
  const location = createMemo(() => workspaceLocation({ session: session(), records: sync.data.workspaces }))
  const name = () => {
    const scope = session()?.scope
    return scope?.type === "project" ? scope.name || scope.local?.directory.split(/[\\/]/).pop() : undefined
  }
  const stateLabel = () => {
    const state = location()
    if (state.state === "none") return _(workspaceCopy.none)
    if (state.state === "unavailable") return _(workspaceCopy.unavailable)
    if (state.stored) return _({ id: "workspace.location.stored", message: "Stored Workspace" })
    if (state.isolated) return _({ id: "workspace.location.isolated", message: "Isolated worktree" })
    return _(workspaceCopy.directory)
  }
  let environmentRequest: AbortController | undefined
  let branchRequest: AbortController | undefined
  const [environment, { refetch }] = createResource(
    () => {
      const id = session()?.environmentID
      return props.active && id ? { id, client: sdk.client } : false
    },
    async ({ id, client }) => {
      environmentRequest?.abort()
      environmentRequest = new AbortController()
      const result = await client.environment.get(
        { environmentID: id },
        { signal: environmentRequest.signal, throwOnError: true },
      )
      return { id, client, value: result.data }
    },
  )
  const [branch] = createResource(
    () => {
      const scope = session()?.scope
      const path = location().path
      if (
        !props.active ||
        !path ||
        location().state !== "bound" ||
        scope?.type !== "project" ||
        scope.local?.vcs !== "git"
      )
        return false
      return { path, scopeID: scope.id, client: sdk.client }
    },
    async ({ path, scopeID, client }) => {
      branchRequest?.abort()
      branchRequest = new AbortController()
      const result = await client.worktree.list({ scopeID }, { signal: branchRequest.signal, throwOnError: true })
      return { path, client, value: result.data.find((entry) => entry.path === path)?.branch }
    },
  )
  onCleanup(() => {
    environmentRequest?.abort()
    branchRequest?.abort()
  })
  const currentEnvironment = createMemo(() => {
    if (environment.error) return undefined
    const result = environment()
    return result?.id === session()?.environmentID && result?.client === sdk.client ? result.value : undefined
  })
  const currentBranch = createMemo(() => {
    if (branch.error) return undefined
    const result = branch()
    return result?.path === location().path && result?.client === sdk.client ? result.value : undefined
  })
  const incomplete = createMemo(() =>
    view()
      .messagesFor(props.sessionID)
      .findLast(
        (message) =>
          message.role === "user" &&
          (message.summary?.diffState?.status === "partial" || message.summary?.diffState?.status === "error"),
      ),
  )
  return (
    <>
      <section class="execution-location">
        <div class="execution-location-heading">
          <Icon name={getSemanticIcon(location().isolated ? "workspace.worktree" : "workspace.main")} size="small" />
          <strong>{name() || stateLabel()}</strong>
        </div>
        <Show when={name()}>
          <span class="execution-location-state">{stateLabel()}</span>
        </Show>
        <Show when={location().path || location().name}>
          <span class="execution-location-path">{location().path || location().name}</span>
        </Show>
        <Show when={currentBranch()}>{(value) => <span class="execution-location-branch">{value()}</span>}</Show>
        <Show when={session()?.workspaceError}>
          <p role="status" class="execution-location-state">
            {_(workspaceCopy.unavailable)}
          </p>
        </Show>
        <div class="execution-location-actions">
          <button
            type="button"
            onClick={() => {
              props.close()
              dialog.show(() => <DialogWorkspace sessionID={props.sessionID} mode="manage" />)
            }}
          >
            {_(workspaceCopy.title)}
          </button>
          <button
            type="button"
            onClick={() => {
              props.close()
              dialog.show(() => <DialogEnvironment sessionID={props.sessionID} />)
            }}
          >
            {_(environmentCopy.title)}
          </button>
        </div>
        <span class="execution-location-state">
          {session()?.environmentID ? (
            environment.error ? (
              <button type="button" onClick={() => void refetch()}>
                {_(E.retry)}
              </button>
            ) : currentEnvironment() ? (
              `${currentEnvironment()!.provider} · ${_({ ...environmentCopy.state, values: { state: currentEnvironment()!.state } })}`
            ) : (
              _(environmentCopy.loading)
            )
          ) : (
            _(environmentCopy.none)
          )}
        </span>
        <span class="execution-location-state">{_(sdk.connected() ? E.connected : E.disconnected)}</span>
      </section>
      <Show when={incomplete()}>
        {(message) => (
          <details class="execution-secondary">
            <summary>{_({ id: "execution.changes.incomplete", message: "Change recording incomplete" })}</summary>
            <div class="execution-location">
              <p>
                {_({
                  id: "execution.changes.incompleteDescription",
                  message: "Some file changes could not be recorded. This does not indicate a task failure.",
                })}
              </p>
              <button
                type="button"
                onClick={() => {
                  props.close()
                  void workbench.openPanel("session-review", { reuseExisting: true, init: { source: message().id } })
                }}
              >
                {_({ id: "execution.changes.diagnostics", message: "View recording details" })}
              </button>
            </div>
          </details>
        )}
      </Show>
    </>
  )
}
