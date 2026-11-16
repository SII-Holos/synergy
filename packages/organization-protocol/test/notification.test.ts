import { expect, test } from "bun:test"
import { OrganizationNotificationProtocol as Notification } from "../src/notification"

const audience = { orgID: "org", accountID: "account", deploymentIncarnation: "deployment", authRevision: 1 }
const streamID = "00000000-0000-4000-8000-000000000001"
const ready = { ...audience, type: "ready" as const, streamID, sequence: 0 as const }
const heartbeat = { type: "heartbeat" as const, streamID, sequence: 1 }
const notice = {
  noticeID: "00000000-0000-4000-8000-000000000002",
  kind: "completion" as const,
  sessionID: "session",
  binding: {
    schemaVersion: 1 as const,
    orgID: "org",
    projectID: "project",
    creatorID: "account",
    driverRuntimeID: "runtime",
    bindingEpoch: 1,
  },
  occurredAt: 1,
}

function stream(chunks: Uint8Array[]) {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk)
      controller.close()
    },
  })
}
async function collect(chunks: Uint8Array[], expected = audience) {
  return Array.fromAsync(Notification.read(stream(chunks), expected))
}

test("live frames retain a captured audience and contiguous stream identity across fragmentation", async () => {
  const expected = { ...audience }
  const bytes = new Uint8Array([
    ...Notification.encode(ready),
    ...Notification.encode(heartbeat),
    ...Notification.encode({ type: "notice", streamID, sequence: 2, notice }),
  ])
  const input = stream(Array.from(bytes, (byte) => new Uint8Array([byte])))
  const reader = Notification.read(input, expected)
  expected.accountID = "later-account"
  expect(await Array.fromAsync(reader)).toEqual([ready, heartbeat, { type: "notice", streamID, sequence: 2, notice }])
  expect(Notification.Observation.safeParse({ ...notice, title: "private" }).success).toBe(false)
  expect(Notification.Observation.safeParse({ ...notice, error: "private" }).success).toBe(false)
})

test("malformed, changed, oversized and truncated frames cannot cross a live subscription", async () => {
  await expect(collect([Notification.encode({ ...ready, accountID: "foreign" })])).rejects.toThrow("audience")
  await expect(
    collect([Notification.encode(ready), Notification.encode({ ...heartbeat, sequence: 2 })]),
  ).rejects.toThrow("contiguous")
  await expect(
    collect([Notification.encode(ready), Notification.encode({ ...heartbeat, streamID: crypto.randomUUID() })]),
  ).rejects.toThrow("stream changed")
  await expect(
    collect([
      Notification.encode(ready),
      Notification.encode({
        type: "notice",
        streamID,
        sequence: 1,
        notice: { ...notice, binding: { ...notice.binding, orgID: "foreign" } },
      }),
    ]),
  ).rejects.toThrow("organization")
  await expect(collect([new TextEncoder().encode("data: " + "x".repeat(Notification.FrameLimit))])).rejects.toThrow(
    "bound",
  )
  await expect(collect([Notification.encode(ready), new Uint8Array([0xe4])])).rejects.toThrow()
  await expect(collect([new TextEncoder().encode("data: {}")])).rejects.toThrow("incomplete")
})

test("abort before first next or between yielded frames never starts a later stream read", async () => {
  const controller = new AbortController()
  let pulls = 0
  const input = new ReadableStream<Uint8Array>(
    {
      pull(value) {
        pulls++
        value.enqueue(Notification.encode(ready))
      },
    },
    { highWaterMark: 0 },
  )
  const reader = Notification.read(input, audience, controller.signal)
  controller.abort()
  await expect(reader.next()).rejects.toThrow()
  expect(pulls).toBe(0)
  const active = new AbortController()
  let cancelled = false
  const second = Notification.read(
    new ReadableStream<Uint8Array>(
      {
        pull(value) {
          pulls++
          value.enqueue(Notification.encode(ready))
        },
        cancel() {
          cancelled = true
        },
      },
      { highWaterMark: 0 },
    ),
    audience,
    active.signal,
  )
  expect((await second.next()).value).toEqual(ready)
  active.abort()
  await expect(second.next()).rejects.toThrow()
  expect(pulls).toBe(1)
  expect(cancelled).toBe(true)
})
