import { createEffect, onCleanup, type ParentProps } from "solid-js"
import { getSemanticIcon } from "@ericsanchezok/synergy-ui/semantic-icon"
import { FileIcon } from "@ericsanchezok/synergy-ui/file-icon"
import { useTerminal } from "@/context/terminal"
import { useFile } from "@/context/file"
import { registerWorkbenchPanel } from "@/plugin/registries/workbench-panel-registry"
import { shortestUniqueFileTitle } from "@/components/file-workbench/model"
import { panels as P } from "@/locales/messages"
import { useLocale } from "@/context/locale"
import { createContextWorkbenchPanel } from "./context-panel-entry"
export function BuiltinWorkbenchPanelsProvider(props: ParentProps) {
  const terminal = useTerminal()
  const file = useFile()
  const { controller, i18n } = useLocale()
  const disposers: VoidFunction[] = []

  createEffect(() => {
    controller.activeLocale()
    const previousDisposers = disposers.splice(0)
    disposers.push(
      registerWorkbenchPanel({
        id: "notes",
        label: i18n._(P.notes),
        icon: getSemanticIcon("notes.main"),
        surface: "side",
        cardinality: "singleton",
        pluginId: "builtin",
        order: 10,
        loader: async () => ({ default: (await import("./tool-notes")).NotesWorkbenchContent }),
      }),
      registerWorkbenchPanel(createContextWorkbenchPanel(i18n._(P.context))),
      registerWorkbenchPanel({
        id: "session-review",
        label: i18n._(P.review),
        icon: getSemanticIcon("command.review"),
        surface: "side",
        cardinality: "singleton",
        requiresSession: true,
        pluginId: "builtin",
        order: 15,
        loader: async () => ({ default: (await import("./tool-session-review")).SessionReviewWorkbenchContent }),
        title: () => i18n._(P.review),
      }),
      registerWorkbenchPanel({
        id: "attachment",
        label: i18n._(P.attachment),
        icon: getSemanticIcon("workspace.files"),
        surface: "side",
        cardinality: "multi",
        requiresSession: true,
        launchable: false,
        pluginId: "builtin",
        order: 17,
        loader: async () => ({
          default: (await import("@/components/attachment-workbench/content")).AttachmentWorkbenchContent,
        }),
        title: (tab) => tab.title ?? i18n._(P.attachment),
        tabIcon(tab) {
          return <FileIcon node={{ path: tab.title ?? "attachment", type: "file" }} class="size-4" />
        },
      }),
      registerWorkbenchPanel({
        id: "file",
        label: i18n._(P.files),
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
          return { title: i18n._(P.openFile), source: "explorer" }
        },
        title(tab, siblings) {
          if (!tab.resourceId) return tab.source === "explorer" ? i18n._(P.openFile) : tab.title
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
        label: i18n._(P.browser),
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
        label: i18n._(P.terminal),
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
    for (const dispose of previousDisposers) dispose()
  })

  onCleanup(() => {
    for (const dispose of disposers.splice(0)) dispose()
  })

  return <>{props.children}</>
}
