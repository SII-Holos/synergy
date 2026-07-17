import "@/index.css"
import { ErrorBoundary, Show, Switch, Match, lazy, createEffect, createMemo, type ParentProps } from "solid-js"
import { Router, Route, Navigate } from "@solidjs/router"
import { MetaProvider } from "@solidjs/meta"
import { Font } from "@ericsanchezok/synergy-ui/font"
import { MarkedProvider, ensureSynergyHighlightTheme } from "@ericsanchezok/synergy-ui/context/marked"
import { DiffComponentProvider } from "@ericsanchezok/synergy-ui/context/diff"
import { CodeComponentProvider } from "@ericsanchezok/synergy-ui/context/code"
import { ThemeProvider } from "@ericsanchezok/synergy-ui/theme"
import { DialogProvider, useDialog } from "@ericsanchezok/synergy-ui/context/dialog"
import { GlobalSyncProvider } from "@/context/global-sync"
import { LayoutProvider } from "@/context/layout"
import { GlobalSDKProvider } from "@/context/global-sdk"
import { ServerProvider, useServer } from "@/context/server"
import { NotificationProvider } from "@/context/notification"
import { CommandProvider } from "@/context/command"
import { ProductUpdateProvider } from "@/context/product-update"
import { SessionTransitionProvider } from "@/context/session-transition"
import { DesktopThemeSync } from "@/components/app-shell"

import { AuthProvider } from "@/context/auth"
import { HolosProvider } from "@/context/holos"
import { InputProvider } from "@/context/input"
import Layout from "@/pages/layout"
import DirectoryLayout from "@/pages/directory-layout"
import { ErrorPage } from "./pages/error"
import {
  PluginComposerSlotBridge,
  PluginThemeConfigBridge,
  PluginHostProvider,
  PluginRouteScope,
  BuiltinNavigationPage,
  PluginNavigationPage,
} from "@/plugin"
import { iife } from "@ericsanchezok/synergy-util/iife"
import { base64Encode } from "@ericsanchezok/synergy-util/encode"
import { Suspense } from "solid-js"
import { DialogSelectServer } from "@/components/dialog"
import { ServerConnectionErrorPage } from "@/pages/server-connection-error"

const APP_SURFACE_READY_EVENT = "synergy:app-surface-ready"

function signalAppSurfaceReady() {
  window.dispatchEvent(new Event(APP_SURFACE_READY_EVENT))
}

function initialRouteWaitsForSessionSurface() {
  const pathname = window.location.pathname
  if (pathname.includes("/agenda")) return false
  if (pathname.includes("/library")) return false
  if (pathname.includes("/plugins")) return false
  if (pathname.includes("/performance")) return false
  return true
}

const Session = lazy(async () => {
  const session = await import("@/pages/session")
  signalAppSurfaceReady()
  return session
})

const Diff = lazy(async () => {
  await ensureSynergyHighlightTheme()
  const diff = await import("@ericsanchezok/synergy-ui/diff")
  return { default: diff.Diff }
})

const Code = lazy(async () => {
  await ensureSynergyHighlightTheme()
  const code = await import("@ericsanchezok/synergy-ui/code")
  return { default: code.Code }
})

const PluginDetailPage = lazy(async () => {
  const pluginDetail = await import("@/plugin/marketplace/PluginDetailPage")
  return { default: pluginDetail.PluginDetailPage }
})

const Loading = () => (
  <div class="synergy-workbench-canvas size-full flex items-center justify-center bg-background-stronger text-text-weak">
    Loading...
  </div>
)

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
        <DesktopThemeSync />
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

  createEffect(() => {
    const view = startupView()
    if (view === "loading") return
    if (view === "connection-error" || !initialRouteWaitsForSessionSurface()) signalAppSurfaceReady()
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
                  <div class="flex items-center justify-center gap-2 px-3 py-1.5 text-12-medium bg-surface-warning-weak text-text-on-warning-base">
                    <span>⚠</span>
                    <span>
                      AI model not configured — run{" "}
                      <code class="font-mono bg-surface-warning-base/20 px-1 rounded">synergy config</code> in your
                      terminal to set one up
                    </span>
                  </div>
                </Show>
                <Router
                  base={proxyPrefix()}
                  root={(props) => (
                    <SessionTransitionProvider>
                      <PluginRouteScope>
                        {(scopeKey) => (
                          <PluginHostProvider scopeKey={scopeKey}>
                            <GlobalSyncProvider>
                              <PluginComposerSlotBridge />
                              <PluginThemeConfigBridge />
                              <LayoutProvider>
                                <NotificationProvider>
                                  <CommandProvider>
                                    <Layout>{props.children}</Layout>
                                  </CommandProvider>
                                </NotificationProvider>
                              </LayoutProvider>
                            </GlobalSyncProvider>
                          </PluginHostProvider>
                        )}
                      </PluginRouteScope>
                    </SessionTransitionProvider>
                  )}
                >
                  <Route path="/" component={() => <Navigate href={`/${base64Encode("home")}/session`} />} />
                  <Route path="/agenda" component={() => <BuiltinNavigationPage navigationId="agenda" />} />
                  <Route path="/library" component={() => <BuiltinNavigationPage navigationId="library" />} />
                  <Route path="/performance" component={() => <BuiltinNavigationPage navigationId="performance" />} />
                  <Route
                    path="/plugins/marketplace"
                    component={() => <BuiltinNavigationPage navigationId="plugins" />}
                  />
                  <Route path="/plugins/:pluginId/:navigationId" component={PluginNavigationPage} />
                  <Route path="/plugins/:pluginId" component={PluginDetailPage} />
                  <Route path="/:dir" component={DirectoryLayout}>
                    <Route path="/" component={() => <Navigate href="session" />} />
                    <Route
                      path="/session/:id?"
                      component={() => (
                        <Suspense fallback={<Loading />}>
                          <Session />
                        </Suspense>
                      )}
                    />
                  </Route>
                </Router>
              </Match>
            </Switch>
          </InputProvider>
        </HolosProvider>
      </ProductUpdateProvider>
    </GlobalSDKProvider>
  )
}
