import { createEffect, createMemo, createSignal, onCleanup, Show, type JSX } from "solid-js"
import { useParams } from "@solidjs/router"
import { useLingui } from "@lingui/solid"
import type { EnvironmentInfo, SessionWorkspaceSelection } from "@ericsanchezok/synergy-sdk/client"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { getSemanticIcon } from "@ericsanchezok/synergy-ui/semantic-icon"
import { useDialog } from "@ericsanchezok/synergy-ui/context/dialog"
import { Tooltip } from "@ericsanchezok/synergy-ui/tooltip"
import { useSDK } from "@/context/sdk"
import { useSync } from "@/context/sync"
import { useLayout } from "@/context/layout"
import { useCommand } from "@/context/command"
import { getScopeLabel, resolveProjectScope } from "@/utils/scope"
import { getFilename } from "@ericsanchezok/synergy-util/path"
import { DialogEnvironment } from "../dialog/dialog-environment"
import { DialogWorkspace } from "../dialog/dialog-workspace"
import { environmentCopy } from "../dialog/environment-dialog-copy"
import { workspaceCopy } from "../dialog/workspace-dialog-copy"
import { WorkspaceLocationButton } from "../top-bar/workspace-location-button"
import { workspaceLocation } from "../top-bar/workspace-location"
import { PromptStartModeSelector, type PromptStartOptionGroup } from "../prompt-input/start-options"

export function SessionWorkContext(props: {
  environmentID?: string | null
  workspaceSelection?: SessionWorkspaceSelection
  onEnvironmentChange?: (id: string | null | undefined) => void
  startOptions: PromptStartOptionGroup[]
  children?: JSX.Element
  disabled: boolean
}) {
  const { _ } = useLingui()
  const sdk = useSDK()
  const sync = useSync()
  const layout = useLayout()
  const command = useCommand()
  const dialog = useDialog()
  const params = useParams()
  const session = createMemo(() => (params.id ? sync.session.get(params.id) : undefined))
  const project = createMemo(() =>
    sdk.isHome
      ? _({ id: "workspace.location.home", message: "Home" })
      : getScopeLabel(resolveProjectScope(sdk.scopeKey, sync.scope, layout.scopes.list()), sdk.scopeKey),
  )
  const location = createMemo(() =>
    params.id && !session()
      ? { state: "unavailable" as const }
      : workspaceLocation({
          session: session(),
          selection: props.workspaceSelection,
          current: sync.data.path.workspace,
          records: sync.data.workspaces,
        }),
  )
  const environmentID = () => (params.id ? (session()?.environmentID ?? null) : props.environmentID)
  const [environment, setEnvironment] = createSignal<EnvironmentInfo>()
  const [failed, setFailed] = createSignal(false)
  createEffect(() => {
    const id = environmentID()
    const connected = sdk.connected()
    setEnvironment(undefined)
    setFailed(false)
    if (!id || !connected) return
    const controller = new AbortController()
    onCleanup(() => controller.abort())
    void sdk.client.environment
      .get({ scopeID: sdk.scopeID, environmentID: id }, { signal: controller.signal, throwOnError: true })
      .then((result) => {
        if (!controller.signal.aborted)
          setEnvironment((previous) =>
            previous && previous.updatedAt > result.data.updatedAt ? previous : result.data,
          )
      })
      .catch(() => {
        if (!controller.signal.aborted) setFailed(true)
      })
  })
  onCleanup(
    sdk.event.on("environment.updated", (event) => {
      if (event.properties.scopeID === sdk.scopeID && event.properties.id === environmentID()) {
        setEnvironment((previous) =>
          previous && previous.updatedAt > event.properties.updatedAt ? previous : event.properties,
        )
        setFailed(false)
      }
    }),
  )
  const environmentLabel = () =>
    environmentID() === undefined
      ? _(environmentCopy.default)
      : environmentID() === null
        ? _(environmentCopy.none)
        : failed()
          ? _({ id: "session.workContext.environmentUnavailable", message: "Environment unavailable" })
          : (environment()?.provider ?? _(environmentCopy.loading))
  const workspaceLabel = () =>
    location().state === "planned"
      ? _({ id: "workspace.location.planned", message: "Worktree pending" })
      : location().state === "none"
        ? _(workspaceCopy.none)
        : location().state === "unavailable"
          ? _(workspaceCopy.unavailable)
          : location().name || (location().path ? getFilename(location().path!) : _(workspaceCopy.directory))

  return (
    <div
      class="session-work-context"
      role="group"
      aria-label={_({ id: "session.workContext.label", message: "Working location" })}
    >
      <Tooltip value={project()} placement="top">
        <button type="button" class="session-work-context-button" onClick={() => command.trigger("project.open")}>
          <Icon name={getSemanticIcon("workspace.main")} size="small" />
          <span>{project()}</span>
        </button>
      </Tooltip>
      <Tooltip value={_(environmentCopy.description)} placement="top">
        <button
          type="button"
          class="session-work-context-button"
          disabled={props.disabled}
          aria-label={_(environmentCopy.title)}
          onClick={() =>
            dialog.show(() => (
              <DialogEnvironment
                sessionID={params.id}
                selection={params.id ? undefined : props.environmentID}
                onSelect={params.id ? undefined : props.onEnvironmentChange}
              />
            ))
          }
        >
          <Icon name={getSemanticIcon("providers.main")} size="small" />
          <span>{environmentLabel()}</span>
          <Icon name={getSemanticIcon("navigation.collapse")} size="small" />
        </button>
      </Tooltip>
      <Show
        when={!params.id}
        fallback={
          <WorkspaceLocationButton
            context
            project={project()}
            location={location()}
            disabled={props.disabled || !session()}
            onChoose={() => dialog.show(() => <DialogWorkspace sessionID={params.id} />)}
          />
        }
      >
        <PromptStartModeSelector groups={props.startOptions} label={workspaceLabel()} disabled={props.disabled} />
      </Show>
      {props.children}
    </div>
  )
}
