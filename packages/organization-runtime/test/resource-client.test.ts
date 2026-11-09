import { expect, test } from "bun:test"
import {
  OrganizationExecutionProtocol as Execution,
  OrganizationGatewayProtocol as Gateway,
} from "@ericsanchezok/synergy-organization-protocol"
import { createMemberResourceClient } from "../src/resource-client"
import { executionFixture as execution } from "./support/execution"

test("retention inspection recovers a lost bind reply after resource disablement without starting another use", async () => {
  await using f = await execution()
  const description = await f.description()
  expect((await f.connection.resources.retention(description)).state).toBe("provisional")
  const binding = await f.binding()
  let original: Execution.BoundGrant | undefined
  let binds = 0
  f.interceptHTTP(async (request) => {
    if (!request.url.endsWith("/execution/bind")) return
    binds++
    original = Execution.BoundGrant.parse(await (await f.service.fetch(request)).json())
    return new Response("Bind response lost", { status: 502 })
  })
  await expect(f.connection.resources.bind(binding)).rejects.toMatchObject({
    data: { code: "PROTOCOL_MISMATCH", outcome: "unknown" },
  })
  expect(binds).toBe(1)
  f.interceptHTTP(undefined)
  await f.client.orgResources.update(
    { resourceID: f.model.resourceID, orgResourceChange: { expectedRevision: 1, state: "disabled" } },
    { headers: f.headers, throwOnError: true },
  )
  await expect(f.connection.resources.describe(description)).rejects.toMatchObject({
    data: { code: "RESOURCE_UNAVAILABLE" },
  })
  expect(await f.connection.resources.retention(description)).toEqual(original!)
  const proof = Execution.ReleaseProof.parse({
    ...binding,
    purpose: "execution-resources-release",
    generation: original!.retention.generation,
    outcome: "completed",
  })
  await f.connection.resources.release(proof)
  const released = await f.connection.resources.retention(description)
  expect(released).toMatchObject({ grantID: original!.grantID, retention: { state: "released", generation: 1 } })
  await f.reconnect()
  expect(await f.connection.resources.retention(await f.description())).toEqual(released)
  f.interceptHTTP(() => Response.json({ ...released, grantID: "different-grant" }))
  await expect(f.connection.resources.retention(await f.description())).rejects.toMatchObject({
    data: { code: "PROTOCOL_MISMATCH" },
  })
})

test("member release verifies its receipt and preserves root identity across response loss and renewed retention", async () => {
  await using f = await execution()
  const binding = await f.binding()
  const grant = await f.connection.resources.bind(binding)
  const proof = Execution.ReleaseProof.parse({
    ...binding,
    purpose: "execution-resources-release",
    generation: grant.retention.generation,
    outcome: "completed",
  })
  let original: Execution.ReleaseReceipt | undefined
  let calls = 0
  f.interceptHTTP(async (request) => {
    if (!request.url.endsWith("/execution/release")) return
    calls++
    const response = await f.service.fetch(request)
    original = Execution.ReleaseReceipt.parse(await response.json())
    return new Response("Response lost after release", { status: 502 })
  })
  await expect(f.connection.resources.release(proof)).rejects.toMatchObject({
    data: { code: "PROTOCOL_MISMATCH", outcome: "unknown" },
  })
  expect(calls).toBe(1)
  f.interceptHTTP(undefined)
  expect(await f.connection.resources.release(proof)).toEqual(original!)
  await f.reconnect()
  const renewed = Execution.ReleaseProof.parse({ ...proof, connectionEpoch: f.connection.connected.connectionEpoch })
  expect(await f.connection.resources.release(renewed)).toEqual(original!)
  const retained = await f.connection.resources.bind({ ...binding, connectionEpoch: renewed.connectionEpoch })
  expect(retained).toMatchObject({
    grantID: grant.grantID,
    rootID: grant.rootID,
    retention: { state: "held", generation: 2 },
  })
  for (const changed of [{ generation: 2 }, { rootID: "different-root" }, { outcome: "failed" }]) {
    f.interceptHTTP(() => Response.json({ ...original!, ...changed }))
    await expect(f.connection.resources.release(renewed)).rejects.toMatchObject({ data: { code: "PROTOCOL_MISMATCH" } })
  }
})

test("the verified member connection prepares native resources and obtains only one-call authority over HTTPS", async () => {
  await using f = await execution()
  const requests: Array<{ path: string; cookie: string | null; origin: string | null; body: string }> = []
  f.interceptHTTP(async (request) => {
    const path = new URL(request.url).pathname
    if (!path.startsWith("/runtime/v1/")) return
    requests.push({
      path,
      cookie: request.headers.get("cookie"),
      origin: request.headers.get("origin"),
      body: await request.clone().text(),
    })
  })
  const description = await f.connection.resources.describe(await f.description())
  expect(description.grant.state).toBe("provisional")
  expect(description.resources[0]?.definition).toMatchObject({ model: { id: "fixture-model" } })
  const grant = await f.connection.resources.bind(await f.binding())
  expect(grant.grantID).toBe(description.grant.grantID)
  const proof = f.proof(grant, "call")
  const capability = await f.connection.resources.reserve(proof)
  expect(capability.permit).toMatchObject({ grantID: grant.grantID, callID: "call", modelID: "fixture-model" })
  expect(await f.connection.resources.reserve(proof)).toEqual(capability)
  expect(await f.connection.resources.inspect(proof)).toMatchObject({ callID: "call", state: "reserved" })
  expect(JSON.stringify({ description, grant, capability, requests })).not.toContain("private-upstream-key")
  expect(JSON.stringify({ description, grant, capability, requests })).not.toContain("provider.example")
  expect(requests).toHaveLength(5)
  expect(requests.every((request) => request.cookie === null && request.origin === null)).toBeTrue()
  const old = f.connection.resources
  await f.reconnect()
  await expect(old.inspect(proof)).rejects.toThrow()
  const current = f.proof(grant, "call")
  expect(await f.connection.resources.reserve(current)).toEqual(capability)
  expect(await f.connection.resources.inspect(current)).toMatchObject({ state: "reserved", connectionEpoch: 1 })
  expect((await f.connection.resources.describe(await f.description())).grant).toEqual(grant)
})

test("resource control rejects changed authority and altered replies without exposing response content", async () => {
  await using f = await execution()
  const description = await f.description()
  let calls = 0
  f.interceptHTTP((request) => {
    if (new URL(request.url).pathname.startsWith("/runtime/v1/")) calls++
  })
  await expect(
    f.connection.resources.describe({ ...description, connectionEpoch: description.connectionEpoch + 1 }),
  ).rejects.toMatchObject({ data: { code: "STALE_CONNECTION", outcome: "not_dispatched" } })
  const expiresAt = Date.now() - 1
  await expect(
    f.connection.resources.describe({ ...description, issuedAt: expiresAt - 30_000, expiresAt }),
  ).rejects.toMatchObject({ data: { code: "PERMISSION_DENIED", outcome: "not_dispatched" } })
  await expect(f.connection.resources.describe(description, AbortSignal.abort())).rejects.toThrow()
  expect(calls).toBe(0)
  for (const change of [
    (value: Execution.Description) => ({ ...value, grant: { ...value.grant, grantID: "different-grant" } }),
    (value: Execution.Description) => ({ ...value, credential: "private-response-content" }),
  ]) {
    f.interceptHTTP(async (request) => {
      if (!request.url.endsWith("/execution/resources")) return
      const response = await f.service.fetch(request)
      return Response.json(change(Execution.Description.parse(await response.json())))
    })
    await expect(f.connection.resources.describe(description)).rejects.toMatchObject({
      data: {
        code: "PROTOCOL_MISMATCH",
        outcome: "unknown",
      },
    })
  }
  const binding = await f.binding()
  f.interceptHTTP(async (request) => {
    if (!request.url.endsWith("/execution/bind")) return
    const response = await f.service.fetch(request)
    return Response.json({ ...Execution.BoundGrant.parse(await response.json()), rootID: "another-root" })
  })
  await expect(f.connection.resources.bind(binding)).rejects.toMatchObject({ data: { code: "PROTOCOL_MISMATCH" } })
  f.interceptHTTP(undefined)
  const grant = await f.connection.resources.bind(binding)
  const proof = f.proof(grant, "altered-call")
  await expect(f.connection.resources.reserve({ ...proof, rootID: "unbound-root" })).rejects.toMatchObject({
    data: { code: "PERMISSION_DENIED", outcome: "not_dispatched" },
  })
  f.interceptHTTP(async (request) => {
    if (!request.url.endsWith("/gateway/calls")) return
    const response = await f.service.fetch(request)
    return Response.json({ ...Gateway.SignedPermit.parse(await response.json()), signature: "0".repeat(128) })
  })
  await expect(f.connection.resources.reserve(proof)).rejects.toMatchObject({
    data: { code: "PROTOCOL_MISMATCH", message: "Organization resource capability signature is invalid" },
  })
  f.interceptHTTP(async (request) => {
    if (!request.url.endsWith("/gateway/calls/inspect")) return
    const response = await f.service.fetch(request)
    return Response.json({ ...Gateway.Receipt.parse(await response.json()), callID: "another-call" })
  })
  await expect(f.connection.resources.inspect(proof)).rejects.toMatchObject({ data: { code: "PROTOCOL_MISMATCH" } })
})

test("resource control preserves uncertain admission, rejects redirects and verifies the deployment CA", async () => {
  await using f = await execution()
  const grant = await f.connection.resources.bind(await f.binding())
  const proof = f.proof(grant, "lost-response")
  let submissions = 0
  let original: Gateway.SignedPermit | undefined
  f.interceptHTTP(async (request) => {
    if (!request.url.endsWith("/gateway/calls")) return
    submissions++
    const response = await f.service.fetch(request)
    original = Gateway.SignedPermit.parse(await response.json())
    return Response.json(
      { code: "SERVICE_UNAVAILABLE", message: "Reply unavailable", retryable: true, outcome: "unknown" },
      { status: 503 },
    )
  })
  await expect(f.connection.resources.reserve(proof)).rejects.toMatchObject({
    data: { code: "SERVICE_UNAVAILABLE", outcome: "unknown", retryable: true },
  })
  expect(submissions).toBe(1)
  f.interceptHTTP(undefined)
  expect(await f.connection.resources.reserve(proof)).toEqual(original!)
  let redirected = 0
  f.interceptHTTP((request) => {
    if (request.url.endsWith("/destination")) {
      redirected++
      return Response.json({ unexpected: true })
    }
    if (request.url.endsWith("/execution/resources")) return Response.redirect(new URL("/destination", f.origin), 307)
  })
  await expect(f.connection.resources.describe(await f.description())).rejects.toMatchObject({
    data: { code: "SERVICE_UNAVAILABLE", outcome: "unknown" },
  })
  expect(redirected).toBe(0)
  let reached = 0
  f.interceptHTTP((request) => {
    if (request.url.endsWith("/execution/resources")) reached++
  })
  const keys = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"])
  const untrusted = createMemberResourceClient({
    origin: f.origin,
    connection: f.connection.connected,
    key: keys.privateKey,
    signal: new AbortController().signal,
  })
  try {
    await expect(untrusted.resources.describe(await f.description())).rejects.toMatchObject({
      data: { code: "SERVICE_UNAVAILABLE", outcome: "unknown" },
    })
    expect(reached).toBe(0)
  } finally {
    await untrusted.close()
  }
})

test("resource calls apply cancellable backpressure and connection closure drains held response bodies", async () => {
  await using f = await execution()
  const proof = await f.description()
  const held: ReadableStreamDefaultController<Uint8Array>[] = []
  const entered = Promise.withResolvers<void>()
  const reused = Promise.withResolvers<void>()
  const cancelled = Promise.withResolvers<void>()
  let disposals = 0
  f.interceptHTTP(async (request) => {
    if (!request.url.endsWith("/execution/resources")) return
    const response = await f.service.fetch(request)
    const bytes = new Uint8Array(await response.arrayBuffer())
    return new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          held.push(controller)
          controller.enqueue(bytes)
          if (held.length === 8) entered.resolve()
          if (held.length === 9) reused.resolve()
        },
        cancel() {
          if (++disposals === 8) cancelled.resolve()
        },
      }),
      { headers: { "content-type": "application/json" } },
    )
  })
  const pending = Array.from({ length: 8 }, () => f.connection.resources.describe(proof))
  const outcomes = Promise.allSettled(pending)
  const completed = Promise.any(pending)
  await entered.promise
  const stop = new AbortController()
  const waiting = f.connection.resources.describe(proof, stop.signal)
  stop.abort(new Error("Cancelled queued resource preparation"))
  await expect(waiting).rejects.toThrow("Cancelled queued resource preparation")
  expect(held).toHaveLength(8)
  const next = f.connection.resources.describe(proof)
  const nextOutcome = Promise.allSettled([next])
  await f.client.orgHealth.get({ throwOnError: true })
  expect(held).toHaveLength(8)
  held[0].close()
  expect((await completed).grant.state).toBe("provisional")
  await reused.promise
  await f.connection.close()
  expect((await outcomes).filter((result) => result.status === "fulfilled")).toHaveLength(1)
  expect((await nextOutcome)[0].status).toBe("rejected")
  await cancelled.promise
  await expect(f.connection.resources.describe(proof)).rejects.toThrow()
})

test("member resource client invokes a selected fixed HTTP connection with one signed capability", async () => {
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
      return Response.json({ ok: true, operationID: "op-1" })
    },
  })
  try {
    await using f = await execution({ connectionEndpoint: new URL("/business", upstream.url).href })
    const connectionID = f.connectionResource!.resourceID
    const description = await f.connection.resources.describe(await f.description())
    expect(description.grant.selection.connectionResourceIDs).toEqual([connectionID])
    const grant = await f.connection.resources.bind(await f.binding())
    const capability = await f.connection.resources.reserve(f.proof(grant, "business-call", connectionID))
    expect(capability.permit.protocol).toBe("fixed-http")
    const response = await f.connection.resources.invoke(capability, {
      body: JSON.stringify({ operationID: "op-1", input: { value: "payload" } }),
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true, operationID: "op-1" })
    expect(received).toEqual([
      {
        url: new URL("/business", upstream.url).href,
        authorization: "Bearer private-connection-key",
        callerHeader: null,
        body: { operationID: "op-1", input: { value: "payload" } },
      },
    ])
    const repeated = await f.connection.resources.invoke(capability, { body: JSON.stringify({ retry: true }) })
    expect(repeated.status).toBe(409)
    expect(received).toHaveLength(1)
    expect(JSON.stringify({ description, grant, capability })).not.toContain("private-connection-key")
  } finally {
    await upstream.stop(true)
  }
})

test("oversized control responses cancel their stream without retaining or echoing the payload", async () => {
  await using f = await execution()
  const cancelled = Promise.withResolvers<void>()
  f.interceptHTTP((request) => {
    if (!request.url.endsWith("/execution/resources")) return
    return new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("private-oversized-response".repeat(12_000)))
        },
        cancel() {
          cancelled.resolve()
        },
      }),
      { headers: { "content-type": "application/json" } },
    )
  })
  await expect(f.connection.resources.describe(await f.description())).rejects.toMatchObject({
    data: {
      code: "PROTOCOL_MISMATCH",
      message: "Organization resource control response exceeded its format limit",
    },
  })
  await cancelled.promise
})
