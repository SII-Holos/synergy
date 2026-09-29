import { BrowserSettings } from "./browser-settings"
import { BrowserResultDialog, type BrowserCapture } from "./browser-result-dialog"
import { useBrowserDraft } from "./browser-draft"
import { BrowserDataDialog } from "./browser-data-settings"
import { useDialog } from "@ericsanchezok/synergy-ui/context/dialog"
import { Button } from "@ericsanchezok/synergy-ui/button"
import { BROWSER_PROTOCOL_VERSION, type BrowserAPISessionState } from "@ericsanchezok/synergy-browser-core"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { getSemanticIcon } from "@ericsanchezok/synergy-ui/semantic-icon"
import { createEffect, createMemo, createResource, createSignal, lazy, Show, on, untrack } from "solid-js"
import { Trans, useLingui } from "@lingui/solid"
import { useParams } from "@solidjs/router"
import { BrowserStoreProvider, createBrowserStore } from "./browser-store"
import { createBrowserWebSocket } from "./browser-ws"
import { AddressBar } from "./address-bar"
import { BrowserSurface } from "./browser-surface"
import { AgentAssistant } from "./agent-assistant"
import { AnnotationInput } from "./annotation-input"
import { browserDebug } from "./browser-debug"
import { useSDK } from "@/context/sdk"
import { usePlatform } from "@/context/platform"
import { useWorkbenchPanels } from "@/context/workbench"
import { browserPageTab } from "./browser-workbench-model"
import { createBrowserCommandId } from "./browser-command"
import { normalizeBrowserError } from "./browser-error"
import { browser as B } from "@/locales/messages"
import { resolveBrowserClientPresentation, type BrowserClientPresentationMode } from "./native-presentation-coordinator"
import type { WorkbenchPanelTab } from "@/plugin/registries/workbench-panel-registry"
import { resolvePendingBrowserNavigation } from "./browser-view-command"
const ConsolePanel = lazy(() => import("./console-panel").then((module) => ({ default: module.ConsolePanel })))
const NetworkPanel = lazy(() => import("./network-panel").then((module) => ({ default: module.NetworkPanel })))
const ElementsPanel = lazy(() => import("./elements-panel").then((module) => ({ default: module.ElementsPanel })))
const DownloadsPanel = lazy(() => import("./downloads-panel").then((module) => ({ default: module.DownloadsPanel })))
const AssetsPanel = lazy(() => import("./assets-panel").then((module) => ({ default: module.AssetsPanel })))

export function BrowserPanel(props: { tab: WorkbenchPanelTab }) {
  const params = useParams()
  const sdk = useSDK()
  const platform = usePlatform()
  const lingui = useLingui()
  const route = createMemo(() => {
    const sessionID = params.id
    const pathDirectory = params.dir ?? sdk.directory ?? sdk.scopeID ?? sdk.scopeKey
    return sessionID && pathDirectory ? { sessionID, pathDirectory, routeDirectory: params.dir } : null
  })
  const [initial, { refetch }] = createResource(route, async (input) => {
    const clientPresentation = await resolveBrowserClientPresentation({
      bridge: platform.browserNative,
      serverUrl: sdk.url,
    })
    const response = await sdk.client.browser.session({
      path_directory: input.pathDirectory,
      query_directory: sdk.directory,
      scopeID: sdk.scopeID,
      mode: "session",
      sessionID: input.sessionID,
      presentation: "auto",
      protocolVersion: BROWSER_PROTOCOL_VERSION,
    })
    if (!response.data) throw response.error ?? new Error("Browser session bootstrap failed")
    return { session: response.data, clientPresentation }
  })

  return (
    <Show
      keyed
      when={!initial.loading ? initial() : undefined}
      fallback={
        <div class="browser-workspace flex h-full flex-col items-center justify-center gap-3 p-4 text-text-weak">
          <div class="browser-empty-mark">
            <Icon name={getSemanticIcon("browser.main")} class="size-4" />
          </div>
          <span class="text-14-medium text-text-strong">
            {initial.error
              ? normalizeBrowserError(initial.error, lingui._(B.bootstrapFailed.id)).message
              : lingui._(B.connecting.id)}
          </span>
          <Show when={initial.error}>
            <Button size="small" variant="primary" onClick={() => void refetch()}>
              <Trans id={B.retry.id} message={B.retry.message} />
            </Button>
          </Show>
        </div>
      }
    >
      {(state) => {
        const browser = createBrowserStore()
        return (
          <BrowserPanelInner
            browser={browser}
            initial={state.session}
            clientPresentation={state.clientPresentation}
            routeDirectory={route()?.routeDirectory}
            sessionID={route()!.sessionID}
            tab={props.tab}
          />
        )
      }}
    </Show>
  )
}

function BrowserPanelInner(props: {
  browser: ReturnType<typeof createBrowserStore>
  initial: BrowserAPISessionState
  clientPresentation: BrowserClientPresentationMode
  routeDirectory?: string
  sessionID: string
  tab: WorkbenchPanelTab
}) {
  const browser = props.browser
  const dialog = useDialog()
  const workbench = useWorkbenchPanels()
  const sdk = useSDK()
  const platform = usePlatform()
  const { _ } = useLingui()
  const draft = useBrowserDraft(props.sessionID)
  const ownerKey = props.initial.ownerKey
  const openData = (section: "import" | "passwords") => {
    const page = browser.page()
    if (!page || !platform.browserNative?.dataAction) return
    dialog.show(() => <BrowserDataDialog ownerKey={ownerKey} pageId={page.id} url={page.url} section={section} />)
  }
  browser.replacePages(props.initial.pages)
  if (props.tab.resourceId) browser.setSession("selectedPageId", props.tab.resourceId)
  browser.setSession("seq", props.initial.seq)
  browser.setSession("epoch", props.initial.epoch)
  browser.setPresentation(props.clientPresentation === "native" ? null : props.initial.presentation)
  for (const page of props.initial.pages)
    browser.setHostStatus(page.id, page.status === "active" ? props.initial.hostStatus : "detached")
  if (props.initial.error) {
    browser.setBrowserError({
      severity: "error",
      code: props.initial.error.code,
      message: props.initial.error.message,
    })
  }
  browserDebug("panel.inner", { sessionID: props.sessionID, routeDirectory: props.routeDirectory, ownerKey })

  const ws = createBrowserWebSocket(browser, {
    sessionID: props.sessionID,
    ownerKey,
    routeDirectory: props.routeDirectory,
    presentation: props.clientPresentation,
  })

  createEffect(
    on(
      browser.pageId,
      (id) => {
        if (!id || id === props.tab.resourceId) return
        const page = browser.session.pages.find((page) => page.id === id)
        if (!page || workbench.surface("side").active() !== props.tab.id) return
        untrack(
          () =>
            void workbench.openPanel("browser", {
              init: browserPageTab(page, {
                sessionID: props.sessionID,
                path_directory: props.routeDirectory ?? sdk.directory ?? sdk.scopeID ?? sdk.scopeKey,
                query_directory: sdk.directory,
                scopeID: sdk.scopeID,
              }),
            }),
        )
      },
      { defer: true },
    ),
  )

  const [handledNavigationNonce, setHandledNavigationNonce] = createSignal<number | undefined>(undefined)
  createEffect(() => {
    const request = resolvePendingBrowserNavigation(props.tab.state, handledNavigationNonce())
    if (!request) return
    setHandledNavigationNonce(request.nonce)
    browser.navigate(request.url)
  })

  const recovering = () => browser.hostStatus() === "restarting"
  const retryNative = () => {
    ws.retryNative()
    const pageId = browser.pageId()
    if (!pageId) return
    if (browser.page()?.status !== "active" || browser.hostStatus() === "detached") {
      browser.send({ type: "resume", pageId })
      return
    }
    browser.setHostStatus(pageId, "restarting")
    void platform.browserNative
      ?.retryPage({ protocolVersion: BROWSER_PROTOCOL_VERSION, ownerKey, pageId })
      .catch((error) => {
        const normalized = normalizeBrowserError(error, "Native Browser recovery failed")
        browser.setHostStatus(pageId, "failed")
        browser.setBrowserError({ pageId, severity: "error", code: normalized.code, message: normalized.message })
      })
  }

  const page = createMemo(() =>
    !props.tab.resourceId || browser.pageId() === props.tab.resourceId ? browser.page() : null,
  )

  const showDevPanel = () => browser.devPanel() !== "closed"
  const [recent, setRecent] = createSignal<Array<{ url: string; title: string; time: number }>>([])
  createEffect(() => {
    const current = page()
    if (!current || current.isLoading || !platform.browserNative?.dataAction) return
    void platform.browserNative
      .dataAction({
        protocolVersion: BROWSER_PROTOCOL_VERSION,
        ownerKey,
        pageId: current.id,
        action: { type: "state" },
      })
      .then((result) => {
        if (result.type === "state" && browser.pageId() === current.id) setRecent(result.history)
      })
      .catch(() => setRecent([]))
  })

  const requestDiagnostics = async (action: "console" | "network" | "elements" | "assets" | "downloads" | "clear") => {
    const pageId = browser.pageId()
    const routeDirectory = props.routeDirectory ?? sdk.directory ?? sdk.scopeID ?? sdk.scopeKey
    if (!pageId || !routeDirectory) return
    try {
      const response = await sdk.client.browser.diagnostics({
        path_directory: routeDirectory,
        query_directory: sdk.directory,
        scopeID: sdk.scopeID,
        mode: "session",
        sessionID: props.sessionID,
        protocolVersion: BROWSER_PROTOCOL_VERSION,
        presentation: "native",
        nativeTicket: await ws.createNativeTicket(),
        browserDiagnosticsRequest: {
          protocolVersion: BROWSER_PROTOCOL_VERSION,
          pageId,
          commandId: createBrowserCommandId(),
          action,
          limit: action === "console" ? 100 : 200,
        },
      })
      if (!response.data) throw response.error ?? new Error("Browser diagnostics failed")
      const data = Array.isArray(response.data.data) ? response.data.data : []
      if (action === "console") browser.setConsoleEntries(pageId, data)
      if (action === "network") browser.setNetworkRequests(pageId, data)
      if (action === "elements") browser.setElements(pageId, data)
      if (action === "assets") browser.setPageAssets(pageId, data)
      if (action === "downloads") browser.setDownloads(pageId, data)
      if (action === "clear") {
        browser.setConsoleEntries(pageId, [])
        browser.setNetworkRequests(pageId, [])
      }
    } catch (error) {
      const normalized = normalizeBrowserError(error, "Browser diagnostics failed")
      browser.setBrowserError({ pageId, severity: "error", message: normalized.message, code: normalized.code })
    }
  }

  const sendPageCommand = (message: Record<string, unknown>) => {
    const pageId = browser.pageId()
    if (!pageId) return
    browser.send({ ...message, pageId })
  }

  const dismissAnnotation = () => {
    browser.clearAnnotationTarget()
    browser.setAnnotationMode(false)
  }

  const handleAnnotationSubmit = async (comment: string) => {
    await draft.text(`Browser feedback: ${browser.page()?.url ?? ""}\n${comment}`)
    dismissAnnotation()
  }
  const capturePage = async (fullPage: boolean): Promise<BrowserCapture> => {
    const pageId = browser.pageId()
    if (!pageId) throw new Error("Open a page before capturing it.")
    const result = await platform.browserNative?.pageAction?.({
      protocolVersion: BROWSER_PROTOCOL_VERSION,
      ownerKey,
      pageId,
      action: { type: "capture", fullPage },
    })
    if (result?.type !== "capture") throw new Error("Screenshot is unavailable. Retry the page.")
    return result
  }
  const openCapture = async () => {
    try {
      const initial = await capturePage(false)
      dialog.show(() => <BrowserResultDialog initial={initial} recapture={capturePage} attach={draft.attach} />)
    } catch (error) {
      browser.setBrowserError({
        pageId: browser.pageId() ?? undefined,
        severity: "error",
        message: normalizeBrowserError(error, "Screenshot failed").message,
      })
    }
  }
  const downloadArtifact = async (id: string, operation: "save" | "open" | "draft") => {
    const prepare = async () => {
      const result = await sdk.client.browser.downloadArtifact({
        path_directory: props.routeDirectory ?? sdk.directory ?? sdk.scopeID ?? sdk.scopeKey,
        query_directory: sdk.directory,
        scopeID: sdk.scopeID,
        mode: "session",
        sessionID: props.sessionID,
        presentation: "native",
        protocolVersion: BROWSER_PROTOCOL_VERSION,
        nativeTicket: await ws.createNativeTicket(),
        id,
      })
      if (!result.data) throw result.error ?? new Error("Download is unavailable.")
      return result.data
    }
    if (operation === "draft") return draft.artifact(prepare)
    const file = await prepare()
    const response = await sdk.client.asset.get({ id: file.id }, { parseAs: "blob" })
    if (!(response.data instanceof Blob)) throw new Error("Download could not be read. Retry.")
    const data = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader()
      reader.onerror = () => reject(new Error("Download could not be read."))
      reader.onload = () => resolve(String(reader.result).split(",")[1]!)
      reader.readAsDataURL(response.data as Blob)
    })
    await platform.browserNative?.fileAction?.({ operation, filename: file.filename, mime: file.mime, data })
  }

  const showAnnotation = () => {
    return browser.annotationMode() && browser.pageId() && browser.annotationTarget() !== null
  }

  return (
    <BrowserStoreProvider store={browser}>
      <div class="browser-workspace flex h-full flex-col">
        <AddressBar
          recent={recent}
          activeUrl={() => page()?.url ?? ""}
          isLoading={() => page()?.isLoading ?? false}
          hasPage={() => Boolean(page())}
          onHistory={(direction) => sendPageCommand({ type: "history", direction })}
          onReload={() => sendPageCommand({ type: "reload" })}
          onStop={() => sendPageCommand({ type: "stop" })}
          onNavigate={browser.navigate}
          onImport={() => openData("import")}
          onPasswords={() => openData("passwords")}
          onScreenshot={() => void openCapture()}
          onNewTab={() => void workbench.openPanel("browser", { forceNew: true })}
          onCloseTab={() => void workbench.closeTab(props.tab.id)}
          onExternal={() => {
            const url = page()?.url
            if (url && /^https?:/.test(url)) platform.openLink(url)
          }}
          onShortcut={(handler) =>
            platform.browserNative?.onEvent?.((event) => {
              if (event.type === "native.shortcut" && event.pageId === browser.pageId()) handler(event.action)
            }) ?? (() => {})
          }
          onPageAction={async (action) => {
            const pageId = browser.pageId()
            if (
              !pageId ||
              browser.page()?.status !== "active" ||
              browser.hostStatus() !== "ready" ||
              !platform.browserNative?.pageAction
            )
              return
            try {
              return await platform.browserNative.pageAction({
                protocolVersion: BROWSER_PROTOCOL_VERSION,
                ownerKey,
                pageId,
                action,
              })
            } catch (error) {
              if (action.type === "state" || browser.page()?.status !== "active") return
              const normalized = normalizeBrowserError(error, "Page action failed. Retry.")
              browser.setBrowserError({ pageId, severity: "error", message: normalized.message, code: normalized.code })
            }
          }}
          onRequestDiagnostics={(action) => void requestDiagnostics(action)}
          onSettings={() =>
            dialog.show(() => (
              <BrowserStoreProvider store={browser}>
                <BrowserSettings
                  ownerKey={ownerKey}
                  sessionID={props.sessionID}
                  routeDirectory={props.routeDirectory}
                  createTicket={ws.createNativeTicket}
                />
              </BrowserStoreProvider>
            ))
          }
        />
        <Show when={browser.session.connectionStatus === "failed"}>
          <div role="status" class="flex items-center justify-between gap-2 px-3 py-2 text-text-weak">
            <Trans id={B.disconnected.id} message={B.disconnected.message} />
            <Button size="small" disabled={recovering()} onClick={retryNative}>
              <Trans id={B.retry.id} message={B.retry.message} />
            </Button>
          </div>
        </Show>
        <div class="browser-content relative flex-1" aria-busy={recovering()}>
          <Show
            when={showDevPanel()}
            fallback={
              <Show
                when={page() && page()?.url !== "about:blank"}
                fallback={
                  <div class="browser-new-tab">
                    <div class="browser-new-tab-center">
                      <div class="browser-new-tab-search">
                        <Icon name={getSemanticIcon("action.search")} size="small" />
                        <input
                          aria-label={_(B.enterUrl)}
                          placeholder={_(B.enterUrl)}
                          onKeyDown={(event) => {
                            if (event.key !== "Enter" || event.isComposing || !event.currentTarget.value.trim()) return
                            event.preventDefault()
                            browser.navigate(event.currentTarget.value.trim())
                          }}
                        />
                      </div>
                    </div>
                    <div class="browser-new-tab-footer">
                      <Button size="small" variant="secondary" onClick={() => openData("import")}>
                        <Icon name={getSemanticIcon("action.import")} size="small" />
                        <Trans id={B.importData.id} message={B.importData.message} />
                      </Button>
                    </div>
                  </div>
                }
              >
                <BrowserSurface
                  sessionID={props.sessionID}
                  routeDirectory={props.routeDirectory}
                  ownerKey={ownerKey}
                  clientPresentation={props.clientPresentation}
                  onRetryNative={retryNative}
                  recovering={recovering()}
                />
              </Show>
            }
          >
            <div class="flex h-full min-h-0 flex-col">
              <div class="border-b border-border-weak-base p-2">
                <Button size="small" variant="ghost" onClick={() => browser.setDevPanel("closed")}>
                  {_({ id: "browser.page.back", message: "Back to webpage" })}
                </Button>
              </div>
              <div class="min-h-0 flex-1">
                <DevPanelContent panel={browser.devPanel()!} downloadArtifact={downloadArtifact} />
              </div>
            </div>
          </Show>
          <AgentAssistant />
          <Show when={showAnnotation()}>
            {(() => {
              const target = browser.annotationTarget()!
              return (
                <AnnotationInput
                  x={target.displayX}
                  y={target.displayY}
                  onSubmit={handleAnnotationSubmit}
                  onCancel={dismissAnnotation}
                />
              )
            })()}
          </Show>
        </div>
      </div>
    </BrowserStoreProvider>
  )
}

function DevPanelContent(props: {
  panel: string
  downloadArtifact(id: string, operation: "save" | "open" | "draft"): Promise<void>
}) {
  return (
    <div class="h-full overflow-hidden">
      <Show when={props.panel === "console"}>
        <ConsolePanel />
      </Show>
      <Show when={props.panel === "network"}>
        <NetworkPanel />
      </Show>
      <Show when={props.panel === "elements"}>
        <ElementsPanel />
      </Show>
      <Show when={props.panel === "downloads"}>
        <DownloadsPanel onArtifact={props.downloadArtifact} />
      </Show>
      <Show when={props.panel === "assets"}>
        <AssetsPanel />
      </Show>
    </div>
  )
}
