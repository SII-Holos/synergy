import { onCleanup, onMount, type ParentProps } from "solid-js"
import { getSemanticIcon } from "@ericsanchezok/synergy-ui/semantic-icon"
import { FileIcon } from "@ericsanchezok/synergy-ui/file-icon"
import { useDialog } from "@ericsanchezok/synergy-ui/context/dialog"
import { useTerminal } from "@/context/terminal"
import { DialogSelectFile } from "@/components/dialog"
import { registerWorkbenchPanel } from "@/plugin/registries/workbench-panel-registry"
import { BrowserWorkbenchContent } from "./tool-browser"
import { NotesWorkbenchContent } from "./tool-notes"
import { SessionReviewWorkbenchContent } from "./tool-session-review"
import { TerminalWorkbenchContent } from "./tool-terminal"
import { FileWorkbenchContent, shortestUniqueFileTitle } from "@/components/file-workbench"

export function BuiltinWorkbenchPanelsProvider(props: ParentProps) {
  const terminal = useTerminal()
  const dialog = useDialog()
  const disposers: VoidFunction[] = []

  onMount(() => {
    disposers.push(
      registerWorkbenchPanel({
        id: "notes",
        label: "Notes",
        icon: "notebook-pen",
        surface: "side",
        cardinality: "singleton",
        pluginId: "builtin",
        order: 10,
        component: NotesWorkbenchContent,
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
        component: SessionReviewWorkbenchContent,
        title: () => "Review",
      }),
      registerWorkbenchPanel({
        id: "file",
        label: "File",
        icon: "file-text",
        surface: "side",
        cardinality: "multi",
        requiresSession: true,
        supportsDraftSession: true,
        pluginId: "builtin",
        order: 18,
        component: FileWorkbenchContent,
        createTab() {
          return new Promise((resolve) => {
            let selected = false
            dialog.show(
              () => (
                <DialogSelectFile
                  onSelect={(path) => {
                    selected = true
                    resolve({ resourceId: path, title: path.split("/").at(-1), source: "picker" })
                  }}
                />
              ),
              () => {
                if (!selected) resolve(undefined)
              },
            )
          })
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
        id: "browser",
        label: "Browser",
        icon: "globe",
        surface: "side",
        cardinality: "singleton",
        requiresSession: true,
        pluginId: "builtin",
        order: 20,
        component: BrowserWorkbenchContent,
      }),
      registerWorkbenchPanel({
        id: "terminal",
        label: "Terminal",
        icon: "terminal",
        surface: "bottom",
        cardinality: "multi",
        pluginId: "builtin",
        order: 10,
        component: TerminalWorkbenchContent,
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
