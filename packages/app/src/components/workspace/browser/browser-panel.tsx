import { Button } from "@ericsanchezok/synergy-ui/button"
import { createMemo, Show } from "solid-js"
import { useParams } from "@solidjs/router"
import { BrowserStoreProvider, createBrowserStore } from "./browser-store"
import { createBrowserWebSocket } from "./browser-ws"
import { TabStrip } from "./tab-strip"
import { AddressBar } from "./address-bar"
import { BrowserSurface } from "./browser-surface"
import { ConsolePanel } from "./console-panel"
import { NetworkPanel } from "./network-panel"
import { ElementsPanel } from "./elements-panel"
import { AgentAssistant } from "./agent-assistant"
import { AnnotationInput } from "./annotation-input"
import { DownloadsPanel } from "./downloads-panel"
import { AssetsPanel } from "./assets-panel"

export function BrowserPanel() {
  const params = useParams()
  const ownerKey = createMemo(() => `${params.dir}:session:${params.id}`)

  return (
    <Show keyed when={ownerKey()}>
      {(key) => {
        const browser = createBrowserStore()
        return <BrowserPanelInner browser={browser} sessionID={params.id!} />
      }}
    </Show>
  )
}

function BrowserPanelInner(props: { browser: ReturnType<typeof createBrowserStore>; sessionID: string }) {
  const browser = props.browser

  const ws = createBrowserWebSocket(browser, props.sessionID)

  const activeTab = createMemo(() => {
    const id = browser.activeTabId()
    return browser.session.tabs.find((t) => t.id === id) ?? null
  })

  const showDevPanel = () => browser.devPanel() !== "closed"

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
      tabId: browser.activeTabId(),
      x: target?.pageX,
      y: target?.pageY,
    })
    dismissAnnotation()
  }

  const showAnnotation = () => {
    return browser.annotationMode() && browser.activeTabId() && browser.annotationTarget() !== null
  }

  return (
    <Show
      when={browser.session.connectionStatus !== "failed"}
      fallback={
        <div class="flex flex-col items-center justify-center h-full gap-3 p-4 text-text-weak">
          <span class="text-14">Browser disconnected</span>
          <Button size="small" variant="primary" onClick={() => ws.connect()}>
            Retry
          </Button>
        </div>
      }
    >
      <BrowserStoreProvider store={browser}>
        <div class="flex flex-col h-full bg-surface-inset-base">
          <TabStrip
            tabs={browser.session.tabs}
            activeTabId={browser.activeTabId()}
            onSwitch={browser.switchTab}
            onClose={browser.closeTab}
            onAddTab={() => browser.createTab()}
          />
          <AddressBar
            activeUrl={() => activeTab()?.url ?? ""}
            isLoading={() => activeTab()?.isLoading ?? false}
            onHistory={(direction) => browser.send({ type: "history", direction, tabId: browser.activeTabId() })}
            onReload={() => browser.send({ type: "reload", tabId: browser.activeTabId() })}
            onStop={() => browser.send({ type: "stop", tabId: browser.activeTabId() })}
            onNavigate={(url) => {
              const tab = activeTab()
              if (!tab) return
              browser.setFollowAgent(false)
              browser.setTabLoading(tab.id, true)
              ws.send({ type: "navigate", source: "user", url, tabId: tab.id })
            }}
          />
          <div class="flex-1 relative bg-background-stronger">
            <Show
              when={showDevPanel()}
              fallback={
                <Show
                  when={activeTab()}
                  fallback={
                    <div class="flex items-center justify-center h-full text-text-weak text-14">No tab open</div>
                  }
                >
                  <BrowserSurface />
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
