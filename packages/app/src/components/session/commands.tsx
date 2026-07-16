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

  command.register(() => [
    {
      id: "session.new",
      title: "New session",
      description: "Start a fresh conversation",
      category: "Session",
      keybind: "mod+shift+s",
      slash: "new",
      onSelect: () => {
        navigate(`/${routeParams.dir}/session`)
      },
    },
    {
      id: "file.open",
      title: "Open file",
      description: "Search and open a file",
      category: "File",
      keybind: "mod+p",
      slash: "open",
      onSelect: () => dialog.show(() => <DialogSelectFile onSelect={(path) => void file.openWorkspaceFile(path)} />),
    },
    {
      id: "file.refresh",
      title: "Refresh current file",
      description: "Reload the active file and expanded folders",
      category: "File",
      onSelect: file.explorer.refresh,
    },
    {
      id: "file.tree.toggle",
      title: "Toggle file tree",
      description: "Show or hide the file explorer",
      category: "View",
      onSelect: () => file.explorer.setOpen(!file.explorer.open()),
    },
    {
      id: "file.tree.collapse",
      title: "Collapse folders",
      description: "Collapse all folders in the file explorer",
      category: "View",
      onSelect: file.explorer.collapseAll,
    },
    {
      id: "terminal.toggle",
      title: "Toggle terminal",
      description: "Show or hide the terminal",
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
      title: "Close side workspace",
      description: "Close the side workspace",
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
      title: "New terminal",
      description: "Create a new terminal tab",
      category: "Terminal",
      keybind: "ctrl+shift+`",
      onSelect: () => {
        void workbench.openPanel("terminal", { forceNew: true })
      },
    },
    {
      id: "message.previous",
      title: "Previous message",
      description: "Go to the previous user message",
      category: "Session",
      keybind: "mod+arrowup",
      disabled: !routeParams.id,
      onSelect: () => navigateMessageByOffset(-1),
    },
    {
      id: "message.next",
      title: "Next message",
      description: "Go to the next user message",
      category: "Session",
      keybind: "mod+arrowdown",
      disabled: !routeParams.id,
      onSelect: () => navigateMessageByOffset(1),
    },
    {
      id: "model.choose",
      title: "Choose model",
      description: "Select a different model",
      category: "Model",
      keybind: "mod+'",
      slash: "model",
      onSelect: () => dialog.show(() => <DialogSelectModel />),
    },
    {
      id: "mcp.toggle",
      title: "Toggle MCPs",
      description: "Toggle MCPs",
      category: "MCP",
      keybind: "mod+;",
      slash: "mcp",
      onSelect: () => dialog.show(() => <DialogSelectMcp />),
    },
    {
      id: "agent.cycle",
      title: "Cycle agent",
      description: "Switch to the next agent",
      category: "Agent",
      keybind: "mod+.",
      slash: "agent",
      onSelect: () => local.agent.move(1),
    },
    {
      id: "agent.cycle.reverse",
      title: "Cycle agent backwards",
      description: "Switch to the previous agent",
      category: "Agent",
      keybind: "shift+mod+.",
      onSelect: () => local.agent.move(-1),
    },
    {
      id: "model.variant.cycle",
      title: "Cycle thinking effort",
      description: "Switch to the next effort level",
      category: "Model",
      keybind: "shift+mod+t",
      onSelect: () => {
        local.model.variant.cycle()
        showToast({
          type: "info",
          title: "Thinking effort changed",
          description: "The thinking effort has been changed to " + (local.model.variant.displayed() ?? "Default"),
        })
      },
    },
    {
      id: "session.undo",
      title: "Undo",
      description: "Undo the last message turn",
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
      title: "Redo",
      description: "Restore the last undone message turn",
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
      title: "Rewind to here",
      description: "Rewind session to the active message",
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
      title: "Restore files",
      description: "Restore files changed by the undone turn",
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
          title: "Files restored",
          description: `${restoredFiles} file${restoredFiles === 1 ? "" : "s"} restored`,
        })
      },
    },
    {
      id: "session.compact",
      title: "Compact session",
      description: "Summarize the session to reduce context size",
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
            title: "No model selected",
            description: "Connect a provider to summarize this session",
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
      title: "Fork session",
      description: "Fork the current message history",
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
