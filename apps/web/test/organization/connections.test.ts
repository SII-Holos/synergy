import { expect, test } from "bun:test"
import { createOrganizationConnections } from "../../src/organization/connections"
import { spaceKey } from "../../src/context/space-state"
import { Persist } from "../../src/utils/persist"
import type { OrgClientTokens } from "@ericsanchezok/synergy-sdk/organization"
import type { OrganizationDesktop as Desktop } from "@ericsanchezok/synergy-organization-protocol"

function storage() {
  const values = new Map<string, string>()
  return {
    get length() {
      return values.size
    },
    key(index: number) {
      return [...values.keys()][index] ?? null
    },
    getItem(key: string) {
      return values.get(key) ?? null
    },
    setItem(key: string, value: string) {
      values.set(key, value)
    },
    removeItem(key: string) {
      values.delete(key)
    },
    clear() {
      values.clear()
    },
    values,
  }
}

function tokens(accountID = "a"): OrgClientTokens {
  return {
    issuer: "https://org.example",
    orgID: "org",
    deploymentIncarnation: "deployment",
    clientID: "web",
    account: {
      accountID,
      orgID: "org",
      loginName: accountID,
      displayName: accountID,
      role: "member",
      state: "active",
      revision: 1,
      authRevision: 1,
      createdAt: 0,
    },
    tokenType: "Bearer",
    accessToken: accountID.repeat(64),
    expiresAt: Date.now() + 60_000,
  }
}
const target = { issuer: "https://org.example", clientID: "web" }
const key = (accountID = "a") =>
  spaceKey({ kind: "organization", orgID: "org", accountID, deploymentIncarnation: "deployment" })

test("organization clients use verified accounts, cancel departed views and persist no credentials", async () => {
  const saved = storage()
  const pending = Promise.withResolvers<Response>()
  const started = Promise.withResolvers<void>()
  const requests: Request[] = []
  let next = tokens()
  let authorizations = 0
  const registry = createOrganizationConnections({
    storage: saved,
    origins: [target.issuer],
    redirectUri: "https://app.example/organization.html",
    authorize: async () => {
      authorizations++
      return next
    },
    fetch: Object.assign(
      async (input: RequestInfo | URL) => {
        const request = new Request(input)
        requests.push(request)
        started.resolve()
        return pending.promise
      },
      { preconnect() {} },
    ),
  })
  try {
    await registry.connect(target)
    const first = registry.current()!
    const oldClient = registry.client()!
    const response = oldClient.orgProjects.list({}, { throwOnError: true }).catch((error: unknown) => error)
    await started.promise
    next = tokens("b")
    await registry.connect(target)
    expect(first.signal.aborted).toBe(true)
    expect(registry.current()?.key).toBe(key("b"))
    expect(requests[0]?.headers.get("authorization")).toBe(`Bearer ${tokens().accessToken}`)
    expect(requests[0]?.credentials).toBe("omit")
    expect(requests[0]?.redirect).toBe("error")
    pending.resolve(Response.json({ items: [{ projectID: "private-a" }] }))
    expect(await response).toBeInstanceOf(DOMException)
    await expect(oldClient.orgProjects.list({}, { throwOnError: true })).rejects.toBeInstanceOf(DOMException)
    registry.select(key())
    expect(registry.current()?.generation).toBeGreaterThan(first.generation)
    expect(authorizations).toBe(2)
    const raw = [...saved.values.values()].join("")
    for (const credential of ["accessToken", "refreshToken", "verifier", tokens().accessToken, tokens("b").accessToken])
      expect(raw).not.toContain(credential)
    registry.select(undefined)
    expect(registry.current()).toBeUndefined()
    expect(registry.client()).toBeUndefined()
    const blocked = createOrganizationConnections({
      storage: saved,
      origins: [],
      redirectUri: "https://app.example/organization.html",
      authorize: async () => {
        throw new Error("must not authorize")
      },
    })
    await expect(blocked.connect(target)).rejects.toMatchObject({ code: "origin_not_allowed" })
    blocked.dispose()
  } finally {
    registry.dispose()
  }
})

test("reload requires explicit authorization and uncertain logout stays blocked until confirmed", async () => {
  const saved = storage()
  let authorizations = 0
  let fail = true
  let requests = 0
  const options = {
    storage: saved,
    origins: [target.issuer],
    redirectUri: "https://app.example/organization.html",
    authorize: async () => {
      authorizations++
      return tokens()
    },
    fetch: Object.assign(
      async () => {
        requests++
        if (fail) throw new Error("offline")
        return Response.json({ ok: true })
      },
      { preconnect() {} },
    ),
  }
  const first = createOrganizationConnections(options)
  await first.connect(target)
  first.dispose()
  const restored = createOrganizationConnections(options)
  try {
    restored.select(key())
    expect(restored.connection()?.state).toBe("reauthorization_required")
    expect(restored.client()).toBeUndefined()
    expect(authorizations).toBe(1)
    await restored.restore(key())
    const own = Persist.connection(key(), "draft")
    const other = Persist.connection(key("b"), "draft")
    saved.setItem(`${own.storage}:${own.key}`, "private draft")
    saved.setItem(`${other.storage}:${other.key}`, "other draft")
    await expect(restored.signOut(key())).rejects.toThrow()
    expect(restored.connection()?.state).toBe("sign_out_pending")
    expect(restored.client()).toBeUndefined()
    expect(requests).toBe(1)
    expect(saved.getItem(`${own.storage}:${own.key}`)).toBeNull()
    expect(saved.getItem(`${other.storage}:${other.key}`)).toBe("other draft")
    await expect(restored.restore(key())).rejects.toMatchObject({ code: "sign_out_pending" })
    await expect(restored.connect(target)).rejects.toMatchObject({ code: "sign_out_pending" })
    expect(restored.connection(key())?.state).toBe("sign_out_pending")
    expect(restored.client()).toBeUndefined()
    fail = false
    await restored.signOut(key())
    expect(restored.connection()?.state).toBe("signed_out")
    expect(requests).toBe(2)
    expect(authorizations).toBe(3)
    await restored.restore(key())
    expect(restored.client()).toBeDefined()
    expect(authorizations).toBe(4)
  } finally {
    restored.dispose()
  }
})

test("late or different-account authorization cannot replace the selected space", async () => {
  const pending = Promise.withResolvers<OrgClientTokens>()
  let next = Promise.resolve(tokens())
  let authorizations = 0
  const registry = createOrganizationConnections({
    storage: storage(),
    origins: [target.issuer],
    redirectUri: "https://app.example/organization.html",
    authorize: () => {
      authorizations++
      return next
    },
  })
  try {
    await registry.connect(target)
    next = Promise.resolve(tokens("b"))
    await expect(registry.restore(key())).rejects.toMatchObject({ code: "identity_changed" })
    expect(registry.connection()?.account.accountID).toBe("a")
    expect(registry.client()).toBeUndefined()
    next = pending.promise
    const connect = registry.restore(key()).catch((error: unknown) => error)
    registry.select(undefined)
    pending.resolve(tokens())
    expect(await connect).toMatchObject({ code: "cancelled" })
    expect(registry.current()).toBeUndefined()
    expect(registry.selected()).toBeUndefined()
  } finally {
    registry.dispose()
  }
  await expect(registry.connect(target)).rejects.toMatchObject({ code: "cancelled" })
  expect(authorizations).toBe(3)
})

test("native connections retain the exact IPC descriptor and cancel requests at a space boundary", async () => {
  const token = tokens()
  const descriptor: Desktop.Connection = {
    id: "c".repeat(64),
    issuer: token.issuer,
    orgID: token.orgID,
    deploymentIncarnation: token.deploymentIncarnation,
    clientID: "native",
    account: token.account,
    state: "ready",
  }
  const pending = Promise.withResolvers<Desktop.Result<Desktop.Response>>()
  const started = Promise.withResolvers<void>()
  const cancelled: string[] = []
  let invalid = false
  const bridge: Desktop.Bridge = {
    list: async () => ({ ok: true, value: [descriptor] }),
    connect: async () => ({
      ok: true,
      value: invalid ? { ...descriptor, account: { ...descriptor.account, accountID: "different" } } : descriptor,
    }),
    request: async (request) => {
      expect(request.connectionID).toBe(descriptor.id)
      started.resolve()
      return pending.promise
    },
    cancel: async ({ requestID }) => {
      cancelled.push(requestID)
      return { ok: true, value: undefined }
    },
    signOut: async () => ({ ok: true, value: { ...descriptor, state: "signed_out" } }),
    memberStatus: async () => ({ ok: true, value: { connectionID: descriptor.id, state: "stopped" } }),
    startMember: async () => ({ ok: false, error: { code: "unavailable" } }),
  }
  const registry = createOrganizationConnections({
    storage: storage(),
    origins: [],
    redirectUri: "https://app.example/organization.html",
    bridge,
  })
  try {
    await registry.load()
    registry.name(key(), "Verified organization")
    registry.select(key())
    const response = registry
      .client()!
      .orgProjects.list({}, { throwOnError: true })
      .catch((error: unknown) => error)
    await started.promise
    registry.select(undefined)
    expect(cancelled).toHaveLength(1)
    pending.resolve({ ok: true, value: { status: 200, body: JSON.stringify({ items: [] }) } })
    expect(await response).toBeInstanceOf(DOMException)
    invalid = true
    await expect(registry.restore(key())).rejects.toMatchObject({ code: "identity_changed" })
    expect(registry.client()).toBeUndefined()
    invalid = false
    await registry.restore(key())
    expect(registry.current()?.key).toBe(key())
    await registry.signOut(key())
    expect(registry.connection()?.state).toBe("signed_out")
  } finally {
    registry.dispose()
  }
})

test("expired Web authority still supports logout while inaccessible storage preserves its original record", async () => {
  const saved = storage()
  let current = tokens()
  current = { ...current, expiresAt: Date.now() + 100 }
  let authorizations = 0
  const registry = createOrganizationConnections({
    storage: saved,
    origins: [target.issuer],
    redirectUri: "https://app.example/organization.html",
    authorize: async () => {
      authorizations++
      return current
    },
    fetch: Object.assign(async () => Response.json({ ok: true }), { preconnect() {} }),
  })
  try {
    await registry.connect(target)
    const write = saved.setItem
    saved.setItem = () => {
      throw new Error("quota")
    }
    await Bun.sleep(Math.max(1, current.expiresAt - Date.now() + 1))
    expect(registry.client()).toBeUndefined()
    expect(registry.connection()?.state).toBe("reauthorization_required")
    expect(registry.error()).toMatchObject({ code: "storage_unavailable" })
    saved.setItem = write
    await registry.signOut(key())
    expect(registry.connection()?.state).toBe("signed_out")
    expect(authorizations).toBe(1)
  } finally {
    registry.dispose()
  }
  const storedKey = [...saved.values.keys()][0]!
  saved.setItem(storedKey, JSON.stringify({ version: 99, connections: [] }))
  const original = saved.getItem(storedKey)
  const broken = createOrganizationConnections({
    storage: saved,
    origins: [target.issuer],
    redirectUri: "https://app.example/organization.html",
    authorize: async () => tokens(),
  })
  try {
    expect(broken.error()).toMatchObject({ code: "storage_unavailable" })
    await expect(broken.connect(target)).rejects.toMatchObject({ code: "storage_unavailable" })
    expect(broken.client()).toBeUndefined()
    expect(saved.getItem(storedKey)).toBe(original)
  } finally {
    broken.dispose()
  }
})
