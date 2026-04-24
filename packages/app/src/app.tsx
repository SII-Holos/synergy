import "@/index.css"
import { ErrorBoundary, Switch, Match, createResource, type ParentProps } from "solid-js"
import { MetaProvider } from "@solidjs/meta"
import { Font } from "@ericsanchezok/synergy-ui/font"
import { MarkedProvider } from "@ericsanchezok/synergy-ui/context/marked"
import { DiffComponentProvider } from "@ericsanchezok/synergy-ui/context/diff"
import { CodeComponentProvider } from "@ericsanchezok/synergy-ui/context/code"
import { Diff } from "@ericsanchezok/synergy-ui/diff"
import { Code } from "@ericsanchezok/synergy-ui/code"
import { ThemeProvider } from "@ericsanchezok/synergy-ui/theme"
import { DialogProvider } from "@ericsanchezok/synergy-ui/context/dialog"
import { ErrorPage } from "./pages/error"
import { isHostedMode, resolveAppAccess } from "@/utils/runtime"
import { HostedAppInterface } from "@/pages/hosted-access"
import { AppWithAccess, Loading } from "@/app-access"

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

export function AppInterface() {
  if (isHostedMode()) {
    return <HostedAppInterface />
  }

  const [access] = createResource(resolveAppAccess)

  return (
    <Switch>
      <Match when={access.error}>
        <ErrorPage error={access.error} />
      </Match>
      <Match when={!access()}>
        <Loading />
      </Match>
      <Match when={access()}>{(resolvedAccess) => <AppWithAccess access={resolvedAccess()} />}</Match>
    </Switch>
  )
}
