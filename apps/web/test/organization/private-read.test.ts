import { expect, test } from "bun:test"
import { createOrganizationClient } from "@ericsanchezok/synergy-sdk/organization"
import { createOrganizationSessionReader } from "../../src/organization/private-read"
import type { OrganizationDesktop as Desktop } from "@ericsanchezok/synergy-organization-protocol"

const binding = {
  schemaVersion: 1,
  orgID: "org-a",
  projectID: "project-a",
  creatorID: "account-a",
  driverRuntimeID: "member-a",
  bindingEpoch: 1,
} as const
const query = { operation: "status", rootSessionID: "session-a" } as const
const value = {
  ...query,
  sourceSessionID: "session-a",
  binding,
  status: { type: "idle", controlVersion: 1, observedAt: 1 },
} as const
function client(requests: Request[]) {
  return createOrganizationClient({
    baseUrl: "https://org.example",
    fetch: Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        requests.push(new Request(input, init))
        return Response.json(value)
      },
      { preconnect() {} },
    ),
  })
}
function bridge(requests: Desktop.MemberRequest[]): Pick<Desktop.Bridge, "memberStatus" | "memberRequest" | "cancel"> {
  return {
    async memberStatus() {
      return {
        ok: true as const,
        value: { connectionID: "a".repeat(64), state: "running" as const, runtimeID: "member-a" },
      }
    },
    async memberRequest(input: Desktop.MemberRequest): Promise<Desktop.Result<Desktop.MemberReadOutcome>> {
      requests.push(input)
      return { ok: true, value: { kind: "result", result: value } }
    },
    async cancel() {
      return { ok: true, value: undefined }
    },
  }
}

test("private reads choose the captured supervised driver and keep the same typed query", async () => {
  const local: Desktop.MemberRequest[] = []
  const remote: Request[] = []
  const read = createOrganizationSessionReader({
    api: client(remote),
    bridge: bridge(local),
    connectionID: "a".repeat(64),
    binding,
    signal: new AbortController().signal,
  })
  expect(await read(query)).toEqual(value)
  expect(local[0]).toMatchObject({ connectionID: "a".repeat(64), query })
  expect(remote).toHaveLength(0)
  const other = createOrganizationSessionReader({
    api: client(remote),
    bridge: bridge(local),
    connectionID: "a".repeat(64),
    binding: { ...binding, driverRuntimeID: "remote-member" },
    signal: new AbortController().signal,
  })
  await expect(other(query)).rejects.toMatchObject({ code: "STALE_BINDING" })
  expect(remote[0]?.url).toBe("https://org.example/org/v1/sessions/session-a/read")
  expect(JSON.parse(await remote[0]!.text())).toEqual(query)
  expect(local).toHaveLength(1)
})

test("a native business conflict never falls back to a different transport", async () => {
  const remote: Request[] = []
  const native = bridge([])
  native.memberRequest = async () => ({ ok: true, value: { kind: "revision_conflict" } })
  const read = createOrganizationSessionReader({
    api: client(remote),
    bridge: native,
    connectionID: "a".repeat(64),
    binding,
    signal: new AbortController().signal,
  })
  await expect(read(query)).rejects.toMatchObject({ code: "REVISION_CONFLICT" })
  expect(remote).toHaveLength(0)
})

test("aborting a native read cancels its exact request and discards a late reply", async () => {
  const remote: Request[] = []
  const pending = Promise.withResolvers<Desktop.Result<Desktop.MemberReadOutcome>>()
  const started = Promise.withResolvers<void>()
  const controller = new AbortController()
  const native = bridge([])
  let requestID = ""
  const cancelled: string[] = []
  native.memberRequest = async (input) => {
    requestID = input.requestID
    started.resolve()
    return pending.promise
  }
  native.cancel = async (input: { requestID: string }) => {
    cancelled.push(input.requestID)
    return { ok: true, value: undefined }
  }
  const read = createOrganizationSessionReader({
    api: client(remote),
    bridge: native,
    connectionID: "a".repeat(64),
    binding,
    signal: controller.signal,
  })
  const result = read(query).catch((error: unknown) => error)
  await started.promise
  controller.abort()
  pending.resolve({ ok: true, value: { kind: "result", result: value } })
  expect(await result).toBeInstanceOf(DOMException)
  expect(cancelled).toEqual([requestID])
  expect(remote).toHaveLength(0)
})

test("native reauthorization reports the captured owner while wrong bindings stay local", async () => {
  const native = bridge([])
  const errors: string[] = []
  native.memberRequest = async () => ({ ok: false, error: { code: "reauthorization_required" } })
  const read = createOrganizationSessionReader({
    api: client([]),
    bridge: native,
    connectionID: "a".repeat(64),
    binding,
    signal: new AbortController().signal,
    authorizationRequired: () => errors.push("owner-a"),
  })
  await expect(read(query)).rejects.toMatchObject({ code: "reauthorization_required" })
  expect(errors).toEqual(["owner-a"])
  native.memberRequest = async () => ({ ok: true, value: { kind: "binding_changed" } })
  await expect(read(query)).rejects.toMatchObject({ code: "STALE_BINDING" })
  expect(errors).toEqual(["owner-a"])
})

test("a private reading window bounds concurrent native requests and drops cancelled queued reads", async () => {
  const native = bridge([])
  const held = Promise.withResolvers<Desktop.Result<Desktop.MemberReadOutcome>>()
  let calls = 0
  const allEntered = Promise.withResolvers<void>()
  native.memberRequest = async () => {
    calls++
    if (calls === 12) allEntered.resolve()
    return held.promise
  }
  const read = createOrganizationSessionReader({
    api: client([]),
    bridge: native,
    connectionID: "a".repeat(64),
    binding,
    signal: new AbortController().signal,
  })
  const controllers = Array.from({ length: 12 }, () => new AbortController())
  const results = controllers.map((controller) => read(query, controller.signal).catch((error: unknown) => error))
  await Promise.race([allEntered.promise, new Promise((resolve) => setTimeout(resolve, 50))])
  expect(calls).toBe(8)
  controllers[8]!.abort()
  held.resolve({ ok: true, value: { kind: "result", result: value } })
  const completed = await Promise.all(results)
  expect(completed[8]).toBeInstanceOf(DOMException)
  expect(calls).toBe(11)
})
