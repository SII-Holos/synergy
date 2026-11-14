import { expect, test } from "bun:test"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import {
  OrganizationHandoffProtocol as Handoff,
  OrganizationRuntimeProtocol as Runtime,
  OrganizationSyncProtocol as Sync,
} from "@ericsanchezok/synergy-organization-protocol"
import { OrganizationHandoffObjectProtocol as Objects } from "../../organization-protocol/src/handoff-object"
import { createHandoffs, registerHandoffAuthorityHistory } from "../src/handoff"
import { OrganizationAuthorityHistory } from "../src/authority-history"
import { OrganizationSharing } from "../src/sharing"
import { OrganizationRecord as Record } from "../src/storage/records"
import { OrganizationStoragePath as Keys } from "../src/storage/path"
import { commandFixture } from "./support/commands"
import { connection, keys } from "./support/runtime"
import { organizationApp, organizationOpenApi } from "../src/http"

const declaredEmptySyncCheckpoint = Handoff.SyncCheckpoint.parse({
  version: 1,
  closureHash: "9".repeat(64),
  pendingBatch: null,
})

async function fixture() {
  const f = await commandFixture({
    sync: { receipt: (lease, query) => handoffs.syncBatchReceipt(lease, query) },
  })
  const sourceSocket = await f.connect(1, true, false, false, true, Handoff.syncTransferBridge)
  const targetKeys = await keys()
  const target = await f.run(async () => {
    const current = (await Record.read(Record.RuntimeRegistration, Keys.runtime("runtime-bob")))!
    const next = Record.RuntimeRegistration.parse({ ...current, connectionEpoch: 0, publicKey: targetKeys.publicKey })
    await Storage.write(Keys.runtime(next.runtimeID), next)
    return next
  })
  const targetSocket = new WebSocket(f.baseUrl.replace(/^http/, "ws"))
  await new Promise<void>((resolve, reject) => {
    targetSocket.onopen = () => resolve()
    targetSocket.onerror = reject
  })
  const handshake = await connection(target, targetKeys.privateKey, 1)
  handshake.proof.handshake.capabilities.push("commands", "handoffs", "sync")
  Object.assign(handshake.proof.handshake.schemas, {
    commands: 1,
    handoffs: Handoff.syncTransferBridge,
    sync: Sync.observationVersion,
  })
  handshake.signature = await Runtime.sign(handshake.proof, targetKeys.privateKey)
  const connected = Promise.withResolvers<unknown>()
  targetSocket.onmessage = (event) => connected.resolve(JSON.parse(String(event.data)))
  targetSocket.send(JSON.stringify(handshake))
  Runtime.Connected.parse(await connected.promise)
  const handoffs = createHandoffs({ connections: f.connections, signing: f.signing, timeoutMs: 2000 })
  const prepared = await f.run(async () => {
    OrganizationAuthorityHistory.register()
    registerHandoffAuthorityHistory()
    await OrganizationAuthorityHistory.initialize({
      schemaVersion: 1,
      orgID: "org",
      deploymentIncarnation: "deployment",
      createdAt: 1,
    })
    await OrganizationSharing.share(f.credentials.alice, f.sessionID, { expectedShareGeneration: 0 })
    return handoffs.prepare(f.credentials.alice, f.sessionID, {
      handoffID: "object-handoff",
      targetRuntimeID: target.runtimeID,
      expectedBindingEpoch: 1,
      expectedControlRevision: 0,
      mappingPlanRevision: 1,
    })
  })
  const tuple = {
    schemaVersion: 1 as const,
    orgID: "org",
    deploymentIncarnation: "deployment",
    handoffID: prepared.handoffID,
    sessionID: f.sessionID,
    sourceRuntimeID: prepared.sourceRuntimeID,
    targetRuntimeID: prepared.targetRuntimeID,
    fromEpoch: prepared.fromEpoch,
    toEpoch: prepared.toEpoch,
    mappingPlanRevision: 1,
    shareGeneration: prepared.shareGeneration,
  }
  const frozen = Handoff.Proof.parse({
    ...tuple,
    shareGeneration: prepared.shareGeneration,
    purpose: "source-frozen",
    manifestHash: "a".repeat(64),
    commandSeq: prepared.commandSeq,
    receivedSeq: prepared.commandSeq,
    compatibilityHash: "b".repeat(64),
    closureHash: "c".repeat(64),
    fileClosureHash: null,
    workspaceMoveReceiptHash: null,
    paused: true,
    drained: true,
    syncCheckpoint: declaredEmptySyncCheckpoint,
  })
  let requests = 0
  return {
    ...f,
    handoffs,
    sourceSocket,
    targetKeys,
    tuple,
    async request(overrides: Partial<Objects.Proof> = {}) {
      const issuedAt = Date.now()
      const proof = Objects.Proof.parse({
        ...tuple,
        purpose: "handoff-object-read",
        runtimeID: prepared.targetRuntimeID,
        connectionEpoch: 1,
        requestID: `object-range-${++requests}`,
        manifestHash: "a".repeat(64),
        range: { hash: "d".repeat(64), offset: 0, length: 2 },
        issuedAt,
        expiresAt: issuedAt + 2000,
        ...overrides,
      })
      return { proof, signature: await Objects.sign(proof, targetKeys.privateKey) }
    },
    async freeze() {
      await f.run(async () => {
        await handoffs.accept(f.credentials.bob, prepared.handoffID, { mappingPlanRevision: 1 })
        await handoffs.proof({ proof: frozen, signature: await Handoff.signProof(frozen, f.machineKeys.privateKey) })
      })
    },
    respond(beforeReply?: () => void | Promise<void>, content = Buffer.from("ai")) {
      sourceSocket.onmessage = async (event) => {
        const frame = Runtime.ServerFrame.parse(JSON.parse(String(event.data)))
        if (frame.type !== "command" || frame.command.kind !== "handoff") return
        const authorization = frame.command.authorization
        const plan = authorization.plan
        expect(plan.operation).toBe("object")
        expect(plan.actor).toMatchObject({ kind: "system", subjectID: tuple.targetRuntimeID, clientKind: "runtime" })
        expect(await Handoff.verifyMachinePlan(plan, authorization.signature, f.signing.identity.publicKey)).toBe(true)
        await beforeReply?.()
        const range = plan.object!
        const nextOffset = Math.min(content.length, range.offset + range.length)
        sourceSocket.send(
          JSON.stringify({
            type: "receipt",
            connectionEpoch: 1,
            exchangeID: frame.exchangeID,
            reply: {
              kind: "handoff",
              authorization,
              result: {
                handoffID: plan.handoffID,
                requestID: plan.requestID,
                runtimeID: plan.runtimeID,
                operation: plan.operation,
                state: "complete",
                stage: "source-frozen",
                revision: "f".repeat(64),
                requirements: [],
                facts: [],
                object: {
                  hash: range.hash,
                  offset: range.offset,
                  nextOffset,
                  totalBytes: content.length,
                  data: content.subarray(range.offset, nextOffset).toString("base64url"),
                  complete: nextOffset === content.length,
                },
              },
            },
          }),
        )
      }
    },
    async [Symbol.asyncDispose]() {
      targetSocket.close()
      await f[Symbol.asyncDispose]()
    },
  }
}

test("a fresh destination machine proof relays only the current consented frozen handoff range without recording its bytes", async () => {
  await using f = await fixture()
  const signal = new AbortController().signal
  await expect(f.run(async () => f.handoffs.object(await f.request(), { signal }))).rejects.toMatchObject({
    data: { code: "HANDOFF_BLOCKED" },
  })
  await f.freeze()
  f.respond()
  const request = await f.request()
  const chunk = await f.run(() => f.handoffs.object(request, { signal }))
  expect(chunk).toMatchObject({ hash: request.proof.range.hash, data: "YWk", complete: true })
  const large = Buffer.alloc(128 * 1024, 43)
  f.respond(undefined, large)
  const largeChunk = await f.run(async () =>
    f.handoffs.object(await f.request({ range: { hash: "d".repeat(64), offset: 0, length: large.length } }), {
      signal,
    }),
  )
  expect(Buffer.from(largeChunk.data, "base64url")).toEqual(large)
  await f.run(async () => {
    const records = await Storage.query({ prefix: ["organization"], limit: 1000 })
    const raw = JSON.stringify(records.map(({ key, value }) => ({ key, value })))
    expect(raw).not.toContain('"data":"YWk"')
    expect(await Storage.readMany([Keys.commandState(f.sessionID)])).toEqual([undefined])
    await expect(
      f.handoffs.object(
        { ...request, proof: { ...request.proof, range: { ...request.proof.range, hash: "e".repeat(64) } } },
        { signal },
      ),
    ).rejects.toMatchObject({ data: { code: "PERMISSION_DENIED" } })
    await expect(
      f.handoffs.object(await f.request({ manifestHash: "e".repeat(64) }), { signal }),
    ).rejects.toMatchObject({ data: { code: "HANDOFF_BLOCKED" } })
    const issuedAt = Date.now() - 3000
    await expect(
      f.handoffs.object(await f.request({ issuedAt, expiresAt: issuedAt + 2000 }), { signal }),
    ).rejects.toMatchObject({ data: { code: "PERMISSION_DENIED" } })
    await f.handoffs.cancel(f.credentials.alice, f.tuple.handoffID)
    await expect(f.handoffs.object(await f.request(), { signal })).rejects.toMatchObject({
      data: { code: "HANDOFF_BLOCKED" },
    })
  })
})

test("a held object reply rechecks current destination access and rejects bytes after project revocation", async () => {
  await using f = await fixture()
  await f.freeze()
  f.respond(() => f.run(() => Storage.remove(Keys.projectMember("project", "bob"))))
  await expect(
    f.run(async () => f.handoffs.object(await f.request(), { signal: new AbortController().signal })),
  ).rejects.toMatchObject({ data: { code: "NOT_FOUND" } })
})

test("the mounted machine object API rejects browser credentials and publishes its generated contract", async () => {
  await using f = await fixture()
  await f.freeze()
  f.respond()
  const app = organizationApp(
    () => true,
    undefined,
    "https://organization.example",
    undefined,
    f.connections,
    undefined,
    undefined,
    undefined,
    undefined,
    f.handoffs,
  )
  const request = await f.request()
  const call = (headers: Record<string, string> = {}) =>
    f.run(() =>
      app.request("/runtime/v1/handoffs/object", {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify(request),
      }),
    )
  const browserHeaders: Record<string, string>[] = [
    { origin: "https://organization.example" },
    { cookie: "unrelated=browser" },
  ]
  for (const headers of browserHeaders) expect((await call(headers)).status).toBe(403)
  const response = await call()
  expect(response.status).toBe(200)
  expect(await response.json()).toMatchObject({ data: "YWk", complete: true })
  const schema = await organizationOpenApi()
  expect(schema.paths?.["/runtime/v1/handoffs/object"]?.post?.operationId).toBe("orgHandoffObject.read")
  expect(schema.paths?.["/runtime/v1/handoffs/object"]?.post?.requestBody).toMatchObject({ required: true })
})
