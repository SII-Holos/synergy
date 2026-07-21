import { DialogSelectFile, DialogSelectModel, DialogSelectMcp } from "@/components/dialog"
import type { useCommand } from "@/context/command"
import type { useLocal } from "@/context/local"
import type { usePrompt } from "@/context/prompt"
import type { useSDK } from "@/context/sdk"
import type { useSync } from "@/context/sync"
import type { useTerminal } from "@/context/terminal"
import type { useLayout } from "@/context/layout"
import { useWorkbenchPanels } from "@/context/workbench"
import { useFile } from "@/context/file"
import { inlineLength } from "@/components/prompt-input/content"
import { extractPromptDraft } from "@/utils/prompt"
import type { useDialog } from "@ericsanchezok/synergy-ui/context/dialog"
import type { UserMessage } from "@ericsanchezok/synergy-sdk"
import { showToast } from "@ericsanchezok/synergy-ui/toast"
import type { useNavigate } from "@solidjs/router"
import { useLocale } from "@/context/locale"
import { S } from "./session-i18n"
import { compactSessionWithCurrentModel } from "./compact-action"

export function useSessionCommands(params: {
  command: ReturnType<typeof useCommand>
  sdk: ReturnType<typeof useSDK>
  sync: ReturnType<typeof useSync>
  local: ReturnType<typeof useLocal>
  dialog: ReturnType<typeof useDialog>
  terminal: ReturnType<typeof useTerminal>
  layout: ReturnType<typeof useLayout>
  prompt: ReturnType<typeof usePrompt>
  navigate: ReturnType<typeof useNavigate>
  routeParams: { dir: string; id?: string }
  info: () => ReturnType<ReturnType<typeof useSync>["session"]["get"]>
  status: () => { type: string }
  activeMessage: () => UserMessage | undefined
  visibleUserMessages: () => UserMessage[]
  userMessages: () => UserMessage[]
  setActiveMessage: (msg: UserMessage | undefined) => void
  navigateMessageByOffset: (offset: number) => void
  isWorking: () => boolean
  onRewind?: (message: UserMessage) => void
}) {
  const {
    command,
    sdk,
    sync,
    local,
    dialog,
    layout,
    prompt,
    navigate,
    routeParams,
    info,
    status,
    activeMessage,
    visibleUserMessages,
    userMessages,
    setActiveMessage,
    navigateMessageByOffset,
  } = params

  const workbench = useWorkbenchPanels()
  const file = useFile()
  const { i18n } = useLocale()

  command.register(() => [
    {
      id: "session.new",
      title: i18n._(S.cmdNewSession),
      description: i18n._(S.cmdNewSessionDesc),
      category: i18n._(S.cmdCategorySession),
      keybind: "mod+shift+s",
      slash: "new",
      onSelect: () => {
        navigate(`/${routeParams.dir}/session`)
      },
    },
    {
      id: "file.open",
      title: i18n._(S.cmdOpenFile),
      description: i18n._(S.cmdOpenFileDesc),
      category: i18n._(S.cmdCategoryFile),
      keybind: "mod+p",
      slash: "open",
      onSelect: () => dialog.show(() => <DialogSelectFile onSelect={(path) => void file.openWorkspaceFile(path)} />),
    },
    {
      id: "file.refresh",
      title: i18n._(S.cmdRefreshFile),
      description: i18n._(S.cmdRefreshFileDesc),
      category: i18n._(S.cmdCategoryFile),
      onSelect: file.explorer.refresh,
    },
    {
      id: "file.tree.toggle",
      title: i18n._(S.cmdToggleFileTree),
      description: i18n._(S.cmdToggleFileTreeDesc),
      category: i18n._(S.cmdCategoryView),
      onSelect: () => file.explorer.setOpen(!file.explorer.open()),
    },
    {
      id: "file.tree.collapse",
      title: i18n._(S.cmdCollapseFolders),
      description: i18n._(S.cmdCollapseFoldersDesc),
      category: i18n._(S.cmdCategoryView),
      onSelect: file.explorer.collapseAll,
    },
    {
      id: "terminal.toggle",
      title: i18n._(S.cmdToggleTerminal),
      description: i18n._(S.cmdToggleTerminalDesc),
      category: i18n._(S.cmdCategoryView),
      keybind: "ctrl+`",
      slash: "terminal",
      onSelect: () => {
        const bottom = workbench.surface("bottom")
        const active = bottom.activeTab()
        if (bottom.opened() && active?.panelId === "terminal") {
          bottom.close()
          return
        }
        void workbench.openPanel("terminal", { reuseExisting: true })
      },
    },
    {
      id: "workspace.close",
      title: i18n._(S.cmdCloseSideWs),
      description: i18n._(S.cmdCloseSideWsDesc),
      category: i18n._(S.cmdCategoryView),
      keybind: "mod+shift+w",
      disabled: !workbench.surface("side").opened(),
      slash: "workspace",
      onSelect: () => {
        workbench.surface("side").close()
      },
    },
    {
      id: "terminal.new",
      title: i18n._(S.cmdNewTerminal),
      description: i18n._(S.cmdNewTerminalDesc),
      category: i18n._(S.cmdCategoryTerminal),
      keybind: "ctrl+shift+`",
      onSelect: () => {
        void workbench.openPanel("terminal", { forceNew: true })
      },
    },
    {
      id: "message.previous",
      title: i18n._(S.cmdPrevMessage),
      description: i18n._(S.cmdPrevMessageDesc),
      category: i18n._(S.cmdCategorySession),
      keybind: "mod+arrowup",
      disabled: !routeParams.id,
      onSelect: () => navigateMessageByOffset(-1),
    },
    {
      id: "message.next",
      title: i18n._(S.cmdNextMessage),
      description: i18n._(S.cmdNextMessageDesc),
      category: i18n._(S.cmdCategorySession),
      keybind: "mod+arrowdown",
      disabled: !routeParams.id,
      onSelect: () => navigateMessageByOffset(1),
    },
    {
      id: "model.choose",
      title: i18n._(S.cmdChooseModel),
      description: i18n._(S.cmdChooseModelDesc),
      category: i18n._(S.cmdCategoryModel),
      keybind: "mod+'",
      slash: "model",
      onSelect: () => dialog.show(() => <DialogSelectModel />),
    },
    {
      id: "mcp.toggle",
      title: i18n._(S.cmdToggleMcp),
      description: i18n._(S.cmdToggleMcpDesc),
      category: i18n._(S.cmdCategoryMcp),
      keybind: "mod+;",
      slash: "mcp",
      onSelect: () => dialog.show(() => <DialogSelectMcp />),
    },
    {
      id: "agent.cycle",
      title: i18n._(S.cmdCycleAgent),
      description: i18n._(S.cmdCycleAgentDesc),
      category: i18n._(S.cmdCategoryAgent),
      keybind: "mod+.",
      slash: "agent",
      onSelect: () => local.agent.move(1),
    },
    {
      id: "agent.cycle.reverse",
      title: i18n._(S.cmdCycleAgentRev),
      description: i18n._(S.cmdCycleAgentRevDesc),
      category: i18n._(S.cmdCategoryAgent),
      keybind: "shift+mod+.",
      onSelect: () => local.agent.move(-1),
    },
    {
      id: "model.variant.cycle",
      title: i18n._(S.cmdCycleEffort),
      description: i18n._(S.cmdCycleEffortDesc),
      category: i18n._(S.cmdCategoryModel),
      keybind: "shift+mod+t",
      onSelect: () => {
        local.model.variant.cycle()
        showToast({
          type: "info",
          title: i18n._(S.cmdToastEffortChanged),
          description: i18n._({
            ...S.cmdToastEffortChangedDesc,
            values: { effort: local.model.variant.displayed() ?? i18n._(S.cmdDefaultEffort) },
          }),
        })
      },
    },
    {
      id: "session.undo",
      title: i18n._(S.cmdUndo),
      description: i18n._(S.cmdUndoDesc),
      category: i18n._(S.cmdCategorySession),
      slash: "undo",
      disabled: !routeParams.id || (visibleUserMessages()?.length ?? 0) === 0,
      onSelect: async () => {
        const message = visibleUserMessages().at(-1)
        if (!message) return
        // Route through rewind confirm dialog (spec §3.3: first undo always confirms)
        params.onRewind?.(message)
      },
    },
    {
      id: "session.redo",
      title: i18n._(S.cmdRedo),
      description: i18n._(S.cmdRedoDesc),
      category: i18n._(S.cmdCategorySession),
      slash: "redo",
      disabled: !routeParams.id || info()?.history?.rollback?.canUnrollback !== true,
      onSelect: async () => {
        const sessionID = routeParams.id
        if (!sessionID) return
        await sdk.client.session.unrollback({ sessionID })
        prompt.resetDraft()
        setActiveMessage(userMessages().at(-1))
      },
    },
    {
      id: "session.rewind_to_here",
      title: i18n._(S.cmdRewindToHere),
      description: i18n._(S.cmdRewindToHereDesc),
      category: i18n._(S.cmdCategorySession),
      disabled: !routeParams.id || !activeMessage(),
      onSelect: async () => {
        const message = activeMessage()
        if (!message) return
        // Route through rewind confirm dialog (spec §3.2: always confirm)
        params.onRewind?.(message)
      },
    },
    {
      id: "session.restore_files",
      title: i18n._(S.cmdRestoreFiles),
      description: i18n._(S.cmdRestoreFilesDesc),
      category: i18n._(S.cmdCategorySession),
      disabled: !routeParams.id || (info()?.history?.rollback?.patchPartIDs.length ?? 0) === 0,
      onSelect: async () => {
        const sessionID = routeParams.id
        const rollback = info()?.history?.rollback
        if (!sessionID || !rollback) return
        const result = await sdk.client.session.files.restore({ sessionID, rollbackID: rollback.id })
        const restoredFiles = result.data?.restoredFiles.length ?? 0
        showToast({
          type: "success",
          title: i18n._(S.cmdToastFilesRestored),
          description: i18n._({ ...S.cmdToastFilesRestoredDesc, values: { count: restoredFiles } }),
        })
      },
    },
    {
      id: "session.compact",
      title: i18n._(S.cmdCompact),
      description: i18n._(S.cmdCompactDesc),
      category: i18n._(S.cmdCategorySession),
      slash: "compact",
      disabled: !routeParams.id || (visibleUserMessages()?.length ?? 0) === 0,
      onSelect: async () => {
        const sessionID = routeParams.id
        if (!sessionID) return
        await compactSessionWithCurrentModel({
          sdk,
          local,
          sessionID,
          notices: {
            noModel: { title: i18n._(S.cmdToastNoModel), description: i18n._(S.cmdToastNoModelDesc) },
            failure: { title: i18n._(S.cmdToastCompactFailed), description: i18n._(S.cmdToastCompactFailedDesc) },
          },
        })
      },
    },
    {
      id: "session.fork",
      title: i18n._(S.cmdFork),
      description: i18n._(S.cmdForkDesc),
      category: i18n._(S.cmdCategorySession),
      keybind: "mod+shift+f",
      disabled: !routeParams.id,
      onSelect: async () => {
        const sessionID = routeParams.id
        if (!sessionID) return
        const forked = await sdk.client.session.fork({
          sessionID,
          workspace: { mode: "current" },
          controlProfile: info()?.controlProfile ?? sync.data.config.controlProfile,
        })
        if (forked.data) navigate(`/${routeParams.dir}/session/${forked.data.id}`)
      },
    },
  ])
}
