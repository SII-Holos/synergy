import { Button } from "@ericsanchezok/synergy-ui/button"
import { BROWSER_PROTOCOL_VERSION, browserOwnerKey } from "@ericsanchezok/synergy-browser"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { getSemanticIcon } from "@ericsanchezok/synergy-ui/semantic-icon"
import { createEffect, createMemo, lazy, Show } from "solid-js"
import { useParams } from "@solidjs/router"
import { BrowserStoreProvider, createBrowserStore } from "./browser-store"
import { createBrowserWebSocket } from "./browser-ws"
import { AddressBar } from "./address-bar"
import { BrowserSurface } from "./browser-surface"
import { AgentAssistant } from "./agent-assistant"
import { AnnotationInput } from "./annotation-input"
import { browserDebug } from "./browser-debug"
import { useSDK } from "@/context/sdk"
import { createBrowserCommandId } from "./browser-command"

const ConsolePanel = lazy(() => import("./console-panel").then((module) => ({ default: module.ConsolePanel })))
const NetworkPanel = lazy(() => import("./network-panel").then((module) => ({ default: module.NetworkPanel })))
const ElementsPanel = lazy(() => import("./elements-panel").then((module) => ({ default: module.ElementsPanel })))
const DownloadsPanel = lazy(() => import("./downloads-panel").then((module) => ({ default: module.DownloadsPanel })))
const AssetsPanel = lazy(() => import("./assets-panel").then((module) => ({ default: module.AssetsPanel })))

export function BrowserPanel() {
  const params = useParams()
  const sdk = useSDK()
  const ownerKey = createMemo(() =>
    sdk.scopeID && params.id ? browserOwnerKey({ mode: "session", scopeID: sdk.scopeID, sessionID: params.id }) : null,
  )
  createEffect(() => {
    browserDebug("panel.route", { dir: params.dir, scopeID: sdk.scopeID, sessionID: params.id, ownerKey: ownerKey() })
  })

  return (
    <Show keyed when={ownerKey()}>
      {(key) => {
        const browser = createBrowserStore()
        return <BrowserPanelInner browser={browser} ownerKey={key} routeDirectory={params.dir} sessionID={params.id!} />
      }}
    </Show>
  )
}

function BrowserPanelInner(props: {
  browser: ReturnType<typeof createBrowserStore>
  ownerKey: string
  routeDirectory?: string
  sessionID: string
}) {
  const browser = props.browser
  const sdk = useSDK()
  browserDebug("panel.inner", { sessionID: props.sessionID, routeDirectory: props.routeDirectory })

  const ws = createBrowserWebSocket(browser, {
    sessionID: props.sessionID,
    ownerKey: props.ownerKey,
    routeDirectory: props.routeDirectory,
  })

  const page = createMemo(() => browser.page())

  const showDevPanel = () => browser.devPanel() !== "closed"

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
        browserDiagnosticsRequest: {
          protocolVersion: BROWSER_PROTOCOL_VERSION,
          pageId,
          commandId: createBrowserCommandId(),
          action,
          limit: action === "console" ? 100 : 200,
        },
      })
      if (!response.data) throw new Error(response.error?.message ?? "Browser diagnostics failed")
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
      browser.setBrowserError({ severity: "error", message: error instanceof Error ? error.message : String(error) })
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

  const handleAnnotationSubmit = (comment: string, styleFeedback?: Record<string, string>) => {
    const target = browser.annotationTarget()
    const pageId = browser.pageId()
    const routeDirectory = props.routeDirectory ?? sdk.directory ?? sdk.scopeID ?? sdk.scopeKey
    if (target && pageId && routeDirectory) {
      void sdk.client.browser
        .createAnnotation({
          path_directory: routeDirectory,
          query_directory: sdk.directory,
          scopeID: sdk.scopeID,
          mode: "session",
          sessionID: props.sessionID,
          protocolVersion: BROWSER_PROTOCOL_VERSION,
          browserAnnotationRequest: {
            protocolVersion: BROWSER_PROTOCOL_VERSION,
            pageId,
            x: target.pageX,
            y: target.pageY,
            comment,
            styleFeedback,
          },
        })
        .then((response) => {
          if (!response.data) throw new Error(response.error?.message ?? "Browser annotation failed")
        })
        .catch((error) => {
          browser.setBrowserError({
            severity: "error",
            message: error instanceof Error ? error.message : String(error),
          })
        })
    }
    dismissAnnotation()
  }

  const showAnnotation = () => {
    return browser.annotationMode() && browser.pageId() && browser.annotationTarget() !== null
  }

  return (
    <Show
      when={browser.session.connectionStatus !== "failed"}
      fallback={
        <div class="browser-workspace flex h-full flex-col items-center justify-center gap-3 p-4 text-text-weak">
          <div class="browser-empty-mark">
            <Icon name={getSemanticIcon("browser.main")} class="size-4" />
          </div>
          <span class="text-14-medium text-text-strong">Browser disconnected</span>
          <Button size="small" variant="primary" onClick={() => ws.connect()}>
            Retry
          </Button>
        </div>
      }
    >
      <BrowserStoreProvider store={browser}>
        <div class="browser-workspace flex h-full flex-col">
          <AddressBar
            activeUrl={() => page()?.url ?? ""}
            isLoading={() => page()?.isLoading ?? false}
            hasPage={() => Boolean(page())}
            onHistory={(direction) => sendPageCommand({ type: "history", direction })}
            onReload={() => sendPageCommand({ type: "reload" })}
            onStop={() => sendPageCommand({ type: "stop" })}
            onNavigate={browser.navigate}
            onRequestDiagnostics={(action) => void requestDiagnostics(action)}
          />
          <div class="browser-content relative flex-1">
            <Show
              when={showDevPanel()}
              fallback={
                <Show
                  when={page()}
                  fallback={
                    <div class="browser-empty-state">
                      <div class="browser-empty-mark">
                        <Icon name={getSemanticIcon("browser.main")} class="size-4" />
                      </div>
                      <div class="browser-empty-title">No page open</div>
                      <div class="browser-empty-text">The next navigation will appear here.</div>
                      <div class="browser-status-pill">{browser.session.connectionStatus}</div>
                    </div>
                  }
                >
                  <BrowserSurface
                    sessionID={props.sessionID}
                    routeDirectory={props.routeDirectory}
                    ownerKey={props.ownerKey}
                  />
                </Show>
              }
            >
              <DevPanelContent panel={browser.devPanel()!} />
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
    </Show>
  )
}

function DevPanelContent(props: { panel: string }) {
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
        <DownloadsPanel />
      </Show>
      <Show when={props.panel === "assets"}>
        <AssetsPanel />
      </Show>
    </div>
  )
}
