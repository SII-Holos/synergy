import type { Session } from "@ericsanchezok/synergy-sdk/client"
import { base64Encode } from "@ericsanchezok/synergy-util/encode"
import { HOME_SCOPE_KEY } from "@/utils/scope"

type SessionNavigatorDependencies = {
  findCachedSession: (sessionID: string) => Session | undefined
  getSession: (sessionID: string) => Promise<Session | undefined>
  fallbackDir: string
  fallbackScopeKey: string
  currentPath: () => string
  navigate: (path: string, options: { state: { from: string } }) => void
}

function routeDirectory(scope: Session["scope"], fallbackScopeKey: string) {
  return base64Encode(scope.type === "home" ? HOME_SCOPE_KEY : (scope.directory ?? fallbackScopeKey))
}

export function createSessionNavigator(dependencies: SessionNavigatorDependencies) {
  const open = (sessionID: string, session?: Session) => {
    const directory = session ? routeDirectory(session.scope, dependencies.fallbackScopeKey) : dependencies.fallbackDir
    dependencies.navigate(`/${directory}/session/${sessionID}`, {
      state: { from: dependencies.currentPath() },
    })
  }

  return async (sessionID: string) => {
    const cached = dependencies.findCachedSession(sessionID)
    if (cached) {
      open(sessionID, cached)
      return
    }

    try {
      open(sessionID, await dependencies.getSession(sessionID))
    } catch {
      open(sessionID)
    }
  }
}
