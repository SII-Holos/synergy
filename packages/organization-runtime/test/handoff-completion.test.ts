import { expect, test } from "bun:test"
import { OrganizationHandoffProtocol as Handoff } from "@ericsanchezok/synergy-organization-protocol"
import { createOrganizationClient } from "@ericsanchezok/synergy-sdk/organization"
import { createHandoffCompletion } from "./support/handoff-completion"

const opaqueResponse = "<html>Original transport response was unavailable</html>"
async function completionFixture(operation: "prepare-source" | "prepare-target") {
  const sourceKey = (await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"])) as CryptoKeyPair
  const targetKey = (await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"])) as CryptoKeyPair
  const source = {
    runtimeID: "source",
    publicKey: Buffer.from(await crypto.subtle.exportKey("raw", sourceKey.publicKey)).toString("hex"),
  }
  const target = {
    runtimeID: "target",
    publicKey: Buffer.from(await crypto.subtle.exportKey("raw", targetKey.publicKey)).toString("hex"),
  }
  const binding = Handoff.Binding.parse({
    schemaVersion: 1,
    orgID: "org",
    deploymentIncarnation: "deployment",
    handoffID: "handoff",
    sessionID: "session",
    sourceRuntimeID: source.runtimeID,
    targetRuntimeID: target.runtimeID,
    fromEpoch: 1,
    toEpoch: 2,
    mappingPlanRevision: 1,
    shareGeneration: 0,
  })
  const proof = Handoff.Proof.parse({
    ...binding,
    purpose: operation === "prepare-source" ? "source-frozen" : "target-prepared",
    manifestHash: "a".repeat(64),
    compatibilityHash: "b".repeat(64),
    closureHash: "c".repeat(64),
    fileClosureHash: null,
    workspaceMoveReceiptHash: null,
    paused: true,
    ...(operation === "prepare-source"
      ? { commandSeq: 1, receivedSeq: 1, drained: true }
      : { convertedHash: "d".repeat(64) }),
  })
  const key = operation === "prepare-source" ? sourceKey.privateKey : targetKey.privateKey
  const signature = await Handoff.signProof(proof, key),
    revision = await Handoff.proofHash(proof)
  const requests: Handoff.Drive[] = [],
    errors: unknown[] = []
  const reply = (request: Handoff.Drive, change: Partial<Handoff.MachineResult> = {}) =>
    Handoff.MachineResult.parse({
      handoffID: binding.handoffID,
      requestID: request.requestID,
      runtimeID: operation === "prepare-source" ? source.runtimeID : target.runtimeID,
      operation: request.operation,
      state: "complete",
      stage: proof.purpose,
      revision,
      requirements: [],
      facts: [{ proof, signature }],
      ...change,
    })
  let respond = (request: Handoff.Drive): Response | Promise<Response> =>
    request.operation === operation
      ? new Response(opaqueResponse, { status: 504, headers: { "content-type": "text/html" } })
      : Response.json(reply(request))
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const value = Handoff.Drive.parse(await request.json())
      requests.push(value)
      return respond(value)
    },
  })
  const client = createOrganizationClient({ baseUrl: server.url.href })
  const drive = createHandoffCompletion({
    binding,
    source,
    target,
    async invoke(operation, requestID) {
      try {
        return (
          await client.orgHandoff.drive(
            { handoffID: binding.handoffID, orgHandoffDrive: { operation, requestID } },
            { throwOnError: true },
          )
        ).data
      } catch (error) {
        errors.push(error)
        throw error
      }
    },
  })
  return {
    binding,
    source,
    target,
    proof,
    key,
    signature,
    revision,
    requests,
    errors,
    reply,
    drive,
    respond(next: typeof respond) {
      respond = next
    },
    async [Symbol.asyncDispose]() {
      await server.stop(true)
    },
  }
}
async function rejected(task: Promise<unknown>) {
  return task.then(
    () => {
      throw new Error("Expected original handoff failure")
    },
    (error: unknown) => error,
  )
}

test("opaque original handoff responses inspect signed source and target receipts without redispatch", async () => {
  for (const operation of ["prepare-source", "prepare-target"] as const) {
    await using f = await completionFixture(operation)
    const result = await f.drive(operation)
    expect(result.state).toBe("complete")
    expect(typeof f.errors[0]).toBe("string")
    expect(f.errors[0]).toBe(opaqueResponse)
    expect(f.requests.map((value) => value.operation)).toEqual([
      operation,
      operation === "prepare-source" ? "inspect-source" : "inspect-target",
    ])
    expect(new Set(f.requests.map((value) => value.requestID)).size).toBe(2)
  }
})

test("failed receipt inspection retains both original opaque and query errors", async () => {
  await using f = await completionFixture("prepare-source")
  const queryError = { code: "SERVICE_UNAVAILABLE", message: "Original receipt query is unavailable" }
  f.respond((request) =>
    request.operation === "prepare-source"
      ? new Response(opaqueResponse, { status: 504, headers: { "content-type": "text/html" } })
      : Response.json(queryError, { status: 503 }),
  )
  const failure = await rejected(f.drive("prepare-source"))
  expect(failure).toBeInstanceOf(AggregateError)
  if (!(failure instanceof AggregateError)) throw new Error("Missing both original failures")
  expect(failure.errors[0]).toBe(f.errors[0])
  expect(failure.errors[1]).toBe(f.errors[1])
  expect(failure.errors[0]).toBe(opaqueResponse)
  expect(failure.errors[1]).toEqual(queryError)
  expect(f.requests.map((value) => value.operation)).toEqual(["prepare-source", "inspect-source"])
})

test("known authorization and returned protocol errors never become uncertain dispatch", async () => {
  await using f = await completionFixture("prepare-source")
  const denied = { code: "PERMISSION_DENIED", message: "Original authorization rejected the drive" }
  f.respond(() => Response.json(denied, { status: 403 }))
  expect(await rejected(f.drive("prepare-source"))).toBe(f.errors[0])
  expect(f.requests.map((value) => value.operation)).toEqual(["prepare-source"])
  for (const change of [{ requestID: "foreign" }, { runtimeID: "foreign" }, { operation: "inspect-source" as const }]) {
    f.requests.length = 0
    f.respond((request) => Response.json(f.reply(request, change)))
    expect(await rejected(f.drive("prepare-source"))).toBeInstanceOf(Error)
    expect(f.requests.map((value) => value.operation)).toEqual(["prepare-source"])
  }
  f.requests.length = 0
  f.respond(() => Response.json({ malformed: true }))
  expect(await rejected(f.drive("prepare-source"))).toBeInstanceOf(Error)
  expect(f.requests.map((value) => value.operation)).toEqual(["prepare-source"])
  let calls = 0
  const localFailure = "Original returned payload failed local validation"
  const complete = createHandoffCompletion({
    binding: f.binding,
    source: f.source,
    target: f.target,
    async invoke(operation, requestID) {
      calls++
      return Object.defineProperty(f.reply({ operation, requestID }), "operation", {
        get() {
          throw localFailure
        },
      })
    },
  })
  expect(await rejected(complete("prepare-source"))).toBe(localFailure)
  expect(calls).toBe(1)
})

test("transport uncertainty cannot accept another binding, revision, signature, purpose or blocked state", async () => {
  await using f = await completionFixture("prepare-source")
  const foreign = Handoff.Proof.parse({ ...f.proof, sessionID: "foreign" })
  const foreignSignature = await Handoff.signProof(foreign, f.key)
  const wrongRevision = (f.revision[0] === "0" ? "1" : "0") + f.revision.slice(1)
  const changes: Array<Partial<Handoff.MachineResult>> = [
    { facts: [{ proof: foreign, signature: foreignSignature }], revision: await Handoff.proofHash(foreign) },
    { facts: [{ proof: f.proof, signature: "0".repeat(128) }] },
    { revision: wrongRevision },
    { stage: "target-prepared" },
    { state: "blocked", stage: "idle", facts: [] },
  ]
  for (const change of changes) {
    f.requests.length = 0
    f.respond((request) =>
      request.operation === "prepare-source"
        ? new Response(opaqueResponse, { status: 504, headers: { "content-type": "text/html" } })
        : Response.json(f.reply(request, change)),
    )
    const error = await rejected(f.drive("prepare-source"))
    expect(error).toBeInstanceOf(Error)
    expect(f.requests.map((value) => value.operation)).toEqual(["prepare-source", "inspect-source"])
  }
})
