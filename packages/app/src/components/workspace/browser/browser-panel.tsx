import { Button } from "@ericsanchezok/synergy-ui/button"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { getSemanticIcon } from "@ericsanchezok/synergy-ui/semantic-icon"
import { createEffect, createMemo, Show } from "solid-js"
import { useParams } from "@solidjs/router"
import { usePlatform } from "@/context/platform"
import { BrowserStoreProvider, createBrowserStore } from "./browser-store"
import { createBrowserWebSocket } from "./browser-ws"
import { AddressBar } from "./address-bar"
import { BrowserSurface } from "./browser-surface"
import { ConsolePanel } from "./console-panel"
import { NetworkPanel } from "./network-panel"
import { ElementsPanel } from "./elements-panel"
import { AgentAssistant } from "./agent-assistant"
import { AnnotationInput } from "./annotation-input"
import { DownloadsPanel } from "./downloads-panel"
import { AssetsPanel } from "./assets-panel"
import { browserDebug } from "./browser-debug"

export function BrowserPanel() {
  const params = useParams()
  const ownerKey = createMemo(() => `${params.dir}:session:${params.id}`)
  createEffect(() => {
    browserDebug("panel.route", { dir: params.dir, sessionID: params.id, ownerKey: ownerKey() })
  })

  return (
    <Show keyed when={ownerKey()}>
      {(key) => {
        const browser = createBrowserStore()
        return <BrowserPanelInner browser={browser} routeDirectory={params.dir} sessionID={params.id!} />
      }}
    </Show>
  )
}

function BrowserPanelInner(props: {
  browser: ReturnType<typeof createBrowserStore>
  routeDirectory?: string
  sessionID: string
}) {
  const browser = props.browser
  const platform = usePlatform()
  browserDebug("panel.inner", { sessionID: props.sessionID, routeDirectory: props.routeDirectory })

  const ws = createBrowserWebSocket(browser, {
    sessionID: props.sessionID,
    routeDirectory: props.routeDirectory,
    client: platform.platform === "desktop" ? "desktop" : "web",
    sameHost: platform.platform === "desktop",
  })

  const page = createMemo(() => browser.page())

  const showDevPanel = () => browser.devPanel() !== "closed"

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
    browser.send({
      type: "createAnnotation",
      comment,
      styleFeedback,
      pageId: browser.pageId(),
      x: target?.pageX,
      y: target?.pageY,
    })
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
                  <BrowserSurface sessionID={props.sessionID} routeDirectory={props.routeDirectory} />
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
