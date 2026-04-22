import { createSignal, onCleanup } from "solid-js"
import { createSimpleContext } from "@ericsanchezok/synergy-ui/context"
import type { HolosState } from "@ericsanchezok/synergy-sdk"
import { useGlobalSDK } from "./global-sdk"

const HOLOS_EVENTS = new Set([
  "holos.contact.added",
  "holos.contact.removed",
  "holos.contact.updated",
  "holos.contact.config_updated",
  "holos.friend_request.created",
  "holos.friend_request.updated",
  "holos.friend_request.removed",
  "holos.profile.updated",
  "holos.connection.status_changed",
])

const HOLOS_EVENT_REFRESH_DEBOUNCE_MS = 150

type HolosContext = {
  state: HolosState
  loaded: boolean
  error: string | null
  refresh: () => Promise<void>
}

const DEFAULT_STATE: HolosState = {
  identity: {
    loggedIn: false,
    agentId: null,
  },
  connection: {
    status: "unknown",
  },
  readiness: {
    ready: false,
  },
  capability: {
    items: [],
  },
  entitlement: {
    quotas: {
      dailyFreeUsage: {
        status: "unknown",
        remaining: null,
        limit: null,
      },
    },
  },
  social: {
    profile: null,
    contacts: [],
    friendRequests: [],
    presence: {},
  },
}

export const { use: useHolos, provider: HolosProvider } = createSimpleContext<HolosContext, {}>({
  name: "Holos",
  init: () => {
    const sdk = useGlobalSDK()

    const [state, setState] = createSignal<HolosState>(DEFAULT_STATE)
    const [loaded, setLoaded] = createSignal(false)
    const [error, setError] = createSignal<string | null>(null)

    let refreshInFlight: Promise<void> | null = null
    let refreshQueued = false
    let refreshVersion = 0
    let eventRefreshTimer: ReturnType<typeof setTimeout> | null = null

    async function runRefresh(version: number) {
      try {
        setError(null)
        const res = await sdk.client.holos.state({ directory: "global" })
        if (res.data && version === refreshVersion) {
          setState(res.data as HolosState)
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        if (version === refreshVersion) {
          setError(msg)
          console.warn("[Holos] refresh failed:", msg)
        }
      } finally {
        if (version === refreshVersion) {
          setLoaded(true)
        }
      }
    }

    async function refresh() {
      refreshQueued = true
      if (refreshInFlight) return refreshInFlight

      refreshInFlight = (async () => {
        while (refreshQueued) {
          refreshQueued = false
          const version = ++refreshVersion
          await runRefresh(version)
        }
      })().finally(() => {
        refreshInFlight = null
      })

      return refreshInFlight
    }

    function scheduleEventRefresh() {
      if (eventRefreshTimer) clearTimeout(eventRefreshTimer)
      eventRefreshTimer = setTimeout(() => {
        eventRefreshTimer = null
        void refresh()
      }, HOLOS_EVENT_REFRESH_DEBOUNCE_MS)
    }

    const unsub = sdk.event.listen((e) => {
      const eventType = e.details?.type
      if (eventType && HOLOS_EVENTS.has(eventType)) {
        scheduleEventRefresh()
      }
    })
    onCleanup(() => {
      unsub()
      if (eventRefreshTimer) clearTimeout(eventRefreshTimer)
    })

    void refresh()

    return {
      get state() {
        return state()
      },
      get loaded() {
        return loaded()
      },
      get error() {
        return error()
      },
      refresh,
    }
  },
})
