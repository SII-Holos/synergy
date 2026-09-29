import type { SessionWorkspaceTransitionRequest } from "./worktree-session"
import { createEffect, createMemo, createSignal, onCleanup, Show, type JSX } from "solid-js"
import { useParams } from "@solidjs/router"
import { useLingui } from "@lingui/solid"
import type { EnvironmentInfo, ResourceProfiles, SessionWorkspaceSelection } from "@ericsanchezok/synergy-sdk/client"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { getSemanticIcon } from "@ericsanchezok/synergy-ui/semantic-icon"
import { useDialog } from "@ericsanchezok/synergy-ui/context/dialog"
import { Tooltip } from "@ericsanchezok/synergy-ui/tooltip"
import { useSDK } from "@/context/sdk"
import { useSync } from "@/context/sync"
import { useLayout } from "@/context/layout"
import { usePlatform } from "@/context/platform"
import { normalizeServerUrl, serverDisplayName } from "@/context/server"
import { getScopeLabel, resolveProjectScope } from "@/utils/scope"
import { getFilename } from "@ericsanchezok/synergy-util/path"
import { workspaceLocation } from "../top-bar/workspace-location"
import type { PromptStartOptionGroup } from "../prompt-input/start-options"
import { DialogWorkingLocation } from "../dialog/dialog-working-location"
import { locationCopy as copy } from "../dialog/task-location-copy"
import { ProjectTaskButton } from "./project-task-button"
import { resolveTaskEnvironment } from "./task-location"

export function SessionWorkContext(props: {
  onWorkspaceTransition?: (request: SessionWorkspaceTransitionRequest) => void
  running?: boolean
  environmentID?: string | null
  environmentProfile?: string | null
  workspaceSelection?: SessionWorkspaceSelection
  onEnvironmentChange?: (id: string | null | undefined) => void
  onEnvironmentProfileChange?: (profile: string | null | undefined) => void
  startOptions: PromptStartOptionGroup[]
  children?: JSX.Element
  disabled: boolean
  uploading?: boolean
}) {
  const { _ } = useLingui()
  const sdk = useSDK()
  const sync = useSync()
  const layout = useLayout()
  const platform = usePlatform()
  const dialog = useDialog()
  const params = useParams()
  const session = createMemo(() => (params.id ? sync.session.get(params.id) : undefined))
  const project = createMemo(() =>
    getScopeLabel(resolveProjectScope(sdk.scopeKey, sync.scope, layout.scopes.list()), sdk.scopeKey),
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
  const intent = () => resolveTaskEnvironment({ id: props.environmentID, profile: props.environmentProfile })
  const environmentID = () => (params.id ? (session()?.environmentID ?? null) : intent().environmentID)
  const [environment, setEnvironment] = createSignal<EnvironmentInfo>()
  const [profiles, setProfiles] = createSignal<ResourceProfiles>()
  const [managed, setManaged] = createSignal(false)
  const [failed, setFailed] = createSignal(false)
  createEffect(() => {
    const id = environmentID()
    const client = sdk.client
    const scopeID = sdk.scopeID
    const url = sdk.url
    setEnvironment(undefined)
    setProfiles(undefined)
    setFailed(false)
    setManaged(false)
    if (!sdk.connected()) return
    const controller = new AbortController()
    onCleanup(() => controller.abort())
    const options = { signal: controller.signal, throwOnError: true as const }
    void client.environment
      .profiles({ scopeID }, options)
      .then((result) => {
        if (!controller.signal.aborted) setProfiles(result.data)
      })
      .catch(() => {
        if (!controller.signal.aborted) setFailed(true)
      })
    if (id)
      void client.environment
        .get({ scopeID, environmentID: id }, options)
        .then((result) => {
          if (!controller.signal.aborted)
            setEnvironment((previous) =>
              previous && previous.updatedAt > result.data.updatedAt ? previous : result.data,
            )
        })
        .catch(() => {
          if (!controller.signal.aborted) setFailed(true)
        })
    void platform.desktopServer
      ?.status()
      .then((status) => {
        if (!controller.signal.aborted)
          setManaged(
            status?.mode === "managed" &&
              status.state === "running" &&
              normalizeServerUrl(status.url ?? "") === normalizeServerUrl(url),
          )
      })
      .catch(() => {})
  })
  onCleanup(
    sdk.event.on("environment.updated", (event) => {
      if (event.properties.scopeID === sdk.scopeID && event.properties.id === environmentID())
        setEnvironment((previous) =>
          previous && previous.updatedAt > event.properties.updatedAt ? previous : event.properties,
        )
    }),
  )
  const selectedProfile = () => intent().environmentProfile ?? profiles()?.defaultEnvironment
  const profile = () => profiles()?.environments.find((item) => item.name === selectedProfile())
  const incompatible = () =>
    (!!location().path || !!location().isolated) &&
    !!(environment()?.provider ?? profile()?.provider) &&
    (environment()?.provider ?? profile()?.provider) !== "native"
  const unavailable = () =>
    incompatible() ||
    failed() ||
    location().state === "unavailable" ||
    environment()?.state === "unavailable" ||
    (!params.id && environmentID() === undefined && !!selectedProfile() && !!profiles() && !profile())
  const executionLabel = () => {
    if (unavailable()) return _(copy.unavailable)
    if (environmentID() === null || (!params.id && environmentID() === undefined && profiles() && !selectedProfile()))
      return _(copy.none)
    const provider = environment()?.provider ?? profile()?.provider
    if (provider === "native")
      return managed()
        ? _(platform.desktopWindow?.chrome === "native" ? copy.mac : copy.computer)
        : serverDisplayName(sdk.url)
    return (
      profiles()?.bindings?.[environmentID() ?? ""]?.join(" / ") ||
      environment()?.provider ||
      profile()?.name ||
      _(copy.loading)
    )
  }
  const filesLabel = () => {
    const current = location()
    if (current.state === "unavailable") return _(copy.unavailable)
    if (current.state === "none") return _(copy.noFiles)
    if (!params.id && props.workspaceSelection?.mode === "create" && props.workspaceSelection.name)
      return `${_(copy.planned)}: ${props.workspaceSelection.name}`
    if (current.isolated) return current.path ? `${_(copy.copy)}: ${getFilename(current.path)}` : _(copy.planned)
    if (current.stored) return current.name ?? _(copy.chooseFiles)
    return current.path && current.path !== sync.data.path.workspace?.path ? getFilename(current.path) : _(copy.files)
  }
  const summary = () => `${filesLabel()} · ${executionLabel()}`
  const open = () =>
    dialog.show(() => (
      <DialogWorkingLocation
        sessionID={params.id}
        onWorkspaceTransition={props.onWorkspaceTransition}
        running={props.running}
        summary={summary()}
        nativeFiles={!!location().path || !!location().isolated}
        profile={props.environmentProfile}
        onProfileChange={props.onEnvironmentProfileChange}
        onEnvironmentChange={props.onEnvironmentChange}
        selection={props.workspaceSelection}
        groups={props.startOptions}
      />
    ))
  const showSummary = () =>
    !sdk.isHome ||
    !!params.id ||
    (props.workspaceSelection?.mode !== undefined && props.workspaceSelection.mode !== "current") ||
    props.environmentProfile !== undefined ||
    props.environmentID !== undefined ||
    unavailable()
  return (
    <div class="session-work-context" role="group" aria-label={_(copy.title)}>
      <ProjectTaskButton label={project()} disabled={props.disabled} uploading={props.uploading} />
      <Show when={showSummary()}>
        <Tooltip value={summary()} placement="top">
          <button
            type="button"
            class="session-work-context-button session-work-context-summary"
            data-unavailable={unavailable()}
            disabled={props.disabled}
            onClick={open}
            aria-label={_(copy.title)}
          >
            <span>{summary()}</span>
          </button>
        </Tooltip>
      </Show>
      <Tooltip value={_(copy.title)} placement="top">
        <button
          type="button"
          class="session-work-context-button session-work-context-more"
          disabled={props.disabled}
          aria-label={_(copy.title)}
          onClick={open}
        >
          <Icon name={getSemanticIcon("action.more")} size="small" />
        </button>
      </Tooltip>
      {props.children}
    </div>
  )
}
