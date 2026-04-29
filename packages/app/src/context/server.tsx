import { createSynergyClient } from "@ericsanchezok/synergy-sdk/client"
import { createSimpleContext } from "@ericsanchezok/synergy-ui/context"
import { batch, createEffect, createMemo, createSignal, onCleanup } from "solid-js"
import { createStore } from "solid-js/store"
import { usePlatform } from "@/context/platform"
import { Persist, persisted } from "@/utils/persist"

type StoredScope = { worktree: string; expanded: boolean }

const HEALTH_TIMEOUT = 8000
const CONSECUTIVE_FAILURES_TO_UNHEALTHY = 2

export function normalizeServerUrl(input: string) {
  const trimmed = input.trim()
  if (!trimmed) return
  const withProtocol = /^https?:\/\//.test(trimmed) ? trimmed : `http://${trimmed}`
  return withProtocol.replace(/\/+$/, "")
}

export function serverDisplayName(url: string) {
  if (!url) return ""
  return url
    .replace(/^https?:\/\//, "")
    .replace(/\/+$/, "")
    .split("/")[0]
}

function projectsKey(url: string) {
  if (!url) return ""
  const host = url.replace(/^https?:\/\//, "").split(":")[0]
  if (host === "localhost" || host === "127.0.0.1") return "local"
  return url
}

export const { use: useServer, provider: ServerProvider } = createSimpleContext({
  name: "Server",
  init: (props: { defaultUrl: string }) => {
    const platform = usePlatform()

    const [store, setStore, _, ready] = persisted(
      Persist.global("server", ["server.v3"]),
      createStore({
        list: [] as string[],
        scopes: {} as Record<string, StoredScope[]>,
      }),
    )

    const [active, setActiveRaw] = createSignal("")

    function setActive(input: string) {
      const url = normalizeServerUrl(input)
      if (!url) return
      setActiveRaw(url)
    }

    function add(input: string) {
      const url = normalizeServerUrl(input)
      if (!url) return

      const fallback = normalizeServerUrl(props.defaultUrl)
      if (fallback && url === fallback) {
        setActiveRaw(url)
        return
      }

      batch(() => {
        if (!store.list.includes(url)) {
          setStore("list", store.list.length, url)
        }
        setActiveRaw(url)
      })
    }

    function remove(input: string) {
      const url = normalizeServerUrl(input)
      if (!url) return

      const list = store.list.filter((x) => x !== url)
      const next = active() === url ? (list[0] ?? normalizeServerUrl(props.defaultUrl) ?? "") : active()

      batch(() => {
        setStore("list", list)
        setActiveRaw(next)
      })
    }

    createEffect(() => {
      if (!ready()) return
      if (active()) return
      const url = normalizeServerUrl(props.defaultUrl)
      if (!url) return
      setActiveRaw(url)
    })

    const isReady = createMemo(() => ready() && !!active())

    const [healthy, setHealthy] = createSignal<boolean | undefined>(undefined)
    const [refreshToken, setRefreshToken] = createSignal(0)

    const check = (url: string) => {
      const sdk = createSynergyClient({
        baseUrl: url,
        fetch: platform.fetch,
        signal: AbortSignal.timeout(HEALTH_TIMEOUT),
      })
      return sdk.global
        .health()
        .then((x) => x.data?.healthy === true)
        .catch(() => false)
    }

    createEffect(() => {
      const url = active()
      refreshToken()
      if (!url) return

      setHealthy(undefined)

      let alive = true
      let busy = false
      let consecutiveFailures = 0

      const run = () => {
        if (busy) return
        busy = true
        void check(url)
          .then((next) => {
            if (!alive) return
            if (next) {
              consecutiveFailures = 0
              setHealthy(true)
            } else {
              consecutiveFailures++
              if (consecutiveFailures >= CONSECUTIVE_FAILURES_TO_UNHEALTHY) {
                setHealthy(false)
              }
            }
          })
          .finally(() => {
            busy = false
          })
      }

      run()
      const interval = setInterval(run, 10_000)

      onCleanup(() => {
        alive = false
        clearInterval(interval)
      })
    })

    const origin = createMemo(() => projectsKey(active()))
    const scopesList = createMemo(() => store.scopes[origin()] ?? [])
    const isLocal = createMemo(() => origin() === "local")

    return {
      ready: isReady,
      healthy,
      isLocal,
      get url() {
        return active()
      },
      get name() {
        return serverDisplayName(active())
      },
      get list() {
        return store.list
      },
      setActive,
      add,
      remove,
      refresh() {
        setRefreshToken((value) => value + 1)
      },
      scopes: {
        list: scopesList,
        open(directory: string) {
          const key = origin()
          if (!key) return
          const current = store.scopes[key] ?? []
          if (current.find((x) => x.worktree === directory)) return
          setStore("scopes", key, [{ worktree: directory, expanded: true }, ...current])
        },
        close(directory: string) {
          const key = origin()
          if (!key) return
          const current = store.scopes[key] ?? []
          setStore(
            "scopes",
            key,
            current.filter((x) => x.worktree !== directory),
          )
        },
        expand(directory: string) {
          const key = origin()
          if (!key) return
          const current = store.scopes[key] ?? []
          const index = current.findIndex((x) => x.worktree === directory)
          if (index !== -1) setStore("scopes", key, index, "expanded", true)
        },
        collapse(directory: string) {
          const key = origin()
          if (!key) return
          const current = store.scopes[key] ?? []
          const index = current.findIndex((x) => x.worktree === directory)
          if (index !== -1) setStore("scopes", key, index, "expanded", false)
        },
        move(directory: string, toIndex: number) {
          const key = origin()
          if (!key) return
          const current = store.scopes[key] ?? []
          const fromIndex = current.findIndex((x) => x.worktree === directory)
          if (fromIndex === -1 || fromIndex === toIndex) return
          const result = [...current]
          const [item] = result.splice(fromIndex, 1)
          result.splice(toIndex, 0, item)
          setStore("scopes", key, result)
        },
      },
    }
  },
})
