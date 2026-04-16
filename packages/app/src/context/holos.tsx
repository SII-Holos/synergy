import { createSignal } from "solid-js"
import { createSimpleContext } from "@ericsanchezok/synergy-ui/context"
import type { HolosState } from "@ericsanchezok/synergy-sdk"
import { useGlobalSDK } from "./global-sdk"

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

    async function refresh() {
      try {
        setError(null)
        const res = await sdk.client.holos.state({ directory: "global" })
        if (res.data) setState(res.data as HolosState)
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        setError(msg)
        console.warn("[Holos] refresh failed:", msg)
      } finally {
        setLoaded(true)
      }
    }

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
