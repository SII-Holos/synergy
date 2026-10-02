import { useLingui } from "@lingui/solid"
import { PI } from "@/components/prompt-input/prompt-input-i18n"
import { sidebar, topBar } from "@/locales/messages"
import { Show, createMemo, createSignal, onMount, onCleanup, useContext, type Accessor } from "solid-js"
import { Portal } from "solid-js/web"
import { SessionWorkbenchChrome } from "@/components/session/workbench-chrome"
import { useNavigate, useParams } from "@solidjs/router"
import { useDialog } from "@ericsanchezok/synergy-ui/context/dialog"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { Popover } from "@ericsanchezok/synergy-ui/popover"
import { Tooltip, TooltipKeybind } from "@ericsanchezok/synergy-ui/tooltip"
import { DialogSessionRename, ModelSelectorPopover, useConfirm } from "@/components/dialog"
import { archiveSessionConfirm, leaveWorktreeConfirm } from "@/components/dialog/confirm-copy"
import { DialogSessionExport } from "@/components/dialog/dialog-session-export"
import { DialogSessionImport } from "@/components/dialog/dialog-session-import"
import { useLayout } from "@/context/layout"
import { useGlobalSDK } from "@/context/global-sdk"
import { useLocal } from "@/context/local"
import { useCommand } from "@/context/command"
import { useSessionDataView } from "@/context/session-data-view"
import { useSync } from "@/context/sync"
import { useWorkbenchPanels } from "@/context/workbench"
import { base64Decode } from "@ericsanchezok/synergy-util/encode"
import { useSessionMeta } from "@/composables/use-session-meta"
import { getSemanticIcon } from "@ericsanchezok/synergy-ui/semantic-icon"
import { WorktreeEnterConfirmDialog } from "@/components/session/worktree-transition-dialog"
import {
  isSessionRunningForWorkspaceChange,
  type SessionWorkspaceTransitionRequest,
} from "@/components/session/worktree-session"
import {
  sessionActionVisibility,
  sessionModelControlVisibility,
  sessionScopeRequestFor,
} from "@/components/session/session-actions"
import { copySessionID } from "@/utils/session-copy"
import "./session-top-bar.css"
import { SlotOutlet } from "@/plugin/slot-outlet"
import { SessionTagMenu } from "@/components/session/session-tag-menu"
import { ModelVariantPicker } from "@/components/provider/model-thinking-picker"

const selectionSaving = { id: "session.modelSelection.saving", message: "Saving…" }
const selectionPending = { id: "session.modelSelection.pending", message: "Applies to the next request" }
const selectionToolTurn = { id: "session.modelSelection.toolTurn", message: "Applies after this tool turn" }
const selectionRetry = { id: "session.modelSelection.retry", message: "Could not save. Retry" }

function SessionActionMenu(props: {
  tools?: { search: () => void; bottom: () => void; side?: () => void; bottomLabel: string; sideLabel: string }
  visibility: ReturnType<typeof sessionActionVisibility>
  isWorktree: () => boolean
  worktreeDisabled: () => boolean
  sessionID: string
  onRename: () => void
  onWorktreeToggle: () => void
  onExport: () => void
  onImport: () => void
  onAbandon?: () => void
  onArchive: () => void
  tags: string[]
  availableTags: string[]
  onTagsChange: (tags: string[]) => Promise<string[]>
}) {
  const [open, setOpen] = createSignal(false)
  const { _ } = useLingui()

  const run = (action: () => void) => {
    setOpen(false)
    action()
  }

  const handleCopySessionID = () => {
    void copySessionID(props.sessionID, {
      successTitle: _(topBar.sessionIDCopied),
      failureLabel: _(topBar.copySessionID),
      failureDescription: _(topBar.copySessionIDFailed),
    })
  }

  return (
    <Popover
      open={open()}
      onOpenChange={setOpen}
      placement="bottom-end"
      gutter={8}
      variant="menu"
      class="stb-menu-popover"
      triggerAs={(triggerProps) => (
        <Tooltip value={_(topBar.sessionActions)} placement="bottom" open={open() ? false : undefined}>
          <button
            {...triggerProps}
            type="button"
            class="stb-icon-btn"
            aria-label={_(topBar.sessionActions)}
            aria-haspopup="menu"
            aria-expanded={open()}
          >
            <Icon name={getSemanticIcon("action.more")} size="small" />
          </button>
        </Tooltip>
      )}
    >
      <div class="stb-menu-list" role="menu">
        <Show when={props.tools}>
          {(tools) => (
            <>
              <button type="button" class="stb-menu-item" role="menuitem" onClick={() => run(tools().search)}>
                <Icon name={getSemanticIcon("action.search")} size="small" />
                <span>{_(sidebar.search)}</span>
              </button>
              <button type="button" class="stb-menu-item" role="menuitem" onClick={() => run(tools().bottom)}>
                <Icon name={getSemanticIcon("app.bottomSpace")} size="small" />
                <span>{tools().bottomLabel}</span>
              </button>
              <Show when={tools().side}>
                <button type="button" class="stb-menu-item" role="menuitem" onClick={() => run(tools().side!)}>
                  <Icon name={getSemanticIcon("app.sideWorkspace")} size="small" />
                  <span>{tools().sideLabel}</span>
                </button>
              </Show>
            </>
          )}
        </Show>
        <Show when={props.visibility.rename}>
          <button type="button" class="stb-menu-item" role="menuitem" onClick={() => run(props.onRename)}>
            <Icon name={getSemanticIcon("action.rename")} size="small" />
            <span>{_(topBar.rename)}</span>
          </button>
        </Show>
        <Show when={props.visibility.copySessionID}>
          <button type="button" class="stb-menu-item" role="menuitem" onClick={() => run(handleCopySessionID)}>
            <Icon name={getSemanticIcon("action.copy")} size="small" />
            <span>{_(topBar.copySessionID)}</span>
          </button>
        </Show>
        <Show when={props.visibility.menu}>
          <SessionTagMenu tags={props.tags} availableTags={props.availableTags} onChange={props.onTagsChange} />
        </Show>
        <Show when={props.visibility.worktree}>
          <button
            type="button"
            class="stb-menu-item"
            role="menuitem"
            disabled={props.worktreeDisabled()}
            title={props.worktreeDisabled() ? _(topBar.worktreeDisabledHint) : undefined}
            onClick={() => run(props.onWorktreeToggle)}
          >
            <Icon
              name={getSemanticIcon(props.isWorktree() ? "workspace.leaveWorktree" : "workspace.enterWorktree")}
              size="small"
            />
            <span>{props.isWorktree() ? _(topBar.exitWorktree) : _(topBar.enterWorktree)}</span>
          </button>
        </Show>
        <Show when={props.visibility.export}>
          <button type="button" class="stb-menu-item" role="menuitem" onClick={() => run(props.onExport)}>
            <Icon name={getSemanticIcon("action.export")} size="small" />
            <span>{_(topBar.exportSessionData)}</span>
          </button>
        </Show>
        <Show when={props.visibility.import}>
          <button type="button" class="stb-menu-item" role="menuitem" onClick={() => run(props.onImport)}>
            <Icon name={getSemanticIcon("action.import")} size="small" />
            <span>{_(topBar.importSessionData)}</span>
          </button>
        </Show>
        <Show when={props.onAbandon}>
          <button
            type="button"
            class="stb-menu-item stb-menu-item--danger"
            role="menuitem"
            onClick={() => run(props.onAbandon!)}
          >
            <Icon name={getSemanticIcon("action.stop")} size="small" />
            <span>{_(PI.abandonExecution)}</span>
          </button>
        </Show>
        <Show when={props.visibility.archive}>
          <button
            type="button"
            class="stb-menu-item stb-menu-item--danger"
            role="menuitem"
            onClick={() => run(props.onArchive)}
          >
            <Icon name={getSemanticIcon("action.archive")} size="small" />
            <span>{_(topBar.archive)}</span>
          </button>
        </Show>
      </div>
    </Popover>
  )
}

export function SessionTopBar(props: {
  onWorkspaceTransition?: (request: SessionWorkspaceTransitionRequest) => void
  sessionTransitionPending?: Accessor<boolean>
}) {
  const { _ } = useLingui()

  const params = useParams()
  const navigate = useNavigate()
  const dialog = useDialog()
  const confirm = useConfirm()
  const layout = useLayout()
  const globalSDK = useGlobalSDK()
  const local = useLocal()
  const command = useCommand()
  const sync = useSync()
  const view = useSessionDataView()
  const workbench = useWorkbenchPanels()
  const workbenchChrome = useContext(SessionWorkbenchChrome)
  let header: HTMLDivElement | undefined
  const [compact, setCompact] = createSignal(false)
  onMount(() => {
    if (!header) return
    const observer = new ResizeObserver(() => setCompact(header!.getBoundingClientRect().width < 640))
    observer.observe(header)
    onCleanup(() => observer.disconnect())
  })
  const sideSurface = createMemo(() => workbench.surface("side"))
  const bottomSurface = createMemo(() => workbench.surface("bottom"))
  const SideWorkspaceToggle = () => (
    <Tooltip
      value={sideSurface().opened() ? _(topBar.hideSideWorkspace) : _(topBar.openSideWorkspace)}
      placement="bottom"
    >
      <button
        type="button"
        class="stb-icon-btn"
        classList={{ "stb-icon-btn--active": sideSurface().opened() }}
        aria-label={sideSurface().opened() ? _(topBar.hideSideWorkspace) : _(topBar.openSideWorkspace)}
        aria-pressed={sideSurface().opened()}
        onClick={() => sideSurface().toggle()}
      >
        <Icon name={getSemanticIcon("app.sideWorkspace")} size="small" />
      </button>
    </Tooltip>
  )

  const directory = () => (params.dir ? base64Decode(params.dir) : "")
  const actionVisibility = createMemo(() => sessionActionVisibility({ sessionID: params.id, scopeKey: directory() }))

  const sessionInfo = createMemo(() => (params.id ? sync.session.get(params.id) : undefined))
  const availableSessionTags = createMemo(() => {
    const tags = new Set(sessionInfo()?.tags ?? [])
    const entries = [
      ...layout.nav.recentEntries(),
      ...layout.nav.rootNavEntries("home"),
      ...layout.nav.rootNavEntries("channel"),
      ...layout.nav.rootNavEntries("background"),
      ...layout.scopes.list().flatMap((scope) => layout.nav.projectNavEntries(scope)),
    ]
    for (const entry of entries) for (const tag of entry.tags ?? []) tags.add(tag)
    return [...tags].sort()
  })
  const sessionDirectory = createMemo(() => sessionInfo()?.scope.id ?? directory())
  const isWorktreeSession = createMemo(() => sessionInfo()?.workspace?.type === "git_worktree")
  const worktreeDisabled = createMemo(() =>
    isSessionRunningForWorkspaceChange({
      pending: props.sessionTransitionPending?.(),
      status: view().statusFor(params.id ?? ""),
      working: sessionInfo()?.working,
    }),
  )

  const sessionHasMessages = createMemo(() => {
    if (!params.id) return false
    return view().messagesFor(params.id).length > 0
  })

  const sessionMeta = useSessionMeta(sessionInfo, sessionHasMessages)
  const modelControlVisibility = createMemo(() =>
    sessionModelControlVisibility({
      canSelectModel: sessionMeta().canSelectModel,
      variantCount: local.agent.current()?.external ? 0 : Math.max(1, local.model.variant.list().length),
    }),
  )

  const isCurrentAgentExternal = createMemo(() => !!local.agent.current()?.external)
  const isCurrentExternalModelLocked = createMemo(() => {
    const external = local.agent.current()?.external
    if (!external) return false
    if (!sessionHasMessages()) return false
    return external.adapter === "codex"
  })

  const showRenameDialog = () => {
    const session = sessionInfo()
    if (!session) return
    dialog.show(() => <DialogSessionRename session={session} scopeRequest={sessionScopeRequestFor(session)} />)
  }

  const showEnterWorktreeDialog = (sessionID: string, dir: string) => {
    dialog.show(() => (
      <WorktreeEnterConfirmDialog
        sessionID={sessionID}
        directory={dir}
        onConfirm={(request) => props.onWorkspaceTransition?.(request)}
      />
    ))
  }

  const toggleWorktree = () => {
    const session = sessionInfo()
    const dir = sessionDirectory()
    if (!session || !dir || worktreeDisabled()) return
    if (!isWorktreeSession()) {
      showEnterWorktreeDialog(session.id, dir)
      return
    }
    confirm.show({
      ...leaveWorktreeConfirm(session.title),
      onConfirm: () => {
        if (worktreeDisabled()) return
        props.onWorkspaceTransition?.({ operation: "leave", sessionID: session.id, directory: dir })
      },
    })
  }

  const archiveSession = () => {
    const session = sessionInfo()
    if (!session) return
    confirm.show({
      ...archiveSessionConfirm(session.title),
      onConfirm: async () => {
        const nextSession = await layout.nav.archiveSession(session)
        if (session.id === params.id) {
          if (nextSession) navigate(`/${params.dir}/session/${nextSession.id}`)
          else navigate(`/${params.dir}/session`)
        }
      },
    })
  }

  const ModelSelectorButton = () => (
    <Show when={modelControlVisibility().model}>
      <Show
        when={!isCurrentExternalModelLocked()}
        fallback={
          <Tooltip placement="bottom" value={_(topBar.modelLocked)}>
            <button type="button" class="stb-selector-btn stb-locked">
              <span class="stb-selector-label">{local.model.current()?.name ?? _(topBar.modelLockedLabel)}</span>
            </button>
          </Tooltip>
        }
      >
        <ModelSelectorPopover
          placement="bottom-start"
          triggerAs={(triggerProps) => (
            <TooltipKeybind
              open={String(triggerProps["aria-expanded"]) === "true" ? false : undefined}
              placement="bottom"
              title={_(topBar.chooseModel)}
              keybind={command.keybind("model.choose")}
            >
              <button {...triggerProps} type="button" class="stb-selector-btn">
                <span class="stb-selector-label">{local.model.current()?.name ?? _(topBar.selectModel)}</span>
                <Show when={local.model.current()?.catalogState === "retained"}>
                  <Tooltip placement="bottom" value={_(topBar.retainedModel)}>
                    <Icon name={getSemanticIcon("state.warning")} size="small" class="text-icon-warning-base" />
                  </Tooltip>
                </Show>
                <Icon name={getSemanticIcon("navigation.collapse")} size="small" class="stb-chevron" />
              </button>
            </TooltipKeybind>
          )}
        />
      </Show>
    </Show>
  )

  const VariantSelectorButton = () => (
    <Show when={modelControlVisibility().variant}>
      <ModelVariantPicker
        appearance="toolbar"
        value={local.model.variant.displayed()}
        availableVariants={local.model.variant.list()}
        onChange={(value) => local.model.variant.set(value || undefined)}
        triggerClass="stb-selector-btn"
      />
      <Show
        when={
          local.model.selection.saving() ||
          local.model.selection.state()?.pendingReason ||
          local.model.selection.error()
        }
      >
        <Tooltip
          placement="bottom"
          value={
            local.model.selection.error()
              ? _(selectionRetry)
              : local.model.selection.saving()
                ? _(selectionSaving)
                : local.model.selection.state()?.pendingReason === "tool-turn"
                  ? _(selectionToolTurn)
                  : _(selectionPending)
          }
        >
          <button
            type="button"
            class="stb-icon-btn"
            aria-label={
              local.model.selection.error()
                ? _(selectionRetry)
                : local.model.selection.saving()
                  ? _(selectionSaving)
                  : local.model.selection.state()?.pendingReason === "tool-turn"
                    ? _(selectionToolTurn)
                    : _(selectionPending)
            }
            onClick={() => {
              if (local.model.selection.error()) local.model.selection.retry()
            }}
          >
            <Show when={local.model.selection.error()} fallback={<span aria-hidden="true">…</span>}>
              <Icon name={getSemanticIcon("state.warning")} size="small" />
            </Show>
          </button>
        </Tooltip>
      </Show>
    </Show>
  )

  return (
    <>
      <div ref={header} class="stb-root" data-compact={compact() ? "" : undefined}>
        {/* Mobile layout */}
        <div class="md:hidden flex w-full items-center justify-between pointer-events-auto">
          <div class="flex items-center gap-1">
            <button
              type="button"
              class="stb-icon-btn"
              aria-label={_(topBar.openNavigation)}
              onClick={() => layout.mobileSidebar.toggle()}
            >
              <Icon name={getSemanticIcon("app.sidebar.open")} size="small" />
            </button>
            <button
              type="button"
              class="stb-icon-btn"
              aria-label={_(topBar.openTools)}
              onClick={() => layout.rightSidebar.toggle()}
            >
              <Icon name={getSemanticIcon("app.toolsDrawer")} size="small" />
            </button>
          </div>
          <div class="stb-center flex min-w-0 flex-1 items-center justify-center">
            <ModelSelectorButton />
          </div>
          <div class="flex items-center gap-1">
            <button
              type="button"
              class="stb-icon-btn"
              aria-label={_(topBar.newSession)}
              onClick={() => navigate(`/${params.dir}/session`)}
            >
              <Icon name={getSemanticIcon("action.add")} size="small" />
            </button>
            <Show when={actionVisibility().menu}>
              <SessionActionMenu
                visibility={actionVisibility()}
                isWorktree={isWorktreeSession}
                worktreeDisabled={worktreeDisabled}
                sessionID={params.id!}
                onRename={showRenameDialog}
                onWorktreeToggle={toggleWorktree}
                onExport={() => dialog.show(() => <DialogSessionExport />)}
                onImport={() => dialog.show(() => <DialogSessionImport />)}
                onArchive={archiveSession}
                tags={sessionInfo()?.tags ?? []}
                availableTags={availableSessionTags()}
                onTagsChange={async (tags) => {
                  const session = sessionInfo()
                  if (!session) throw new Error("Session is unavailable")
                  const result = await globalSDK.client.session.update(
                    {
                      ...sessionScopeRequestFor(session),
                      sessionID: session.id,
                      tags,
                    },
                    { throwOnError: true },
                  )
                  return result.data.tags ?? []
                }}
                onAbandon={
                  command.options.some((option) => option.id === "session.abandon" && !option.disabled)
                    ? () => command.trigger("session.abandon")
                    : undefined
                }
              />
            </Show>
          </div>
        </div>

        {/* Desktop layout */}
        <div class="stb-desktop hidden md:flex w-full items-center justify-between pointer-events-auto">
          <div class="stb-left">
            <ModelSelectorButton />
            <VariantSelectorButton />
          </div>
          <div class="stb-drag-region" aria-hidden="true" />
          <div class="stb-right">
            <Show when={actionVisibility().menu || compact()}>
              <SessionActionMenu
                tools={
                  compact()
                    ? {
                        search: () => command.trigger("session.list"),
                        bottom: () => bottomSurface().toggle(),
                        side: workbenchChrome?.() ? undefined : () => sideSurface().toggle(),
                        bottomLabel: bottomSurface().opened() ? _(topBar.hideBottomSpace) : _(topBar.openBottomSpace),
                        sideLabel: sideSurface().opened() ? _(topBar.hideSideWorkspace) : _(topBar.openSideWorkspace),
                      }
                    : undefined
                }
                visibility={actionVisibility()}
                isWorktree={isWorktreeSession}
                worktreeDisabled={worktreeDisabled}
                sessionID={params.id!}
                onRename={showRenameDialog}
                onWorktreeToggle={toggleWorktree}
                onExport={() => dialog.show(() => <DialogSessionExport />)}
                onImport={() => dialog.show(() => <DialogSessionImport />)}
                onArchive={archiveSession}
                tags={sessionInfo()?.tags ?? []}
                availableTags={availableSessionTags()}
                onTagsChange={async (tags) => {
                  const session = sessionInfo()
                  if (!session) throw new Error("Session is unavailable")
                  const result = await globalSDK.client.session.update(
                    {
                      ...sessionScopeRequestFor(session),
                      sessionID: session.id,
                      tags,
                    },
                    { throwOnError: true },
                  )
                  return result.data.tags ?? []
                }}
                onAbandon={
                  command.options.some((option) => option.id === "session.abandon" && !option.disabled)
                    ? () => command.trigger("session.abandon")
                    : undefined
                }
              />
            </Show>
            <Show when={!compact()}>
              <Tooltip
                value={bottomSurface().opened() ? _(topBar.hideBottomSpace) : _(topBar.openBottomSpace)}
                placement="bottom"
              >
                <button
                  type="button"
                  class="stb-icon-btn"
                  classList={{ "stb-icon-btn--active": bottomSurface().opened() }}
                  aria-label={bottomSurface().opened() ? _(topBar.hideBottomSpace) : _(topBar.openBottomSpace)}
                  aria-pressed={bottomSurface().opened()}
                  onClick={() => bottomSurface().toggle()}
                >
                  <Icon name={getSemanticIcon("app.bottomSpace")} size="small" />
                </button>
              </Tooltip>
              <Show when={!workbenchChrome?.()}>
                <SideWorkspaceToggle />
              </Show>
            </Show>
          </div>
          <SlotOutlet slot="session.header.actions" sessionId={params.id} />
        </div>
      </div>
      <Show when={workbenchChrome?.()}>
        {(mount) => (
          <Portal mount={mount()}>
            <SideWorkspaceToggle />
          </Portal>
        )}
      </Show>
    </>
  )
}
