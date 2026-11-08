import { expect, spyOn, test } from "bun:test"
import { OrganizationGatewayProtocol as Gateway } from "@ericsanchezok/synergy-organization-protocol"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { createOrganizationClient } from "@ericsanchezok/synergy-sdk/organization"
import { OrganizationRecord as Record } from "../src/storage/records"
import { OrganizationStoragePath as Keys } from "../src/storage/path"
import { OrganizationResources as Resources } from "../src/resources"
import { executionFixture } from "./support/execution"

type Fixture = Awaited<ReturnType<typeof executionFixture>>
async function reserve(f: Fixture, callID: string = crypto.randomUUID()) {
  const proof = await f.proof(callID)
  return f.run(() => f.gateway.calls.reserve(proof))
}
function request(
  f: Fixture,
  authorization: Gateway.SignedPermit,
  input: { body?: string; headers?: Record<string, string> } = {},
) {
  const suffix = authorization.permit.protocol === "openai-compatible" ? "chat/completions" : "messages"
  return new Request(new URL(`/runtime/v1/gateway/models/${authorization.permit.resourceID}/${suffix}`, f.baseUrl), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(authorization.permit.protocol === "openai-compatible"
        ? { authorization: `Bearer ${Gateway.encode(authorization)}` }
        : { "x-api-key": Gateway.encode(authorization) }),
      ...input.headers,
    },
    body:
      input.body ?? JSON.stringify({ model: "fixture-model", messages: [{ role: "user", content: "Private prompt" }] }),
  })
}
function invoke(f: Fixture, authorization: Gateway.SignedPermit, input?: Parameters<typeof request>[2]) {
  return f.run(() =>
    f.gateway.models.invoke(
      request(f, authorization, input),
      authorization.permit.resourceID,
      authorization.permit.protocol,
    ),
  )
}
async function receipt(f: Fixture, callID: string) {
  const proof = await f.proof(callID)
  return f.run(() => f.gateway.calls.inspect(proof))
}

test("a finite call reaches only its selected model with service credentials and cannot dispatch twice", async () => {
  const received: { url: string; authorization: string | null; callerHeader: string | null; body: unknown }[] = []
  const upstream = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      received.push({
        url: request.url,
        authorization: request.headers.get("authorization"),
        callerHeader: request.headers.get("x-private-caller"),
        body: await request.json(),
      })
      return Response.json(
        { model: "fixture-model", choices: [{ message: { content: "Fixture answer" } }] },
        { headers: { "set-cookie": "upstream-secret=private", "x-private-upstream": "private" } },
      )
    },
  })
  try {
    await using f = await executionFixture({ endpoint: new URL("/v1", upstream.url).href })
    const request = await f.proof("one-call")
    const client = createOrganizationClient({ baseUrl: f.baseUrl })
    const reserve = () => client.orgGateway.reserve({ orgGatewayRequest: request }, { throwOnError: true })
    const response = await reserve()
    expect(response.response.status).toBe(200)
    const authorization = Gateway.SignedPermit.parse(response.data)
    expect(Gateway.SignedPermit.parse((await reserve()).data)).toEqual(authorization)
    const url = new URL(`/runtime/v1/gateway/models/${f.grant.selection.modelResourceID}/chat/completions`, f.baseUrl)
    const invoke = () =>
      fetch(url, {
        method: "POST",
        headers: {
          authorization: `Bearer ${Gateway.encode(authorization)}`,
          "content-type": "application/json",
          "x-private-caller": "never-forward",
        },
        body: JSON.stringify({ model: "fixture-model", messages: [{ role: "user", content: "Private prompt" }] }),
      })
    const result = await invoke()
    expect(result.status).toBe(200)
    expect(await result.json()).toMatchObject({ model: "fixture-model" })
    expect(result.headers.get("set-cookie")).toBeNull()
    expect(result.headers.get("x-private-upstream")).toBeNull()
    expect((await invoke()).status).toBe(409)
    expect(
      (await client.orgGateway.inspect({ orgGatewayRequest: request }, { throwOnError: true })).data,
    ).toMatchObject({ state: "response_complete", httpStatus: 200 })
    expect(received).toEqual([
      {
        url: new URL("/v1/chat/completions", upstream.url).href,
        authorization: "Bearer private-upstream-key",
        callerHeader: null,
        body: { model: "fixture-model", messages: [{ role: "user", content: "Private prompt" }] },
      },
    ])
  } finally {
    await upstream.stop(true)
  }
})

test("concurrent use of one capability commits only one transmission", async () => {
  let submissions = 0
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const upstream = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch() {
      submissions++
      entered.resolve()
      await release.promise
      return Response.json({ ok: true })
    },
  })
  try {
    await using f = await executionFixture({ endpoint: new URL("/v1", upstream.url).href })
    const authorization = await reserve(f, "concurrent")
    const first = invoke(f, authorization)
    try {
      await entered.promise
      await expect(invoke(f, authorization)).rejects.toMatchObject({
        data: { code: "REVISION_CONFLICT", outcome: "unknown" },
      })
    } finally {
      release.resolve()
    }
    expect(await (await first).json()).toEqual({ ok: true })
    expect(submissions).toBe(1)
  } finally {
    release.resolve()
    await upstream.stop(true)
  }
})

test("call budget and identity survive storage restart, and reservation rollback never consumes another call", async () => {
  await using f = await executionFixture({ endpoint: "https://provider.example/v1" })
  await f.run(() =>
    Storage.write(Keys.executionGrant(f.grant.grantID), { ...f.grant, limits: { ...f.grant.limits, calls: 2 } }),
  )
  const first = await reserve(f, "first")
  const write = Storage.write
  const failure = spyOn(Storage, "write").mockImplementation(async (key, value) => {
    if (key[1] === "gateway-calls") throw new Error("Fixture write failure")
    return write(key, value)
  })
  try {
    await expect(reserve(f, "rollback")).rejects.toThrow("Fixture write failure")
  } finally {
    failure.mockRestore()
  }
  await f.restart()
  expect(await reserve(f, "first")).toEqual(first)
  const changed = await f.proof("first", { connectionEpoch: 1, resourceID: "other-resource" })
  await expect(f.run(() => f.gateway.calls.reserve(changed))).rejects.toMatchObject({
    data: { code: "PERMISSION_DENIED" },
  })
  await reserve(f, "second")
  await expect(reserve(f, "third")).rejects.toMatchObject({ data: { code: "RESOURCE_UNAVAILABLE" } })
  expect(await f.run(() => Storage.read(Keys.executionUsage(f.grant.grantID)))).toMatchObject({ calls: 2 })
  expect(
    await f.run(() => Record.read(Record.GatewayCall, Keys.gatewayCall(f.grant.grantID, "rollback"))),
  ).toBeUndefined()
})

for (const fault of ["expired", "disconnected"] as const)
  test(`call reservation rolls back when ${fault} before the writer commits`, async () => {
    await using f = await executionFixture({ endpoint: "https://provider.example/v1" })
    const proof = await f.proof("rollback")
    const write = Storage.write
    let clock: ReturnType<typeof spyOn<typeof Date, "now">> | undefined
    const held = spyOn(Storage, "write").mockImplementation(async (key, value) => {
      await write(key, value)
      if (key[1] !== "gateway-calls") return
      if (fault === "expired") clock = spyOn(Date, "now").mockReturnValue(proof.proof.expiresAt)
      else f.connections.close()
    })
    try {
      await expect(f.run(() => f.gateway.calls.reserve(proof))).rejects.toThrow()
    } finally {
      held.mockRestore()
      clock?.mockRestore()
    }
    expect(await f.run(() => Record.read(Record.ExecutionUsage, Keys.executionUsage(f.grant.grantID)))).toBeUndefined()
    expect(
      await f.run(() => Record.read(Record.GatewayCall, Keys.gatewayCall(f.grant.grantID, "rollback"))),
    ).toBeUndefined()
  })

test("current driver, root, resource revision and role gate each new dispatch even after a capability was issued", async () => {
  let submissions = 0
  const upstream = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      submissions++
      return Response.json({ ok: true })
    },
  })
  try {
    await using f = await executionFixture({ endpoint: new URL("/v1", upstream.url).href })
    const authorization = await reserve(f, "current")
    const badProof = await f.proof("forged", { rootID: "another-root" })
    await expect(f.run(() => f.gateway.calls.reserve(badProof))).rejects.toMatchObject({
      data: { code: "PERMISSION_DENIED" },
    })
    const altered = structuredClone(authorization)
    altered.permit.modelID = "other-model"
    await expect(invoke(f, altered)).rejects.toMatchObject({ data: { code: "PERMISSION_DENIED" } })
    const blocked: NonNullable<Parameters<typeof request>[2]>[] = [
      { body: JSON.stringify({ model: "other-model" }) },
      { headers: { origin: "https://organization.example" } },
      { headers: { cookie: "arbitrary=session" } },
      { headers: { "content-encoding": "gzip" } },
    ]
    for (const input of blocked) await expect(invoke(f, authorization, input)).rejects.toThrow()
    const runtime = await f.run(() => Record.read(Record.RuntimeRegistration, Keys.runtime("runtime-alice")))
    const member = await f.run(() => Record.read(Record.ProjectMember, Keys.projectMember("project", "alice")))
    const session = await f.run(() => Record.read(Record.SessionDirectory, Keys.session(f.sessionID)))
    const account = await f.run(() => Record.read(Record.Account, Keys.account("alice")))
    for (const [key, original, changed] of [
      [Keys.runtime("runtime-alice"), runtime, { ...runtime, state: "revoked" }],
      [Keys.account("alice"), account, { ...account, state: "removed" }],
      [Keys.projectMember("project", "alice"), member, { ...member, role: "reader" }],
      [Keys.session(f.sessionID), session, { ...session, bindingEpoch: 2 }],
      [Keys.session(f.sessionID), session, { ...session, handoffID: "handoff" }],
      [
        Keys.executionGrant(f.grant.grantID),
        f.grant,
        { ...f.grant, state: "provisional", rootID: undefined, boundAt: undefined },
      ],
    ] as const) {
      await f.run(() => Storage.write(key, changed))
      try {
        await expect(invoke(f, authorization)).rejects.toThrow()
      } finally {
        await f.run(() => Storage.write(key, original))
      }
    }
    await f.run(() =>
      Resources.update(f.credentials.admin, f.grant.selection.modelResourceID, {
        expectedRevision: 1,
        credential: { kind: "bearer", value: "rotated-private-key" },
      }),
    )
    await expect(invoke(f, authorization)).rejects.toMatchObject({ data: { code: "REVISION_CONFLICT" } })
    expect(submissions).toBe(0)
    expect((await receipt(f, "current")).state).toBe("reserved")
    const next = await reserve(f, "next")
    await f.run(() =>
      Resources.update(f.credentials.admin, next.permit.resourceID, { expectedRevision: 2, state: "disabled" }),
    )
    await expect(invoke(f, next)).rejects.toMatchObject({ data: { code: "RESOURCE_UNAVAILABLE" } })
    expect((await receipt(f, "next")).state).toBe("reserved")
    expect(submissions).toBe(0)
  } finally {
    await upstream.stop(true)
  }
})

test("a response stream retains capacity through cancellation, and unread streams drain on gateway shutdown", async () => {
  let submissions = 0
  const upstream = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      submissions++
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("data: partial\n\n"))
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      )
    },
  })
  try {
    await using f = await executionFixture({ endpoint: new URL("/v1", upstream.url).href })
    const permits = await Promise.all(Array.from({ length: 9 }, (_, index) => reserve(f, `call-${index}`)))
    const responses = await Promise.all(permits.slice(0, 8).map((permit) => invoke(f, permit)))
    expect(submissions).toBe(8)
    await expect(invoke(f, permits[8])).rejects.toMatchObject({ data: { code: "RESOURCE_UNAVAILABLE" } })
    const reader = responses[0].body!.getReader()
    expect(new TextDecoder().decode((await reader.read()).value)).toBe("data: partial\n\n")
    await reader.cancel()
    reader.releaseLock()
    expect(await receipt(f, "call-0")).toMatchObject({ state: "unknown", responseBytes: 15 })
    await expect(invoke(f, permits[0])).rejects.toMatchObject({ data: { outcome: "unknown" } })
    responses.push(await invoke(f, permits[8]))
    expect(submissions).toBe(9)
    await f.gateway.models.close()
    expect((await receipt(f, "call-8")).state).toBe("unknown")
    await expect(responses[1].text()).rejects.toThrow()
    await expect(invoke(f, await reserve(f, "closed"))).rejects.toMatchObject({ data: { code: "SERVICE_UNAVAILABLE" } })
  } finally {
    await upstream.stop(true)
  }
}, 10_000)

test("request and response byte limits stop forwarding and preserve only metadata", async () => {
  let submissions = 0
  const upstream = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      submissions++
      return Response.json({ oversized: "z".repeat(512) })
    },
  })
  try {
    await using f = await executionFixture({ endpoint: new URL("/v1", upstream.url).href })
    await f.run(() =>
      Storage.write(Keys.executionGrant(f.grant.grantID), {
        ...f.grant,
        limits: { calls: 5, requestBytes: 200, responseBytes: 100 },
      }),
    )
    const large = await reserve(f, "large")
    await expect(
      invoke(f, large, { body: JSON.stringify({ model: "fixture-model", messages: "a".repeat(201) }) }),
    ).rejects.toMatchObject({ data: { code: "RESOURCE_UNAVAILABLE", outcome: "not_dispatched" } })
    expect(submissions).toBe(0)
    const response = await invoke(f, large)
    await expect(response.text()).rejects.toThrow()
    expect(await receipt(f, "large")).toMatchObject({
      state: "unknown",
      requestBytes: 81,
      responseBytes: 528,
      httpStatus: 200,
    })
    const stored = await f.run(() => Storage.read(Keys.gatewayCall(f.grant.grantID, "large")))
    expect(JSON.stringify(stored)).not.toContain("Private prompt")
    expect(JSON.stringify(stored)).not.toContain("private-upstream-key")
    expect(submissions).toBe(1)
  } finally {
    await upstream.stop(true)
  }
})

test("model redirects never forward credentials and upstream failures never expose response secrets", async () => {
  let destinationCalls = 0
  const destination = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      destinationCalls++
      return Response.json({ ok: true })
    },
  })
  let redirect = true
  const upstream = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      if (redirect) return Response.redirect(destination.url, 307)
      return Response.json(
        { error: { message: "private-upstream-key" } },
        { status: 429, headers: { "retry-after": "5", "set-cookie": "secret=private" } },
      )
    },
  })
  try {
    await using f = await executionFixture({ endpoint: new URL("/v1", upstream.url).href })
    await expect(invoke(f, await reserve(f, "redirect"))).rejects.toMatchObject({ data: { outcome: "unknown" } })
    expect(destinationCalls).toBe(0)
    redirect = false
    const response = await invoke(f, await reserve(f, "limited"))
    expect(response.status).toBe(429)
    expect(response.headers.get("retry-after")).toBe("5")
    expect(response.headers.get("set-cookie")).toBeNull()
    expect(await response.text()).not.toContain("private-upstream-key")
    expect((await receipt(f, "limited")).state).toBe("unknown")
  } finally {
    await Promise.all([upstream.stop(true), destination.stop(true)])
  }
})

for (const fault of ["expired", "disconnected"] as const)
  test(`model dispatch rolls back when ${fault} before its admission commits`, async () => {
    let submissions = 0
    const upstream = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch() {
        submissions++
        return Response.json({ ok: true })
      },
    })
    try {
      await using f = await executionFixture({ endpoint: new URL("/v1", upstream.url).href })
      const authorization = await reserve(f, "rollback")
      const write = Storage.write
      let clock: ReturnType<typeof spyOn<typeof Date, "now">> | undefined
      const held = spyOn(Storage, "write").mockImplementation(async (key, value) => {
        await write(key, value)
        if (key[1] !== "gateway-calls" || Record.GatewayCall.parse(value).receipt.state !== "started") return
        if (fault === "expired") clock = spyOn(Date, "now").mockReturnValue(authorization.permit.expiresAt)
        else f.connections.close()
      })
      try {
        await expect(invoke(f, authorization)).rejects.toThrow()
      } finally {
        held.mockRestore()
        clock?.mockRestore()
      }
      expect(submissions).toBe(0)
      expect(await f.run(() => Storage.read(Keys.gatewayCall(f.grant.grantID, "rollback")))).toMatchObject({
        receipt: { state: "reserved" },
      })
    } finally {
      await upstream.stop(true)
    }
  })

test("accepted work retains its resource contract on archive and personal selection revocation, with a larger model body than control APIs", async () => {
  let submissions = 0
  const upstream = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      await request.text()
      submissions++
      return Response.json({ ok: true })
    },
  })
  try {
    await using f = await executionFixture({ endpoint: new URL("/v1", upstream.url).href })
    await f.run(async () => {
      await Resources.grant(
        f.credentials.admin,
        f.grant.selection.modelResourceID,
        { kind: "account", id: "alice" },
        { expectedRevision: 1, enabled: false },
      )
      const project = await Record.read(Record.Project, Keys.project("project"))
      await Storage.write(Keys.project("project"), { ...project, state: "archived" })
    })
    const authorization = await reserve(f, "large-accepted")
    const response = await fetch(
      request(f, authorization, {
        body: JSON.stringify({ model: "fixture-model", messages: [{ role: "user", content: "x".repeat(70 * 1024) }] }),
      }),
    )
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true })
    expect(submissions).toBe(1)
    const control = await fetch(new URL("/runtime/v1/gateway/calls", f.baseUrl), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ data: "x".repeat(70 * 1024) }),
    })
    expect(control.status).toBe(400)
    expect((await receipt(f, "large-accepted")).state).toBe("response_complete")
    await f.connect(2)
    await expect(invoke(f, authorization)).rejects.toThrow()
    const reconnected = await f.proof("large-accepted", { connectionEpoch: 2 })
    expect(await f.run(() => f.gateway.calls.inspect(reconnected))).toMatchObject({
      state: "response_complete",
      connectionEpoch: 1,
    })
    expect(await f.run(() => f.gateway.calls.reserve(reconnected))).toEqual(authorization)
    expect(submissions).toBe(1)
  } finally {
    await upstream.stop(true)
  }
})

test("aborting an actual HTTP reader cancels its upstream stream and records an unknown outcome", async () => {
  const canceled = Promise.withResolvers<void>()
  const upstream = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("data: partial\n\n"))
          },
          cancel() {
            canceled.resolve()
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      )
    },
  })
  try {
    await using f = await executionFixture({ endpoint: new URL("/v1", upstream.url).href })
    const authorization = await reserve(f, "aborted")
    const saved = Promise.withResolvers<void>()
    const original = f.gateway.calls.finish
    const finish = spyOn(f.gateway.calls, "finish").mockImplementation(async (...args) => {
      await original(...args)
      saved.resolve()
    })
    const abort = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const response = await fetch(request(f, authorization), { signal: abort.signal })
      const reader = response.body!.getReader()
      expect(new TextDecoder().decode((await reader.read()).value)).toBe("data: partial\n\n")
      abort.abort()
      await reader.cancel().catch(() => {})
      reader.releaseLock()
      await Promise.race([
        Promise.all([canceled.promise, saved.promise]),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("HTTP cancellation did not drain")), 3000)
        }),
      ])
      expect((await receipt(f, "aborted")).state).toBe("unknown")
    } finally {
      clearTimeout(timer)
      finish.mockRestore()
      abort.abort()
    }
  } finally {
    await upstream.stop(true)
  }
}, 5000)
