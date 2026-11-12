import { expect, test } from "bun:test"
import {
  OrganizationCommandProtocol as Command,
  OrganizationExecutionProtocol as Execution,
  OrganizationHandoffProtocol as Handoff,
} from "@ericsanchezok/synergy-organization-protocol"
import { executionFixture } from "./support/execution"

test("the enrolled resource client signs exact handoff inventory and nonterminal closure over HTTPS", async () => {
  await using f = await executionFixture()
  const description = await f.description()
  const accepted = description.receipt.accepted!
  const binding = Handoff.Binding.parse({
    schemaVersion: 1,
    orgID: description.orgID,
    deploymentIncarnation: description.deploymentIncarnation,
    handoffID: "resource-close-client",
    sessionID: f.sessionID,
    sourceRuntimeID: description.runtimeID,
    targetRuntimeID: "other-runtime",
    fromEpoch: accepted.permit.bindingEpoch,
    toEpoch: accepted.permit.bindingEpoch + 1,
    mappingPlanRevision: 1,
    shareGeneration: 0,
  })
  const issuedAt = Date.now()
  const inventory = Execution.HandoffInventoryProof.parse({
    ...binding,
    purpose: "execution-handoff-inventory",
    runtimeID: description.runtimeID,
    connectionEpoch: description.connectionEpoch,
    manifestHash: "1".repeat(64),
    preparedHash: "2".repeat(64),
    issuedAt,
    expiresAt: issuedAt + 30_000,
  })
  const page = Execution.HandoffInventoryPage.parse({
    binding,
    retained: 1,
    items: [
      {
        grantID: accepted.permit.provisionalGrantID,
        rootID: accepted.effect.messageID,
        generation: 0,
        originGrantID: accepted.permit.provisionalGrantID,
        lookup: { subjectID: accepted.permit.actor.subjectID, requestID: accepted.permit.requestID },
      },
    ],
  })
  const close = Execution.HandoffCloseProof.parse({
    ...inventory,
    purpose: "execution-handoff-close",
    grantID: accepted.permit.provisionalGrantID,
    rootID: accepted.effect.messageID,
    generation: 0,
    receipt: description.receipt,
  })
  const closed = Execution.HandoffCloseReceipt.parse({
    ...binding,
    purpose: "execution-handoff-closed",
    grantID: close.grantID,
    rootID: close.rootID,
    generation: close.generation,
    manifestHash: close.manifestHash,
    preparedHash: close.preparedHash,
    closedAt: Date.now(),
  })
  const paths: string[] = []
  f.interceptHTTP(async (request) => {
    const pathname = new URL(request.url).pathname
    if (!pathname.startsWith("/runtime/v1/execution/handoff-")) return
    paths.push(pathname)
    expect(request.headers.get("cookie")).toBeNull()
    expect(request.headers.get("origin")).toBeNull()
    if (pathname.endsWith("handoff-inventory")) {
      const signed = Execution.HandoffInventoryRequest.parse(await request.json())
      expect(signed.proof).toEqual(inventory)
      expect(await Execution.verifyHandoffInventory(signed.proof, signed.signature, f.member.publicKey)).toBeTrue()
      return Response.json(page)
    }
    const signed = Execution.HandoffCloseRequest.parse(await request.json())
    expect(signed.proof).toEqual(close)
    expect(await Execution.verifyHandoffClose(signed.proof, signed.signature, f.member.publicKey)).toBeTrue()
    return Response.json(closed)
  })
  expect(await f.connection.resources.handoffInventory(inventory)).toEqual(page)
  expect(await f.connection.resources.closeHandoff(close)).toEqual(closed)
  expect(paths).toEqual(["/runtime/v1/execution/handoff-inventory", "/runtime/v1/execution/handoff-close"])
  for (const change of [{ toEpoch: binding.toEpoch + 1 }, { handoffID: "another-handoff" }]) {
    f.interceptHTTP(() => Response.json({ ...page, binding: { ...binding, ...change } }))
    await expect(f.connection.resources.handoffInventory(inventory)).rejects.toMatchObject({
      data: { code: "PROTOCOL_MISMATCH" },
    })
  }
  for (const change of [{ generation: 1 }, { rootID: "another-root" }, { preparedHash: "3".repeat(64) }]) {
    f.interceptHTTP(() => Response.json({ ...closed, ...change }))
    await expect(f.connection.resources.closeHandoff(close)).rejects.toMatchObject({
      data: { code: "PROTOCOL_MISMATCH" },
    })
  }
})

test("continued resource replies preserve original input provenance and exact current control", async () => {
  await using f = await executionFixture()
  const original = await f.description()
  const initialDescription = await f.connection.resources.describe(original)
  const initial = initialDescription.grant
  const accepted = original.receipt.accepted!
  const issuedAt = Date.now()
  const controlPermit = Command.Permit.parse({
    ...accepted.permit,
    operation: "continue",
    requestID: "explicit-control",
    admissionID: "control-admission",
    attemptID: "control-attempt",
    actor: { ...accepted.permit.actor, subjectID: "current-controller", requestID: "explicit-control" },
    commandSeq: accepted.permit.commandSeq + 1,
    authorizedAt: issuedAt,
    deadline: issuedAt + 30_000,
  })
  const control = Command.ControlAccepted.parse({
    schemaVersion: 1,
    permit: controlPermit,
    acceptedAt: issuedAt,
    intakeSeq: accepted.intakeSeq + 1,
    effect: {
      kind: "control",
      operation: "continue",
      controlVersion: 1,
      pausedSince: issuedAt - 1,
      itemID: "resume-item",
      messageID: "resume-message",
      rootID: accepted.effect.messageID,
    },
  })
  const continuation = Execution.Continuation.parse({
    handoffID: "cancelled-handoff",
    receipt: {
      attempt: {
        schemaVersion: 1,
        permit: controlPermit,
        receivedAt: issuedAt,
        status: "accepted",
        acceptedAttemptID: controlPermit.attemptID,
      },
      accepted: control,
    },
  })
  const proof = Execution.DescriptionProof.parse({ ...original, continuation, issuedAt, expiresAt: issuedAt + 30_000 })
  const grant = Execution.Grant.parse({
    ...initial,
    state: "provisional",
    grantID: "fresh-control-grant",
    provenance: {
      handoffID: continuation.handoffID,
      predecessorGrantID: initial.grantID,
      originGrantID: accepted.permit.provisionalGrantID,
      rootID: accepted.effect.messageID,
      control,
    },
  })
  f.interceptHTTP(() => Response.json({ grant, resources: initialDescription.resources }))
  expect((await f.connection.resources.describe(proof)).grant).toEqual(grant)
  for (const changed of [
    { actor: controlPermit.actor },
    { bindingEpoch: initial.bindingEpoch + 1 },
    { grantID: initial.grantID },
    { provenance: { ...grant.provenance!, originGrantID: "other-input-grant" } },
    { provenance: { ...grant.provenance!, handoffID: "other-handoff" } },
    { provenance: { ...grant.provenance!, control: { ...control, effect: { ...control.effect, controlVersion: 2 } } } },
  ]) {
    f.interceptHTTP(() => Response.json({ grant: { ...grant, ...changed }, resources: initialDescription.resources }))
    await expect(f.connection.resources.describe(proof)).rejects.toMatchObject({ data: { code: "PROTOCOL_MISMATCH" } })
  }
})
