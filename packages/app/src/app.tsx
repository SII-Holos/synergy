import "@/index.css"
import { ErrorBoundary, Show, Switch, Match, lazy, createMemo, createSignal, type ParentProps } from "solid-js"
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
import { PermissionProvider } from "@/context/permission"
import { LayoutProvider } from "@/context/layout"
import { GlobalSDKProvider } from "@/context/global-sdk"
import { ServerProvider, useServer } from "@/context/server"
import { TerminalProvider } from "@/context/terminal"
import { PromptProvider } from "@/context/prompt"
import { FileProvider } from "@/context/file"
import { NotificationProvider } from "@/context/notification"
import { RecentSessionsProvider } from "@/context/recent-sessions"
import { CommandProvider } from "@/context/command"

import { OnboardingProvider, useOnboarding } from "@/context/onboarding"
import { AuthProvider } from "@/context/auth"
import { HolosProvider } from "@/context/holos"
import { InputProvider } from "@/context/input"
import Layout from "@/pages/layout"
import DirectoryLayout from "@/pages/directory-layout"
import { ErrorPage } from "./pages/error"
import { iife } from "@ericsanchezok/synergy-util/iife"
import { base64Encode } from "@ericsanchezok/synergy-util/encode"
import { Suspense } from "solid-js"
import { DialogSelectServer } from "@/components/dialog"
import { ServerConnectionErrorPage } from "@/pages/server-connection-error"

const Session = lazy(() => import("@/pages/session"))
const Welcome = lazy(() => import("@/pages/onboarding/welcome"))
const Setup = lazy(() => import("@/pages/onboarding/setup"))
const Loading = () => <div class="size-full flex items-center justify-center text-text-weak">Loading...</div>

declare global {
  interface Window {
    __SYNERGY_ROUTE__?: string
  }
}

function proxyPrefix() {
  const route = window.__SYNERGY_ROUTE__
  if (route != null) {
    const fullPath = window.location.pathname
    if (fullPath !== route && fullPath.endsWith(route)) {
      return fullPath.slice(0, fullPath.length - route.length).replace(/\/+$/, "")
    }
  }
  return ""
}

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
      <OnboardingProvider>
        <OnboardingGate />
      </OnboardingProvider>
    </AuthProvider>
  )
}

function OnboardingGate() {
  const onboarding = useOnboarding()

  return (
    <Show when={onboarding.ready} fallback={<Loading />}>
      <Switch>
        <Match when={onboarding.phase === "welcome"}>
          <Suspense fallback={<Loading />}>
            <Welcome serverUrl={defaultAccess.attachUrl} callbackUrl={defaultAccess.callbackUrl} />
          </Suspense>
        </Match>
        <Match when={onboarding.phase === "setup" || onboarding.phase === "ready"}>
          <ServerProvider defaultUrl={defaultAccess.attachUrl}>
            <ServerKey>
              <ConnectedApp />
            </ServerKey>
          </ServerProvider>
        </Match>
      </Switch>
    </Show>
  )
}

function ConnectedApp() {
  const dialog = useDialog()
  const onboarding = useOnboarding()
  const server = useServer()
  const [setupConnectionFailed, setSetupConnectionFailed] = createSignal(false)

  const startupView = createMemo<"loading" | "connection-error" | "setup" | "ready">(() => {
    const healthy = server.healthy()
    if (healthy === undefined) return "loading"
    if (healthy === false || setupConnectionFailed()) return "connection-error"
    if (onboarding.phase === "ready") return "ready"
    return "setup"
  })

  function retry() {
    setSetupConnectionFailed(false)
    server.refresh()
  }

  function changeServer() {
    dialog.show(() => <DialogSelectServer />)
  }

  return (
    <GlobalSDKProvider>
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
            <Match when={startupView() === "setup"}>
              <Suspense fallback={<Loading />}>
                <Setup onConnectionError={() => setSetupConnectionFailed(true)} />
              </Suspense>
            </Match>
            <Match when={startupView() === "ready"}>
              <GlobalSyncProvider>
                <Router
                  base={proxyPrefix()}
                  root={(props) => (
                    <PermissionProvider>
                      <LayoutProvider>
                        <NotificationProvider>
                          <RecentSessionsProvider>
                            <CommandProvider>
                              <Layout>{props.children}</Layout>
                            </CommandProvider>
                          </RecentSessionsProvider>
                        </NotificationProvider>
                      </LayoutProvider>
                    </PermissionProvider>
                  )}
                >
                  <Route path="/" component={() => <Navigate href={`/${base64Encode("global")}/session`} />} />
                  <Route path="/:dir" component={DirectoryLayout}>
                    <Route path="/" component={() => <Navigate href="session" />} />
                    <Route
                      path="/session/:id?"
                      component={() => (
                        <TerminalProvider>
                          <FileProvider>
                            <PromptProvider>
                              <Suspense fallback={<Loading />}>
                                <Session />
                              </Suspense>
                            </PromptProvider>
                          </FileProvider>
                        </TerminalProvider>
                      )}
                    />
                  </Route>
                </Router>
              </GlobalSyncProvider>
            </Match>
          </Switch>
        </InputProvider>
      </HolosProvider>
    </GlobalSDKProvider>
  )
}
