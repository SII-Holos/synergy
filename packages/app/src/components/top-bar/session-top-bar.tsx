import { Show, createMemo, createSignal } from "solid-js"
import { useNavigate, useParams } from "@solidjs/router"
import { useDialog } from "@ericsanchezok/synergy-ui/context/dialog"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { Popover } from "@ericsanchezok/synergy-ui/popover"
import { Tooltip, TooltipKeybind } from "@ericsanchezok/synergy-ui/tooltip"
import { DialogSessionRename, ModelSelectorPopover, useConfirm } from "@/components/dialog"
import { archiveSessionConfirm, leaveWorktreeConfirm } from "@/components/dialog/confirm-copy"
import { DialogSessionExport } from "@/components/dialog/dialog-session-export"
import { useLayout } from "@/context/layout"
import { useLocal } from "@/context/local"
import { useCommand } from "@/context/command"
import { useSync } from "@/context/sync"
import { useWorkbenchPanels } from "@/context/workbench-panels"
import { base64Decode } from "@ericsanchezok/synergy-util/encode"
import { isHomeScope } from "@/utils/scope"
import { useSessionMeta } from "@/composables/use-session-meta"
import { getSemanticIcon } from "@ericsanchezok/synergy-ui/semantic-icon"
import { setWorktreeTransition, worktreeTransition } from "@/components/session/worktree-progress-signals"
import { isSessionRunningForWorkspaceChange } from "@/components/session/worktree-session"
import "./session-top-bar.css"

function SessionActionMenu(props: {
  isWorktree: () => boolean
  worktreeDisabled: () => boolean
  onRename: () => void
  onWorktreeToggle: () => void
  onExport: () => void
  onArchive: () => void
}) {
  const [open, setOpen] = createSignal(false)

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
        <Tooltip value="Session actions" placement="bottom">
          <button
            type="button"
            class="stb-icon-btn"
            aria-label="Session actions"
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
          <span>Rename</span>
        </button>
        <button
          type="button"
          class="stb-menu-item"
          role="menuitem"
          disabled={props.worktreeDisabled()}
          title={props.worktreeDisabled() ? "Stop the session before changing worktree." : undefined}
          onClick={() => run(props.onWorktreeToggle)}
        >
          <Icon
            name={getSemanticIcon(props.isWorktree() ? "workspace.leaveWorktree" : "workspace.enterWorktree")}
            size="small"
          />
          <span>{props.isWorktree() ? "Exit worktree" : "Enter worktree"}</span>
        </button>
        <button type="button" class="stb-menu-item" role="menuitem" onClick={() => run(props.onExport)}>
          <Icon name={getSemanticIcon("action.export")} size="small" />
          <span>Export session data</span>
        </button>
        <button
          type="button"
          class="stb-menu-item stb-menu-item--danger"
          role="menuitem"
          onClick={() => run(props.onArchive)}
        >
          <Icon name={getSemanticIcon("action.archive")} size="small" />
          <span>Archive</span>
        </button>
      </div>
    </Popover>
  )
}

export function SessionTopBar() {
  const params = useParams()
  const navigate = useNavigate()
  const dialog = useDialog()
  const confirm = useConfirm()
  const layout = useLayout()
  const local = useLocal()
  const command = useCommand()
  const sync = useSync()
  const workbench = useWorkbenchPanels()
  const worktreePending = createMemo(() => !!worktreeTransition())
  const sideSurface = createMemo(() => workbench.surface("side"))
  const bottomSurface = createMemo(() => workbench.surface("bottom"))

  const directory = () => (params.dir ? base64Decode(params.dir) : "")
  const isGlobal = () => (params.dir ? isHomeScope(directory()) : false)

  const sessionInfo = createMemo(() => (params.id ? sync.session.get(params.id) : undefined))
  const sessionDirectory = createMemo(() => sessionInfo()?.scope.directory ?? directory())
  const isWorktreeSession = createMemo(() => sessionInfo()?.workspace?.type === "git_worktree")
  const worktreeDisabled = createMemo(() =>
    isSessionRunningForWorkspaceChange({
      pending: worktreePending(),
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

  const showWorktreeTransition = (mode: "enter" | "leave", sessionID: string, dir: string) => {
    setWorktreeTransition({ mode, sessionID, directory: dir })
  }

  const toggleWorktree = () => {
    const session = sessionInfo()
    const dir = sessionDirectory()
    if (!session || !dir || worktreeDisabled()) return
    if (!isWorktreeSession()) {
      showWorktreeTransition("enter", session.id, dir)
      return
    }
    confirm.show({
      ...leaveWorktreeConfirm(session.title),
      onConfirm: () => {
        setTimeout(() => {
          if (worktreeDisabled()) return
          showWorktreeTransition("leave", session.id, dir)
        }, 0)
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

  return (
    <div class="stb-root">
      <div class="stb-left">
        {/* Mobile left sidebar trigger */}
        <button
          type="button"
          class="stb-icon-btn md:hidden"
          aria-label="Open navigation"
          onClick={() => layout.mobileSidebar.toggle()}
        >
          <Icon name="panel-left-open" size="normal" />
        </button>
        <Show when={!isGlobal()}>
          <Icon name={getSemanticIcon("workspace.main")} size="normal" class="stb-folder hidden md:block" />
          <span class="stb-slash hidden md:block">/</span>
        </Show>
        {/* Model selector */}
        <Show when={sessionMeta().canSelectModel}>
          <Show
            when={!isCurrentExternalModelLocked()}
            fallback={
              <Tooltip placement="bottom" value="Model is locked for this external agent after the session starts">
                <button type="button" class="stb-selector-btn stb-locked">
                  <span class="stb-selector-label">{local.model.current()?.name ?? "Model locked"}</span>
                </button>
              </Tooltip>
            }
          >
            <ModelSelectorPopover>
              <TooltipKeybind placement="bottom" title="Choose model" keybind={command.keybind("model.choose")}>
                <button type="button" class="stb-selector-btn">
                  <span class="stb-selector-label">{local.model.current()?.name ?? "Select model"}</span>
                  <Icon name={getSemanticIcon("navigation.collapse")} size="normal" class="stb-chevron" />
                </button>
              </TooltipKeybind>
            </ModelSelectorPopover>
          </Show>
        </Show>

        {/* Variant cycle */}
        <Show when={local.model.variant.list().length > 0}>
          <TooltipKeybind placement="bottom" title="Thinking effort" keybind={command.keybind("model.variant.cycle")}>
            <button
              type="button"
              class="stb-selector-btn border-transparent! hover:border-border-weak-base!"
              onClick={() => local.model.variant.cycle()}
            >
              <span class="stb-variant-label">{local.model.variant.current() ?? "Default"}</span>
            </button>
          </TooltipKeybind>
        </Show>
      </div>
      <div class="stb-right">
        <Show when={!!params.id && !isGlobal()}>
          <SessionActionMenu
            isWorktree={isWorktreeSession}
            worktreeDisabled={worktreeDisabled}
            onRename={showRenameDialog}
            onWorktreeToggle={toggleWorktree}
            onExport={() => dialog.show(() => <DialogSessionExport />)}
            onArchive={archiveSession}
          />
        </Show>
        {/* BottomSpace hidden on mobile */}
        <Tooltip value={bottomSurface().opened() ? "Hide BottomSpace" : "Open BottomSpace"} placement="bottom">
          <button
            type="button"
            class="stb-icon-btn hidden md:flex"
            classList={{ "stb-icon-btn--active": bottomSurface().opened() }}
            aria-label={bottomSurface().opened() ? "Hide BottomSpace" : "Open BottomSpace"}
            aria-pressed={bottomSurface().opened()}
            onClick={() => bottomSurface().toggle()}
          >
            <Icon name={getSemanticIcon("app.bottomSpace")} size="normal" />
          </button>
        </Tooltip>
        {/* Side workspace: opens right tools drawer on mobile, toggles desktop panel on desktop */}
        <Tooltip value={sideSurface().opened() ? "Hide side workspace" : "Open side workspace"} placement="bottom">
          <button
            type="button"
            class="stb-icon-btn md:hidden"
            classList={{ "stb-icon-btn--active": sideSurface().opened() }}
            aria-label={sideSurface().opened() ? "Hide side workspace" : "Open side workspace"}
            aria-pressed={sideSurface().opened()}
            onClick={() => layout.rightSidebar.show()}
          >
            <Icon name={getSemanticIcon("app.sideWorkspace")} size="normal" />
          </button>
        </Tooltip>
        <Tooltip value={sideSurface().opened() ? "Hide side workspace" : "Open side workspace"} placement="bottom">
          <button
            type="button"
            class="stb-icon-btn hidden md:flex"
            classList={{ "stb-icon-btn--active": sideSurface().opened() }}
            aria-label={sideSurface().opened() ? "Hide side workspace" : "Open side workspace"}
            aria-pressed={sideSurface().opened()}
            onClick={() => sideSurface().toggle()}
          >
            <Icon name={getSemanticIcon("app.sideWorkspace")} size="normal" />
          </button>
        </Tooltip>
      </div>
    </div>
  )
}
