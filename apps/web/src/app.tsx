import { runtimeFeatureAvailable } from "@/components/runtime-features"
import { WorkbenchPanelsProvider } from "@/context/workbench"
import { ViewResidencyProvider } from "@/context/view-residency"
import { NoteDocumentsProvider } from "@/components/note/documents"
import { WelcomeProvider } from "@/components/session/welcome/context"
import { PluginPageOutlet } from "./plugin/shell-outlet"
import "@/index.css"
import { ErrorBoundary, Show, Switch, Match, lazy, createEffect, createMemo, type ParentProps } from "solid-js"
import { Router, Route, Navigate } from "@solidjs/router"
import { MetaProvider } from "@solidjs/meta"
import { LocaleProvider } from "@/context/locale"
import { useLocale } from "@/context/locale"
import { AP } from "@/app-i18n"
import { Font } from "@ericsanchezok/synergy-ui/font"
import { MarkedProvider, ensureSynergyHighlightTheme } from "@ericsanchezok/synergy-ui/context/marked"
import { DiffComponentProvider } from "@ericsanchezok/synergy-ui/context/diff"
import { CodeComponentProvider } from "@ericsanchezok/synergy-ui/context/code"
import { ThemeProvider } from "@ericsanchezok/synergy-ui/theme"
import { DialogProvider, useDialog } from "@ericsanchezok/synergy-ui/context/dialog"
import { GlobalSyncProvider } from "@/context/global-sync"
import { LayoutProvider } from "@/context/layout"
import { GlobalSDKProvider, useGlobalSDK } from "@/context/global-sdk"
import { ServerProvider, useServer } from "@/context/server"
import { NotificationProvider } from "@/context/notification"
import { CommandProvider } from "@/context/command"
import { ProductUpdateProvider } from "@/context/product-update"
import { SessionTransitionProvider } from "@/context/session-transition"
import { DesktopThemeSync, DesktopPowerSync } from "@/components/app-shell"

import { AuthProvider } from "@/context/auth"
import { HolosProvider } from "@/context/holos"
import { InputProvider } from "@/context/input"
import { FontPreferenceProvider } from "@/context/font-preference"
import Layout from "@/pages/layout"
import { PluginUIRecoveryProvider } from "@/plugin/ui-recovery"
import SessionRoute from "@/pages/session-route"
import { FatalErrorPage } from "./pages/fatal-error"
import {
  PluginComposerSlotBridge,
  PluginThemeConfigBridge,
  PluginHostProvider,
  PluginRouteScope,
  BuiltinNavigationPage,
  PluginNavigationPage,
  PluginTextInteractionBridge,
  GlobalPluginThemesRegistrar,
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
  if (pathname.includes("/kanban")) return false
  return true
}

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

function Loading() {
  const { i18n } = useLocale()
  return (
    <div class="synergy-workbench-canvas size-full flex items-center justify-center bg-background-stronger text-text-weak">
      {i18n._(AP.appLoading.id)}
    </div>
  )
}

import { proxyPrefix } from "@/utils/proxy"

function browserBaseUrl() {
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
      <LocaleProvider>
        <FontPreferenceProvider>
          <ThemeProvider>
            <DesktopThemeSync />
            <ErrorBoundary fallback={(error) => <FatalErrorPage error={error} />}>
              <DialogProvider>
                <MarkedProvider>
                  <DiffComponentProvider component={Diff}>
                    <CodeComponentProvider component={Code}>{props.children}</CodeComponentProvider>
                  </DiffComponentProvider>
                </MarkedProvider>
              </DialogProvider>
            </ErrorBoundary>
          </ThemeProvider>
        </FontPreferenceProvider>
      </LocaleProvider>
    </MetaProvider>
  )
}

function ServerKey(props: ParentProps) {
  const server = useServer()
  return (
    <Show when={server.url} keyed>
      {(_url) => props.children}
    </Show>
  )
}

export function AppInterface() {
  return (
    <PluginUIRecoveryProvider>
      <AuthProvider>
        <ServerProvider defaultUrl={defaultAccess.attachUrl}>
          <ServerKey>
            <ConnectedApp />
          </ServerKey>
        </ServerProvider>
      </AuthProvider>
    </PluginUIRecoveryProvider>
  )
}

function RuntimePage(props: ParentProps<{ navigation: string }>) {
  const { capabilities } = useGlobalSDK()
  return (
    <Show
      when={runtimeFeatureAvailable("navigation", props.navigation, capabilities.has)}
      fallback={
        <Show when={capabilities.current()}>
          <Navigate href={`/${base64Encode("home")}/session`} />
        </Show>
      }
    >
      {props.children}
    </Show>
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
                <NoteDocumentsProvider>
                  <Router
                    base={proxyPrefix()}
                    root={(props) => (
                      <WelcomeProvider connection={server.url}>
                        <SessionTransitionProvider>
                          <CommandProvider>
                            <PluginRouteScope>
                              {(scopeKey) => (
                                <GlobalSyncProvider>
                                  <DesktopPowerSync />
                                  <LayoutProvider>
                                    <ViewResidencyProvider>
                                      <WorkbenchPanelsProvider>
                                        <PluginHostProvider scopeKey={scopeKey}>
                                          <PluginComposerSlotBridge />
                                          <PluginThemeConfigBridge />
                                          <PluginTextInteractionBridge />
                                          <GlobalPluginThemesRegistrar />
                                          <NotificationProvider>
                                            <Layout>{props.children}</Layout>
                                          </NotificationProvider>
                                        </PluginHostProvider>
                                      </WorkbenchPanelsProvider>
                                    </ViewResidencyProvider>
                                  </LayoutProvider>
                                </GlobalSyncProvider>
                              )}
                            </PluginRouteScope>
                          </CommandProvider>
                        </SessionTransitionProvider>
                      </WelcomeProvider>
                    )}
                  >
                    <Route path="/" component={() => <Navigate href={`/${base64Encode("home")}/session`} />} />
                    <Route
                      path="/agenda"
                      component={() => (
                        <RuntimePage navigation="agenda">
                          <PluginPageOutlet
                            page="agenda"
                            fallback={() => <BuiltinNavigationPage navigationId="agenda" />}
                          />
                        </RuntimePage>
                      )}
                    />
                    <Route
                      path="/kanban"
                      component={() => (
                        <RuntimePage navigation="kanban">
                          <PluginPageOutlet
                            page="kanban"
                            fallback={() => <BuiltinNavigationPage navigationId="kanban" />}
                          />
                        </RuntimePage>
                      )}
                    />
                    <Route
                      path="/library"
                      component={() => (
                        <RuntimePage navigation="library">
                          <PluginPageOutlet
                            page="library"
                            fallback={() => <BuiltinNavigationPage navigationId="library" />}
                          />
                        </RuntimePage>
                      )}
                    />
                    <Route
                      path="/performance"
                      component={() => (
                        <RuntimePage navigation="performance">
                          <PluginPageOutlet
                            page="performance"
                            fallback={() => <BuiltinNavigationPage navigationId="performance" />}
                          />
                        </RuntimePage>
                      )}
                    />
                    <Route
                      path="/plugins/marketplace"
                      component={() => (
                        <RuntimePage navigation="plugins">
                          <PluginPageOutlet
                            page="plugins"
                            fallback={() => <BuiltinNavigationPage navigationId="plugins" />}
                          />
                        </RuntimePage>
                      )}
                    />
                    <Route
                      path="/plugins/:pluginId/:navigationId"
                      component={() => (
                        <RuntimePage navigation="plugins">
                          <PluginPageOutlet page="plugin-page" fallback={() => <PluginNavigationPage />} />
                        </RuntimePage>
                      )}
                    />
                    <Route
                      path="/plugins/:pluginId"
                      component={() => (
                        <RuntimePage navigation="plugins">
                          <PluginPageOutlet page="plugin-detail" fallback={() => <PluginDetailPage />} />
                        </RuntimePage>
                      )}
                    />
                    <Route path="/:dir">
                      <Route path="/" component={() => <Navigate href="session" />} />
                      <Route path="/session/:id?" component={SessionRoute} />
                    </Route>
                  </Router>
                </NoteDocumentsProvider>
              </Match>
            </Switch>
          </InputProvider>
        </HolosProvider>
      </ProductUpdateProvider>
    </GlobalSDKProvider>
  )
}
