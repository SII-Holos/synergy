import "@/index.css"
import { ErrorBoundary, Show, Switch, Match, lazy, createMemo, type ParentProps } from "solid-js"
import { Router, Route, Navigate } from "@solidjs/router"
import { MetaProvider } from "@solidjs/meta"
import { Font } from "@ericsanchezok/synergy-ui/font"
import { MarkedProvider } from "@ericsanchezok/synergy-ui/context/marked"
import { DiffComponentProvider } from "@ericsanchezok/synergy-ui/context/diff"
import { CodeComponentProvider } from "@ericsanchezok/synergy-ui/context/code"
import { Diff } from "@ericsanchezok/synergy-ui/diff"
import { Code } from "@ericsanchezok/synergy-ui/code"
import { ThemeProvider } from "@ericsanchezok/synergy-ui/theme"
import { DialogProvider, useDialog } from "@ericsanchezok/synergy-ui/context/dialog"
import { GlobalSyncProvider } from "@/context/global-sync"
import { LayoutProvider } from "@/context/layout"
import { GlobalSDKProvider } from "@/context/global-sdk"
import { ServerProvider, useServer } from "@/context/server"
import { TerminalProvider } from "@/context/terminal"
import { PromptProvider } from "@/context/prompt"
import { FileProvider } from "@/context/file"
import { ResourceOpenProvider } from "@/context/resource-open"
import { NotificationProvider } from "@/context/notification"
import { CommandProvider } from "@/context/command"
import { ProductUpdateProvider } from "@/context/product-update"

import { AuthProvider } from "@/context/auth"
import { HolosProvider } from "@/context/holos"
import { InputProvider } from "@/context/input"
import Layout from "@/pages/layout"
import DirectoryLayout from "@/pages/directory-layout"
import { ErrorPage } from "./pages/error"
import {
  PluginToolBridge,
  PluginCommandBridge,
  PluginMessageSlotBridge,
  PluginThemeConfigBridge,
  PluginHostProvider,
  MarketplacePage,
  PluginDetailPage,
  PluginAppPanelPage,
  PluginAppRoutePage,
} from "@/plugin"
import { AgendaPanel } from "@/components/agenda"
import { LibraryPanel } from "@/components/library"
import { iife } from "@ericsanchezok/synergy-util/iife"
import { base64Encode } from "@ericsanchezok/synergy-util/encode"
import { Suspense } from "solid-js"
import { DialogSelectServer } from "@/components/dialog"
import { ServerConnectionErrorPage } from "@/pages/server-connection-error"

const Session = lazy(() => import("@/pages/session"))
const Loading = () => <div class="size-full flex items-center justify-center text-text-weak">Loading...</div>

import { proxyPrefix } from "@/utils/proxy"

function browserBaseUrl() {
  // Detect path-prefix proxies (e.g. VS Code remote) by comparing the
  // server-side request path against the browser's full pathname.
  // The server injects __SYNERGY_ROUTE__ = the path it received (proxy prefix stripped).
  // Subtracting that suffix from location.pathname reveals the proxy prefix.
  const prefix = proxyPrefix()
  if (prefix) return (window.location.origin + prefix).replace(/\/+$/, "")
  return window.location.origin.replace(/\/+$/, "")
}

function isHttpUrl(value: string) {
  return /^https?:\/\//i.test(value)
}

export const defaultAccess = iife(() => {
  const param = new URLSearchParams(document.location.search).get("url")
  const attachUrl = (() => {
    if (param && isHttpUrl(param)) return param
    if (import.meta.env.DEV) return import.meta.env.VITE_SYNERGY_SERVER_URL ?? "http://localhost:4096"
    return browserBaseUrl()
  })()

  return {
    attachUrl,
    callbackUrl: import.meta.env.DEV
      ? (import.meta.env.VITE_SYNERGY_CALLBACK_URL ?? `${attachUrl}/holos/callback`)
      : `${attachUrl}/holos/callback`,
  }
})

export function AppBaseProviders(props: ParentProps) {
  return (
    <MetaProvider>
      <Font />
      <ThemeProvider>
        <ErrorBoundary fallback={(error) => <ErrorPage error={error} />}>
          <DialogProvider>
            <MarkedProvider>
              <DiffComponentProvider component={Diff}>
                <CodeComponentProvider component={Code}>{props.children}</CodeComponentProvider>
              </DiffComponentProvider>
            </MarkedProvider>
          </DialogProvider>
        </ErrorBoundary>
      </ThemeProvider>
    </MetaProvider>
  )
}

function ServerKey(props: ParentProps) {
  const server = useServer()
  return (
    <Show when={server.url} keyed>
      {props.children}
    </Show>
  )
}

export function AppInterface() {
  return (
    <AuthProvider>
      <ServerProvider defaultUrl={defaultAccess.attachUrl}>
        <ServerKey>
          <ConnectedApp />
        </ServerKey>
      </ServerProvider>
    </AuthProvider>
  )
}

function ConnectedApp() {
  const dialog = useDialog()
  const server = useServer()

  const startupView = createMemo<"loading" | "connection-error" | "ready">(() => {
    const healthy = server.healthy()
    if (healthy === undefined) return "loading"
    if (healthy === false) return "connection-error"
    return "ready"
  })

  function retry() {
    server.refresh()
  }

  function changeServer() {
    dialog.show(() => <DialogSelectServer />)
  }

  const showModelReadyWarning = createMemo(() => server.modelReady() === false && server.healthy() === true)

  return (
    <GlobalSDKProvider>
      <ProductUpdateProvider>
        <HolosProvider>
          <InputProvider>
            <Switch>
              <Match when={startupView() === "loading"}>
                <Loading />
              </Match>
              <Match when={startupView() === "connection-error"}>
                <ServerConnectionErrorPage
                  serverUrl={server.url}
                  retrying={server.healthy() === undefined}
                  onRetry={retry}
                  onChangeServer={changeServer}
                />
              </Match>
              <Match when={startupView() === "ready"}>
                <Show when={showModelReadyWarning()}>
                  <div class="flex items-center justify-center gap-2 px-3 py-1.5 text-12-medium bg-surface-warning-soft text-text-warning">
                    <span>⚠</span>
                    <span>
                      AI model not configured — run{" "}
                      <code class="font-mono bg-surface-warning-base/20 px-1 rounded">synergy config</code> in your
                      terminal to set one up
                    </span>
                  </div>
                </Show>
                <PluginHostProvider>
                  <GlobalSyncProvider>
                    <PluginToolBridge />
                    <PluginMessageSlotBridge />
                    <PluginThemeConfigBridge />
                    <Router
                      base={proxyPrefix()}
                      root={(props) => (
                        <LayoutProvider>
                          <NotificationProvider>
                            <CommandProvider>
                              <PluginCommandBridge />
                              <Layout>{props.children}</Layout>
                            </CommandProvider>
                          </NotificationProvider>
                        </LayoutProvider>
                      )}
                    >
                      <Route path="/" component={() => <Navigate href={`/${base64Encode("home")}/session`} />} />
                      <Route path="/agenda" component={AgendaPanel} />
                      <Route path="/library" component={LibraryPanel} />
                      <Route path="/plugins/marketplace" component={MarketplacePage} />
                      <Route path="/plugins/panels/:pluginId/:panelId" component={PluginAppPanelPage} />
                      <Route path="/plugins/routes/:pluginId/:routeId" component={PluginAppRoutePage} />
                      <Route path="/plugins/:pluginId" component={PluginDetailPage} />
                      <Route path="/:dir" component={DirectoryLayout}>
                        <Route path="/" component={() => <Navigate href="session" />} />
                        <Route
                          path="/session/:id?"
                          component={() => (
                            <TerminalProvider>
                              <FileProvider>
                                <ResourceOpenProvider>
                                  <PromptProvider>
                                    <Suspense fallback={<Loading />}>
                                      <Session />
                                    </Suspense>
                                  </PromptProvider>
                                </ResourceOpenProvider>
                              </FileProvider>
                            </TerminalProvider>
                          )}
                        />
                      </Route>
                    </Router>
                  </GlobalSyncProvider>
                </PluginHostProvider>
              </Match>
            </Switch>
          </InputProvider>
        </HolosProvider>
      </ProductUpdateProvider>
    </GlobalSDKProvider>
  )
}
