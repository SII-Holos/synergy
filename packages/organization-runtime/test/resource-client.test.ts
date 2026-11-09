import { expect, spyOn, test } from "bun:test"
import path from "node:path"
import {
  OrganizationExecutionProtocol as Execution,
  OrganizationGatewayProtocol as Gateway,
} from "@ericsanchezok/synergy-organization-protocol"
import { RuntimeContext } from "@ericsanchezok/synergy-harness/lifecycle/context"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { SessionInbox } from "@ericsanchezok/synergy-harness/session/inbox"
import { SessionManager } from "@ericsanchezok/synergy-harness/session/manager"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { RolloutLedger } from "@ericsanchezok/synergy-harness/session/rollout/ledger"
import { RolloutLifecycle } from "@ericsanchezok/synergy-harness/session/rollout/lifecycle"
import { testRuntime } from "@ericsanchezok/synergy-harness/test/support/runtime"
import { testResources } from "@ericsanchezok/synergy-testing/resources"
import { prepareMemberHome } from "../src/home"
import { enrollMemberRuntime } from "../src/enrollment"
import { openMemberConnection, type MemberConnection } from "../src/connection"
import { createCommandIntake } from "../src/command-intake"
import { registerSessionSchema } from "../src/session-schema"
import { fixture } from "./support/organization"
import { createMemberResourceClient } from "../src/resource-client"

async function execution() {
  const resources = testResources()
  try {
    const f = await fixture()
    resources.defer("organization fixture", () => f[Symbol.asyncDispose]())
    const member = await prepareMemberHome({
      baseDirectory: path.join(f.root, "members"),
      identity: f.identity,
      origin: f.origin,
    })
    await enrollMemberRuntime({
      home: member.home,
      identity: member.identity,
      ca: f.ca,
      ticket: await f.ticket(member.identity.deviceID, member.publicKey),
    })
    const runtime = await testRuntime({
      home: path.join(f.root, "agent"),
      register: () => registerSessionSchema({ orgID: f.identity.orgID }),
    })
    resources.defer("native Runtime", () => runtime.close())
    const wake = spyOn(SessionManager, "scheduleWake").mockImplementation(() => {})
    resources.defer("native wake observation", () => wake.mockRestore())
    const context = await runtime.run(() => RuntimeContext.current())
    let intake: ReturnType<typeof createCommandIntake>
    let connection: MemberConnection
    let supplied: MemberConnection["resources"] | undefined
    async function connect() {
      connection = await openMemberConnection({
        home: member.home,
        identity: member.identity,
        ca: f.ca,
        buildVersion: "resource-client-fixture",
        commands(current, signal, client) {
          supplied = client
          intake = createCommandIntake({
            identity: current.signingIdentity,
            runtimeID: current.runtimeID,
            accountID: f.identity.accountID,
            connectionEpoch: current.connectionEpoch,
            signal,
          })
          return {
            create: context.bind(intake.create),
            input: context.bind(intake.input),
            control: context.bind(intake.control),
            query: context.bind(intake.query),
            skip: context.bind(intake.skip),
          }
        },
      })
      const established = connection
      resources.defer("member connection", () => established.close())
      expect(supplied).toBe(established.resources)
      return connection
    }
    await connect()
    const options = { headers: f.headers, throwOnError: true as const }
    const project = (
      await f.client.orgProjects.create({ orgProjectCreate: { name: "Resource calls", description: "" } }, options)
    ).data
    const model = (
      await f.client.orgResources.create(
        {
          orgResourceCreate: {
            name: "Selected model",
            scope: { kind: "organization" },
            configuration: {
              protocol: "openai-compatible",
              endpoint: "https://provider.example/v1",
              model: { id: "fixture-model", name: "Fixture", limit: { context: 8192, output: 1024 } },
            },
            credential: { kind: "bearer", value: "private-upstream-key" },
          },
        },
        options,
      )
    ).data
    await f.client.orgResourceGrants.set(
      {
        resourceID: model.resourceID,
        kind: "account",
        subjectID: f.identity.accountID,
        orgResourceGrantChange: { expectedRevision: 0, enabled: true },
      },
      options,
    )
    const created = (
      await f.client.orgSessions.create(
        {
          orgCommandCreateRequest: {
            schemaVersion: 1,
            orgID: f.identity.orgID,
            requestID: "create-resource-session",
            projectID: project.projectID,
            runtimeID: connection!.connected.runtimeID,
            creation: { operation: "create" },
          },
        },
        options,
      )
    ).data
    const sessionID = created.effect.sessionID
    await f.client.orgSessionResources.set(
      {
        sessionID,
        orgSessionResourceChange: {
          expectedRevision: 0,
          selection: { modelResourceID: model.resourceID, connectionResourceIDs: [] },
        },
      },
      options,
    )
    const accepted = (
      await f.client.orgCommands.input(
        {
          sessionID,
          orgCommandInputRequest: {
            schemaVersion: 1,
            orgID: f.identity.orgID,
            requestID: "resource-task",
            sessionID,
            projectID: project.projectID,
            runtimeID: connection!.connected.runtimeID,
            input: { operation: "input", mode: "task", parts: [{ type: "text", text: "A private task" }] },
          },
        },
        options,
      )
    ).data
    const lookup = { subjectID: f.identity.accountID, requestID: accepted.permit.requestID }
    return {
      ...f,
      runtime,
      sessionID,
      model,
      get connection() {
        return connection!
      },
      async reconnect() {
        await connection!.close()
        return connect()
      },
      description: () => runtime.run(() => intake.descriptionProof(lookup)),
      async binding() {
        return runtime.run(async () => {
          const session = await Session.get(sessionID)
          return ScopeContext.provide({
            scope: session.scope,
            workspace: null,
            fn: async () => {
              await Session.update(sessionID, (draft) => {
                draft.modelOverride = { providerID: "test", modelID: "test" }
              })
              const item = (await SessionInbox.list(sessionID))[0]!
              expect((await SessionInbox.materializeNextTask(sessionID)).status).toBe("materialized")
              await RolloutLedger.beginRun(RolloutLifecycle.owner(session), item.messageID)
              return intake.bindingProof(lookup, item.messageID)
            },
          })
        })
      },
      proof(grant: Execution.BoundGrant, callID: string): Gateway.Proof {
        return Gateway.Proof.parse({
          schemaVersion: 1,
          purpose: "gateway-call",
          orgID: grant.orgID,
          deploymentIncarnation: grant.deploymentIncarnation,
          runtimeID: grant.runtimeID,
          connectionEpoch: connection!.connected.connectionEpoch,
          grantID: grant.grantID,
          sessionID,
          rootID: grant.rootID,
          bindingEpoch: grant.bindingEpoch,
          resourceID: model.resourceID,
          callID,
          issuedAt: Date.now(),
          expiresAt: Date.now() + 30_000,
        })
      },
      [Symbol.asyncDispose]: resources.close,
    }
  } catch (error) {
    await resources.close()
    throw error
  }
}

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
