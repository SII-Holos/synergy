import { expect, spyOn, test } from "bun:test"
import { createHash } from "node:crypto"
import path from "node:path"
import { z } from "zod"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import {
  OrganizationRuntimeProtocol as Runtime,
  OrganizationCommandProtocol as Command,
} from "@ericsanchezok/synergy-organization-protocol"
import * as IntakeModule from "../../src/command-intake"
import { OrganizationRuntimeError } from "../../src/error"
import { OrganizationIntakePath as NativeKeys } from "../../src/storage/path"
import { OrganizationCommandRecords as NativeRecords } from "../../src/command-records"
import { prepareMemberHome } from "../../src/home"
import { enrollMemberRuntime } from "../../src/enrollment"
import { readMemberRegistration } from "../../src/registration"
import { openMemberRuntime } from "../../src/runtime"
import { OrganizationCommandHistory as History } from "../../../organization/src/command-history"
import { OrganizationRecord as Record } from "../../../organization/src/storage/records"
import { OrganizationStoragePath as Keys } from "../../../organization/src/storage/path"
import { fixture } from "../support/organization"

type Rows = Map<string, unknown>
function reader(rows: Rows): Record.HistoricalReader {
  return {
    read<T>(schema: z.ZodType<T>, key: string[]) {
      const value = rows.get(JSON.stringify(key))
      if (value === undefined) throw new Error("Missing original acknowledged command record")
      return schema.parse(structuredClone(value))
    },
    *entries(prefix) {
      for (const [key, value] of [...rows].sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))) {
        const parsed = z.array(z.string()).parse(JSON.parse(key))
        if (prefix.every((part, index) => parsed[index] === part)) yield { key: parsed, value: structuredClone(value) }
      }
    },
  }
}

test("real Member history retains a skipped original attempt and its accepted logical retry without Hosted authority", async () => {
  await using f = await fixture()
  const options = { headers: f.headers, throwOnError: true as const }
  const project = (
    await f.client.orgProjects.create({ orgProjectCreate: { name: "Original command history" } }, options)
  ).data
  const home = await prepareMemberHome({
    baseDirectory: path.join(f.root, "members"),
    identity: f.identity,
    origin: f.origin,
  })
  await enrollMemberRuntime({
    home: home.home,
    identity: home.identity,
    ca: f.ca,
    ticket: await f.ticket(home.identity.deviceID, home.publicKey),
  })
  const registration = await readMemberRegistration(home.home, home.identity)
  if (!registration) throw new Error("The actual Member enrollment did not persist")
  const listening = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() })
  const port = listening.port
  if (!port) throw new Error("The task-owned Member listener did not allocate a port")
  await listening.stop(true)
  const online = Promise.withResolvers<void>()
  f.interceptFrames((_socket, raw) => {
    if (Runtime.ClientFrame.parse(JSON.parse(String(raw))).type === "heartbeat") online.resolve()
    return false
  })
  const retryRequestID = "original-member-context-retry"
  let refused = 0
  let observedRuntime = false
  const createIntake = IntakeModule.createCommandIntake
  await using runtime = await (async () => {
    using observe = spyOn(IntakeModule, "createCommandIntake").mockImplementation((input) => {
      const intake = createIntake(input)
      if (input.runtimeID !== registration.runtimeID) return intake
      observedRuntime = true
      return {
        ...intake,
        async input(delivery: Command.InputDelivery) {
          if (delivery.authorization.permit.requestID === retryRequestID && !refused) {
            refused++
            throw new OrganizationRuntimeError({
              code: "SERVICE_UNAVAILABLE",
              message: "Fixture refusal before original native reception",
              outcome: "not_dispatched",
              retryable: true,
            })
          }
          return intake.input(delivery)
        },
      }
    })
    const opened = await openMemberRuntime({
      home: home.home,
      identity: home.identity,
      ca: f.ca,
      listen: { port, token: "c".repeat(64) },
    })
    const timeout = setTimeout(() => online.reject(new Error("The original Member bridge did not connect")), 3000)
    try {
      await online.promise
      return opened
    } catch (error) {
      await opened.close()
      throw error
    } finally {
      clearTimeout(timeout)
    }
  })()
  expect(observedRuntime).toBe(true)
  const created = (
    await f.client.orgSessions.create(
      {
        orgCommandCreateRequest: {
          schemaVersion: 1,
          orgID: f.identity.orgID,
          projectID: project.projectID,
          runtimeID: registration.runtimeID,
          requestID: "original-member-create",
          creation: { operation: "create" },
        },
      },
      options,
    )
  ).data
  const paused = (
    await f.client.orgCommands.control(
      {
        sessionID: created.effect.sessionID,
        orgCommandControlRequest: {
          schemaVersion: 1,
          orgID: f.identity.orgID,
          projectID: project.projectID,
          runtimeID: registration.runtimeID,
          sessionID: created.effect.sessionID,
          requestID: "original-member-pause",
          control: { operation: "pause" },
        },
      },
      options,
    )
  ).data
  expect(paused.effect.operation).toBe("pause")
  const retryInput = {
    sessionID: created.effect.sessionID,
    orgCommandInputRequest: Command.InputRequest.parse({
      schemaVersion: 1,
      orgID: f.identity.orgID,
      projectID: project.projectID,
      runtimeID: registration.runtimeID,
      sessionID: created.effect.sessionID,
      requestID: retryRequestID,
      input: {
        operation: "input",
        mode: "context",
        parts: [{ type: "text", text: "Retain this one logical context input" }],
      },
    }),
  }
  const firstCall = await f.client.orgCommands.input(retryInput, options).then(
    (value) => ({ state: "resolved" as const, value }),
    (error: unknown) => ({ state: "rejected" as const, error }),
  )
  expect(firstCall.state).toBe("rejected")
  expect(refused).toBe(1)
  const firstRequest = await f.service.maintenance.run(() =>
    Record.read(Record.CommandRequest, Keys.commandRequest(created.permit.actor.subjectID, retryRequestID)),
  )
  if (!firstRequest) throw new Error("The original A-point request did not persist")
  const firstPermit = firstRequest.first
  expect(
    await f.service.maintenance.run(() =>
      Record.read(Record.CommandAttempt, Keys.commandAttempt(firstPermit.attemptID)),
    ),
  ).toMatchObject({ state: "not_dispatched" })
  expect(
    await runtime.run(() =>
      Storage.readMany([NativeKeys.attempt(f.identity.orgID, created.effect.sessionID, firstPermit.attemptID)]),
    ),
  ).toEqual([undefined])
  const retryAccepted = (await f.client.orgCommands.input(retryInput, options)).data
  expect(retryAccepted.permit.requestID).toBe(firstPermit.requestID)
  expect(retryAccepted.permit.commandSeq).toBe(firstPermit.commandSeq + 1)
  expect(retryAccepted.permit.payloadHash).toBe(firstPermit.payloadHash)
  expect(retryAccepted.permit.attemptID).not.toBe(firstPermit.attemptID)
  expect(refused).toBe(1)
  await runtime.run(async () => {
    const skipped = Command.Attempt.parse(
      await Storage.read(NativeKeys.attempt(f.identity.orgID, created.effect.sessionID, firstPermit.attemptID)),
    )
    expect(skipped.status).toBe("skipped")
    const accepted = NativeRecords.Request.parse(
      await Storage.read(NativeKeys.request(f.identity.orgID, firstPermit.actor.subjectID, retryRequestID)),
    )
    expect(accepted.accepted).toEqual(retryAccepted)
  })
  const snapshot = await f.service.maintenance.run(() =>
    Storage.snapshot(async (tx) => {
      const rows: Rows = new Map()
      for await (const entry of tx.exportEntries())
        if (entry.type === "record") rows.set(JSON.stringify(entry.key), entry.value)
      return rows
    }),
  )
  const stateKey = Keys.commandState(created.effect.sessionID)
  const state = reader(snapshot).read(Record.CommandState, stateKey)
  expect(state.commandSeq).toBe(retryAccepted.permit.commandSeq)
  expect(state.pendingAttemptID).toBeUndefined()
  const closedFirst = reader(snapshot).read(Record.CommandAttempt, Keys.commandAttempt(firstPermit.attemptID))
  expect(closedFirst).toMatchObject({ state: "rejected", result: { attempt: { status: "skipped" } } })
  if (!closedFirst.result?.skip) throw new Error("The actual Native skip did not close its original Service attempt")
  const skipKey = Keys.commandSkip(
    firstPermit.attemptID,
    createHash("sha256").update(JSON.stringify(closedFirst.result.skip.permit)).digest("hex"),
  )
  const skip = reader(snapshot).read(Command.SignedSkip, skipKey)
  const signing = reader(snapshot).read(Record.SigningIdentity, Keys.signingIdentity())
  expect(await Command.verifySkip(skip.permit, skip.signature, signing.publicKey)).toBe(true)
  expect(skip.permit.command).toEqual(firstPermit)
  expect(
    reader(snapshot).read(Record.CommandRequest, Keys.commandRequest(firstPermit.actor.subjectID, retryRequestID)),
  ).toMatchObject({ first: firstPermit, lastAttemptID: retryAccepted.permit.attemptID, accepted: retryAccepted })
  expect(await History.validate(reader(snapshot), stateKey, state)).toBe(true)
  const missingSkip = new Map(snapshot)
  expect(missingSkip.delete(JSON.stringify(skipKey))).toBe(true)
  const noSkip = await History.validate(reader(missingSkip), stateKey, state).then(
    (value) => ({ state: "resolved" as const, value }),
    (error: unknown) => ({ state: "rejected" as const, error }),
  )
  expect(noSkip.state).toBe("rejected")
  for (const key of [
    Keys.requestAttempt(firstPermit.actor.subjectID, retryRequestID, firstPermit.commandSeq),
    Keys.sessionCommand(created.effect.sessionID, retryAccepted.permit.commandSeq),
  ]) {
    const missing = new Map(snapshot)
    expect(missing.delete(JSON.stringify(key))).toBe(true)
    const outcome = await History.validate(reader(missing), stateKey, state).then(
      (value) => ({ state: "resolved" as const, value }),
      (error: unknown) => ({ state: "rejected" as const, error }),
    )
    expect(outcome.state).toBe("rejected")
  }
  const unknownPending = { ...state, pendingAttemptID: firstPermit.attemptID }
  const unresolvedAttempt = new Map(snapshot)
  unresolvedAttempt.set(JSON.stringify(stateKey), unknownPending)
  unresolvedAttempt.set(JSON.stringify(Keys.commandAttempt(firstPermit.attemptID)), {
    ...closedFirst,
    state: "unknown",
    result: undefined,
  })
  const unknown = await History.validate(reader(unresolvedAttempt), stateKey, unknownPending).then(
    (value) => ({ state: "resolved" as const, value }),
    (error: unknown) => ({ state: "rejected" as const, error }),
  )
  expect(unknown.state).toBe("rejected")
  const createKey = Keys.commandAttempt(created.permit.attemptID)
  const create = reader(snapshot).read(Record.CommandAttempt, createKey)
  const pause = reader(snapshot).read(Record.CommandAttempt, Keys.commandAttempt(paused.permit.attemptID))
  const damaged = new Map(snapshot)
  damaged.set(JSON.stringify(createKey), {
    ...create,
    authorization: { ...create.authorization, signature: pause.authorization.signature },
  })
  await expect(History.validate(reader(damaged), stateKey, state)).rejects.toThrow("Closed command history")
  for (const key of [
    Keys.sessionCommand(created.effect.sessionID, created.permit.commandSeq),
    Keys.requestAttempt(created.permit.actor.subjectID, created.permit.requestID, created.permit.commandSeq),
  ]) {
    const missing = new Map(snapshot)
    missing.delete(JSON.stringify(key))
    await expect(History.validate(reader(missing), stateKey, state)).rejects.toThrow()
  }
  const pending = { ...state, pendingAttemptID: paused.permit.attemptID }
  const unresolved = new Map(snapshot)
  unresolved.set(JSON.stringify(stateKey), pending)
  await expect(History.validate(reader(unresolved), stateKey, pending)).rejects.toThrow("Closed command history")
  const behind = { ...state, commandSeq: created.permit.commandSeq }
  const incomplete = new Map(snapshot)
  incomplete.set(JSON.stringify(stateKey), behind)
  await expect(History.validate(reader(incomplete), stateKey, behind)).rejects.toThrow()
  expect(await History.validate(reader(snapshot), stateKey, state)).toBe(true)
  f.interceptFrames(undefined)
})
