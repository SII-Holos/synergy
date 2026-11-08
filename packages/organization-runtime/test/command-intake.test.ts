import { expect, spyOn, test } from "bun:test"
import {
  OrganizationCommandProtocol as Command,
  OrganizationRuntimeProtocol as Runtime,
  OrganizationSessionProtocol as Sessions,
} from "@ericsanchezok/synergy-organization-protocol"
import { Scope } from "@ericsanchezok/synergy-harness/scope"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { SessionInbox } from "@ericsanchezok/synergy-harness/session/inbox"
import { Bus } from "@ericsanchezok/synergy-harness/bus"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { testRuntime } from "@ericsanchezok/synergy-harness/test/support/runtime"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import { createCommandIntake } from "../src/command-intake"
import { registerSessionSchema } from "../src/session-schema"
import { OrganizationIntakePath as Keys } from "../src/storage/path"
import { OrganizationRuntimeError } from "../src/error"

const binding: Sessions.Binding = {
  schemaVersion: 1,
  orgID: "org-intake",
  projectID: "project-intake",
  creatorID: "account-intake",
  driverRuntimeID: "runtime-intake",
  bindingEpoch: 1,
}

async function authority() {
  const keys = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"])
  const identity: Command.SigningIdentity = {
    schemaVersion: 1,
    orgID: binding.orgID,
    deploymentIncarnation: "deployment-intake",
    keyID: "key-intake",
    publicKey: await Runtime.publicKey(keys.publicKey),
  }
  return {
    identity,
    receiver(connectionEpoch = 1, signal = new AbortController().signal) {
      return createCommandIntake({
        identity,
        runtimeID: binding.driverRuntimeID,
        accountID: binding.creatorID,
        connectionEpoch,
        signal,
      })
    },
    async input(
      sessionID: string,
      options: Partial<Command.Permit> = {},
      text = "Private task body",
      mode: Command.Input["mode"] = "context",
    ) {
      const input: Command.Input = { operation: "input", mode, parts: [{ type: "text", text }] }
      const requestID = options.requestID ?? "request-intake"
      const permit: Command.Permit = {
        schemaVersion: 1,
        purpose: "session-command",
        orgID: identity.orgID,
        deploymentIncarnation: identity.deploymentIncarnation,
        keyID: identity.keyID,
        requestID,
        sessionID,
        projectID: binding.projectID,
        runtimeID: binding.driverRuntimeID,
        bindingEpoch: binding.bindingEpoch,
        connectionEpoch: 1,
        commandSeq: 1,
        shareGeneration: 0,
        controlRevision: 0,
        authRevision: 1,
        admissionID: "admission-intake",
        attemptID: "attempt-intake",
        actor: {
          kind: "account",
          subjectID: binding.creatorID,
          orgID: binding.orgID,
          displayName: "Original author",
          clientKind: "web",
          requestID,
        },
        operation: "input",
        authorizedAt: Date.now(),
        deadline: Date.now() + 60_000,
        payloadHash: "0".repeat(64),
        ...options,
      }
      permit.payloadHash = await Command.digestInput({ ...Command.inputRequest(permit, input) })
      return { authorization: { permit, signature: await Command.sign(permit, keys.privateKey) }, input }
    },
    async skip(permit: Command.Permit, connectionEpoch = 1, changes: Partial<Command.SkipPermit> = {}) {
      const proof: Command.SkipPermit = {
        schemaVersion: 1,
        purpose: "session-command-skip",
        command: permit,
        connectionEpoch,
        authorizedAt: Date.now(),
        deadline: Date.now() + 60_000,
        ...changes,
      }
      return { permit: proof, signature: await Command.signSkip(proof, keys.privateKey) }
    },
    async create(sessionID: string, options: Partial<Command.Permit> = {}): Promise<Command.CreateDelivery> {
      const permit = (await this.input(sessionID, { requestID: "create-intake", ...options, operation: "create" }))
        .authorization.permit
      const creation: Command.Creation = { operation: "create", title: "Native creation title" }
      permit.payloadHash = await Command.digestCreate(Command.createRequest(permit, creation))
      return { authorization: { permit, signature: await Command.sign(permit, keys.privateKey) }, creation }
    },
  }
}

async function session() {
  const scope = await Scope.registerProject({
    type: "project",
    id: binding.projectID,
    local: null,
    time: { created: 1, updated: 1 },
  })
  return ScopeContext.provide({
    scope,
    workspace: null,
    fn: () => Session.create({ organization: binding, workspaceID: null }),
  })
}

test("creation rolls back the real Session and Scope with its receipt and never adopts an existing Session", async () => {
  await using home = await tmpdir()
  const service = await authority()
  await using runtime = await testRuntime({ home: home.path, register: () => registerSessionSchema(binding) })
  await runtime.run(async () => {
    const receiver = service.receiver()
    const delivery = await service.create("ses_create_intake")
    const write = Storage.write
    const failure = spyOn(Storage, "write").mockImplementation(async (key, value) => {
      await write(key, value)
      if (
        key.join("/") ===
        Keys.request(binding.orgID, binding.creatorID, delivery.authorization.permit.requestID).join("/")
      )
        throw new Error("Receipt publication failed")
    })
    try {
      await expect(receiver.create(delivery)).rejects.toThrow("Receipt publication failed")
    } finally {
      failure.mockRestore()
    }
    await expect(Session.get(delivery.authorization.permit.sessionID)).rejects.toBeInstanceOf(Storage.NotFoundError)
    expect((await Scope.list()).find((value) => value.id === binding.projectID)).toBeUndefined()
    expect(await receiver.query(delivery.authorization)).toEqual({ authorization: delivery.authorization })
    const [first, duplicate] = await Promise.all([receiver.create(delivery), receiver.create(delivery)])
    expect(first).toEqual(duplicate)
    expect(first.accepted?.intakeSeq).toBe(1)
    expect((await Session.get(delivery.authorization.permit.sessionID)).organization).toEqual(binding)
    const collision = await service.create(delivery.authorization.permit.sessionID, {
      requestID: "collision",
      attemptID: "collision",
      commandSeq: 2,
    })
    expect((await receiver.create(collision)).attempt).toMatchObject({
      status: "rejected",
      reason: "SESSION_UNAVAILABLE",
    })
    expect(await SessionInbox.list(delivery.authorization.permit.sessionID)).toHaveLength(0)
    const other = await service.create("ses_wrong_creator", {
      requestID: "other",
      attemptID: "other",
      actor: {
        ...delivery.authorization.permit.actor,
        subjectID: "other-member",
        requestID: "other",
      },
    })
    expect((await receiver.create(other)).attempt).toMatchObject({ status: "rejected", reason: "REQUEST_CONFLICT" })
    await expect(Session.get("ses_wrong_creator")).rejects.toBeInstanceOf(Storage.NotFoundError)
  })
})

test("a committed creation survives restart and replay cannot recreate a removed Session", async () => {
  await using home = await tmpdir()
  const service = await authority()
  const delivery = await service.create("ses_retained_creation")
  let receipt: Command.CreatedResult
  {
    await using runtime = await testRuntime({ home: home.path, register: () => registerSessionSchema(binding) })
    receipt = await runtime.run(() => service.receiver().create(delivery))
  }
  await using runtime = await testRuntime({ home: home.path, register: () => registerSessionSchema(binding) })
  await runtime.run(async () => {
    const receiver = service.receiver(2)
    expect(await receiver.query(delivery.authorization)).toEqual({
      authorization: delivery.authorization,
      result: receipt,
    })
    expect((await Session.get(delivery.authorization.permit.sessionID)).title).toBe(delivery.creation.title!)
    await Session.remove(delivery.authorization.permit.sessionID)
    expect(await receiver.create(delivery)).toEqual(receipt)
    await expect(Session.get(delivery.authorization.permit.sessionID)).rejects.toBeInstanceOf(Storage.NotFoundError)
  })
})

test("signed receipt queries survive expiry and reconnect without accepting or skipping input", async () => {
  await using home = await tmpdir()
  const service = await authority()
  await using runtime = await testRuntime({ home: home.path, register: () => registerSessionSchema(binding) })
  await runtime.run(async () => {
    const sessionID = (await session()).id
    const delivery = await service.input(sessionID)
    const receiver = service.receiver()
    expect(await receiver.query(delivery.authorization)).toEqual({ authorization: delivery.authorization })
    expect(await SessionInbox.list(sessionID)).toHaveLength(0)
    const accepted = await receiver.input(delivery)
    const next = service.receiver(2)
    const observation = await service.input(sessionID, {
      attemptID: "unreceived-retry",
      commandSeq: 2,
      connectionEpoch: 2,
    })
    expect(await next.query(observation.authorization)).toEqual({
      authorization: observation.authorization,
      result: accepted,
    })
    expect(await Storage.readMany([Keys.attempt(binding.orgID, sessionID, "unreceived-retry")])).toEqual([undefined])
    const clock = spyOn(Date, "now").mockReturnValue(delivery.authorization.permit.deadline + 1)
    try {
      expect(await next.query(delivery.authorization)).toEqual({
        authorization: delivery.authorization,
        result: accepted,
      })
      await expect(next.query({ ...delivery.authorization, signature: "0".repeat(128) })).rejects.toMatchObject({
        data: { code: "PERMISSION_DENIED" },
      })
    } finally {
      clock.mockRestore()
    }
    expect(await SessionInbox.list(sessionID)).toHaveLength(1)
    const absent = await service.input(sessionID, { requestID: "unseen", attemptID: "unseen", commandSeq: 2 })
    const snapshot = await next.query(absent.authorization)
    expect(snapshot.result).toBeUndefined()
    const controller = new AbortController()
    controller.abort()
    await expect(service.receiver(2, controller.signal).query(absent.authorization)).rejects.toMatchObject({
      data: { code: "STALE_CONNECTION" },
    })
  })
})

test("accepted input has one durable effect, fixed actor and intake order across retries and restart", async () => {
  await using home = await tmpdir()
  const service = await authority()
  let sessionID = ""
  let delivery: Awaited<ReturnType<typeof service.input>>
  let accepted: Command.InputAccepted | undefined
  {
    await using runtime = await testRuntime({ home: home.path, register: () => registerSessionSchema(binding) })
    await runtime.run(async () => {
      sessionID = (await session()).id
      delivery = await service.input(sessionID)
      const receiver = service.receiver()
      const results = await Promise.all([receiver.input(delivery), receiver.input(delivery)])
      expect(results[0]).toEqual(results[1])
      accepted = results[0].accepted
      expect(accepted?.intakeSeq).toBe(1)
      expect(accepted?.permit.actor).toEqual(delivery.authorization.permit.actor)
      expect(accepted!.acceptedAt).toBeGreaterThanOrEqual(delivery.authorization.permit.authorizedAt)
      const items = await SessionInbox.list(sessionID)
      expect(items).toHaveLength(1)
      expect(items[0].message?.actor).toEqual(delivery.authorization.permit.actor)
      expect(items[0].messageID).toBe(accepted!.effect.messageID)
      expect(items[0].mode).toBe("context")
    })
  }
  await using runtime = await testRuntime({ home: home.path, register: () => registerSessionSchema(binding) })
  await runtime.run(async () => {
    const receiver = service.receiver(2)
    const retry = await service.input(sessionID, {
      connectionEpoch: 2,
      commandSeq: 2,
      attemptID: "attempt-retry",
      admissionID: "admission-retry",
    })
    expect((await receiver.input(retry)).accepted).toEqual(accepted)
    expect(await SessionInbox.list(sessionID)).toHaveLength(1)
    const next = await service.input(sessionID, {
      requestID: "request-next",
      connectionEpoch: 2,
      commandSeq: 3,
      attemptID: "attempt-next",
      admissionID: "admission-next",
    })
    expect((await receiver.input(next)).accepted?.intakeSeq).toBe(2)
    expect(await receiver.accepted({ subjectID: binding.creatorID, requestID: "request-intake" })).toEqual(accepted)
    expect(await SessionInbox.list(sessionID)).toHaveLength(2)
  })
})

test("a rejected attempt closes only its own slot and a newly authorized retry can be accepted", async () => {
  const service = await authority()
  await using runtime = await testRuntime({ register: () => registerSessionSchema(binding) })
  await runtime.run(async () => {
    const id = (await session()).id
    const receiver = service.receiver(2)
    const expired = await service.input(id, {
      connectionEpoch: 2,
      authorizedAt: Date.now() - 60_000,
      deadline: Date.now() - 1,
    })
    expect((await receiver.input(expired)).attempt).toMatchObject({ status: "rejected", reason: "EXPIRED_PERMIT" })
    const retry = await service.input(id, {
      connectionEpoch: 2,
      commandSeq: 2,
      admissionID: "retry-admission",
      attemptID: "retry-attempt",
    })
    const accepted = (await receiver.input(retry)).accepted!
    expect(accepted.intakeSeq).toBe(1)
    expect(accepted.permit.attemptID).toBe("retry-attempt")
    expect((await receiver.input(expired)).accepted).toEqual(accepted)
    const stale = await service.input(id, {
      commandSeq: 3,
      requestID: "stale-request",
      admissionID: "stale-admission",
      attemptID: "stale-attempt",
    })
    expect((await receiver.input(stale)).attempt).toMatchObject({ status: "rejected", reason: "STALE_CONNECTION" })
    const changed = await service.input(
      id,
      {
        connectionEpoch: 2,
        commandSeq: 4,
        admissionID: "changed-admission",
        attemptID: "changed-attempt",
      },
      "Changed payload under the same logical identity",
    )
    expect(await receiver.input(changed)).toMatchObject({ attempt: { status: "rejected", reason: "REQUEST_CONFLICT" } })
    expect((await receiver.input(changed)).accepted).toBeUndefined()
    const tampered = structuredClone(retry)
    tampered.input.parts[0].text = "Replacement body"
    await expect(receiver.input(tampered)).rejects.toBeInstanceOf(OrganizationRuntimeError)
    const reusedAttempt = await service.input(id, { ...retry.authorization.permit, authRevision: 2 })
    await expect(receiver.input(reusedAttempt)).rejects.toBeInstanceOf(OrganizationRuntimeError)
    expect(await SessionInbox.list(id)).toHaveLength(1)
  })
})

test("explicit skip receipts close ordered gaps and fence late frames without preventing a fresh attempt", async () => {
  const service = await authority()
  await using runtime = await testRuntime({ register: () => registerSessionSchema(binding) })
  await runtime.run(async () => {
    const id = (await session()).id
    const receiver = service.receiver(2)
    const first = await service.input(id)
    const second = await service.input(id, {
      connectionEpoch: 2,
      commandSeq: 2,
      requestID: "second-request",
      attemptID: "second-attempt",
      admissionID: "second-admission",
    })
    const skippedSecond = await service.skip(second.authorization.permit, 2)
    await expect(receiver.skip(skippedSecond)).rejects.toBeInstanceOf(OrganizationRuntimeError)
    expect((await receiver.input(second)).attempt).toMatchObject({ status: "rejected", reason: "SEQUENCE_GAP" })
    const skippedFirst = await service.skip(first.authorization.permit, 2)
    const result = await receiver.skip(skippedFirst)
    expect(result.attempt.status).toBe("skipped")
    expect(result.skip?.permit.connectionEpoch).toBe(2)
    expect(await receiver.input(first)).toEqual(Command.InputResult.parse(result))
    const closedSecond = await receiver.skip(skippedSecond)
    expect(closedSecond.attempt).toMatchObject({ status: "rejected", reason: "SEQUENCE_GAP" })
    expect(closedSecond.skip).toBeDefined()
    expect(await receiver.skip(skippedSecond)).toEqual(closedSecond)
    const retry = await service.input(id, {
      connectionEpoch: 2,
      commandSeq: 3,
      attemptID: "fresh-attempt",
      admissionID: "fresh-admission",
    })
    expect((await receiver.input(retry)).accepted?.intakeSeq).toBe(1)
    expect((await receiver.input(first)).attempt.status).toBe("skipped")
    expect((await receiver.input(second)).attempt.status).toBe("rejected")
    const competing = await service.input(id, {
      connectionEpoch: 2,
      commandSeq: 4,
      requestID: "racing-request",
      attemptID: "racing-attempt",
      admissionID: "racing-admission",
    })
    const skip = await service.skip(competing.authorization.permit, 2)
    const [received, skipped] = await Promise.all([receiver.input(competing), receiver.skip(skip)])
    expect(received.attempt.status).toBe(skipped.attempt.status)
    expect(["accepted", "skipped"]).toContain(received.attempt.status)
    expect(await SessionInbox.list(id)).toHaveLength(received.attempt.status === "accepted" ? 2 : 1)
  })
})

test("failed commit, lost connection and deadline crossing leave no input, intake allocation or notification", async () => {
  const service = await authority()
  await using runtime = await testRuntime({ register: () => registerSessionSchema(binding) })
  await runtime.run(async () => {
    const observed: string[] = []
    const unsubscribe = Bus.subscribeGlobal(SessionInbox.Event.Updated, (event) =>
      observed.push(event.properties.sessionID),
    )
    try {
      const failures = ["write", "disconnect", "deadline", "deadline-input"] as const
      for (const failure of failures) {
        const id = (await session()).id
        const stopped = new AbortController()
        const receiver = service.receiver(1, stopped.signal)
        const requestID = `request-${failure}`
        const delivery = await service.input(id, { requestID, attemptID: `attempt-${failure}` })
        const requestKey = Keys.request(binding.orgID, binding.creatorID, requestID)
        const original = Storage.write
        let clock: ReturnType<typeof spyOn<typeof Date, "now">> | undefined
        const write = spyOn(Storage, "write").mockImplementation(async <T>(key: string[], value: T) => {
          await original(key, value)
          if (failure === "deadline-input") {
            if (key[0] !== "sessions" || key[2] !== id || key[3] !== "inbox") return
          } else if (JSON.stringify(key) !== JSON.stringify(requestKey)) return
          if (failure === "write") throw new Error("Injected failure after a real receipt write")
          if (failure === "disconnect") stopped.abort()
          if (failure.startsWith("deadline") && !clock)
            clock = spyOn(Date, "now").mockReturnValue(delivery.authorization.permit.deadline)
        })
        try {
          if (failure.startsWith("deadline")) {
            expect((await receiver.input(delivery)).attempt).toMatchObject({
              status: "rejected",
              reason: "EXPIRED_PERMIT",
            })
          } else await expect(receiver.input(delivery)).rejects.toThrow()
        } finally {
          write.mockRestore()
          clock?.mockRestore()
        }
        expect(await SessionInbox.list(id)).toHaveLength(0)
        expect(observed).not.toContain(id)
        expect(await Storage.current().store.pendingEventCount()).toBe(0)
        expect(await receiver.accepted({ subjectID: binding.creatorID, requestID })).toBeUndefined()
        const retry = failure.startsWith("deadline")
          ? await service.input(id, {
              requestID,
              commandSeq: 2,
              attemptID: "after-deadline",
              admissionID: "after-deadline",
            })
          : delivery
        expect((await service.receiver().input(retry)).accepted?.intakeSeq).toBe(failures.indexOf(failure) + 1)
        expect(observed.filter((entry) => entry === id)).toHaveLength(1)
      }
    } finally {
      unsubscribe()
    }
  })
})

test("binding and transfer fences reject before Inbox writes without poisoning a valid binding", async () => {
  const service = await authority()
  await using runtime = await testRuntime({ register: () => registerSessionSchema(binding) })
  await runtime.run(async () => {
    const id = (await session()).id
    const receiver = service.receiver()
    const wrong = await service.input(id, { bindingEpoch: 2 })
    expect((await receiver.input(wrong)).attempt).toMatchObject({ status: "rejected", reason: "STALE_BINDING" })
    const valid = await service.input(id, { attemptID: "valid-binding", admissionID: "valid-binding" })
    const gateKey = ["session_transfer_gate", id]
    await Storage.write(gateKey, {
      version: 1,
      migrationID: "transfer-fixture",
      scopeID: binding.projectID,
      targetID: "target-fixture",
      phase: "preparing",
    })
    expect((await receiver.input(valid)).attempt).toMatchObject({ status: "rejected", reason: "TRANSFER_BLOCKED" })
    expect(await SessionInbox.list(id)).toHaveLength(0)
    await Storage.remove(gateKey)
    const retry = await service.input(id, { commandSeq: 2, attemptID: "after-transfer", admissionID: "after-transfer" })
    expect((await receiver.input(retry)).accepted?.intakeSeq).toBe(1)
    await ScopeContext.provide({
      scope: (await Session.get(id)).scope,
      workspace: null,
      fn: () =>
        Session.update(id, (draft) => {
          draft.time.archived = Date.now()
        }),
    })
    const archived = await service.input(id, {
      commandSeq: 3,
      requestID: "archived-request",
      attemptID: "archived-attempt",
      admissionID: "archived-admission",
    })
    expect((await receiver.input(archived)).attempt).toMatchObject({
      status: "rejected",
      reason: "SESSION_UNAVAILABLE",
    })
    expect(await SessionInbox.list(id)).toHaveLength(1)
  })
})

test("trusted intake captures input before awaits, uses native modes and never resurrects removed input", async () => {
  const service = await authority()
  await using runtime = await testRuntime({ register: () => registerSessionSchema(binding) })
  await runtime.run(async () => {
    const id = (await session()).id
    const otherID = (await session()).id
    const receiver = service.receiver()
    const input = await service.input(id, {}, "Captured task", "task")
    const pending = receiver.input(input)
    input.input.parts[0].text = "Mutated after entry"
    input.authorization.permit.actor.displayName = "Mutated author"
    const received = await pending
    expect(received.accepted?.intakeSeq).toBe(1)
    expect((await SessionInbox.list(id))[0]).toMatchObject({
      mode: "task",
      message: { actor: { displayName: "Original author" }, parts: [{ type: "text", text: "Captured task" }] },
    })
    const supplement = await service.input(
      otherID,
      { requestID: "other-request", attemptID: "other-attempt" },
      "Supplement",
      "steer",
    )
    expect((await receiver.input(supplement)).accepted?.intakeSeq).toBe(2)
    const removed = (await SessionInbox.list(otherID))[0]
    await SessionInbox.remove({ sessionID: otherID, itemID: removed.id })
    expect((await receiver.input(supplement)).accepted?.effect.itemID).toBe(removed.id)
    expect(await SessionInbox.list(otherID)).toHaveLength(0)
    const rows = await Storage.current().store.query({ prefix: ["organization-command", binding.orgID] })
    const records = JSON.stringify(rows.map((row) => row.value))
    expect(records).not.toContain("Captured task")
    expect(records).not.toContain("Supplement")
    expect(records).not.toContain("Mutated author")
  })
})

test("untrusted frames and nested transactions cannot create an acceptance receipt", async () => {
  const service = await authority()
  await using runtime = await testRuntime({ register: () => registerSessionSchema(binding) })
  await runtime.run(async () => {
    const id = (await session()).id
    const receiver = service.receiver()
    const valid = await service.input(id)
    const corrupted = structuredClone(valid)
    corrupted.authorization.signature = "0".repeat(128)
    await expect(receiver.input(corrupted)).rejects.toBeInstanceOf(OrganizationRuntimeError)
    const wrongRuntime = await service.input(id, { runtimeID: "different-runtime" })
    await expect(receiver.input(wrongRuntime)).rejects.toBeInstanceOf(OrganizationRuntimeError)
    const foreign = await authority()
    await expect(foreign.receiver().input(valid)).rejects.toBeInstanceOf(OrganizationRuntimeError)
    await expect(Storage.transaction(() => receiver.input(valid))).rejects.toBeInstanceOf(OrganizationRuntimeError)
    const corruptedBody = structuredClone(valid)
    corruptedBody.input.parts[0].text = "Incomplete or changed payload"
    expect((await receiver.input(corruptedBody)).attempt).toMatchObject({
      status: "rejected",
      reason: "PAYLOAD_MISMATCH",
    })
    expect(await SessionInbox.list(id)).toHaveLength(0)
    const retry = await service.input(id, {
      commandSeq: 2,
      attemptID: "complete-payload",
      admissionID: "complete-payload",
    })
    expect((await receiver.input(retry)).accepted?.intakeSeq).toBe(1)
  })
})

test("logical keys include the actor and target conflicts cannot move a request to another Session", async () => {
  const service = await authority()
  await using runtime = await testRuntime({ register: () => registerSessionSchema(binding) })
  await runtime.run(async () => {
    const firstID = (await session()).id
    const secondID = (await session()).id
    const receiver = service.receiver()
    const first = await service.input(firstID)
    const accepted = (await receiver.input(first)).accepted!
    const moved = await service.input(secondID, { attemptID: "moved-attempt", admissionID: "moved-admission" })
    expect((await receiver.input(moved)).attempt).toMatchObject({ status: "rejected", reason: "REQUEST_CONFLICT" })
    expect(await SessionInbox.list(secondID)).toHaveLength(0)
    const otherActor = {
      ...first.authorization.permit.actor,
      subjectID: "another-account",
      displayName: "Another author",
    }
    const other = await service.input(firstID, {
      commandSeq: 2,
      actor: otherActor,
      attemptID: "other-actor-attempt",
      admissionID: "other-actor-admission",
    })
    expect((await receiver.input(other)).accepted?.intakeSeq).toBe(2)
    expect(
      (await SessionInbox.list(firstID)).map((item) =>
        item.message?.actor?.kind === "account" ? item.message.actor.subjectID : undefined,
      ),
    ).toEqual([binding.creatorID, otherActor.subjectID])
    const key = Keys.request(binding.orgID, binding.creatorID, first.authorization.permit.requestID)
    const retained = await Storage.read<{ identity: unknown; accepted: Command.Accepted }>(key)
    await Storage.write(key, {
      ...retained,
      accepted: { ...accepted, permit: { ...accepted.permit, actor: otherActor } },
    })
    await expect(
      receiver.accepted({ subjectID: binding.creatorID, requestID: first.authorization.permit.requestID }),
    ).rejects.toBeInstanceOf(OrganizationRuntimeError)
    await Storage.write(key, retained)
    expect(
      await receiver.accepted({ subjectID: binding.creatorID, requestID: first.authorization.permit.requestID }),
    ).toEqual(accepted)
  })
})

test("invalid skip proofs cannot close a slot and a corrupted retained skip cannot be reported", async () => {
  const service = await authority()
  await using runtime = await testRuntime({ register: () => registerSessionSchema(binding) })
  await runtime.run(async () => {
    const id = (await session()).id
    const receiver = service.receiver()
    const input = await service.input(id)
    const valid = await service.skip(input.authorization.permit)
    const expired = await service.skip(input.authorization.permit, 1, {
      authorizedAt: Date.now() - 60_000,
      deadline: Date.now() - 1,
    })
    for (const proof of [
      { ...valid, signature: "0".repeat(128) },
      await service.skip(input.authorization.permit, 2),
      expired,
    ])
      await expect(receiver.skip(proof)).rejects.toBeInstanceOf(OrganizationRuntimeError)
    await expect(Storage.transaction(() => receiver.skip(valid))).rejects.toBeInstanceOf(OrganizationRuntimeError)
    const accepted = await receiver.input(input)
    expect(accepted.accepted?.intakeSeq).toBe(1)
    expect(await receiver.skip(valid)).toEqual(accepted)
    const closed = await service.input(id, {
      requestID: "closed-slot",
      attemptID: "closed-slot",
      admissionID: "closed-slot",
    })
    expect((await receiver.input(closed)).attempt).toMatchObject({ status: "rejected", reason: "SEQUENCE_CLOSED" })
    const next = await service.input(id, {
      commandSeq: 2,
      requestID: "skip-next",
      attemptID: "skip-next",
      admissionID: "skip-next",
    })
    const skipped = await receiver.skip(await service.skip(next.authorization.permit))
    expect(skipped.attempt.status).toBe("skipped")
    const key = Keys.skip(binding.orgID, id, next.authorization.permit.attemptID)
    const retained = await Storage.read(key)
    await Storage.write(key, { ...skipped.skip, permit: valid.permit })
    await expect(receiver.input(next)).rejects.toBeInstanceOf(OrganizationRuntimeError)
    await Storage.write(key, retained)
    expect(await receiver.input(next)).toEqual(Command.InputResult.parse(skipped))
    expect(await SessionInbox.list(id)).toHaveLength(1)
  })
})
