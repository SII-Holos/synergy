import { OrganizationCommandProtocol as Command } from "@ericsanchezok/synergy-organization-protocol"
import { OrganizationRecord as Record } from "./storage/records"
import { OrganizationStoragePath as Keys } from "./storage/path"
import { fail } from "./error"
import { isDeepStrictEqual as equal } from "node:util"
import { createHash } from "node:crypto"
import { z } from "zod"
import { OrganizationRuntimeHistory } from "./runtime-history"
import { OrganizationSigningHistory } from "./signing-history"
import { OrganizationHandoffHistory } from "./handoff-history"

export namespace OrganizationCommandHistory {
  function invalid(): never {
    return fail("PROTOCOL_MISMATCH", "Closed command history lacks its original accepted authority")
  }
  function logical(first: Command.Permit, next: Command.Permit) {
    return (
      first.actor.subjectID === next.actor.subjectID &&
      first.requestID === next.requestID &&
      (["orgID", "sessionID", "projectID", "runtimeID", "operation", "payloadHash"] as const).every(
        (key) => first[key] === next[key],
      )
    )
  }
  async function acceptedEffect(accepted: Command.Accepted) {
    const { permit, effect } = accepted
    if (effect.kind === "session" || effect.kind === "inbox" || effect.kind === "decision") return true
    const control: Command.Control =
      effect.operation === "pause"
        ? { operation: "pause" }
        : effect.operation === "continue"
          ? { operation: "continue", pausedSince: effect.pausedSince, controlVersion: effect.controlVersion - 1 }
          : { operation: "cancel", runID: effect.runID, controlVersion: effect.controlVersion - 1 }
    return permit.payloadHash === (await Command.digestControl(Command.controlRequest(permit, control)))
  }
  async function originalPermit(reader: Record.HistoricalReader, permit: Command.Permit) {
    const attempt = reader.read(Record.CommandAttempt, Keys.commandAttempt(permit.attemptID))
    const session = reader.read(Record.SessionDirectory, Keys.session(permit.sessionID))
    const runtime = OrganizationRuntimeHistory.forPermit(reader, permit)
    const signing = OrganizationSigningHistory.identity(reader, permit)
    if (
      !equal(attempt.authorization.permit, permit) ||
      session.sessionID !== permit.sessionID ||
      session.projectID !== permit.projectID ||
      session.orgID !== permit.orgID ||
      runtime.runtimeID !== permit.runtimeID ||
      runtime.orgID !== permit.orgID ||
      runtime.deploymentIncarnation !== permit.deploymentIncarnation ||
      runtime.connectionEpoch < permit.connectionEpoch ||
      reader.read(Record.CommandAttemptIndex, Keys.sessionCommand(permit.sessionID, permit.commandSeq)).attemptID !==
        permit.attemptID ||
      reader.read(
        Record.CommandAttemptIndex,
        Keys.requestAttempt(permit.actor.subjectID, permit.requestID, permit.commandSeq),
      ).attemptID !== permit.attemptID ||
      !(await Command.verify(permit, attempt.authorization.signature, signing.publicKey))
    )
      invalid()
    await OrganizationHandoffHistory.binding(reader, session, permit)
    return attempt
  }
  async function records(reader: Record.HistoricalReader, permit: Command.Permit) {
    const attempt = await originalPermit(reader, permit)
    const request = reader.read(Record.CommandRequest, Keys.commandRequest(permit.actor.subjectID, permit.requestID))
    const state = reader.read(Record.CommandState, Keys.commandState(permit.sessionID))
    if (!logical(request.first, permit) || state.pendingAttemptID || state.commandSeq < permit.commandSeq) invalid()
    const first = await originalPermit(reader, request.first)
    const latest = reader.read(Record.CommandAttempt, Keys.commandAttempt(request.lastAttemptID))
    if (
      !logical(request.first, latest.authorization.permit) ||
      latest.authorization.permit.attemptID !== request.lastAttemptID
    )
      invalid()
    await originalPermit(reader, latest.authorization.permit)
    let firstSequence = Number.POSITIVE_INFINITY,
      lastSequence = 0
    for (const row of reader.entries(Keys.requestAttempt(permit.actor.subjectID, permit.requestID, 0).slice(0, -1))) {
      const index = Record.CommandAttemptIndex.parse(row.value)
      const indexed = reader.read(Record.CommandAttempt, Keys.commandAttempt(index.attemptID)).authorization.permit
      if (
        indexed.attemptID !== index.attemptID ||
        !logical(request.first, indexed) ||
        !equal(row.key, Keys.requestAttempt(permit.actor.subjectID, permit.requestID, indexed.commandSeq))
      )
        invalid()
      firstSequence = Math.min(firstSequence, indexed.commandSeq)
      lastSequence = Math.max(lastSequence, indexed.commandSeq)
    }
    if (
      request.first.commandSeq !== firstSequence ||
      latest.authorization.permit.commandSeq !== lastSequence ||
      permit.commandSeq < firstSequence ||
      permit.commandSeq > lastSequence
    )
      invalid()
    return { attempt, request, first, latest }
  }
  async function skip(
    reader: Record.HistoricalReader,
    permit: Command.Permit,
    receipt: z.infer<typeof Command.SkipReceipt>,
  ) {
    const digest = createHash("sha256").update(JSON.stringify(receipt.permit)).digest("hex")
    const signed = reader.read(Command.SignedSkip, Keys.commandSkip(permit.attemptID, digest))
    const identity = OrganizationSigningHistory.identity(reader, permit)
    if (
      !equal(signed.permit, receipt.permit) ||
      !equal(receipt.permit.command, permit) ||
      receipt.permit.connectionEpoch < permit.connectionEpoch ||
      receipt.receivedAt < receipt.permit.authorizedAt ||
      receipt.receivedAt >= receipt.permit.deadline ||
      !(await Command.verifySkip(signed.permit, signed.signature, identity.publicKey))
    )
      invalid()
  }
  async function outcome(reader: Record.HistoricalReader, attempt: Record.CommandAttempt, accepted?: Command.Accepted) {
    const permit = attempt.authorization.permit
    const result = attempt.result
    if (!result || !equal(result.attempt.permit, permit)) invalid()
    if (result.accepted && (!accepted || !equal(result.accepted, accepted))) invalid()
    if (attempt.state === "accepted") {
      if (
        result.attempt.status !== "accepted" ||
        !accepted ||
        !result.accepted ||
        result.attempt.acceptedAttemptID !== accepted.permit.attemptID ||
        !logical(permit, accepted.permit)
      )
        invalid()
      return
    }
    if (attempt.state !== "rejected" || result.attempt.status === "accepted" || !result.skip) invalid()
    await skip(reader, permit, result.skip)
  }
  export async function accepted(reader: Record.HistoricalReader, permit: Command.Permit) {
    const current = await records(reader, permit)
    const accepted = current.request.accepted
    if (
      !accepted ||
      !equal(accepted.permit, permit) ||
      current.attempt.skip ||
      current.attempt.state !== "accepted" ||
      current.attempt.result?.attempt.status !== "accepted" ||
      current.attempt.result.attempt.acceptedAttemptID !== permit.attemptID ||
      !equal(current.attempt.result.accepted, accepted) ||
      !(await acceptedEffect(accepted))
    )
      invalid()
    await outcome(reader, current.first, accepted)
    await outcome(reader, current.latest, accepted)
    return accepted
  }
  export async function closedAttempt(reader: Record.HistoricalReader, permit: Command.Permit) {
    const current = await records(reader, permit)
    await outcome(reader, current.attempt, current.request.accepted)
    await outcome(reader, current.first, current.request.accepted)
    await outcome(reader, current.latest, current.request.accepted)
    if (current.request.accepted) await accepted(reader, current.request.accepted.permit)
    return current.attempt
  }
  async function validateHistory(reader: Record.HistoricalReader, key: string[], value: unknown) {
    const kind = key[1]
    if (kind === "command-states") {
      const state = Record.CommandState.parse(value),
        sessionID = key[2]
      if (!sessionID || !equal(key, Keys.commandState(sessionID)) || state.pendingAttemptID) invalid()
      const session = reader.read(Record.SessionDirectory, Keys.session(sessionID))
      if (session.sessionID !== sessionID) invalid()
      let sequence = 0
      for (const row of reader.entries(Keys.sessionCommand(sessionID, 0).slice(0, -1))) {
        const index = Record.CommandAttemptIndex.parse(row.value)
        const permit = reader.read(Record.CommandAttempt, Keys.commandAttempt(index.attemptID)).authorization.permit
        if (
          permit.sessionID !== sessionID ||
          permit.commandSeq !== ++sequence ||
          !equal(row.key, Keys.sessionCommand(sessionID, sequence))
        )
          invalid()
        await closedAttempt(reader, permit)
      }
      if (sequence !== state.commandSeq) invalid()
      return true
    }
    let permit: Command.Permit
    if (kind === "command-attempts") {
      permit = Record.CommandAttempt.parse(value).authorization.permit
      if (!equal(key, Keys.commandAttempt(permit.attemptID))) invalid()
    } else if (kind === "command-requests") {
      const request = Record.CommandRequest.parse(value)
      permit = request.first
      if (!equal(key, Keys.commandRequest(permit.actor.subjectID, permit.requestID))) invalid()
    } else if (kind === "session-commands" || kind === "request-attempts") {
      permit = reader.read(
        Record.CommandAttempt,
        Keys.commandAttempt(Record.CommandAttemptIndex.parse(value).attemptID),
      ).authorization.permit
      const expected =
        kind === "session-commands"
          ? Keys.sessionCommand(permit.sessionID, permit.commandSeq)
          : Keys.requestAttempt(permit.actor.subjectID, permit.requestID, permit.commandSeq)
      if (!equal(key, expected)) invalid()
    } else if (kind === "command-skips") {
      const signed = Command.SignedSkip.parse(value)
      permit = signed.permit.command
      const digest = createHash("sha256").update(JSON.stringify(signed.permit)).digest("hex")
      if (!equal(key, Keys.commandSkip(permit.attemptID, digest))) invalid()
      const signing = OrganizationSigningHistory.identity(reader, permit)
      if (!(await Command.verifySkip(signed.permit, signed.signature, signing.publicKey))) invalid()
      const attempt = await closedAttempt(reader, permit)
      if (!attempt.result?.skip) invalid()
      await skip(reader, permit, attempt.result.skip)
      return true
    } else return false
    await closedAttempt(reader, permit)
    return true
  }
  export function validate(reader: Record.HistoricalReader, key: string[], value: unknown) {
    return validateHistory(reader, key, value)
  }
}
