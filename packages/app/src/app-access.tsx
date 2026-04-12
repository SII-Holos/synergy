import { Show, Switch, Match, createMemo, createSignal, lazy, Suspense, type ParentProps } from "solid-js"
import { DialogSelectServer } from "@/components/dialog"
import { useOnboarding, OnboardingProvider } from "@/context/onboarding"
import { AuthProvider } from "@/context/auth"
import { ServerProvider, useServer } from "@/context/server"
import { GlobalSDKProvider } from "@/context/global-sdk"
import { HolosProvider } from "@/context/holos"
import { InputProvider } from "@/context/input"
import { useDialog } from "@ericsanchezok/synergy-ui/context/dialog"
import { ServerConnectionErrorPage } from "@/pages/server-connection-error"
import { type AppAccess } from "@/utils/runtime"
import { MainApp } from "@/app-main"

const Welcome = lazy(() => import("@/pages/onboarding/welcome"))
const Setup = lazy(() => import("@/pages/onboarding/setup"))

export const Loading = () => <div class="size-full flex items-center justify-center text-text-weak">Loading...</div>

function ServerKey(props: ParentProps) {
  const server = useServer()
  return (
    <Show when={server.url} keyed>
      {props.children}
    </Show>
  )
}

function OnboardingGate(props: { access: AppAccess }) {
  const onboarding = useOnboarding()

  return (
    <Show when={onboarding.ready} fallback={<Loading />}>
      <Switch>
        <Match when={onboarding.phase === "welcome"}>
          <Suspense fallback={<Loading />}>
            <Welcome serverUrl={props.access.attachUrl} callbackUrl={props.access.callbackUrl} />
          </Suspense>
        </Match>
        <Match when={onboarding.phase === "setup" || onboarding.phase === "ready"}>
          <ServerProvider defaultUrl={props.access.attachUrl}>
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
              <MainApp />
            </Match>
          </Switch>
        </InputProvider>
      </HolosProvider>
    </GlobalSDKProvider>
  )
}

export function AppWithAccess(props: { access: AppAccess }) {
  return (
    <AuthProvider>
      <OnboardingProvider>
        <OnboardingGate access={props.access} />
      </OnboardingProvider>
    </AuthProvider>
  )
}
