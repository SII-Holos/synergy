import { usePlatform } from "@/context/platform"
import { useGlobalSDK } from "@/context/global-sdk"
import { runtimeFeatureAvailable } from "../runtime-features"
import { createEffect, createMemo, lazy, Show, Suspense, onCleanup, type ParentProps } from "solid-js"
import { useParams } from "@solidjs/router"
import { useSDK } from "@/context/sdk"
import { useWorkbenchPanels } from "@/context/workbench"
import { browserWorkbenchRoute } from "./browser/browser-workbench-model"
import { getSemanticIcon } from "@ericsanchezok/synergy-ui/semantic-icon"
import { FileIcon } from "@ericsanchezok/synergy-ui/file-icon"
import { showToast } from "@ericsanchezok/synergy-ui/toast"
import { normalizeBrowserError } from "./browser/browser-error"
import { useTerminal } from "@/context/terminal"
import { workspaceFilePath } from "@/context/file/workspace"
import { useFile } from "@/context/file"
import { registerWorkbenchPanel } from "@/plugin/registries/workbench-panel-registry"
import { shortestUniqueFileTitle } from "@/components/file-workbench/model"
import { panels as P, browser as B } from "@/locales/messages"
import { useLocale } from "@/context/locale"
import { createContextWorkbenchPanel } from "./context-panel-entry"
import { createLatticeWorkbenchPanel } from "./lattice-panel-entry"
import { createBossWorkbenchPanel } from "./boss-panel-entry"
export function BuiltinWorkbenchPanelsProvider(props: ParentProps) {
  const { capabilities } = useGlobalSDK()
  const platform = usePlatform()
  const sdk = useSDK()
  const params = useParams()
  const workbench = useWorkbenchPanels()
  const browserRoute = createMemo(() =>
    params.id
      ? {
          sessionID: params.id,
          path_directory: params.dir ?? sdk.directory ?? sdk.scopeID ?? sdk.scopeKey,
          query_directory: sdk.directory,
          scopeID: sdk.scopeID,
        }
      : undefined,
  )
  const browserSync = createMemo(() =>
    Boolean(
      browserRoute() &&
        platform.browserNative &&
        runtimeFeatureAvailable("panel", "browser", capabilities.has) &&
        workbench
          .surface("side")
          .tabs()
          .some((tab) => tab.panelId === "browser"),
    ),
  )
  const register = (entry: Parameters<typeof registerWorkbenchPanel>[0]) =>
    runtimeFeatureAvailable("panel", entry.id, capabilities.has) &&
    (entry.id !== "browser" || Boolean(platform.browserNative))
      ? registerWorkbenchPanel(entry)
      : () => {}
  const terminal = useTerminal()
  const file = useFile()
  const { controller, i18n } = useLocale()
  const disposers: VoidFunction[] = []

  createEffect(() => {
    controller.activeLocale()
    // Dispose the previous registrations before re-registering: the slot
    // registry rejects duplicate ids, and the effect re-runs on locale
    // switches to relabel the builtin panels.
    for (const dispose of disposers.splice(0)) dispose()
    disposers.push(
      register({
        id: "notes",
        label: i18n._(P.notes),
        icon: getSemanticIcon("notes.main"),
        surface: "side",
        cardinality: "singleton",
        pluginId: "builtin",
        order: 10,
        loader: async () => ({ default: (await import("./tool-notes")).NotesWorkbenchContent }),
      }),
      register(createContextWorkbenchPanel(i18n._(P.context))),
      register({
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
      register(createLatticeWorkbenchPanel(i18n._(P.lattice))),
      register(createBossWorkbenchPanel(i18n._(P.boss))),
      register({
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
      register({
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
          return { title: i18n._(P.openFile), source: "explorer", state: { workspace: file.workspace } }
        },
        title(tab, siblings) {
          if (!tab.resourceId) return tab.source === "explorer" ? i18n._(P.openFile) : tab.title
          return shortestUniqueFileTitle(
            workspaceFilePath(tab.resourceId),
            siblings
              .filter((candidate) => candidate.panelId === "file" && !!candidate.resourceId)
              .map((candidate) => workspaceFilePath(candidate.resourceId)),
          )
        },
        tabIcon(tab) {
          return (
            <FileIcon
              node={{ path: workspaceFilePath(tab.resourceId) || tab.title || "file", type: "file" }}
              class="size-4"
            />
          )
        },
      }),
      register({
        id: "browser",
        label: i18n._(P.browser),
        icon: getSemanticIcon("browser.main"),
        surface: "side",
        cardinality: "multi",
        requiresSession: true,
        pluginId: "builtin",
        order: 20,
        loader: async () => ({ default: (await import("./tool-browser")).BrowserWorkbenchContent }),
        async createTab() {
          const route = browserRoute()
          if (!route) return
          const { openBrowserWorkbenchPage } = await import("./browser/browser-workbench-api")
          return openBrowserWorkbenchPage({
            client: sdk.client,
            serverUrl: sdk.url,
            bridge: platform.browserNative,
            route,
          }).catch((error) => {
            showToast({
              type: "error",
              title: i18n._(B.issue),
              description: normalizeBrowserError(error, "Page could not be opened. Retry.").message,
            })
            return undefined
          })
        },
        async onCloseTab(tab) {
          if (!tab.resourceId) return
          const route = browserWorkbenchRoute(tab.state) ?? browserRoute()
          if (!route) return false
          const { closeBrowserWorkbenchPage } = await import("./browser/browser-workbench-api")
          return closeBrowserWorkbenchPage({
            client: sdk.client,
            serverUrl: sdk.url,
            bridge: platform.browserNative,
            route,
            pageId: tab.resourceId,
          }).catch((error) => {
            showToast({
              type: "error",
              title: i18n._(B.issue),
              description: normalizeBrowserError(error, "Page could not be closed. Retry.").message,
            })
            return false
          })
        },
        title(tab) {
          return tab.title && tab.title !== "about:blank" ? tab.title : i18n._(B.newTab)
        },
      }),
      register({
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
  })

  onCleanup(() => {
    for (const dispose of disposers.splice(0)) dispose()
  })

  const BrowserSync = lazy(() =>
    import("./browser/browser-workbench-sync").then((module) => ({ default: module.BrowserWorkbenchSync })),
  )
  return [
    props.children,
    <Show when={browserSync()}>
      <Suspense>
        <BrowserSync route={browserRoute()!} />
      </Suspense>
    </Show>,
  ]
}
