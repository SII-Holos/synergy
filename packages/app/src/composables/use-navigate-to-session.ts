import { useLocation, useNavigate, useParams } from "@solidjs/router"
import { base64Encode } from "@ericsanchezok/synergy-util/encode"
import { useGlobalSDK } from "@/context/global-sdk"
import { useGlobalSync } from "@/context/global-sync"
import { useSDK } from "@/context/sdk"
import { useSync } from "@/context/sync"
import { HOME_SCOPE_KEY } from "@/utils/scope"
import { navigateResolvedSession, type SessionNavigationIntent } from "./use-navigate-to-session-model"
export type { SessionNavigationIntent } from "./use-navigate-to-session-model"

export function useNavigateToSession() {
  const params = useParams()
  const location = useLocation()
  const navigate = useNavigate()
  const sdk = useSDK()
  const sync = useSync()
  const globalSync = useGlobalSync()
  const globalSDK = useGlobalSDK()

  const routeDir = (scope: { type?: string; directory?: string }) =>
    base64Encode(scope.type === "home" ? HOME_SCOPE_KEY : (scope.directory ?? sdk.scopeKey))

  return (sessionID: string, intent: SessionNavigationIntent = "open") => {
    const currentPath = window.location.pathname
    const from = (location.state as { from?: string } | undefined)?.from
    const navigateResolved = (targetPath: string) =>
      navigateResolvedSession(navigate, { intent, targetPath, currentPath, from })

    const localMatch = sync.data.session.find((s) => s.id === sessionID)
    if (localMatch) {
      navigateResolved(`/${routeDir(localMatch.scope)}/session/${sessionID}`)
      return
    }

    for (const scope of globalSync.data.scope) {
      const [store] = globalSync.ensureScopeState(scope.worktree)
      const match = store.session.find((s) => s.id === sessionID)
      if (match) {
        navigateResolved(`/${routeDir(match.scope)}/session/${sessionID}`)
        return
      }
    }

    globalSDK.client.session
      .get({ sessionID })
      .then((res) => {
        const session = res.data
        if (session) {
          navigateResolved(`/${routeDir(session.scope)}/session/${sessionID}`)
        } else {
          navigateResolved(`/${params.dir}/session/${sessionID}`)
        }
      })
      .catch(() => {
        navigateResolved(`/${params.dir}/session/${sessionID}`)
      })
  }
}
