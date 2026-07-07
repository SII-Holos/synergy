import { useNavigate, useParams } from "@solidjs/router"
import { base64Encode } from "@ericsanchezok/synergy-util/encode"
import { useGlobalSDK } from "@/context/global-sdk"
import { useGlobalSync } from "@/context/global-sync"
import { useSDK } from "@/context/sdk"
import { useSync } from "@/context/sync"
import { HOME_SCOPE_KEY } from "@/utils/scope"

export function useNavigateToSession() {
  const params = useParams()
  const navigate = useNavigate()
  const sdk = useSDK()
  const sync = useSync()
  const globalSync = useGlobalSync()
  const globalSDK = useGlobalSDK()

  const routeDir = (scope: { type?: string; directory?: string }) =>
    base64Encode(scope.type === "home" ? HOME_SCOPE_KEY : (scope.directory ?? sdk.scopeKey))

  return (sessionID: string) => {
    const navState = { state: { from: window.location.pathname } }

    const localMatch = sync.data.session.find((s) => s.id === sessionID)
    if (localMatch) {
      navigate(`/${routeDir(localMatch.scope)}/session/${sessionID}`, navState)
      return
    }

    for (const scope of globalSync.data.scope) {
      const [store] = globalSync.ensureScopeState(scope.worktree)
      const match = store.session.find((s) => s.id === sessionID)
      if (match) {
        navigate(`/${routeDir(match.scope)}/session/${sessionID}`, navState)
        return
      }
    }

    globalSDK.client.session
      .get({ sessionID })
      .then((res) => {
        const session = res.data
        if (session) {
          navigate(`/${routeDir(session.scope)}/session/${sessionID}`, navState)
        } else {
          navigate(`/${params.dir}/session/${sessionID}`, navState)
        }
      })
      .catch(() => {
        navigate(`/${params.dir}/session/${sessionID}`, navState)
      })
  }
}
