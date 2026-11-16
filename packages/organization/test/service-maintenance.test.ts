import { expect, test } from "bun:test"
import { OrganizationRuntimeProtocol as Runtime } from "@ericsanchezok/synergy-organization-protocol"
import { RuntimeMaintenance } from "@ericsanchezok/synergy-harness/storage/runtime-maintenance"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { OrganizationServiceMaintenance } from "../src/service-maintenance"
import { fixture, password } from "./support/organization"

const actor = (requestID: string) => ({
  kind: "local" as const,
  subjectID: "backup-operator",
  displayName: "Operator",
  clientKind: "cli" as const,
  requestID,
})

test("real service maintenance waits accepted HTTP tail and blocks fresh HTTP and native writers", async () => {
  await using f = await fixture()
  const token = await f.service.bootstrapToken()
  const entered = Promise.withResolvers<void>()
  const proceed = Promise.withResolvers<void>()
  const request = new Request("https://organization.example/org/v1/setup/bootstrap", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "https://organization.example" },
    body: new ReadableStream(
      {
        async pull(controller) {
          entered.resolve()
          await proceed.promise
          controller.enqueue(
            new TextEncoder().encode(
              JSON.stringify({
                token,
                requestID: "accepted-bootstrap",
                organizationName: "Captured tail",
                loginName: "owner",
                displayName: "Owner",
                password,
              }),
            ),
          )
          controller.close()
        },
      },
      { highWaterMark: 0 },
    ),
  })
  const accepted = f.service.fetch(request)
  await entered.promise
  const lease = await f.service.maintenance.run(() =>
    RuntimeMaintenance.begin({ purpose: "organization-backup", requestID: "backup", actor: actor("backup") }),
  )
  let drained = false
  const receipt = f.service.maintenance.run(async () => {
    const result = await RuntimeMaintenance.drain(lease)
    drained = true
    return result
  })
  await expect(f.service.maintenance.run(() => Storage.write(["unaccepted"], { value: true }))).rejects.toThrow()
  const blocked = await f.service.fetch(new Request("https://organization.example/org/v1/health"))
  expect(blocked.status).toBe(503)
  expect(drained).toBe(false)
  proceed.resolve()
  expect((await accepted).status).toBe(200)
  const proof = await receipt
  await f.service.maintenance.run(async () => {
    await RuntimeMaintenance.freeze(lease, proof)
    expect((await Storage.queryKeys({ prefix: ["organization", "accounts"], limit: 10 })).length).toBe(1)
    await RuntimeMaintenance.release(lease)
  })
  expect((await f.service.fetch(new Request("https://organization.example/org/v1/health"))).status).toBe(200)
})

test("only an open accepted service tail can mutate while draining and escaped work stays closed", async () => {
  await using f = await fixture()
  const entered = Promise.withResolvers<void>()
  const proceed = Promise.withResolvers<void>()
  let tail: ReturnType<typeof OrganizationServiceMaintenance.captureTail> | undefined
  const work = f.service.maintenance.run(() =>
    OrganizationServiceMaintenance.run(async () => {
      tail = OrganizationServiceMaintenance.captureTail()
      entered.resolve()
      await proceed.promise
      await Storage.write(["accepted", "initial"], { value: 1 })
    }),
  )
  await entered.promise
  const lease = await f.service.maintenance.run(() =>
    RuntimeMaintenance.begin({ purpose: "organization-backup", requestID: "retained", actor: actor("retained") }),
  )
  proceed.resolve()
  await work
  if (!tail) throw new Error("Missing real accepted tail")
  await tail.run(() => Storage.write(["accepted", "tail"], { value: 2 }))
  tail.close()
  await expect(tail.run(() => Storage.write(["escaped"], {}))).rejects.toThrow()
  await f.service.maintenance.run(async () => {
    const receipt = await RuntimeMaintenance.drain(lease)
    await RuntimeMaintenance.freeze(lease, receipt)
    expect(await Storage.read(["accepted", "tail"])).toEqual({ value: 2 })
    await RuntimeMaintenance.release(lease)
  })
})

test("a real machine receipt can finish its accepted exchange during hold while new machine frames cannot", async () => {
  const { OrganizationProtocol: Protocol, OrganizationCommandProtocol: Command } =
    await import("@ericsanchezok/synergy-organization-protocol")
  const { keys, register, consume, proof, connection } = await import("./support/runtime")
  const { loadSigningAuthority } = await import("../src/signing")
  const { createRuntimeConnections } = await import("../src/runtime-connection")
  const { OrganizationStoragePath: Keys } = await import("../src/storage/path")
  await using f = await fixture()
  const owner = await f.initialize()
  const machine = await keys()
  const ticket = await register(owner, "maintenance-machine", machine.publicKey)
  const registration = Runtime.Registration.parse(
    await (await consume(f, await proof(ticket, machine.privateKey))).json(),
  )
  const signing = await f.service.maintenance.run(async () =>
    loadSigningAuthority(Protocol.Deployment.parse(await Storage.read(Keys.deployment()))),
  )
  const connections = createRuntimeConnections({
    run: (body) => f.service.maintenance.run(() => OrganizationServiceMaintenance.run(body)),
    signingIdentity: signing.identity,
    captureTail: OrganizationServiceMaintenance.captureTail,
  })
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    websocket: connections.websocket,
    fetch(request, server) {
      return server.upgrade(request, { data: connections.socket() }) ? undefined : new Response(null, { status: 400 })
    },
  })
  const socket = new WebSocket(server.url.toString().replace(/^http/, "ws"))
  const incoming: Runtime.ServerFrame[] = []
  const waiters: ReturnType<typeof Promise.withResolvers<Runtime.ServerFrame>>[] = []
  socket.onmessage = (event) => {
    const frame = Runtime.ServerFrame.parse(JSON.parse(String(event.data)))
    const waiter = waiters.shift()
    if (waiter) waiter.resolve(frame)
    else incoming.push(frame)
  }
  const next = async () => {
    if (incoming.length) return incoming.shift()!
    const waiter = Promise.withResolvers<Runtime.ServerFrame>()
    waiters.push(waiter)
    return waiter.promise
  }
  try {
    await new Promise<void>((resolve, reject) => {
      socket.onopen = () => resolve()
      socket.onerror = reject
    })
    const hello = await connection(registration, machine.privateKey, 1)
    hello.proof.handshake.capabilities.push("commands")
    hello.proof.handshake.schemas.commands = 1
    hello.signature = await Runtime.sign(hello.proof, machine.privateKey)
    socket.send(JSON.stringify(hello))
    expect(await next()).toMatchObject({ type: "handshake" })
    const now = Date.now()
    const authorization = await signing.sign(
      Command.Permit.parse({
        schemaVersion: 1,
        purpose: "session-command",
        orgID: registration.orgID,
        deploymentIncarnation: registration.deploymentIncarnation,
        keyID: signing.identity.keyID,
        requestID: "original",
        payloadHash: "a".repeat(64),
        sessionID: "session",
        projectID: "project",
        runtimeID: registration.runtimeID,
        bindingEpoch: 1,
        connectionEpoch: 1,
        commandSeq: 1,
        shareGeneration: 0,
        controlRevision: 0,
        authRevision: 1,
        admissionID: "admission",
        attemptID: "attempt",
        actor: {
          kind: "account",
          subjectID: "account",
          displayName: "Owner",
          orgID: registration.orgID,
          clientKind: "web",
          requestID: "original",
        },
        operation: "input",
        authorizedAt: now,
        deadline: now + 5000,
      }),
    )
    const accepted = f.service.maintenance.run(() =>
      OrganizationServiceMaintenance.run(async () => {
        const reply = await connections
          .capture(registration.runtimeID)
          .exchange({ kind: "query", authorization }, { signal: new AbortController().signal, deadline: now + 5000 })
        await Storage.write(["machine-tail"], { kind: reply.kind })
        return reply
      }),
    )
    const command = await next()
    if (command.type !== "command") throw new Error("Missing actual command")
    const lease = await f.service.maintenance.run(() =>
      RuntimeMaintenance.begin({
        purpose: "organization-backup",
        requestID: "machine-backup",
        actor: actor("machine-backup"),
      }),
    )
    const receipt = f.service.maintenance.run(() => RuntimeMaintenance.drain(lease))
    socket.send(
      JSON.stringify({
        type: "receipt",
        connectionEpoch: 1,
        exchangeID: command.exchangeID,
        reply: { kind: "query", query: { authorization } },
      }),
    )
    expect(await accepted).toMatchObject({ kind: "query" })
    const drained = await receipt
    socket.send(JSON.stringify({ type: "heartbeat", connectionEpoch: 1, sequence: 1 }))
    expect(await next()).toMatchObject({ type: "error", error: { code: "SERVICE_UNAVAILABLE" } })
    await f.service.maintenance.run(async () => {
      await RuntimeMaintenance.freeze(lease, drained)
      expect(await Storage.read(["machine-tail"])).toEqual({ kind: "query" })
      await RuntimeMaintenance.release(lease)
    })
  } finally {
    socket.close()
    connections.close()
    await server.stop(true)
  }
})

test("cancelled drainage and failed release retain the hold and never open new service admission", async () => {
  await using f = await fixture()
  const entered = Promise.withResolvers<void>()
  const proceed = Promise.withResolvers<void>()
  const active = f.service.maintenance.run(() =>
    OrganizationServiceMaintenance.run(async () => {
      entered.resolve()
      await proceed.promise
      await Storage.transaction(async () => {
        await Storage.write(["rolled-back"], {})
        throw new Error("transaction rollback")
      })
    }),
  )
  void active.catch(() => {})
  await entered.promise
  const lease = await f.service.maintenance.run(() =>
    RuntimeMaintenance.begin({
      purpose: "organization-backup",
      requestID: "cancel-drain",
      actor: actor("cancel-drain"),
    }),
  )
  const abort = new AbortController()
  const drained = f.service.maintenance.run(() => RuntimeMaintenance.drain(lease, { signal: abort.signal }))
  const reason = new Error("operator cancelled drain")
  abort.abort(reason)
  await expect(drained).rejects.toBe(reason)
  await expect(f.service.maintenance.run(() => RuntimeMaintenance.release(lease))).rejects.toThrow()
  expect((await f.service.fetch(new Request("https://organization.example/org/v1/health"))).status).toBe(503)
  proceed.resolve()
  await expect(active).rejects.toThrow("transaction rollback")
  await f.service.maintenance.run(async () => {
    expect((await Storage.readMany([["rolled-back"]]))[0]).toBeUndefined()
    expect((await RuntimeMaintenance.status())?.phase).toBe("draining")
    const receipt = await RuntimeMaintenance.drain(lease)
    await RuntimeMaintenance.freeze(lease, receipt)
    await RuntimeMaintenance.release(lease)
  })
})

test("a real model stream retains its original service admission until its final usage receipt commits", async () => {
  const { executionFixture } = await import("./support/execution")
  const { createModelGateway } = await import("../src/gateway")
  const { OrganizationGatewayProtocol: Gateway } = await import("@ericsanchezok/synergy-organization-protocol")
  const finish = Promise.withResolvers<void>()
  const upstream = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () =>
      new Response(
        new ReadableStream(
          {
            async pull(controller) {
              controller.enqueue(new TextEncoder().encode("data: accepted\n\n"))
              await finish.promise
              controller.close()
            },
          },
          { highWaterMark: 0 },
        ),
        { headers: { "content-type": "text/event-stream" } },
      ),
  })
  try {
    await using f = await executionFixture({ endpoint: new URL("/v1", upstream.url).href })
    await f.run(() => OrganizationServiceMaintenance.register())
    const gateway = createModelGateway({
      calls: f.gateway.calls,
      run: async (body) => f.run(body),
      captureTail: OrganizationServiceMaintenance.captureTail,
    })
    const proof = await f.proof("maintenance-stream")
    const authorization = await f.run(() => OrganizationServiceMaintenance.run(() => f.gateway.calls.reserve(proof)))
    const response = await f.run(() =>
      OrganizationServiceMaintenance.run(() =>
        gateway.invoke(
          new Request("https://organization.example/runtime/v1/gateway/models/model/chat/completions", {
            method: "POST",
            headers: { "content-type": "application/json", authorization: `Bearer ${Gateway.encode(authorization)}` },
            body: JSON.stringify({ model: "fixture-model", messages: [] }),
          }),
          authorization.permit.resourceID,
          "openai-compatible",
        ),
      ),
    )
    const lease = await f.run(() =>
      RuntimeMaintenance.begin({
        purpose: "organization-backup",
        requestID: "stream-backup",
        actor: actor("stream-backup"),
      }),
    )
    let complete = false
    const drainage = f.run(async () => {
      const receipt = await RuntimeMaintenance.drain(lease)
      complete = true
      return receipt
    })
    try {
      expect(complete).toBe(false)
      await expect(f.run(() => OrganizationServiceMaintenance.run(async () => {}))).rejects.toThrow()
      const body = response.text()
      finish.resolve()
      expect(await body).toBe("data: accepted\n\n")
      const receipt = await drainage
      await f.run(async () => {
        await RuntimeMaintenance.freeze(lease, receipt)
        expect(await f.gateway.calls.inspect(proof)).toMatchObject({ state: "response_complete", responseBytes: 16 })
        await RuntimeMaintenance.release(lease)
      })
    } finally {
      finish.resolve()
      await gateway.close()
      await Promise.allSettled([drainage])
    }
  } finally {
    finish.resolve()
    await upstream.stop(true)
  }
})

test("a cold service preserves its held maintenance history instead of certifying an empty new process", async () => {
  await using f = await fixture()
  const request = { purpose: "organization-backup" as const, requestID: "cold-service", actor: actor("cold-service") }
  const before = await f.service.maintenance.run(async () => {
    const lease = await RuntimeMaintenance.begin(request)
    await RuntimeMaintenance.freeze(lease, await RuntimeMaintenance.drain(lease))
    return RuntimeMaintenance.status()
  })
  await f.restart()
  expect((await f.service.fetch(new Request("https://organization.example/org/v1/health"))).status).toBe(503)
  await f.service.maintenance.run(async () => {
    expect(await RuntimeMaintenance.status()).toEqual(before)
    await expect(RuntimeMaintenance.begin(request)).rejects.toThrow("prior Runtime")
    await expect(Storage.write(["cold-unadmitted"], {})).rejects.toThrow()
  })
})

test("service shutdown retains accepted completion and native operator lifetimes before closing its Store", async () => {
  await using f = await fixture()
  const tail = await f.service.maintenance.run(() =>
    OrganizationServiceMaintenance.run(async () => OrganizationServiceMaintenance.captureTail()),
  )
  const entered = Promise.withResolvers<void>()
  const proceed = Promise.withResolvers<void>()
  const operator = f.service.maintenance.run(async () => {
    entered.resolve()
    await proceed.promise
    await Storage.write(["operator-shutdown-tail"], { retained: true })
  })
  await entered.promise
  let closed = false
  const close = f.service.close().then(() => {
    closed = true
  })
  await expect(f.service.deployment()).rejects.toThrow("closed")
  expect(closed).toBe(false)
  proceed.resolve()
  await operator
  await tail.run(() => Storage.write(["accepted-shutdown-tail"], { retained: true }))
  expect(closed).toBe(false)
  tail.close()
  await close
  await f.restart()
  await f.service.maintenance.run(async () => {
    expect(await Storage.read(["operator-shutdown-tail"])).toEqual({ retained: true })
    expect(await Storage.read(["accepted-shutdown-tail"])).toEqual({ retained: true })
  })
})

test("an ended callback cannot borrow another open tail to write or mint completion authority", async () => {
  await using f = await fixture()
  const proceed = Promise.withResolvers<void>()
  const { tail, escaped } = await f.service.maintenance.run(() =>
    OrganizationServiceMaintenance.run(async () => {
      const tail = OrganizationServiceMaintenance.captureTail()
      const escaped = proceed.promise.then(() =>
        Promise.allSettled([
          Storage.write(["escaped-old-callback"], {}),
          OrganizationServiceMaintenance.run(() => Storage.write(["escaped-new-run"], {})),
          (async () => {
            const stolen = OrganizationServiceMaintenance.captureTail()
            stolen.close()
          })(),
        ]),
      )
      return { tail, escaped }
    }),
  )
  const lease = await f.service.maintenance.run(() =>
    RuntimeMaintenance.begin({
      purpose: "organization-backup",
      requestID: "closed-callback",
      actor: actor("closed-callback"),
    }),
  )
  try {
    proceed.resolve()
    expect((await escaped).map((result) => result.status)).toEqual(["rejected", "rejected", "rejected"])
    await tail.run(() => Storage.write(["legitimate-retained-tail"], { retained: true }))
  } finally {
    tail.close()
  }
  await f.service.maintenance.run(async () => {
    const receipt = await RuntimeMaintenance.drain(lease)
    await RuntimeMaintenance.freeze(lease, receipt)
    expect(await Storage.readMany([["escaped-old-callback"], ["escaped-new-run"]])).toEqual([undefined, undefined])
    expect(await Storage.read(["legitimate-retained-tail"])).toEqual({ retained: true })
    await RuntimeMaintenance.release(lease)
  })
})

test("nested runs and explicit tail runs close their own callback frames independently", async () => {
  await using f = await fixture()
  const escapedNested = Promise.withResolvers<void>()
  const finishParent = Promise.withResolvers<void>()
  const entered = Promise.withResolvers<{
    tail: ReturnType<typeof OrganizationServiceMaintenance.captureTail>
    nested: Promise<unknown>
  }>()
  const parent = f.service.maintenance.run(() =>
    OrganizationServiceMaintenance.run(async () => {
      const tail = OrganizationServiceMaintenance.captureTail()
      const result = await OrganizationServiceMaintenance.run(async () => ({
        nested: escapedNested.promise.then(() => Storage.write(["escaped-nested-frame"], {})),
      }))
      entered.resolve({ tail, nested: result.nested })
      await finishParent.promise
    }),
  )
  const { tail, nested } = await entered.promise
  try {
    escapedNested.resolve()
    await expect(nested).rejects.toThrow("callback has ended")
    const escapedTail = Promise.withResolvers<void>()
    const result = await tail.run(async () => ({
      nested: escapedTail.promise.then(() => Storage.write(["escaped-tail-frame"], {})),
    }))
    escapedTail.resolve()
    await expect(result.nested).rejects.toThrow("callback has ended")
    await tail.run(() => Storage.write(["another-open-tail-frame"], { retained: true }))
  } finally {
    finishParent.resolve()
    await parent
    tail.close()
  }
  await f.service.maintenance.run(async () => {
    expect(await Storage.readMany([["escaped-nested-frame"], ["escaped-tail-frame"]])).toEqual([undefined, undefined])
    expect(await Storage.read(["another-open-tail-frame"])).toEqual({ retained: true })
  })
})
