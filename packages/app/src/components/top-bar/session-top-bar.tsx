import { useLingui } from "@lingui/solid"
import { topBar } from "@/locales/messages"
import { Show, createMemo, createSignal, type Accessor } from "solid-js"
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
import { useLocal } from "@/context/local"
import { useCommand } from "@/context/command"
import { useSync } from "@/context/sync"
import { useWorkbenchPanels } from "@/context/workbench"
import { base64Decode } from "@ericsanchezok/synergy-util/encode"
import { isHomeScope } from "@/utils/scope"
import { useSessionMeta } from "@/composables/use-session-meta"
import { getSemanticIcon } from "@ericsanchezok/synergy-ui/semantic-icon"
import { WorktreeEnterConfirmDialog } from "@/components/session/worktree-transition-dialog"
import {
  isSessionRunningForWorkspaceChange,
  type SessionWorkspaceTransitionRequest,
} from "@/components/session/worktree-session"
import "./session-top-bar.css"

function SessionActionMenu(props: {
  isWorktree: () => boolean
  worktreeDisabled: () => boolean
  onRename: () => void
  onWorktreeToggle: () => void
  onExport: () => void
  onImport: () => void
  onArchive: () => void
}) {
  const [open, setOpen] = createSignal(false)
  const { _ } = useLingui()

  const run = (action: () => void) => {
    setOpen(false)
    action()
  }

  return (
    <Popover
      open={open()}
      onOpenChange={setOpen}
      placement="bottom-end"
      gutter={8}
      class="stb-menu-popover"
      trigger={
        <Tooltip value={_(topBar.sessionActions)} placement="bottom">
          <button
            type="button"
            class="stb-icon-btn"
            aria-label={_(topBar.sessionActions)}
            aria-haspopup="menu"
            aria-expanded={open()}
          >
            <Icon name={getSemanticIcon("action.more")} size="normal" />
          </button>
        </Tooltip>
      }
    >
      <div class="stb-menu-list" role="menu">
        <button type="button" class="stb-menu-item" role="menuitem" onClick={() => run(props.onRename)}>
          <Icon name={getSemanticIcon("action.rename")} size="small" />
          <span>{_(topBar.rename)}</span>
        </button>
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
        <button type="button" class="stb-menu-item" role="menuitem" onClick={() => run(props.onExport)}>
          <Icon name={getSemanticIcon("action.export")} size="small" />
          <span>{_(topBar.exportSessionData)}</span>
        </button>
        <button type="button" class="stb-menu-item" role="menuitem" onClick={() => run(props.onImport)}>
          <Icon name={getSemanticIcon("action.import")} size="small" />
          <span>{_(topBar.importSessionData)}</span>
        </button>
        <button
          type="button"
          class="stb-menu-item stb-menu-item--danger"
          role="menuitem"
          onClick={() => run(props.onArchive)}
        >
          <Icon name={getSemanticIcon("action.archive")} size="small" />
          <span>{_(topBar.archive)}</span>
        </button>
      </div>
    </Popover>
  )
}

export function SessionTopBar(props: {
  onWorkspaceTransition?: (request: SessionWorkspaceTransitionRequest) => void
  workspaceTransitionPending?: Accessor<boolean>
}) {
  const { _ } = useLingui()

  const params = useParams()
  const navigate = useNavigate()
  const dialog = useDialog()
  const confirm = useConfirm()
  const layout = useLayout()
  const local = useLocal()
  const command = useCommand()
  const sync = useSync()
  const workbench = useWorkbenchPanels()
  const sideSurface = createMemo(() => workbench.surface("side"))
  const bottomSurface = createMemo(() => workbench.surface("bottom"))

  const directory = () => (params.dir ? base64Decode(params.dir) : "")
  const isGlobal = () => (params.dir ? isHomeScope(directory()) : false)

  const sessionInfo = createMemo(() => (params.id ? sync.session.get(params.id) : undefined))
  const sessionDirectory = createMemo(() => sessionInfo()?.scope.directory ?? directory())
  const isWorktreeSession = createMemo(() => sessionInfo()?.workspace?.type === "git_worktree")
  const worktreeDisabled = createMemo(() =>
    isSessionRunningForWorkspaceChange({
      pending: props.workspaceTransitionPending?.(),
      status: sync.data.session_status[params.id ?? ""],
      working: sessionInfo()?.working,
    }),
  )

  const sessionHasMessages = createMemo(() => {
    if (!params.id) return false
    return (sync.data.message[params.id] ?? []).length > 0
  })

  const sessionMeta = useSessionMeta(sessionInfo, sessionHasMessages)

  const isCurrentAgentExternal = createMemo(() => !!local.agent.current()?.external)
  const isCurrentExternalModelLocked = createMemo(() => {
    const external = local.agent.current()?.external
    if (!external) return false
    if (!sessionHasMessages()) return false
    return external.adapter === "codex"
  })

  const showRenameDialog = () => {
    const session = sessionInfo()
    const dir = sessionDirectory()
    if (!session || !dir) return
    dialog.show(() => <DialogSessionRename session={session} directory={dir} />)
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
    <Show when={sessionMeta().canSelectModel}>
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
        <ModelSelectorPopover>
          <TooltipKeybind placement="bottom" title={_(topBar.chooseModel)} keybind={command.keybind("model.choose")}>
            <button type="button" class="stb-selector-btn">
              <span class="stb-selector-label">{local.model.current()?.name ?? _(topBar.selectModel)}</span>
              <Icon name={getSemanticIcon("navigation.collapse")} size="normal" class="stb-chevron" />
            </button>
          </TooltipKeybind>
        </ModelSelectorPopover>
      </Show>
    </Show>
  )

  const VariantSelectorButton = () => (
    <Show when={local.model.variant.list().length > 0}>
      <TooltipKeybind
        placement="bottom"
        title={_(topBar.thinkingEffort)}
        keybind={command.keybind("model.variant.cycle")}
      >
        <button
          type="button"
          class="stb-selector-btn border-transparent! hover:border-border-weak-base!"
          onClick={() => local.model.variant.cycle()}
        >
          <span class="stb-variant-label">{local.model.variant.displayed() ?? _(topBar.defaultVariant)}</span>
        </button>
      </TooltipKeybind>
    </Show>
  )

  return (
    <div class="stb-root">
      {/* Mobile layout */}
      <div class="md:hidden flex w-full items-center justify-between pointer-events-auto">
        <div class="flex items-center gap-1">
          <button
            type="button"
            class="stb-icon-btn"
            aria-label={_(topBar.openNavigation)}
            onClick={() => layout.mobileSidebar.toggle()}
          >
            <Icon name={getSemanticIcon("app.sidebar.open")} size="normal" />
          </button>
          <button
            type="button"
            class="stb-icon-btn"
            aria-label={_(topBar.openTools)}
            onClick={() => layout.rightSidebar.toggle()}
          >
            <Icon name={getSemanticIcon("app.toolsDrawer")} size="normal" />
          </button>
        </div>
        <div class="stb-center flex min-w-0 items-center justify-center">
          <ModelSelectorButton />
        </div>
        <div class="flex items-center gap-1">
          <button
            type="button"
            class="stb-icon-btn"
            aria-label={_(topBar.newSession)}
            onClick={() => navigate(`/${params.dir}/session`)}
          >
            <Icon name={getSemanticIcon("action.add")} size="normal" />
          </button>
          <Show when={!!params.id && !isGlobal()}>
            <SessionActionMenu
              isWorktree={isWorktreeSession}
              worktreeDisabled={worktreeDisabled}
              onRename={showRenameDialog}
              onWorktreeToggle={toggleWorktree}
              onExport={() => dialog.show(() => <DialogSessionExport />)}
              onImport={() => dialog.show(() => <DialogSessionImport />)}
              onArchive={archiveSession}
            />
          </Show>
        </div>
      </div>

      {/* Desktop layout */}
      <div class="hidden md:flex w-full items-center justify-between pointer-events-auto">
        <div class="stb-left">
          <Show when={!isGlobal()}>
            <Icon name={getSemanticIcon("workspace.main")} size="normal" class="stb-folder" />
            <span class="stb-slash">/</span>
          </Show>
          <ModelSelectorButton />
          <VariantSelectorButton />
        </div>
        <div class="stb-right">
          <Show when={!!params.id && !isGlobal()}>
            <SessionActionMenu
              isWorktree={isWorktreeSession}
              worktreeDisabled={worktreeDisabled}
              onRename={showRenameDialog}
              onWorktreeToggle={toggleWorktree}
              onExport={() => dialog.show(() => <DialogSessionExport />)}
              onImport={() => dialog.show(() => <DialogSessionImport />)}
              onArchive={archiveSession}
            />
          </Show>
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
              <Icon name={getSemanticIcon("app.bottomSpace")} size="normal" />
            </button>
          </Tooltip>
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
              <Icon name={getSemanticIcon("app.sideWorkspace")} size="normal" />
            </button>
          </Tooltip>
        </div>
      </div>
    </div>
  )
}
