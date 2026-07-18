import { useLocation, useNavigate, useParams } from "@solidjs/router"
import { base64Encode } from "@ericsanchezok/synergy-util/encode"
import { useGlobalSDK } from "@/context/global-sdk"
import { useGlobalSync } from "@/context/global-sync"
import { HOME_SCOPE_KEY } from "@/utils/scope"
import { createSessionNavigator } from "./session-navigator"

export function useGlobalNavigateToSession() {
  const location = useLocation()
  const navigate = useNavigate()
  const params = useParams()
  const globalSDK = useGlobalSDK()
  const globalSync = useGlobalSync()

  return createSessionNavigator({
    findCachedSession(sessionID) {
      const home = globalSync.peekScopeState(HOME_SCOPE_KEY)?.[0].session.find((session) => session.id === sessionID)
      if (home) return home

      for (const scope of globalSync.data.scope) {
        const match = globalSync.peekScopeState(scope.worktree)?.[0].session.find((session) => session.id === sessionID)
        if (match) return match
      }
    },
    getSession: (sessionID) => globalSDK.client.session.get({ sessionID }).then((response) => response.data),
    fallbackDir: params.dir ?? base64Encode(HOME_SCOPE_KEY),
    fallbackScopeKey: HOME_SCOPE_KEY,
    currentPath: () => location.pathname,
    navigate,
  })
}
