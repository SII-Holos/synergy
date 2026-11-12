import { expect, test } from "bun:test"
import { OrganizationNotificationProtocol as Notification } from "@ericsanchezok/synergy-organization-protocol"
import type { OrgClientTokens } from "@ericsanchezok/synergy-sdk/organization"
import { createOrganizationConnections } from "../../src/organization/connections"

const target = { issuer: "https://organization.example", clientID: "web" }
function token(
  accountID = "account-a",
  deploymentIncarnation = "deployment-a",
  accessToken = "a".repeat(64),
): OrgClientTokens {
  return {
    ...target,
    orgID: "org",
    deploymentIncarnation,
    tokenType: "Bearer",
    accessToken,
    expiresAt: Date.now() + 60_000,
    account: {
      accountID,
      orgID: "org",
      loginName: accountID,
      displayName: accountID,
      role: "member",
      state: "active",
      revision: 1,
      authRevision: 1,
      createdAt: 1,
    },
  }
}
function fixture(holdFirst = false) {
  const values = new Map<string, string>()
  const saved: Storage = {
    get length() {
      return values.size
    },
    key(index) {
      return [...values.keys()][index] ?? null
    },
    getItem(key) {
      return values.get(key) ?? null
    },
    setItem(key, value) {
      values.set(key, value)
    },
    removeItem(key) {
      values.delete(key)
    },
    clear() {
      values.clear()
    },
  }
  let next = token()
  const issued = new Map<string, OrgClientTokens>()
  const requests: Array<{
    controller: ReadableStreamDefaultController<Uint8Array>
    streamID: string
    token: OrgClientTokens
    cancelled: boolean
  }> = []
  const held = Promise.withResolvers<Response>()
  const changed = new Set<() => void>()
  const wake = () => {
    for (const listener of changed) listener()
  }
  const registry = createOrganizationConnections({
    storage: saved,
    origins: [target.issuer],
    redirectUri: "https://app.example/organization.html",
    async authorize() {
      issued.set(next.accessToken, next)
      return next
    },
    fetch: Object.assign(
      async (input: RequestInfo | URL) => {
        const request = new Request(input)
        expect(request.url).toBe(`${target.issuer}/org/v1/notifications`)
        const owned = issued.get(request.headers.get("authorization")!.slice(7))
        if (!owned) throw new Error("Unknown fixture credential")
        const streamID = crypto.randomUUID()
        let context!: (typeof requests)[number]
        const response = new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              context = { controller, streamID, token: owned, cancelled: false }
              requests.push(context)
              controller.enqueue(
                Notification.encode({
                  type: "ready",
                  streamID,
                  sequence: 0,
                  orgID: owned.orgID,
                  accountID: owned.account.accountID,
                  deploymentIncarnation: owned.deploymentIncarnation,
                  authRevision: owned.account.authRevision,
                }),
              )
              wake()
            },
            cancel() {
              context.cancelled = true
              wake()
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        )
        if (holdFirst && requests.length === 1) return held.promise
        return response
      },
      { preconnect() {} },
    ),
  })
  async function until(predicate: () => boolean) {
    if (predicate()) return
    let timer: ReturnType<typeof setTimeout> | undefined
    let listener!: () => void
    try {
      await new Promise<void>((resolve, reject) => {
        listener = () => {
          if (predicate()) resolve()
        }
        changed.add(listener)
        timer = setTimeout(() => reject(new Error("Notification connection fixture timed out")), 2000)
      })
    } finally {
      clearTimeout(timer)
      changed.delete(listener)
    }
  }
  const notice = (index: number, sequence = 1) => {
    const request = requests[index]
    if (!request) throw new Error("Notification source did not open")
    return {
      type: "notice" as const,
      streamID: request.streamID,
      sequence,
      notice: {
        noticeID: crypto.randomUUID(),
        kind: "completion" as const,
        sessionID: "session",
        binding: {
          schemaVersion: 1 as const,
          orgID: "org",
          projectID: "project",
          creatorID: request.token.account.accountID,
          driverRuntimeID: "runtime",
          bindingEpoch: 1,
        },
        occurredAt: 1,
      },
    }
  }
  function releaseFirst() {
    const request = requests[0]
    if (!request) return
    held.resolve(
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(
              Notification.encode({
                type: "ready",
                streamID: request.streamID,
                sequence: 0,
                orgID: "org",
                accountID: request.token.account.accountID,
                deploymentIncarnation: request.token.deploymentIncarnation,
                authRevision: 1,
              }),
            )
            controller.enqueue(Notification.encode(notice(0)))
          },
          cancel() {
            request.cancelled = true
            wake()
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      ),
    )
  }
  return {
    registry,
    requests,
    until,
    notice,
    wake,
    next(value: OrgClientTokens) {
      next = value
    },
    releaseFirst,
    dispose() {
      registry.dispose()
      releaseFirst()
    },
  }
}

test("one Web source survives personal and other-account views and is shared by notification consumers", async () => {
  const f = fixture()
  const notices: Notification.Observation[] = []
  try {
    const key = await f.registry.connect(target)
    const first = f.registry.subscribeNotifications(key, (value) => {
      notices.push(value)
      f.wake()
    })
    const second = f.registry.subscribeNotifications(key, () => {})
    await f.until(() => f.requests.length === 1)
    f.registry.select(undefined)
    f.registry.personal("00000000-0000-4000-8000-000000000001")
    f.requests[0].controller.enqueue(Notification.encode(f.notice(0)))
    await f.until(() => notices.length === 1)
    f.next(token("account-b", "deployment-a", "b".repeat(64)))
    const b = await f.registry.connect(target)
    const owner = f.registry.current()
    f.requests[0].controller.enqueue(Notification.encode(f.notice(0, 2)))
    await f.until(() => notices.length === 2)
    expect(f.registry.selected()).toBe(b)
    expect(f.registry.current()).toBe(owner)
    expect(f.registry.error()).toBeUndefined()
    expect(f.requests).toHaveLength(1)
    first()
    expect(f.requests[0].cancelled).toBe(false)
    second()
    await f.until(() => f.requests[0].cancelled)
  } finally {
    f.dispose()
  }
})

test("a later verified deployment at the same issuer retires the old source before its held bytes arrive", async () => {
  const f = fixture(true)
  const notices: Notification.Observation[] = []
  try {
    const old = await f.registry.connect(target)
    f.registry.subscribeNotifications(old, (value) => {
      notices.push(value)
      f.wake()
    })
    await f.until(() => f.requests.length === 1)
    f.next(token("account-a", "deployment-b", "c".repeat(64)))
    const current = await f.registry.connect(target)
    f.releaseFirst()
    await f.until(() => f.requests[0].cancelled || notices.length > 0)
    expect(notices).toEqual([])
    expect(f.registry.connection(old)?.state).toBe("reauthorization_required")
    expect(f.registry.connection(current)?.state).toBe("ready")
    expect(f.registry.selected()).toBe(current)
  } finally {
    f.dispose()
  }
})

test("a fresh login keeps the source key but retires the old credential-bound read without duplicate subscriptions", async () => {
  const f = fixture(true)
  const notices: Notification.Observation[] = []
  try {
    const key = await f.registry.connect(target)
    f.registry.subscribeNotifications(key, (value) => {
      notices.push(value)
      f.wake()
    })
    await f.until(() => f.requests.length === 1)
    f.next(token("account-a", "deployment-a", "c".repeat(64)))
    expect(await f.registry.connect(target)).toBe(key)
    await f.until(() => f.requests.length === 2)
    f.requests[1].controller.enqueue(Notification.encode(f.notice(1)))
    await f.until(() => notices.length === 1)
    f.releaseFirst()
    await f.until(() => f.requests[0].cancelled)
    expect(notices).toHaveLength(1)
    expect(f.requests).toHaveLength(2)
  } finally {
    f.dispose()
  }
})

test("a retired consumer cannot be called after an earlier listener yields while their shared source stays live", async () => {
  const f = fixture()
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const completed = Promise.withResolvers<void>()
  let retiredCalls = 0
  try {
    const key = await f.registry.connect(target)
    f.registry.subscribeNotifications(key, async () => {
      entered.resolve()
      await release.promise
    })
    const retire = f.registry.subscribeNotifications(key, () => {
      retiredCalls++
    })
    f.registry.subscribeNotifications(key, () => completed.resolve())
    await f.until(() => f.requests.length === 1)
    f.requests[0].controller.enqueue(Notification.encode(f.notice(0)))
    await entered.promise
    retire()
    release.resolve()
    await completed.promise
    expect(retiredCalls).toBe(0)
    expect(f.requests[0].cancelled).toBe(false)
  } finally {
    release.resolve()
    f.dispose()
  }
})
