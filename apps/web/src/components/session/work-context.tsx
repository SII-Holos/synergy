import type { SessionWorkspaceTransitionRequest } from "./worktree-session"
import { createMemo, createResource, createSignal, For, Show, type JSX } from "solid-js"
import { useParams } from "@solidjs/router"
import { useLingui } from "@lingui/solid"
import type { ProjectDirectories, SessionWorkspaceSelection, Worktree } from "@ericsanchezok/synergy-sdk/client"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { Popover } from "@ericsanchezok/synergy-ui/popover"
import { Tooltip } from "@ericsanchezok/synergy-ui/tooltip"
import { getSemanticIcon } from "@ericsanchezok/synergy-ui/semantic-icon"
import { useDialog } from "@ericsanchezok/synergy-ui/context/dialog"
import { useGlobalSDK } from "@/context/global-sdk"
import { useSDK } from "@/context/sdk"
import { useSync } from "@/context/sync"
import { useLayout } from "@/context/layout"
import { getScopeLabel, resolveProjectScope } from "@/utils/scope"
import { getFilename } from "@ericsanchezok/synergy-util/path"
import { requestErrorMessage } from "@/utils/error"
import type { PromptStartOptionGroup } from "../prompt-input/start-options"
import { ProjectTaskButton } from "./project-task-button"
import { ComputerMenu } from "../dialog/computer-menu"
import { DialogScopeEdit } from "../dialog/dialog-scope-edit"
import { DialogWorktrees } from "../dialog/dialog-worktrees"
import { DialogWorkingLocation } from "../dialog/dialog-working-location"
import { projectEntryCopy as copy } from "../dialog/project-entry-copy"

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
  directories?: ProjectDirectories
  directoryError?: string
  onRefresh?: () => void
  onSelect?: (selection: SessionWorkspaceSelection) => void
}) {
  const { _ } = useLingui()
  const sdk = useSDK()
  const globalSDK = useGlobalSDK()
  const sync = useSync()
  const layout = useLayout()
  const dialog = useDialog()
  const params = useParams()
  const [open, setOpen] = createSignal(false)
  const [pending, setPending] = createSignal(false)
  const [error, setError] = createSignal("")
  const scope = createMemo(() => resolveProjectScope(sdk.scopeKey, sync.scope, layout.scopes.list()))
  const main = createMemo(() =>
    props.directories?.folders.find((folder) => folder.workspaceID === props.directories?.mainWorkspaceID),
  )
  const session = createMemo(() => (params.id ? sync.session.get(params.id) : undefined))
  const [trees] = createResource(
    () =>
      !sdk.isHome && globalSDK.capabilities.has("workbench")
        ? { scopeID: sdk.scopeID, revision: props.directories?.revision, workspaceID: session()?.workspaceID }
        : false,
    async ({ scopeID }) => {
      try {
        setError("")
        return (await sdk.client.project.worktrees({ scopeID }, { throwOnError: true })).data
      } catch (failure) {
        setError(requestErrorMessage(failure, _(copy.unavailable)))
        return []
      }
    },
  )
  const [environment] = createResource(
    () => session()?.environmentID,
    async (environmentID) => (await sdk.client.environment.get({ environmentID }, { throwOnError: true })).data,
  )
  const actual = () => session()?.workspace
  const selectedTree = () =>
    props.workspaceSelection?.mode === "existing" ? props.workspaceSelection.target : undefined
  const mainSelected = () =>
    params.id
      ? session()?.workspaceID === main()?.workspaceID
      : props.workspaceSelection?.mode === "workspace" && props.workspaceSelection.workspaceID === main()?.workspaceID
  const label = () => {
    if (params.id)
      return actual()?.type === "git_worktree"
        ? String(actual()?.branch ?? actual()?.name ?? getFilename(actual()?.path ?? ""))
        : mainSelected()
          ? _(copy.main)
          : actual()?.path
            ? _(copy.originalMain)
            : _(copy.unavailable)
    if (props.workspaceSelection?.mode === "create") return _(copy.newWorktree)
    return (
      trees()?.find((tree) => tree.id === selectedTree() || tree.path === selectedTree())?.branch ??
      (selectedTree() ? getFilename(selectedTree()!) : _(copy.main))
    )
  }
  async function select(selection: SessionWorkspaceSelection) {
    if (pending() || props.running || props.disabled) return false
    setPending(true)
    setError("")
    try {
      if (params.id) {
        await sdk.client.session.selectWorkspace(
          { sessionID: params.id, sessionWorkspaceSelection: selection },
          { throwOnError: true },
        )
        await sync.session.sync(params.id, { trigger: { type: "workspace-transition" } })
      } else props.onSelect?.(selection)
      setOpen(false)
      return true
    } catch (failure) {
      setError(requestErrorMessage(failure, _(copy.unavailable)))
      return false
    } finally {
      setPending(false)
    }
  }
  const useTree = (tree: Worktree) =>
    select({ mode: "existing", target: tree.id, sourceWorkspaceID: tree.sourceWorkspaceID })
  function settings() {
    const project = scope()
    if (project) dialog.show(() => <DialogScopeEdit scope={{ ...project, expanded: true }} onSaved={props.onRefresh} />)
  }
  const custom = () =>
    (!params.id && props.environmentProfile !== undefined && props.environmentProfile !== "native") ||
    (params.id &&
      ((session()?.workspaceID && !actual()?.path) ||
        environment.error ||
        (environment() && environment()?.provider !== "native")))
  const advanced = () =>
    dialog.show(() => (
      <DialogWorkingLocation
        sessionID={params.id}
        onWorkspaceTransition={props.onWorkspaceTransition}
        running={props.running}
        summary={_(copy.unsupported)}
        nativeFiles={!!actual()?.path || !!main()}
        profile={props.environmentProfile}
        onProfileChange={props.onEnvironmentProfileChange}
        onEnvironmentChange={props.onEnvironmentChange}
        selection={props.workspaceSelection}
        groups={props.startOptions}
      />
    ))
  return (
    <div class="session-work-context" role="group" aria-label={_(copy.computer)}>
      <ComputerMenu disabled={props.disabled || props.uploading || pending()} />
      <ProjectTaskButton
        label={getScopeLabel(scope(), sdk.scopeKey)}
        disabled={props.disabled || pending()}
        uploading={props.uploading}
        onSettings={sdk.isHome ? undefined : settings}
      />
      <Show
        when={
          !sdk.isHome &&
          ((trees()?.length ?? 0) > 0 ||
            main()?.git ||
            actual()?.type === "git_worktree" ||
            (params.id && actual()?.path !== main()?.path))
        }
      >
        <Popover
          variant="menu"
          title={_(copy.worktrees)}
          open={open()}
          onOpenChange={setOpen}
          placement="top-start"
          class="project-select-popover"
          triggerAs={(attributes) => (
            <Tooltip value={open() ? "" : (actual()?.path ?? main()?.path ?? "")}>
              <button
                {...attributes}
                class="session-work-context-button"
                disabled={props.disabled || pending()}
                aria-label={label()}
              >
                <Icon name={getSemanticIcon("workspace.worktree")} size="small" />
                <span>{label()}</span>
              </button>
            </Tooltip>
          )}
        >
          <button
            type="button"
            class="project-flow-row"
            disabled={props.running || pending() || !main()?.available}
            aria-pressed={mainSelected()}
            onClick={() =>
              main() &&
              void select({
                mode: "workspace",
                workspaceID: main()!.workspaceID,
                workspaceGeneration: main()!.generation,
              })
            }
          >
            <Icon name={getSemanticIcon("workspace.main")} size="small" />
            <span class="project-flow-row-copy">{_(copy.main)}</span>
            <span class="project-flow-check">
              <Show when={mainSelected()}>
                <Icon name={getSemanticIcon("state.success")} size="small" />
              </Show>
            </span>
          </button>
          <Show when={main()?.git}>
            <button
              type="button"
              class="project-flow-row"
              disabled={props.running || pending()}
              aria-pressed={!params.id && props.workspaceSelection?.mode === "create"}
              onClick={() => void select({ mode: "create", sourceWorkspaceID: main()!.workspaceID })}
            >
              <Icon name={getSemanticIcon("workspace.worktree")} size="small" />
              <span class="project-flow-row-copy">
                <strong>{_(copy.newWorktree)}</strong>
                <small>
                  {(props.directories?.additionalWorkspaceIDs.length ?? 0) > 0
                    ? _({
                        ...copy.shared,
                        values: {
                          folder: getFilename(main()!.path),
                          count: props.directories!.additionalWorkspaceIDs.length,
                        },
                      })
                    : _(copy.onSend)}
                </small>
              </span>
              <span class="project-flow-check">
                <Show when={!params.id && props.workspaceSelection?.mode === "create"}>
                  <Icon name={getSemanticIcon("state.success")} size="small" />
                </Show>
              </span>
            </button>
          </Show>
          <div class="project-flow-list">
            <For each={trees()}>
              {(tree) => (
                <button
                  type="button"
                  class="project-flow-row"
                  disabled={props.running || pending() || tree.stale}
                  onClick={() => void useTree(tree)}
                >
                  <Icon name={getSemanticIcon("workspace.worktree")} size="small" />
                  <span class="project-flow-row-copy">
                    <strong>{tree.branch ?? tree.name}</strong>
                    <small>
                      {tree.setupFailed
                        ? tree.setupError
                        : _({ ...copy.using, values: { count: tree.bindings?.length ?? 0 } })}
                    </small>
                  </span>
                  <span class="project-flow-check">
                    <Show when={actual()?.path === tree.path || selectedTree() === tree.id}>
                      <Icon name={getSemanticIcon("state.success")} size="small" />
                    </Show>
                  </span>
                </button>
              )}
            </For>
          </div>
          <Show when={error()}>
            <p class="project-inline-error" role="alert">
              {error()}
            </p>
          </Show>
          <div class="project-menu-footer">
            <button
              type="button"
              class="project-flow-row"
              onClick={() => {
                setOpen(false)
                dialog.show(() => (
                  <DialogWorktrees
                    scopeID={sdk.scopeID}
                    disabled={props.running}
                    onSelect={async (tree) => {
                      if (await useTree(tree)) dialog.close()
                    }}
                  />
                ))
              }}
            >
              {_(copy.manageWorktrees)}
            </button>
          </div>
        </Popover>
      </Show>
      <Show when={props.directoryError}>
        <button class="session-work-context-button" data-unavailable="true" onClick={props.onRefresh}>
          {_(copy.retry)}
        </button>
      </Show>
      <Show when={custom()}>
        <Tooltip value={_(copy.unsupported)}>
          <button class="session-work-context-button" data-unavailable="true" onClick={advanced}>
            {_(copy.developer)}
          </button>
        </Tooltip>
      </Show>
      {props.children}
    </div>
  )
}
