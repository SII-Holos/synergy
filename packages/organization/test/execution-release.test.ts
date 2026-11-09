import { expect, spyOn, test } from "bun:test"
import {
  OrganizationExecutionProtocol as Execution,
  OrganizationGatewayProtocol as Gateway,
} from "@ericsanchezok/synergy-organization-protocol"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { OrganizationRecord as Record } from "../src/storage/records"
import { OrganizationStoragePath as Keys } from "../src/storage/path"
import { OrganizationSessionResources } from "../src/session-resources"
import { executionFixture } from "./support/execution"

type Fixture = Awaited<ReturnType<typeof executionFixture>>
async function release(f: Fixture, changes: Partial<Execution.ReleaseProof> = {}) {
  const proof = Execution.ReleaseProof.parse({
    ...f.binding.proof,
    purpose: "execution-resources-release",
    generation: 1,
    outcome: "completed",
    materialized: true,
    issuedAt: Date.now(),
    expiresAt: Date.now() + 30_000,
    ...changes,
  })
  return { proof, signature: await Execution.signRelease(proof, f.machineKeys.privateKey) }
}
function request(f: Fixture, authorization: Gateway.SignedPermit, body?: ReadableStream<Uint8Array>) {
  return new Request(new URL("/model", f.baseUrl), {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${Gateway.encode(authorization)}` },
    body: body ?? JSON.stringify({ model: "fixture-model", messages: [] }),
  })
}

test("release waits for the actual response stream and remains possible when a selected resource is disabled", async () => {
  const upstream = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
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
    const proof = await f.proof()
    const authorization = await f.run(() => f.gateway.calls.reserve(proof))
    const response = await f.run(() =>
      f.gateway.models.invoke(request(f, authorization), f.grant.selection.modelResourceID, "openai-compatible"),
    )
    const input = await release(f, { outcome: "cancelled" })
    await expect(f.run(() => f.execution.release(input))).rejects.toMatchObject({
      data: { code: "RESOURCE_UNAVAILABLE" },
    })
    await f.run(async () => {
      const key = Keys.resource(f.grant.orgID, f.grant.selection.modelResourceID)
      const resource = (await Record.read(Record.Resource, key))!
      await Storage.write(key, { ...resource, state: "disabled" })
    })
    await response.body!.cancel()
    const receipt = await f.run(() => f.execution.release(input))
    expect(receipt.outcome).toBe("cancelled")
    await f.run(async () => {
      expect(await f.gateway.calls.inspect(proof)).toMatchObject({ state: "unknown" })
      expect((await Record.read(Record.SessionDirectory, Keys.session(f.sessionID)))!.retainedExecutionGrants).toBe(0)
      const key = Keys.resource(f.grant.orgID, f.grant.selection.modelResourceID)
      const resource = (await Record.read(Record.Resource, key))!
      await Storage.write(key, { ...resource, state: "enabled" })
      await OrganizationSessionResources.set(f.credentials.alice, f.sessionID, {
        expectedRevision: 1,
        selection: f.grant.selection,
      })
      expect(await f.execution.release(input)).toEqual(receipt)
      expect(await f.gateway.calls.inspect(proof)).toMatchObject({ state: "unknown" })
    })
  } finally {
    await upstream.stop(true)
  }
})

for (const fault of ["write", "expiry", "connection"] as const)
  test(`release rolls back its receipt, grant and retained count on ${fault} failure`, async () => {
    await using f = await executionFixture({ endpoint: "https://provider.example/v1" })
    const input = await release(f)
    const write = Storage.write
    let clock: ReturnType<typeof spyOn<typeof Date, "now">> | undefined
    const failed = spyOn(Storage, "write").mockImplementation(async (key, value) => {
      await write(key, value)
      if (key[1] !== "execution-releases") return
      if (fault === "write") throw new Error("Fixture release publication failed")
      if (fault === "expiry") clock = spyOn(Date, "now").mockReturnValue(input.proof.expiresAt)
      if (fault === "connection") f.connections.close()
    })
    try {
      await expect(f.run(() => f.execution.release(input))).rejects.toThrow()
    } finally {
      failed.mockRestore()
      clock?.mockRestore()
    }
    await f.run(async () => {
      expect(await Record.read(Record.ExecutionGrant, Keys.executionGrant(f.grant.grantID))).toEqual(f.grant)
      expect((await Record.read(Record.SessionDirectory, Keys.session(f.sessionID)))!.retainedExecutionGrants).toBe(1)
      expect(await Record.read(Record.ExecutionRelease, Keys.executionRelease(f.grant.grantID, 1))).toBeUndefined()
    })
  })

test("release rejects a request that acquires gateway capacity before its commit", async () => {
  const upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => Response.json({ answer: "done" }) })
  try {
    await using f = await executionFixture({ endpoint: new URL("/v1", upstream.url).href })
    const input = await release(f)
    const proof = await f.proof()
    const authorization = await f.run(() => f.gateway.calls.reserve(proof))
    const reading = Promise.withResolvers<void>()
    const allowBody = Promise.withResolvers<void>()
    const body = new ReadableStream<Uint8Array>(
      {
        async pull(controller) {
          reading.resolve()
          await allowBody.promise
          controller.enqueue(new TextEncoder().encode(JSON.stringify({ model: "fixture-model", messages: [] })))
          controller.close()
        },
      },
      { highWaterMark: 0 },
    )
    const write = Storage.write
    const begin = Promise.withResolvers<void>()
    const invocation = (async () => {
      await begin.promise
      const response = await f.run(() =>
        f.gateway.models.invoke(
          request(f, authorization, body),
          f.grant.selection.modelResourceID,
          "openai-compatible",
        ),
      )
      return response.json()
    })()
    void invocation.catch(() => {})
    const rescue = setTimeout(() => {
      reading.reject(new Error("Fixture request did not start reading"))
      allowBody.resolve()
    }, 2000)
    const held = spyOn(Storage, "write").mockImplementation(async (key, value) => {
      await write(key, value)
      if (key[1] !== "execution-releases") return
      begin.resolve()
      await reading.promise
    })
    try {
      await expect(f.run(() => f.execution.release(input))).rejects.toMatchObject({
        data: { code: "RESOURCE_UNAVAILABLE" },
      })
    } finally {
      held.mockRestore()
      begin.resolve()
      allowBody.resolve()
      clearTimeout(rescue)
    }
    expect(await invocation).toEqual({ answer: "done" })
    expect((await f.run(() => f.execution.release(input))).generation).toBe(1)
  } finally {
    await upstream.stop(true)
  }
})

test("release replay survives storage restart and connection renewal without accepting stale or changed evidence", async () => {
  await using f = await executionFixture({ endpoint: "https://provider.example/v1" })
  const input = await release(f)
  await expect(
    f.run(() => f.execution.release({ ...input, proof: { ...input.proof, outcome: "failed" } })),
  ).rejects.toMatchObject({ data: { code: "PERMISSION_DENIED" } })
  await expect(f.run(async () => f.execution.release(await release(f, { generation: 2 })))).rejects.toMatchObject({
    data: { code: "REVISION_CONFLICT" },
  })
  const receipt = await f.run(() => f.execution.release(input))
  await f.restart()
  await f.connect(2)
  await expect(f.run(() => f.execution.release(input))).rejects.toMatchObject({ data: { code: "PERMISSION_DENIED" } })
  expect(await f.run(async () => f.execution.release(await release(f, { connectionEpoch: 2 })))).toEqual(receipt)
  await expect(
    f.run(async () => f.execution.release(await release(f, { connectionEpoch: 2, outcome: "failed" }))),
  ).rejects.toMatchObject({ data: { code: "REVISION_CONFLICT" } })
})

test("handoff and revoked project access fence new use without blocking drainage of the existing driver", async () => {
  await using f = await executionFixture({ endpoint: "https://provider.example/v1" })
  const input = await release(f)
  await f.run(async () => {
    const key = Keys.session(f.sessionID)
    const session = (await Record.read(Record.SessionDirectory, key))!
    await Storage.write(key, { ...session, handoffID: "handoff" })
    await Storage.remove(Keys.projectMember(session.projectID, "alice"))
    await expect(f.execution.bind(f.binding)).rejects.toThrow()
    expect((await f.execution.release(input)).grantID).toBe(f.grant.grantID)
    expect((await Record.read(Record.SessionDirectory, key))!.retainedExecutionGrants).toBe(0)
  })
})

test("reacquisition commits its generation and occupancy together without rewriting release evidence", async () => {
  await using f = await executionFixture({ endpoint: "https://provider.example/v1" })
  const input = await release(f)
  const receipt = await f.run(() => f.execution.release(input))
  const write = Storage.write
  const failed = spyOn(Storage, "write").mockImplementation(async (key, value) => {
    await write(key, value)
    if (key[1] === "sessions") throw new Error("Fixture retention publication failed")
  })
  try {
    await expect(f.run(() => f.execution.bind(f.binding))).rejects.toThrow("Fixture retention publication failed")
  } finally {
    failed.mockRestore()
  }
  await f.run(async () => {
    expect(await Record.read(Record.ExecutionGrant, Keys.executionGrant(f.grant.grantID))).toMatchObject({
      retention: { state: "released", generation: 1 },
    })
    expect((await Record.read(Record.SessionDirectory, Keys.session(f.sessionID)))!.retainedExecutionGrants).toBe(0)
    expect(await f.execution.release(input)).toEqual(receipt)
    expect((await f.execution.bind(f.binding)).retention).toEqual({ state: "held", generation: 2 })
    expect((await Record.read(Record.SessionDirectory, Keys.session(f.sessionID)))!.retainedExecutionGrants).toBe(1)
  })
})
