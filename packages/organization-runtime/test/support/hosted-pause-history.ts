import { expect } from "bun:test"
import { z } from "zod"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { OrganizationCommandProtocol as Command } from "@ericsanchezok/synergy-organization-protocol"
import { OrganizationCommandHistory as History } from "../../../organization/src/command-history"
import { OrganizationError } from "../../../organization/src/error"
import { validateSigningMaterial } from "../../../organization/src/signing"
import { OrganizationRecord as Record } from "../../../organization/src/storage/records"
import { OrganizationStoragePath as Keys } from "../../../organization/src/storage/path"
import type { fixture } from "./organization"
import type { completedHostedTask } from "./hosted-task"

type Rows = Map<string, unknown>
function reader(rows: Rows): Record.HistoricalReader {
  return {
    read<T>(schema: z.ZodType<T>, key: string[]) {
      return schema.parse(structuredClone(rows.get(JSON.stringify(key))))
    },
    *entries(prefix) {
      for (const [key, value] of [...rows].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
        const parsed = z.array(z.string()).parse(JSON.parse(key))
        if (prefix.every((part, index) => parsed[index] === part)) yield { key: parsed, value: structuredClone(value) }
      }
    },
  }
}
async function rejected(work: Promise<unknown>) {
  const outcome = await work.then(
    () => ({ kind: "resolved" as const }),
    (error: unknown) => ({ kind: "rejected" as const, error }),
  )
  if (outcome.kind !== "rejected") throw new Error("Corrupt original command history was accepted")
  return outcome.error
}
function protocolMismatch(error: unknown) {
  if (!(error instanceof OrganizationError)) throw error
  expect(error.data.code).toBe("PROTOCOL_MISMATCH")
}

export async function verifyHostedPauseHistory(
  service: Awaited<ReturnType<typeof fixture>>,
  task: Awaited<ReturnType<typeof completedHostedTask>>,
  original: Command.ControlAccepted,
) {
  if (original.permit.operation !== "pause" || original.effect.operation !== "pause")
    throw new Error("Expected the original Hosted pause acknowledgement")
  const calls = task.calls.length
  const repeated = (
    await service.client.orgCommands.control(
      {
        sessionID: task.sessionID,
        orgCommandControlRequest: {
          ...task.target,
          sessionID: task.sessionID,
          requestID: "pause-selected-cloud-already-paused",
          control: { operation: "pause" },
        },
      },
      { headers: service.headers, throwOnError: true },
    )
  ).data
  if (repeated.permit.operation !== "pause" || repeated.effect.operation !== "pause")
    throw new Error("Expected the original repeated Hosted pause acknowledgement")
  expect(repeated.effect.changed).toBe(false)
  const rows = await service.service.maintenance.run(() =>
    Storage.snapshot(async (tx) => {
      const rows: Rows = new Map()
      for await (const entry of tx.exportEntries())
        if (entry.type === "record" && entry.key[0] === "organization") rows.set(JSON.stringify(entry.key), entry.value)
      return rows
    }),
  )
  const canonical = reader(rows)
  expect(await History.accepted(canonical, original.permit)).toEqual(original)
  expect(await History.accepted(canonical, repeated.permit)).toEqual(repeated)
  const stateKey = Keys.commandState(task.sessionID)
  const state = canonical.read(Record.CommandState, stateKey)
  expect(state.commandSeq).toBe(repeated.permit.commandSeq)
  expect(await History.validate(canonical, stateKey, state)).toBe(true)
  expect(await History.retainedMember(canonical, stateKey, state)).toBe(false)
  const attemptKey = Keys.commandAttempt(repeated.permit.attemptID)
  const requestKey = Keys.commandRequest(repeated.permit.actor.subjectID, repeated.permit.requestID)
  const attempt = canonical.read(Record.CommandAttempt, attemptKey)
  const request = canonical.read(Record.CommandRequest, requestKey)
  if (!attempt.result) throw new Error("The actual accepted pause attempt has no result")
  const first = canonical.read(Record.CommandAttempt, Keys.commandAttempt(original.permit.attemptID))
  const signatureChanged = new Map(rows)
  signatureChanged.set(JSON.stringify(attemptKey), {
    ...attempt,
    authorization: { ...attempt.authorization, signature: first.authorization.signature },
  })
  protocolMismatch(await rejected(History.accepted(reader(signatureChanged), repeated.permit)))
  const operationChanged = {
    ...repeated,
    effect: {
      kind: "control",
      operation: "continue",
      controlVersion: repeated.effect.controlVersion,
      pausedSince: repeated.effect.pausedSince,
      itemID: task.accepted.effect.itemID,
      messageID: task.accepted.effect.messageID,
      rootID: task.accepted.effect.messageID,
    },
  }
  const mismatchedOperation = new Map(rows)
  mismatchedOperation.set(JSON.stringify(requestKey), { ...request, accepted: operationChanged })
  mismatchedOperation.set(JSON.stringify(attemptKey), {
    ...attempt,
    result: { ...attempt.result, accepted: operationChanged },
  })
  const operationError = await rejected(History.accepted(reader(mismatchedOperation), repeated.permit))
  if (!(operationError instanceof z.ZodError)) throw operationError
  expect(
    operationError.issues.some(
      (issue) => issue.message === "Accepted control must match its operation and reception window",
    ),
  ).toBe(true)
  const signing = canonical.read(Record.SigningIdentity, Keys.signingIdentity())
  const privateKey = await validateSigningMaterial({
    keyID: signing.keyID,
    publicKey: signing.publicKey,
    pkcs8: signing.pkcs8,
  })
  const foreignPayload = await Command.digestControl(
    Command.controlRequest(
      {
        ...repeated.permit,
        requestID: original.permit.requestID,
      },
      { operation: "pause" },
    ),
  )
  expect(foreignPayload).not.toBe(repeated.permit.payloadHash)
  const foreignPermit = Command.Permit.parse({ ...repeated.permit, payloadHash: foreignPayload })
  const foreignAccepted = Command.ControlAccepted.parse({ ...repeated, permit: foreignPermit })
  const foreignSignature = await Command.sign(foreignPermit, privateKey)
  expect(await Command.verify(foreignPermit, foreignSignature, signing.publicKey)).toBe(true)
  const signedForeignPayload = new Map(rows)
  signedForeignPayload.set(JSON.stringify(requestKey), { ...request, first: foreignPermit, accepted: foreignAccepted })
  signedForeignPayload.set(JSON.stringify(attemptKey), {
    ...attempt,
    authorization: { permit: foreignPermit, signature: foreignSignature },
    result: {
      ...attempt.result,
      attempt: { ...attempt.result.attempt, permit: foreignPermit },
      accepted: foreignAccepted,
    },
  })
  protocolMismatch(await rejected(History.accepted(reader(signedForeignPayload), foreignPermit)))
  const foreignBinding = new Map(rows)
  const sessionKey = Keys.session(task.sessionID)
  const session = canonical.read(Record.SessionDirectory, sessionKey)
  foreignBinding.set(
    JSON.stringify(sessionKey),
    Record.SessionDirectory.parse({
      ...session,
      bindingEpoch: session.bindingEpoch + 1,
      nextBindingEpoch: Math.max(session.nextBindingEpoch, session.bindingEpoch + 2),
    }),
  )
  protocolMismatch(await rejected(History.accepted(reader(foreignBinding), repeated.permit)))
  expect(await History.validate(reader(rows), stateKey, state)).toBe(true)
  expect(task.calls).toHaveLength(calls)
}
