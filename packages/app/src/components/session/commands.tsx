import { DialogSelectFile, DialogSelectModel, DialogSelectMcp } from "@/components/dialog"
import type { useCommand } from "@/context/command"
import type { useLocal } from "@/context/local"
import type { usePrompt } from "@/context/prompt"
import type { useSDK } from "@/context/sdk"
import type { useSync } from "@/context/sync"
import type { useTerminal } from "@/context/terminal"
import type { useLayout } from "@/context/layout"
import { useWorkspace } from "@/context/workspace"
import { extractPromptFromParts } from "@/utils/prompt"
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
}) {
  const {
    command,
    sdk,
    sync,
    local,
    dialog,
    terminal,
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

  const workspace = useWorkspace()

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
      onSelect: () => dialog.show(() => <DialogSelectFile />),
    },
    {
      id: "terminal.toggle",
      title: "Toggle terminal",
      description: "Show or hide the terminal",
      category: "View",
      keybind: "ctrl+`",
      slash: "terminal",
      onSelect: () => layout.terminal.toggle(),
    },
    {
      id: "workspace.close",
      title: "Close workspace drawer",
      description: "Close the workspace drawer",
      category: "View",
      keybind: "mod+shift+w",
      disabled: !routeParams.id || !workspace.opened(),
      slash: "workspace",
      onSelect: () => {
        workspace.closePanel()
        workspace.setActive(null)
      },
    },
    {
      // TODO: redesign sidebar — disabled for now
      id: "review.toggle",
      title: "Toggle review",
      description: "Show or hide the review panel",
      category: "View",
      keybind: "mod+shift+r",
      disabled: true,
      onSelect: () => {},
    },
    {
      id: "terminal.new",
      title: "New terminal",
      description: "Create a new terminal tab",
      category: "Terminal",
      keybind: "ctrl+shift+`",
      onSelect: () => terminal.new(),
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
          description: "The thinking effort has been changed to " + (local.model.variant.current() ?? "Default"),
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
        const sessionID = routeParams.id
        if (!sessionID) return
        if (status()?.type !== "idle") {
          await sdk.client.session.abort({ sessionID }).catch(() => {})
        }
        const message = visibleUserMessages().at(-1)
        if (!message) return
        await sdk.client.session.rollback({ sessionID, numTurns: 1 })
        const parts = sync.data.part[message.id]
        if (parts) {
          const restored = extractPromptFromParts(parts, { directory: sdk.directory })
          prompt.set(restored)
        }
        const priorMessage = userMessages().findLast((x) => x.id < message.id)
        setActiveMessage(priorMessage)
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
        prompt.reset()
        setActiveMessage(userMessages().at(-1))
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
        const forked = await sdk.client.session.fork({ sessionID, workspace: { mode: "current" } })
        if (forked.data) navigate(`/${routeParams.dir}/session/${forked.data.id}`)
      },
    },
  ])
}
