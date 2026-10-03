import type { SessionWorkspaceTransitionRequest } from "./worktree-session"
import { createMemo, createResource, createSignal, For, Show, Suspense, onCleanup, type JSX } from "solid-js"
import { useParams } from "@solidjs/router"
import { useLingui } from "@lingui/solid"
import type {
  ProjectDirectories,
  SessionWorkspaceSelection,
  WorktreeInventoryEntry,
} from "@ericsanchezok/synergy-sdk/client"
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
import { loadWorktreeInventory } from "@/utils/worktree-inventory"
import { requestErrorMessage } from "@/utils/error"
import type { PromptStartOptionGroup } from "../prompt-input/start-options"
import { ProjectTaskButton } from "./project-task-button"
import { ComputerMenu } from "../dialog/computer-menu"
import { DialogScopeEdit } from "../dialog/dialog-scope-edit"
import { DialogWorktrees } from "../dialog/dialog-worktrees"
import { DialogWorkingLocation } from "../dialog/dialog-working-location"
import { DialogProjectDirectoryRecovery } from "../dialog/dialog-project-directory-recovery"
import { sameProjectDirectories } from "../dialog/project-directory-recovery"
import { projectEntryCopy as copy } from "../dialog/project-entry-copy"

type WorkContextProps = {
  onWorkspaceTransition?: (request: SessionWorkspaceTransitionRequest) => void
  running?: boolean
  environmentID?: string | null
  environmentProfile?: string | null
  workspaceSelection?: SessionWorkspaceSelection
  workspaceSelectionKey?: string
  onEnvironmentChange?: (id: string | null | undefined) => void
  onEnvironmentProfileChange?: (profile: string | null | undefined) => void
  startOptions: PromptStartOptionGroup[]
  children?: JSX.Element
  disabled: boolean
  uploading?: boolean
  directories?: ProjectDirectories
  directoryError?: string
  onRefresh?: () => void | Promise<void>
  onSelect?: (selection: SessionWorkspaceSelection) => void
}
export function SessionWorkContext(props: WorkContextProps) {
  const { _ } = useLingui()
  const params = useParams()
  return (
    <Show when={!params.id}>
      <Suspense fallback={<span class="project-inline-note">{_(copy.loading)}</span>}>
        <WorkContextContent {...props} />
      </Suspense>
    </Show>
  )
}
function WorkContextContent(props: WorkContextProps) {
  const { _ } = useLingui()
  const sdk = useSDK()
  const globalSDK = useGlobalSDK()
  const sync = useSync()
  const layout = useLayout()
  const dialog = useDialog()
  const params = useParams()
  const [open, setOpen] = createSignal(false)
  const [optionsOpen, setOptionsOpen] = createSignal(false)
  const [pending, setPending] = createSignal(false)
  const [error, setError] = createSignal("")
  const scope = createMemo(() => resolveProjectScope(sdk.scopeKey, sync.scope, layout.scopes.list()))
  const main = createMemo(() =>
    props.directories?.folders.find((folder) => folder.workspaceID === props.directories?.mainWorkspaceID),
  )
  const session = createMemo(() => (params.id ? sync.session.get(params.id) : undefined))
  let inventoryRequest: AbortController | undefined
  let disposed = false
  onCleanup(() => {
    disposed = true
    inventoryRequest?.abort()
  })
  const inventoryVersion = createMemo(() =>
    JSON.stringify([
      props.directories?.revision,
      sync.data.workspaces.map((workspace) => [workspace.id, workspace.binding.generation]),
    ]),
  )
  const [trees, { refetch: refreshTrees }] = createResource(
    () =>
      !sdk.isHome && globalSDK.capabilities.has("workbench")
        ? { client: sdk.client, url: globalSDK.url, scopeID: sdk.scopeID, version: inventoryVersion() }
        : false,
    async (owner) => {
      inventoryRequest?.abort()
      const controller = new AbortController()
      inventoryRequest = controller
      try {
        setError("")
        return {
          ...owner,
          items:
            (await loadWorktreeInventory(owner.client, owner.url, owner.scopeID, owner.version, controller.signal)).data
              ?.items ?? [],
        }
      } catch (failure) {
        if (
          controller.signal.aborted ||
          sdk.client !== owner.client ||
          sdk.scopeID !== owner.scopeID ||
          globalSDK.url !== owner.url
        )
          return undefined
        setError(requestErrorMessage(failure, _(copy.unavailable)))
        return { ...owner, items: [] }
      }
    },
  )
  const treeItems = () => {
    const snapshot = trees.latest
    return snapshot?.client === sdk.client && snapshot.scopeID === sdk.scopeID && snapshot.url === globalSDK.url
      ? snapshot.items
      : []
  }
  const needsRecovery = () => props.directories?.folders.some((folder) => !folder.available)
  const [environment] = createResource(
    () => session()?.environmentID,
    async (environmentID) => (await sdk.client.environment.get({ environmentID }, { throwOnError: true })).data,
  )
  const actual = () => session()?.workspace
  const selectedTree = () =>
    props.workspaceSelection?.mode === "existing" ? props.workspaceSelection.target : undefined
  const selectedWorkspace = () => treeItems().find((tree) => tree.id === selectedTree() || tree.path === selectedTree())
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
    return selectedWorkspace()?.branch ?? (selectedTree() ? getFilename(selectedTree()!) : _(copy.main))
  }
  const location = () =>
    [
      label(),
      props.workspaceSelection?.mode === "create" ? _(copy.onSend) : undefined,
      actual()?.path ?? (selectedTree() ? selectedWorkspace()?.path : main()?.path),
    ]
      .filter(Boolean)
      .join("\n")
  const worktreeSelected = () =>
    actual()?.type === "git_worktree" ||
    props.workspaceSelection?.mode === "create" ||
    props.workspaceSelection?.mode === "existing"
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
  const useTree = (tree: WorktreeInventoryEntry) =>
    select({ mode: "existing", target: tree.id, sourceWorkspaceID: tree.sourceWorkspaceID })
  function recover(mode: "create" | "main") {
    const directories = props.directories
    if (!directories || pending() || props.disabled || props.running) return
    const client = sdk.client
    const scopeID = sdk.scopeID
    const url = globalSDK.url
    const selectionKey = () => props.workspaceSelectionKey ?? JSON.stringify(props.workspaceSelection)
    const selection = selectionKey()
    const isCurrent = () =>
      !disposed &&
      sdk.client === client &&
      sdk.scopeID === scopeID &&
      globalSDK.url === url &&
      !!props.directories &&
      sameProjectDirectories(directories, props.directories) &&
      selectionKey() === selection
    setOpen(false)
    document.querySelector<HTMLButtonElement>("[data-worktree-task-selector]")?.focus({ preventScroll: true })
    dialog.show(() => (
      <DialogProjectDirectoryRecovery
        directories={directories}
        isCurrent={isCurrent}
        onRecovered={async (restored) => {
          await props.onRefresh?.()
          await refreshTrees()
          if (!isCurrent()) return
          const folder = restored.folders.find((item) => item.workspaceID === restored.mainWorkspaceID)
          if (!folder?.available) return
          if (mode === "create" && !folder.git) {
            setError(_(copy.notGit))
            return
          }
          await select(
            mode === "create"
              ? { mode: "create", sourceWorkspaceID: folder.workspaceID }
              : { mode: "workspace", workspaceID: folder.workspaceID, workspaceGeneration: folder.generation },
          )
        }}
      />
    ))
  }
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
      <ComputerMenu showTooltip={false} disabled={props.disabled || props.uploading || pending()} />
      <ProjectTaskButton
        label={getScopeLabel(scope(), sdk.scopeKey)}
        path={main()?.path}
        disabled={props.disabled || pending()}
        uploading={props.uploading}
        onSettings={sdk.isHome ? undefined : settings}
      />
      <Show when={!sdk.isHome && globalSDK.capabilities.has("workbench")}>
        <Popover
          variant="menu"
          title={_(copy.worktrees)}
          open={open()}
          onOpenChange={setOpen}
          placement="top-start"
          class="project-select-popover"
          triggerAs={(attributes) => (
            <Tooltip inactive value={location()}>
              <button
                {...attributes}
                class="session-work-context-button"
                data-worktree-task-selector
                disabled={props.disabled || pending()}
                aria-label={location()}
              >
                <Icon
                  name={getSemanticIcon(worktreeSelected() ? "workspace.worktree" : "workspace.main")}
                  size="small"
                />
              </button>
            </Tooltip>
          )}
        >
          <button
            type="button"
            class="project-flow-row"
            disabled={props.running || pending() || !main()}
            aria-pressed={mainSelected()}
            onClick={() =>
              needsRecovery()
                ? recover("main")
                : main() &&
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
          <button
            type="button"
            class="project-flow-row"
            disabled={props.running || pending() || !main() || (main()?.available && !main()?.git)}
            aria-pressed={!params.id && props.workspaceSelection?.mode === "create"}
            onClick={() =>
              needsRecovery()
                ? recover("create")
                : void select({ mode: "create", sourceWorkspaceID: main()!.workspaceID })
            }
          >
            <Icon name={getSemanticIcon("workspace.worktree")} size="small" />
            <span class="project-flow-row-copy">
              <strong>{_(copy.newWorktree)}</strong>
              <small>
                {!main()
                  ? _(copy.unavailable)
                  : main()?.available && !main()?.git
                    ? _(copy.notGit)
                    : needsRecovery()
                      ? _(copy.confirmFolder)
                      : (props.directories?.additionalWorkspaceIDs.length ?? 0) > 0
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
          <div class="project-flow-list">
            <For each={treeItems()}>
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
                document
                  .querySelector<HTMLButtonElement>("[data-worktree-task-selector]")
                  ?.focus({ preventScroll: true })
                dialog.show(() => (
                  <DialogWorktrees
                    scopeID={sdk.scopeID}
                    inventoryVersion={inventoryVersion()}
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
      <Show when={props.directoryError || custom()}>
        <Popover
          variant="menu"
          title={_(copy.locationOptions)}
          open={optionsOpen()}
          onOpenChange={setOptionsOpen}
          placement="top-end"
          class="project-select-popover"
          triggerAs={(attributes) => (
            <Tooltip value={optionsOpen() || dialog.active ? "" : props.directoryError || _(copy.unsupported)}>
              <button
                {...attributes}
                type="button"
                class="session-work-context-button"
                data-location-options
                data-unavailable="true"
                disabled={props.disabled || pending()}
                aria-label={_(copy.locationOptions)}
              >
                <Icon name={getSemanticIcon(props.directoryError ? "state.warning" : "action.more")} size="small" />
              </button>
            </Tooltip>
          )}
        >
          <Show when={props.directoryError}>
            <p class="project-inline-error" role="alert">
              {props.directoryError}
            </p>
            <button
              type="button"
              class="project-flow-row"
              onClick={() => {
                setOptionsOpen(false)
                props.onRefresh?.()
              }}
            >
              <Icon name={getSemanticIcon("action.refresh")} size="small" />
              {_(copy.retry)}
            </button>
          </Show>
          <Show when={custom()}>
            <button
              type="button"
              class="project-flow-row"
              onClick={() => {
                setOptionsOpen(false)
                document.querySelector<HTMLButtonElement>("[data-location-options]")?.focus({ preventScroll: true })
                advanced()
              }}
            >
              <Icon name={getSemanticIcon("settings.general")} size="small" />
              {_(copy.developer)}
            </button>
          </Show>
        </Popover>
      </Show>
      {props.children}
    </div>
  )
}
