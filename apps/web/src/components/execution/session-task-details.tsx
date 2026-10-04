import { createMemo, createResource, onCleanup, Show } from "solid-js"
import { useLingui } from "@lingui/solid"
import { useParams } from "@solidjs/router"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { Tooltip } from "@ericsanchezok/synergy-ui/tooltip"
import { createCopyController } from "@ericsanchezok/synergy-ui/clipboard"
import { getSemanticIcon } from "@ericsanchezok/synergy-ui/semantic-icon"
import { useSDK } from "@/context/sdk"
import { useSync } from "@/context/sync"
import { useGlobalSDK } from "@/context/global-sdk"
import { useSessionDataView } from "@/context/session-data-view"
import { workspaceCopy } from "@/components/dialog/workspace-dialog-copy"
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
      inbox={(active, history) => (
        <SessionInbox
          sessionID={props.sessionID}
          sdk={sdk}
          sync={sync}
          active={active()}
          compact={!history()}
          hasCanonicalRoot={props.hasCanonicalRoot}
          freezeHint={props.inboxFrozen}
        />
      )}
      context={(active) => <TaskResources sessionID={props.sessionID} active={active()} />}
      agenda={(active, close) => (
        <Show when={globalSDK.capabilities.has("workflows")}>
          <SessionAgendaWakeIndicator sessionID={props.sessionID} active={active()} onDetailOpened={close} />
        </Show>
      )}
    />
  )
}

function TaskResources(props: { sessionID: string; active: boolean }) {
  const sdk = useSDK()
  const sync = useSync()
  const { _ } = useLingui()
  const session = () => sync.session.get(props.sessionID)
  const location = createMemo(() => workspaceLocation({ session: session(), records: sync.data.workspaces }))
  const name = () => {
    const scope = session()?.scope
    return (
      (scope?.type === "project" ? scope.name || scope.local?.directory.split(/[\\/]/).pop() : undefined) ||
      location().name ||
      _(workspaceCopy.directory)
    )
  }
  const copy = createCopyController({
    text: () => location().path ?? "",
    get copyLabel() {
      return _(E.copyPath)
    },
    get copiedLabel() {
      return _(E.pathCopied)
    },
  })
  let request: AbortController | undefined
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
      request?.abort()
      request = new AbortController()
      const result = await client.worktree.list({ scopeID }, { signal: request.signal, throwOnError: true })
      return { path, scopeID, client, value: result.data.find((entry) => entry.path === path)?.branch }
    },
    { initialValue: undefined },
  )
  onCleanup(() => request?.abort())
  const currentBranch = () => {
    if (branch.error) return
    const result = branch.latest
    return result?.path === location().path && result?.scopeID === session()?.scope.id && result?.client === sdk.client
      ? result.value
      : undefined
  }
  const description = () =>
    [
      _(
        location().state === "unavailable"
          ? workspaceCopy.unavailable
          : location().isolated
            ? E.worktree
            : workspaceCopy.directory,
      ),
      location().path || location().name,
      currentBranch(),
      copy.state() === "copied" ? _(E.pathCopied) : location().path ? _(E.copyPath) : undefined,
    ]
      .filter(Boolean)
      .join("\n")
  return (
    <Tooltip
      value={<span class="execution-path-tooltip">{description()}</span>}
      placement="bottom-start"
      hideWhenDetached
    >
      <button
        type="button"
        class="execution-location-heading"
        aria-label={location().path ? _(E.copyPath) : name()}
        aria-disabled={!location().path}
        data-copy-state={copy.state()}
        onClick={() => location().path && void copy.copy()}
      >
        <Icon name={getSemanticIcon(location().isolated ? "workspace.worktree" : "workspace.main")} size="small" />
        <strong>{name()}</strong>
        <Show when={session()?.workspaceError || location().state === "unavailable"}>
          <Icon name={getSemanticIcon("state.warning")} size="small" />
        </Show>
        <span class="execution-visually-hidden" role="status">
          {copy.state() === "copied" ? _(E.pathCopied) : ""}
        </span>
      </button>
    </Tooltip>
  )
}
