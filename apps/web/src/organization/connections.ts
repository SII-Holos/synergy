import { batch, createSignal } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import { z } from "zod"
import {
  OrganizationClientAuth as Auth,
  OrganizationDesktop as Desktop,
  OrganizationIdentity as Identity,
} from "@ericsanchezok/synergy-organization-protocol"
import {
  createOrganizationClient,
  type OrganizationClient,
  type OrgClientTokens,
} from "@ericsanchezok/synergy-sdk/organization"
import { generateUUID } from "@ericsanchezok/synergy-util/uuid"
import { createSpaceView, spaceKey } from "../context/space-state"
import { spaceFetch } from "../context/space-fetch"
import { Persist, workspaceEntryOwner } from "../utils/persist"
import { authorizeOrganization } from "./authorization"
import { desktopOrganizationFetch } from "./desktop"

const WebConnection = Auth.Authority.extend({
  transport: z.literal("web"),
  clientID: Identity.ID,
  account: Identity.Account,
  state: Desktop.Connection.shape.state,
  name: Identity.Name.optional(),
})
const NativeConnection = Desktop.Connection.extend({ transport: z.literal("desktop"), name: Identity.Name.optional() })
const Connection = z.discriminatedUnion("transport", [WebConnection, NativeConnection])
export type OrganizationConnection = z.infer<typeof Connection>
const SavedConnections = z.strictObject({ version: z.literal(1), connections: z.array(WebConnection).max(100) })
const persistence = Persist.global("organization-connections")
const storageKey = `${persistence.storage}:${persistence.key}`

export class OrganizationConnectionError extends Error {
  constructor(readonly code: Desktop.ErrorCode | "origin_not_allowed" | "storage_unavailable" | "sign_out_pending") {
    super("Organization connection unavailable")
    this.name = "OrganizationConnectionError"
  }
}

export function organizationSpaceKey(
  connection: Pick<OrganizationConnection, "orgID" | "deploymentIncarnation" | "account">,
) {
  return spaceKey({
    kind: "organization",
    orgID: connection.orgID,
    accountID: connection.account.accountID,
    deploymentIncarnation: connection.deploymentIncarnation,
  })
}

function clearCache(storage: Storage, key: string) {
  const prefix = `${Persist.connection(key, "").storage}:`
  for (const name of Array.from({ length: storage.length }, (_, index) => storage.key(index))) {
    if (!name) continue
    if (name.startsWith(prefix)) {
      storage.removeItem(name)
      continue
    }
    const owner = workspaceEntryOwner(name)
    if (!owner) continue
    try {
      const tuple: unknown = JSON.parse(owner)
      if (Array.isArray(tuple) && tuple[0] === key) storage.removeItem(name)
    } catch {
      continue
    }
  }
}

export function createOrganizationConnections(options: {
  storage: Storage
  origins: readonly string[]
  redirectUri: string
  bridge?: Desktop.Bridge
  fetch?: typeof fetch
  authorize?: typeof authorizeOrganization
}) {
  const view = createSpaceView()
  const [state, setState] = createStore({ connections: [] as OrganizationConnection[] })
  const [selected, setSelected] = createSignal<string>()
  const [client, setClient] = createSignal<OrganizationClient>()
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal<unknown>()
  const credentials = new Map<string, OrgClientTokens>()
  let authorization: AbortController | undefined
  let expiration: ReturnType<typeof setTimeout> | undefined
  let revision = 0
  let disposed = false
  let persistenceFailed = false

  function connection(key = selected()) {
    return state.connections.find((item) => organizationSpaceKey(item) === key)
  }
  function save() {
    if (options.bridge) return
    if (persistenceFailed) throw new OrganizationConnectionError("storage_unavailable")
    try {
      const saved = SavedConnections.parse({
        version: 1,
        connections: state.connections
          .filter((item) => item.transport === "web")
          .map((item) => ({ ...item, state: item.state === "ready" ? "reauthorization_required" : item.state })),
      })
      options.storage.setItem(storageKey, JSON.stringify(saved))
    } catch {
      throw new OrganizationConnectionError("storage_unavailable")
    }
  }
  function put(input: OrganizationConnection) {
    const value = Connection.parse(input)
    if (value.account.orgID !== value.orgID || (value.state === "ready" && value.account.state !== "active"))
      throw new OrganizationConnectionError("identity_changed")
    const index = state.connections.findIndex((item) => organizationSpaceKey(item) === organizationSpaceKey(value))
    if (index === -1) setState("connections", state.connections.length, value)
    else setState("connections", index, reconcile(value))
    save()
    return value
  }
  function suspend() {
    clearTimeout(expiration)
    expiration = undefined
    view.clear()
    setClient(undefined)
  }
  function cancel() {
    revision++
    authorization?.abort()
    authorization = undefined
    setBusy(false)
    suspend()
  }
  function requireAuthorization(key: string) {
    const entry = connection(key)
    if (!entry || entry.state !== "ready") return
    batch(() => {
      if (selected() === key) suspend()
      try {
        put({ ...entry, state: "reauthorization_required" })
      } catch (error) {
        setError(error)
      }
    })
  }
  function webClient(tokens: OrgClientTokens, signal: AbortSignal, onUnauthorized?: () => void) {
    const owned = spaceFetch(signal, options.fetch)
    const transport: typeof fetch = Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init)
        const url = new URL(request.url)
        if (
          url.origin !== tokens.issuer ||
          !url.pathname.startsWith("/org/v1/") ||
          url.username ||
          url.password ||
          url.hash
        )
          throw new OrganizationConnectionError("invalid_request")
        const headers = new Headers(request.headers)
        headers.set("authorization", `Bearer ${tokens.accessToken}`)
        headers.delete("cookie")
        const response = await owned(
          new Request(request, { headers, credentials: "omit", redirect: "error", referrerPolicy: "no-referrer" }),
        )
        if (response.status === 401) onUnauthorized?.()
        return response
      },
      { preconnect() {} },
    )
    return createOrganizationClient({
      baseUrl: tokens.issuer,
      fetch: transport,
      credentials: "omit",
      redirect: "error",
    })
  }
  function select(key: string | undefined) {
    if (disposed) return
    return batch(() => {
      cancel()
      setError(undefined)
      setSelected(key)
      if (disposed || key === undefined) return
      const entry = connection(key)
      if (!entry || entry.state !== "ready") return
      const token = credentials.get(key)
      if (entry.transport === "web" && (!token || token.expiresAt <= Date.now())) {
        requireAuthorization(key)
        return
      }
      const current = view.select({
        kind: "organization",
        orgID: entry.orgID,
        accountID: entry.account.accountID,
        deploymentIncarnation: entry.deploymentIncarnation,
      })
      if (entry.transport === "desktop") {
        if (!options.bridge) throw new OrganizationConnectionError("unavailable")
        const { transport: _transport, name: _name, ...descriptor } = entry
        const transport = spaceFetch(current.signal, desktopOrganizationFetch(options.bridge, descriptor))
        setClient(
          createOrganizationClient({
            baseUrl: entry.issuer,
            fetch: Object.assign(
              async (input: RequestInfo | URL, init?: RequestInit) => {
                try {
                  const response = await transport(input, init)
                  if (response.status === 401 && view.isCurrent(current)) requireAuthorization(key)
                  return response
                } catch (error) {
                  if (
                    view.isCurrent(current) &&
                    error &&
                    typeof error === "object" &&
                    "code" in error &&
                    ["reauthorization_required", "signed_out", "identity_changed"].includes(String(error.code))
                  )
                    requireAuthorization(key)
                  throw error
                }
              },
              { preconnect() {} },
            ),
            credentials: "omit",
            redirect: "error",
          }),
        )
        return
      }
      setClient(
        webClient(token!, current.signal, () => {
          if (view.isCurrent(current)) requireAuthorization(key)
        }),
      )
      expiration = setTimeout(
        () => {
          if (view.isCurrent(current)) requireAuthorization(key)
        },
        Math.min(token!.expiresAt - Date.now(), 2_147_483_647),
      )
    })
  }
  function assertCurrent(controller: AbortController, version: number) {
    if (disposed || controller.signal.aborted || version !== revision)
      throw new OrganizationConnectionError("cancelled")
  }
  async function authorize(target: Desktop.Connect, controller: AbortController, version: number) {
    const result = Desktop.Connect.safeParse(target)
    if (!result.success) throw new OrganizationConnectionError("invalid_request")
    const parsed = result.data
    if (options.bridge) {
      const requestID = generateUUID()
      const abort = () => {
        void options.bridge!.cancel({ requestID }).catch(() => {})
      }
      controller.signal.addEventListener("abort", abort, { once: true })
      try {
        const result = await options.bridge.connect({ requestID, target: parsed })
        assertCurrent(controller, version)
        if (!result.ok) throw new OrganizationConnectionError(result.error.code)
        const entry = Desktop.Connection.parse(result.value)
        if (
          entry.issuer !== parsed.issuer ||
          entry.clientID !== parsed.clientID ||
          entry.account.orgID !== entry.orgID ||
          entry.state !== "ready" ||
          entry.account.state !== "active" ||
          (parsed.expected &&
            (entry.orgID !== parsed.expected.orgID ||
              entry.deploymentIncarnation !== parsed.expected.deploymentIncarnation ||
              (parsed.expected.accountID !== undefined && entry.account.accountID !== parsed.expected.accountID)))
        )
          throw new OrganizationConnectionError("identity_changed")
        return { entry: { ...entry, transport: "desktop" as const }, tokens: undefined }
      } finally {
        controller.signal.removeEventListener("abort", abort)
      }
    }
    if (!options.origins.includes(parsed.issuer)) throw new OrganizationConnectionError("origin_not_allowed")
    const tokens = Auth.Tokens.parse(
      await (options.authorize ?? authorizeOrganization)({
        issuer: parsed.issuer,
        clientID: parsed.clientID,
        ...parsed.expected,
        redirectUri: options.redirectUri,
        signal: controller.signal,
        fetch: options.fetch,
      }),
    )
    assertCurrent(controller, version)
    if (
      tokens.issuer !== parsed.issuer ||
      tokens.clientID !== parsed.clientID ||
      tokens.account.orgID !== tokens.orgID ||
      tokens.account.state !== "active" ||
      tokens.expiresAt <= Date.now() ||
      tokens.refreshToken !== undefined ||
      tokens.refreshExpiresAt !== undefined ||
      (parsed.expected &&
        (tokens.orgID !== parsed.expected.orgID ||
          tokens.deploymentIncarnation !== parsed.expected.deploymentIncarnation ||
          (parsed.expected.accountID !== undefined && tokens.account.accountID !== parsed.expected.accountID)))
    )
      throw new OrganizationConnectionError("identity_changed")
    const entry = WebConnection.parse({
      transport: "web",
      issuer: tokens.issuer,
      orgID: tokens.orgID,
      deploymentIncarnation: tokens.deploymentIncarnation,
      clientID: tokens.clientID,
      account: tokens.account,
      state: "ready",
    })
    return { entry, tokens }
  }
  async function connect(target: Desktop.Connect, existingKey?: string) {
    if (disposed) throw new OrganizationConnectionError("cancelled")
    const previous = existingKey ? connection(existingKey) : undefined
    if (previous?.state === "sign_out_pending") throw new OrganizationConnectionError("sign_out_pending")
    cancel()
    setSelected(existingKey ?? "connect")
    setError(undefined)
    const controller = (authorization = new AbortController())
    const version = revision
    setBusy(true)
    try {
      if (previous) put({ ...previous, state: "reauthorization_required" })
      const { entry, tokens } = await authorize(target, controller, version)
      const key = organizationSpaceKey(entry)
      const known = connection(key)
      if (known && (known.issuer !== entry.issuer || known.clientID !== entry.clientID))
        throw new OrganizationConnectionError("identity_changed")
      if (known?.state === "sign_out_pending") throw new OrganizationConnectionError("sign_out_pending")
      put(entry)
      if (tokens) credentials.set(key, tokens)
      select(key)
      return key
    } catch (error) {
      if (revision === version) setError(error)
      throw error
    } finally {
      if (revision === version) {
        authorization = undefined
        setBusy(false)
      }
    }
  }
  function restore(key: string) {
    const entry = connection(key)
    if (!entry) return Promise.reject(new OrganizationConnectionError("invalid_request"))
    return connect(
      {
        issuer: entry.issuer,
        clientID: entry.clientID,
        expected: {
          orgID: entry.orgID,
          deploymentIncarnation: entry.deploymentIncarnation,
          accountID: entry.account.accountID,
        },
      },
      key,
    )
  }
  async function signOut(key: string) {
    if (disposed) throw new OrganizationConnectionError("cancelled")
    const entry = connection(key)
    if (!entry) throw new OrganizationConnectionError("invalid_request")
    cancel()
    setSelected(key)
    const controller = (authorization = new AbortController())
    const version = revision
    setBusy(true)
    setError(undefined)
    try {
      put({ ...entry, state: "sign_out_pending" })
      try {
        clearCache(options.storage, key)
      } catch {
        throw new OrganizationConnectionError("storage_unavailable")
      }
      if (entry.transport === "desktop") {
        const result = await options.bridge!.signOut({ connectionID: entry.id })
        assertCurrent(controller, version)
        if (!result.ok) throw new OrganizationConnectionError(result.error.code)
        put({ ...Desktop.Connection.parse(result.value), transport: "desktop" })
      } else {
        let token = credentials.get(key)
        if (!token) {
          const result = await authorize(
            {
              issuer: entry.issuer,
              clientID: entry.clientID,
              expected: {
                orgID: entry.orgID,
                deploymentIncarnation: entry.deploymentIncarnation,
                accountID: entry.account.accountID,
              },
            },
            controller,
            version,
          )
          token = result.tokens!
          credentials.set(key, token)
        }
        const result = await webClient(token, controller.signal).orgAuth.logout({ orgEmptyInput: {} })
        assertCurrent(controller, version)
        if (result.error) {
          if (result.response.status === 401) credentials.delete(key)
          throw result.error
        }
        if (result.data?.ok !== true) throw new OrganizationConnectionError("invalid_response")
        credentials.delete(key)
        put({ ...entry, state: "signed_out" })
      }
    } catch (error) {
      if (revision === version) setError(error)
      throw error
    } finally {
      if (revision === version) {
        authorization = undefined
        setBusy(false)
      }
    }
  }
  try {
    const raw = options.storage.getItem(storageKey)
    if (!options.bridge && raw)
      setState(
        "connections",
        reconcile(
          SavedConnections.parse(JSON.parse(raw)).connections.map((entry) => ({
            ...entry,
            state: entry.state === "ready" ? ("reauthorization_required" as const) : entry.state,
          })),
        ),
      )
  } catch {
    persistenceFailed = true
    setError(new OrganizationConnectionError("storage_unavailable"))
  }

  return {
    get connections() {
      return state.connections
    },
    selected,
    connection,
    current: view.current,
    client,
    busy,
    error,
    select,
    connect,
    restore,
    signOut,
    personal(runtimeID?: string) {
      if (selected() !== undefined || disposed) return
      if (!runtimeID) {
        suspend()
        return
      }
      if (
        view.current()?.identity.kind === "personal" &&
        view.current()?.key === spaceKey({ kind: "personal", localRuntimeID: runtimeID })
      )
        return
      view.select({ kind: "personal", localRuntimeID: runtimeID })
    },
    name(key: string, name: string) {
      if (disposed) return
      const entry = connection(key)
      if (entry) put({ ...entry, name: Identity.Name.parse(name) })
    },
    async load() {
      if (disposed || !options.bridge) return
      const version = revision
      try {
        const result = await options.bridge.list()
        if (disposed || version !== revision) return
        if (!result.ok) throw new OrganizationConnectionError(result.error.code)
        const entries = z
          .array(Desktop.Connection)
          .parse(result.value)
          .map((entry) => ({ ...entry, transport: "desktop" as const }))
        if (
          entries.some(
            (entry) =>
              entry.account.orgID !== entry.orgID || (entry.state === "ready" && entry.account.state !== "active"),
          )
        )
          throw new OrganizationConnectionError("identity_changed")
        setState("connections", reconcile(entries))
        select(selected())
      } catch (error) {
        if (!disposed && version === revision) setError(error)
      }
    },
    dispose() {
      disposed = true
      cancel()
      credentials.clear()
    },
  }
}
