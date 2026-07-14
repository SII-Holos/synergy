import { onCleanup, onMount, type ParentProps } from "solid-js"
import { getSemanticIcon } from "@ericsanchezok/synergy-ui/semantic-icon"
import { FileIcon } from "@ericsanchezok/synergy-ui/file-icon"
import { useTerminal } from "@/context/terminal"
import { useFile } from "@/context/file"
import { registerWorkbenchPanel } from "@/plugin/registries/workbench-panel-registry"
import { shortestUniqueFileTitle } from "@/components/file-workbench/model"

export function BuiltinWorkbenchPanelsProvider(props: ParentProps) {
  const terminal = useTerminal()
  const file = useFile()
  const disposers: VoidFunction[] = []

  onMount(() => {
    disposers.push(
      registerWorkbenchPanel({
        id: "notes",
        label: "Notes",
        icon: getSemanticIcon("notes.main"),
        surface: "side",
        cardinality: "singleton",
        pluginId: "builtin",
        order: 10,
        loader: async () => ({ default: (await import("./tool-notes")).NotesWorkbenchContent }),
      }),
      registerWorkbenchPanel({
        id: "session-review",
        label: "Review",
        icon: getSemanticIcon("command.review"),
        surface: "side",
        cardinality: "singleton",
        requiresSession: true,
        pluginId: "builtin",
        order: 15,
        loader: async () => ({ default: (await import("./tool-session-review")).SessionReviewWorkbenchContent }),
        title: () => "Review",
      }),
      registerWorkbenchPanel({
        id: "file",
        label: "Files",
        icon: getSemanticIcon("workspace.files"),
        surface: "side",
        cardinality: "multi",
        requiresSession: true,
        supportsDraftSession: true,
        pluginId: "builtin",
        order: 18,
        loader: async () => ({ default: (await import("@/components/file-workbench/content")).FileWorkbenchContent }),
        createTab() {
          file.explorer.setOpen(true)
          return { title: "Open file", source: "explorer" }
        },
        title(tab, siblings) {
          if (!tab.resourceId) return tab.title
          return shortestUniqueFileTitle(
            tab.resourceId,
            siblings
              .filter((candidate) => candidate.panelId === "file" && !!candidate.resourceId)
              .map((candidate) => candidate.resourceId!),
          )
        },
        tabIcon(tab) {
          return <FileIcon node={{ path: tab.resourceId ?? tab.title ?? "file", type: "file" }} class="size-4" />
        },
      }),
      registerWorkbenchPanel({
        id: "boss",
        label: "Boss",
        icon: getSemanticIcon("performance.network"),
        surface: "side",
        cardinality: "singleton",
        requiresSession: true,
        pluginId: "builtin",
        order: 19,
        loader: async () => ({ default: (await import("./tool-boss")).BossWorkbenchContent }),
      }),
      registerWorkbenchPanel({
        id: "browser",
        label: "Browser",
        icon: getSemanticIcon("browser.main"),
        surface: "side",
        cardinality: "singleton",
        requiresSession: true,
        pluginId: "builtin",
        order: 20,
        loader: async () => ({ default: (await import("./tool-browser")).BrowserWorkbenchContent }),
      }),
      registerWorkbenchPanel({
        id: "terminal",
        label: "Terminal",
        icon: getSemanticIcon("terminal.main"),
        surface: "bottom",
        cardinality: "multi",
        pluginId: "builtin",
        order: 10,
        loader: async () => ({ default: (await import("./tool-terminal")).TerminalWorkbenchContent }),
        async createTab() {
          const pty = await terminal.new()
          if (!pty) return undefined
          return {
            id: `terminal:${pty.id}`,
            resourceId: pty.id,
            title: pty.title,
            source: "terminal",
          }
        },
        async onCloseTab(tab) {
          if (!tab.resourceId) return
          if (!terminal.all().some((pty) => pty.id === tab.resourceId)) return
          await terminal.close(tab.resourceId)
        },
        title(tab) {
          if (!tab.resourceId) return tab.title
          return terminal.all().find((pty) => pty.id === tab.resourceId)?.title ?? tab.title
        },
      }),
    )
  })

  onCleanup(() => {
    for (const dispose of disposers.splice(0)) dispose()
  })

  return <>{props.children}</>
}
