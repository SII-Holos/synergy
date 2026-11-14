import {
  batch,
  createContext,
  createEffect,
  createSignal,
  onCleanup,
  onMount,
  useContext,
  type ParentProps,
} from "solid-js"
import { OrganizationClientAuth } from "@ericsanchezok/synergy-organization-protocol"
import { z } from "zod"
import { usePlatform } from "./platform"
import { spaceKey } from "./space-state"
import { createOrganizationConnections, organizationSpaceKey } from "../organization/connections"
import {
  organizationRoute,
  parseOrganizationRoute,
  type OrganizationRoute,
  type OrganizationView,
} from "../organization/route"
import { assetPath, proxyPrefix } from "../utils/proxy"
import { base64Encode } from "@ericsanchezok/synergy-util/encode"

declare global {
  interface Window {
    __SYNERGY_WEB_CONNECT_ORIGINS__?: unknown
  }
}

function createSpace(props: { personalRuntimeID?: string }) {
  const platform = usePlatform()
  const parsed = z
    .array(OrganizationClientAuth.Origin)
    .max(32)
    .safeParse(window.__SYNERGY_WEB_CONNECT_ORIGINS__ ?? [])
  const origins = parsed.success ? parsed.data : []
  const connections = createOrganizationConnections({
    storage: localStorage,
    origins,
    bridge: platform.organization,
    fetch: platform.fetch,
    redirectUri: new URL(assetPath("/organization.html"), window.location.origin).href,
  })
  const [route, setRoute] = createSignal<OrganizationRoute>()
  const [navigation, setNavigation] = createSignal(0)
  let personalLocation = assetPath("/aG9tZQ/session")

  function receiveLocation() {
    const next = parseOrganizationRoute(window.location.pathname, proxyPrefix())
    if (!next) personalLocation = window.location.pathname + window.location.search + window.location.hash
    batch(() => {
      connections.select(
        next?.kind === "organization" ? spaceKey(next.identity) : next?.kind === "connect" ? "connect" : undefined,
      )
      setRoute(next)
      setNavigation((value) => value + 1)
    })
  }
  function navigate(path: string) {
    if (connections.selected() === undefined)
      personalLocation = window.location.pathname + window.location.search + window.location.hash
    window.history.pushState(null, "", path)
    window.dispatchEvent(new PopStateEvent("popstate"))
  }
  function open(key: string, projectID?: string, view?: OrganizationView, sessionID?: string) {
    const entry = connections.connections.find((item) => organizationSpaceKey(item) === key)
    if (!entry) return
    navigate(
      organizationRoute(
        {
          kind: "organization",
          orgID: entry.orgID,
          accountID: entry.account.accountID,
          deploymentIncarnation: entry.deploymentIncarnation,
        },
        projectID,
        proxyPrefix(),
        view,
        sessionID,
      ),
    )
  }
  receiveLocation()
  window.addEventListener("popstate", receiveLocation)
  createEffect(() => {
    navigation()
    connections.personal(props.personalRuntimeID)
  })
  onMount(() => {
    void connections.load()
  })
  onCleanup(() => {
    window.removeEventListener("popstate", receiveLocation)
    connections.dispose()
  })
  return {
    ...connections,
    get connections() {
      return connections.connections
    },
    route,
    origins,
    desktop: !!platform.organization,
    get available() {
      return !!platform.organization || origins.length > 0 || connections.connections.length > 0
    },
    personal() {
      navigate(personalLocation)
    },
    openPersonal(runtimeID: string, scopeID: string, sessionID?: string) {
      if (props.personalRuntimeID !== runtimeID) return false
      navigate(assetPath(`/${base64Encode(scopeID)}${sessionID ? `/session/${encodeURIComponent(sessionID)}` : ""}`))
      return true
    },
    open,
    add() {
      navigate(assetPath("/organization/connect"))
    },
    async connect(target: Parameters<typeof connections.connect>[0]) {
      open(await connections.connect(target))
    },
    async restore(key: string) {
      await connections.restore(key)
    },
    project(projectID?: string) {
      const key = connections.selected()
      if (key) open(key, projectID)
    },
    page(view?: OrganizationView, projectID?: string, sessionID?: string) {
      const key = connections.selected()
      if (key) open(key, projectID, view, sessionID)
    },
  }
}
const SpaceContext = createContext<ReturnType<typeof createSpace>>()
export function SpaceProvider(props: ParentProps<{ personalRuntimeID?: string }>) {
  const space = createSpace(props)
  return <SpaceContext.Provider value={space}>{props.children}</SpaceContext.Provider>
}
export function useOptionalSpace() {
  return useContext(SpaceContext)
}
export function useSpace() {
  const value = useOptionalSpace()
  if (!value) throw new Error("Space context must be used within a context provider")
  return value
}
