import { createEffect, lazy, Suspense } from "solid-js"
import { Router, Route, useNavigate } from "@solidjs/router"
import { GlobalSyncProvider } from "@/context/global-sync"
import { PermissionProvider } from "@/context/permission"
import { LayoutProvider } from "@/context/layout"
import { TerminalProvider } from "@/context/terminal"
import { PromptProvider } from "@/context/prompt"
import { FileProvider } from "@/context/file"
import { NotificationProvider } from "@/context/notification"
import { RecentSessionsProvider } from "@/context/recent-sessions"
import { CommandProvider } from "@/context/command"
import { proxyPrefix } from "@/utils/proxy"
import { globalSessionRoute } from "@/utils/session-route"
import Layout from "@/pages/layout"
import DirectoryLayout from "@/pages/directory-layout"

const Session = lazy(() => import("@/pages/session"))
const Loading = () => <div class="size-full flex items-center justify-center text-text-weak">Loading...</div>

function RootSessionRedirect() {
  const navigate = useNavigate()

  createEffect(() => {
    navigate(globalSessionRoute(), { replace: true })
  })

  return null
}

function SessionRoute() {
  return (
    <TerminalProvider>
      <FileProvider>
        <PromptProvider>
          <Suspense fallback={<Loading />}>
            <Session />
          </Suspense>
        </PromptProvider>
      </FileProvider>
    </TerminalProvider>
  )
}

export function MainApp() {
  return (
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
        <Route path="/" component={RootSessionRedirect} />
        <Route path="/:dir" component={DirectoryLayout}>
          <Route path="/" component={SessionRoute} />
          <Route path="/session/:id?" component={SessionRoute} />
        </Route>
      </Router>
    </GlobalSyncProvider>
  )
}
