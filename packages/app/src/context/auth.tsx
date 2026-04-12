import { createStore } from "solid-js/store"
import { createSimpleContext } from "@ericsanchezok/synergy-ui/context"
import { Persist, persisted } from "@/utils/persist"
import { isHostedMode } from "@/utils/runtime"

export interface AuthUser {
  id: string
  name?: string
  email?: string
  avatar?: string
}

interface AuthState {
  status: "authenticated" | "guest" | "unauthenticated"
  user: AuthUser | null
}

export const { use: useAuth, provider: AuthProvider } = createSimpleContext({
  name: "Auth",
  init: () => {
    const hosted = isHostedMode()
    const [persistedStore, setPersistedStore, , ready] = persisted(
      Persist.global("auth", ["auth.v1"]),
      createStore<{ token: string | null; user: AuthUser | null }>({
        token: null,
        user: null,
      }),
    )

    const [store, setStore] = createStore<AuthState>({
      status: "unauthenticated",
      user: null,
    })

    if (!hosted && persistedStore.token && persistedStore.user) {
      setStore({ status: "authenticated", user: persistedStore.user })
    }

    function loginAsGuest() {
      setStore({ status: "guest", user: null })
    }

    function loginWithToken(token: string, user: AuthUser) {
      if (!hosted) {
        setPersistedStore({ token, user })
      }
      setStore({ status: "authenticated", user })
    }

    function logout() {
      if (!hosted) {
        setPersistedStore({ token: null, user: null })
      }
      setStore({ status: "unauthenticated", user: null })
    }

    return {
      get status() {
        return store.status
      },
      get user() {
        return store.user
      },
      get ready() {
        return ready()
      },
      get isAuthenticated() {
        return store.status === "authenticated" || store.status === "guest"
      },
      loginAsGuest,
      loginWithToken,
      logout,
    }
  },
})
