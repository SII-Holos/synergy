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
      title: S.cmdNewSession.message,
      description: S.cmdNewSessionDesc.message,
      category: "Session",
      keybind: "mod+shift+s",
      slash: "new",
      onSelect: () => {
        navigate(`/${routeParams.dir}/session`)
      },
    },
    {
      id: "file.open",
      title: S.cmdOpenFile.message,
      description: S.cmdOpenFileDesc.message,
      category: "File",
      keybind: "mod+p",
      slash: "open",
      onSelect: () => dialog.show(() => <DialogSelectFile onSelect={(path) => void file.openWorkspaceFile(path)} />),
    },
    {
      id: "file.refresh",
      title: S.cmdRefreshFile.message,
      description: S.cmdRefreshFileDesc.message,
      category: "File",
      onSelect: file.explorer.refresh,
    },
    {
      id: "file.tree.toggle",
      title: S.cmdToggleFileTree.message,
      description: S.cmdToggleFileTreeDesc.message,
      category: "View",
      onSelect: () => file.explorer.setOpen(!file.explorer.open()),
    },
    {
      id: "file.tree.collapse",
      title: S.cmdCollapseFolders.message,
      description: S.cmdCollapseFoldersDesc.message,
      category: "View",
      onSelect: file.explorer.collapseAll,
    },
    {
      id: "terminal.toggle",
      title: S.cmdToggleTerminal.message,
      description: S.cmdToggleTerminalDesc.message,
      category: "View",
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
      title: S.cmdCloseSideWs.message,
      description: S.cmdCloseSideWsDesc.message,
      category: "View",
      keybind: "mod+shift+w",
      disabled: !workbench.surface("side").opened(),
      slash: "workspace",
      onSelect: () => {
        workbench.surface("side").close()
      },
    },
    {
      id: "terminal.new",
      title: S.cmdNewTerminal.message,
      description: S.cmdNewTerminalDesc.message,
      category: "Terminal",
      keybind: "ctrl+shift+`",
      onSelect: () => {
        void workbench.openPanel("terminal", { forceNew: true })
      },
    },
    {
      id: "message.previous",
      title: S.cmdPrevMessage.message,
      description: S.cmdPrevMessageDesc.message,
      category: "Session",
      keybind: "mod+arrowup",
      disabled: !routeParams.id,
      onSelect: () => navigateMessageByOffset(-1),
    },
    {
      id: "message.next",
      title: S.cmdNextMessage.message,
      description: S.cmdNextMessageDesc.message,
      category: "Session",
      keybind: "mod+arrowdown",
      disabled: !routeParams.id,
      onSelect: () => navigateMessageByOffset(1),
    },
    {
      id: "model.choose",
      title: S.cmdChooseModel.message,
      description: S.cmdChooseModelDesc.message,
      category: "Model",
      keybind: "mod+'",
      slash: "model",
      onSelect: () => dialog.show(() => <DialogSelectModel />),
    },
    {
      id: "mcp.toggle",
      title: S.cmdToggleMcp.message,
      description: S.cmdToggleMcpDesc.message,
      category: "MCP",
      keybind: "mod+;",
      slash: "mcp",
      onSelect: () => dialog.show(() => <DialogSelectMcp />),
    },
    {
      id: "agent.cycle",
      title: S.cmdCycleAgent.message,
      description: S.cmdCycleAgentDesc.message,
      category: "Agent",
      keybind: "mod+.",
      slash: "agent",
      onSelect: () => local.agent.move(1),
    },
    {
      id: "agent.cycle.reverse",
      title: S.cmdCycleAgentRev.message,
      description: S.cmdCycleAgentRevDesc.message,
      category: "Agent",
      keybind: "shift+mod+.",
      onSelect: () => local.agent.move(-1),
    },
    {
      id: "model.variant.cycle",
      title: S.cmdCycleEffort.message,
      description: S.cmdCycleEffortDesc.message,
      category: "Model",
      keybind: "shift+mod+t",
      onSelect: () => {
        local.model.variant.cycle()
        showToast({
          type: "info",
          title: S.cmdToastEffortChanged.message,
          description: i18n._({
            ...S.cmdToastEffortChangedDesc,
            values: { effort: local.model.variant.displayed() ?? "Default" },
          }),
        })
      },
    },
    {
      id: "session.undo",
      title: S.cmdUndo.message,
      description: S.cmdUndoDesc.message,
      category: "Session",
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
      title: S.cmdRedo.message,
      description: S.cmdRedoDesc.message,
      category: "Session",
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
      title: S.cmdRewindToHere.message,
      description: S.cmdRewindToHereDesc.message,
      category: "Session",
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
      title: S.cmdRestoreFiles.message,
      description: S.cmdRestoreFilesDesc.message,
      category: "Session",
      disabled: !routeParams.id || (info()?.history?.rollback?.patchPartIDs.length ?? 0) === 0,
      onSelect: async () => {
        const sessionID = routeParams.id
        const rollback = info()?.history?.rollback
        if (!sessionID || !rollback) return
        const result = await sdk.client.session.files.restore({ sessionID, rollbackID: rollback.id })
        const restoredFiles = result.data?.restoredFiles.length ?? 0
        showToast({
          type: "success",
          title: S.cmdToastFilesRestored.message,
          description: i18n._({ ...S.cmdToastFilesRestoredDesc, values: { count: restoredFiles } }),
        })
      },
    },
    {
      id: "session.compact",
      title: S.cmdCompact.message,
      description: S.cmdCompactDesc.message,
      category: "Session",
      slash: "compact",
      disabled: !routeParams.id || (visibleUserMessages()?.length ?? 0) === 0,
      onSelect: async () => {
        const sessionID = routeParams.id
        if (!sessionID) return
        const model = local.model.current()
        if (!model) {
          showToast({
            type: "warning",
            title: S.cmdToastNoModel.message,
            description: S.cmdToastNoModelDesc.message,
          })
          return
        }
        await sdk.client.session.summarize({
          sessionID,
          modelID: model.id,
          providerID: model.provider.id,
        })
      },
    },
    {
      id: "session.fork",
      title: S.cmdFork.message,
      description: S.cmdForkDesc.message,
      category: "Session",
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
