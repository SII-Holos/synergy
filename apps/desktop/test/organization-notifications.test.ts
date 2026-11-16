import { expect, test } from "bun:test"
import {
  OrganizationDesktop as Desktop,
  OrganizationNotificationProtocol as Notification,
} from "@ericsanchezok/synergy-organization-protocol"
import { DesktopOrganizationNotifications } from "../src/organization/notification-stream"

function fixture(ackMs = 1000) {
  const connection = Desktop.Connection.parse({
    issuer: "https://organization.example",
    orgID: "org",
    deploymentIncarnation: "deployment",
    clientID: "desktop",
    id: "a".repeat(64),
    revision: crypto.randomUUID(),
    state: "ready",
    account: {
      accountID: "account",
      orgID: "org",
      displayName: "Account",
      loginName: "account",
      role: "member",
      state: "active",
      revision: 1,
      authRevision: 1,
      createdAt: 1,
    },
  })
  let saved = connection
  let current = true
  let transport: ReadableStreamDefaultController<Uint8Array> | undefined
  let cancelled = false
  let released = false
  const work = new AbortController()
  const input = { requestID: crypto.randomUUID(), connectionID: connection.id, revision: connection.revision }
  const streamID = crypto.randomUUID()
  const ready: Notification.Frame = {
    type: "ready",
    streamID,
    sequence: 0,
    orgID: "org",
    accountID: "account",
    deploymentIncarnation: "deployment",
    authRevision: 1,
  }
  const notices: Desktop.NotificationEvent[] = []
  const changed = new Set<() => void>()
  const owner = new DesktopOrganizationNotifications({
    reserve(requestID, connectionID, valid) {
      expect({ requestID, connectionID }).toEqual({ requestID: input.requestID, connectionID: input.connectionID })
      return {
        signal: work.signal,
        current: () => valid() && !work.signal.aborted && !released,
        release() {
          released = true
        },
        abort() {
          work.abort()
        },
      }
    },
    async access() {
      return { connection: saved, accessToken: "private-native-token" }
    },
    fetch: Object.assign(
      async (request: RequestInfo | URL) => {
        const actual = new Request(request)
        expect(actual.url).toBe("https://organization.example/org/v1/notifications")
        expect(actual.headers.get("authorization")).toBe("Bearer private-native-token")
        expect(actual.redirect).toBe("error")
        return new Response(
          new ReadableStream<Uint8Array>({
            start(value) {
              transport = value
              value.enqueue(Notification.encode(ready))
            },
            cancel() {
              cancelled = true
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        )
      },
      { preconnect() {} },
    ),
    ackMs,
  })
  const emit = (value: Desktop.NotificationEvent) => {
    notices.push(value)
    for (const listener of changed) listener()
  }
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
        timer = setTimeout(() => reject(new Error("Native notification fixture timed out")), 2000)
      })
    } finally {
      clearTimeout(timer)
      changed.delete(listener)
    }
  }
  const send = (sequence: number) =>
    transport!.enqueue(
      Notification.encode({
        type: "notice",
        streamID,
        sequence,
        notice: {
          noticeID: crypto.randomUUID(),
          kind: "completion",
          sessionID: "session",
          binding: {
            schemaVersion: 1,
            orgID: "org",
            projectID: "project",
            creatorID: "account",
            driverRuntimeID: "runtime",
            bindingEpoch: 1,
          },
          occurredAt: 1,
        },
      }),
    )
  return {
    owner,
    input,
    streamID,
    notices,
    until,
    emit,
    send,
    valid: () => current,
    stop() {
      owner.stop({ requestID: input.requestID, connectionID: input.connectionID }, () => true)
    },
    retire() {
      current = false
      work.abort()
    },
    replace() {
      saved = { ...saved, revision: crypto.randomUUID() }
    },
    get cancelled() {
      return cancelled
    },
    get released() {
      return released
    },
  }
}

test("native live subscriptions emit one acknowledged metadata frame at a time without exposing credentials", async () => {
  const f = fixture()
  try {
    await f.owner.start(f.input, f.valid, f.emit)
    expect(f.notices).toHaveLength(1)
    expect(f.notices[0]).toMatchObject({ type: "frame", ...f.input, frame: { type: "ready", sequence: 0 } })
    f.send(1)
    expect(f.notices).toHaveLength(1)
    f.owner.ack(
      { requestID: f.input.requestID, connectionID: f.input.connectionID, streamID: f.streamID, sequence: 0 },
      f.valid,
    )
    await f.until(() => f.notices.length === 2)
    expect(f.notices[1]).toMatchObject({ type: "frame", frame: { type: "notice", sequence: 1 } })
    expect(JSON.stringify(f.notices)).not.toContain("private-native-token")
  } finally {
    f.stop()
  }
})

test("a replaced account revision or document retires the original native stream before another frame is emitted", async () => {
  const f = fixture()
  await f.owner.start(f.input, f.valid, f.emit)
  f.replace()
  f.owner.ack(
    { requestID: f.input.requestID, connectionID: f.input.connectionID, streamID: f.streamID, sequence: 0 },
    f.valid,
  )
  f.send(1)
  await f.until(() => f.notices.some((event) => event.type === "closed"))
  expect(f.notices.filter((event) => event.type === "frame")).toHaveLength(1)
  expect(f.notices.at(-1)).toMatchObject({ type: "closed", code: "connection_changed" })
  expect(f.cancelled).toBe(true)
  expect(f.released).toBe(true)
  const second = fixture()
  await second.owner.start(second.input, second.valid, second.emit)
  second.retire()
  await second.until(() => second.released)
  expect(second.cancelled).toBe(true)
  expect(second.notices.filter((event) => event.type === "frame")).toHaveLength(1)
})

test("a renderer that does not acknowledge closes its stream instead of accumulating native IPC frames", async () => {
  const f = fixture(10)
  await f.owner.start(f.input, f.valid, f.emit)
  f.send(1)
  await f.until(() => f.notices.some((event) => event.type === "closed"))
  expect(f.notices.filter((event) => event.type === "frame")).toHaveLength(1)
  expect(f.cancelled).toBe(true)
  expect(f.released).toBe(true)
})
