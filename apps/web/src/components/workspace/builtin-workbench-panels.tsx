import { usePlatform } from "@/context/platform"
import { useGlobalSDK } from "@/context/global-sdk"
import { runtimeFeatureAvailable } from "../runtime-features"
import { createEffect, createMemo, lazy, Show, Suspense, onCleanup, onMount, type ParentProps } from "solid-js"
import { useNavigate, useParams } from "@solidjs/router"
import { base64Encode } from "@ericsanchezok/synergy-util/encode"
import { useSDK } from "@/context/sdk"
import { useWorkbenchPanels } from "@/context/workbench"
import { browserWorkbenchRoute, browserTabURL } from "./browser/browser-workbench-model"
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
import { E } from "@/components/execution/i18n"
export function BuiltinWorkbenchPanelsProvider(props: ParentProps) {
  const { capabilities } = useGlobalSDK()
  const platform = usePlatform()
  const sdk = useSDK()
  const params = useParams()
  const navigate = useNavigate()
  const workbench = useWorkbenchPanels()
  let openingBrowser = false
  onMount(() => {
    const key = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        event.altKey ||
        event.shiftKey ||
        event.key.toLowerCase() !== "t" ||
        !(navigator.platform.includes("Mac") ? event.metaKey : event.ctrlKey)
      )
        return
      if (!platform.browserNative || !runtimeFeatureAvailable("panel", "browser", capabilities.has)) return
      event.preventDefault()
      void workbench.openPanel("browser", { forceNew: true })
    }
    window.addEventListener("keydown", key)
    onCleanup(() => window.removeEventListener("keydown", key))
  })
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
      register(createContextWorkbenchPanel(i18n._(E.title))),
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
        requiresSession: false,
        pluginId: "builtin",
        order: 20,
        loader: async () => ({ default: (await import("./tool-browser")).BrowserWorkbenchContent }),
        async createTab() {
          if (openingBrowser) return
          openingBrowser = true
          try {
            const route = browserRoute()
            const { openBrowserWorkbenchPage } = await import("./browser/browser-workbench-api")
            if (!route) {
              const scopeKey = sdk.scopeKey
              const created = await sdk.client.session.create(
                { workspace: { mode: "current" } },
                { throwOnError: true },
              )
              if (!created.data || params.id || sdk.scopeKey !== scopeKey) return
              const newRoute = {
                sessionID: created.data.id,
                path_directory: sdk.directory ?? sdk.scopeID ?? scopeKey,
                query_directory: sdk.directory,
                scopeID: sdk.scopeID,
              }
              const tab = await openBrowserWorkbenchPage({
                client: sdk.client,
                serverUrl: sdk.url,
                bridge: platform.browserNative,
                route: newRoute,
              })
              if (params.id || sdk.scopeKey !== scopeKey) return
              navigate(`/${base64Encode(scopeKey)}/session/${created.data.id}`)
              queueMicrotask(() => void workbench.openPanel("browser", { init: tab }))
              return
            }
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
          } catch (error) {
            showToast({
              type: "error",
              title: i18n._(B.issue),
              description: normalizeBrowserError(error, "Page could not be opened. Retry.").message,
            })
          } finally {
            openingBrowser = false
          }
        },
        tabActions(tab) {
          const url = browserTabURL(tab)
          const route = browserWorkbenchRoute(tab.state) ?? browserRoute()
          const run = (action: () => Promise<void>) =>
            action().catch((error) => {
              showToast({
                type: "error",
                title: i18n._(B.issue),
                description: normalizeBrowserError(error, "Browser action failed").message,
              })
            })
          return [
            {
              id: "reload",
              label: i18n._(B.reload),
              disabled: !route || !tab.resourceId,
              run: () =>
                run(async () => {
                  if (!route || !tab.resourceId) return
                  const { browserWorkbenchAccess } = await import("./browser/browser-workbench-api")
                  const { BROWSER_PROTOCOL_VERSION } = await import("@ericsanchezok/synergy-browser-core")
                  const { createBrowserCommandId } = await import("./browser/browser-command")
                  await sdk.client.browser.control(
                    {
                      ...(await browserWorkbenchAccess({
                        client: sdk.client,
                        serverUrl: sdk.url,
                        bridge: platform.browserNative,
                        route,
                      })),
                      browserControlRequest: {
                        protocolVersion: BROWSER_PROTOCOL_VERSION,
                        pageId: tab.resourceId,
                        commandId: createBrowserCommandId(),
                        command: { type: "reload" },
                      },
                    },
                    { throwOnError: true },
                  )
                }),
            },
            {
              id: "copy",
              label: i18n._({ id: "browser.tab.copyAddress", message: "Copy page address" }),
              disabled: !/^https?:/.test(url),
              run: () =>
                run(async () => {
                  if (!(await platform.clipboard?.writeText(url))) await navigator.clipboard.writeText(url)
                }),
            },
            {
              id: "external",
              label: i18n._(B.openExternal),
              disabled: !/^https?:/.test(url),
              run: () => {
                platform.openLink(url)
              },
            },
          ]
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
