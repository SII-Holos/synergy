import { OrganizationCommandProtocol as Command } from "@ericsanchezok/synergy-organization-protocol"
import { OrganizationRecord as Record } from "./storage/records"
import { OrganizationStoragePath as Keys } from "./storage/path"
import { fail } from "./error"
import { isDeepStrictEqual as equal } from "node:util"
import { OrganizationRuntimeHistory } from "./runtime-history"

export namespace OrganizationCommandHistory {
  export async function accepted(reader: Record.HistoricalReader, permit: Command.Permit) {
    const attempt = reader.read(Record.CommandAttempt, Keys.commandAttempt(permit.attemptID))
    const request = reader.read(Record.CommandRequest, Keys.commandRequest(permit.actor.subjectID, permit.requestID))
    const state = reader.read(Record.CommandState, Keys.commandState(permit.sessionID))
    const session = reader.read(Record.SessionDirectory, Keys.session(permit.sessionID))
    const runtime = reader.read(Record.RuntimeRegistration, Keys.runtime(permit.runtimeID))
    const signing = reader.read(Record.SigningIdentity, Keys.signingIdentity())
    const accepted = request.accepted
    if (
      !accepted ||
      attempt.state !== "accepted" ||
      attempt.skip ||
      attempt.result?.attempt.status !== "accepted" ||
      attempt.result.attempt.acceptedAttemptID !== permit.attemptID ||
      !equal(attempt.authorization.permit, permit) ||
      !equal(attempt.result.accepted, accepted) ||
      !equal(accepted.permit, permit) ||
      !equal(request.first, permit) ||
      request.lastAttemptID !== permit.attemptID ||
      state.pendingAttemptID ||
      state.commandSeq < permit.commandSeq ||
      reader.read(Record.CommandAttemptIndex, Keys.sessionCommand(permit.sessionID, permit.commandSeq)).attemptID !==
        permit.attemptID ||
      reader.read(
        Record.CommandAttemptIndex,
        Keys.requestAttempt(permit.actor.subjectID, permit.requestID, permit.commandSeq),
      ).attemptID !== permit.attemptID ||
      session.sessionID !== permit.sessionID ||
      session.projectID !== permit.projectID ||
      session.orgID !== permit.orgID ||
      session.driverRuntimeID !== permit.runtimeID ||
      session.bindingEpoch !== permit.bindingEpoch ||
      runtime.runtimeID !== permit.runtimeID ||
      runtime.runtimeKind !== "hosted" ||
      runtime.orgID !== permit.orgID ||
      runtime.deploymentIncarnation !== permit.deploymentIncarnation ||
      signing.orgID !== permit.orgID ||
      signing.deploymentIncarnation !== permit.deploymentIncarnation ||
      signing.keyID !== permit.keyID ||
      !(await Command.verify(permit, attempt.authorization.signature, signing.publicKey)) ||
      (accepted.effect.kind !== "session" && (accepted.effect.kind !== "inbox" || accepted.effect.mode !== "task"))
    )
      fail("PROTOCOL_MISMATCH", "Closed command history lacks its original accepted authority")
    return accepted
  }
  async function acceptedMemberMetadata(reader: Record.HistoricalReader, permit: Command.Permit) {
    const attempt = reader.read(Record.CommandAttempt, Keys.commandAttempt(permit.attemptID))
    const request = reader.read(Record.CommandRequest, Keys.commandRequest(permit.actor.subjectID, permit.requestID))
    const state = reader.read(Record.CommandState, Keys.commandState(permit.sessionID))
    const session = reader.read(Record.SessionDirectory, Keys.session(permit.sessionID))
    const runtime = OrganizationRuntimeHistory.member(reader, permit.runtimeID)
    const signing = reader.read(Record.SigningIdentity, Keys.signingIdentity())
    const accepted = request.accepted
    if (
      !accepted ||
      attempt.state !== "accepted" ||
      attempt.skip ||
      attempt.result?.attempt.status !== "accepted" ||
      attempt.result.attempt.acceptedAttemptID !== permit.attemptID ||
      !equal(attempt.authorization.permit, permit) ||
      !equal(attempt.result.accepted, accepted) ||
      !equal(accepted.permit, permit) ||
      !equal(request.first, permit) ||
      request.lastAttemptID !== permit.attemptID ||
      state.pendingAttemptID ||
      state.commandSeq < permit.commandSeq ||
      reader.read(Record.CommandAttemptIndex, Keys.sessionCommand(permit.sessionID, permit.commandSeq)).attemptID !==
        permit.attemptID ||
      reader.read(
        Record.CommandAttemptIndex,
        Keys.requestAttempt(permit.actor.subjectID, permit.requestID, permit.commandSeq),
      ).attemptID !== permit.attemptID ||
      session.sessionID !== permit.sessionID ||
      session.projectID !== permit.projectID ||
      session.orgID !== permit.orgID ||
      session.bindingEpoch < permit.bindingEpoch ||
      session.handoffID ||
      session.retainedExecutionGrants !== 0 ||
      runtime.orgID !== permit.orgID ||
      runtime.deploymentIncarnation !== permit.deploymentIncarnation ||
      runtime.connectionEpoch < permit.connectionEpoch ||
      signing.orgID !== permit.orgID ||
      signing.deploymentIncarnation !== permit.deploymentIncarnation ||
      signing.keyID !== permit.keyID ||
      !(await Command.verify(permit, attempt.authorization.signature, signing.publicKey)) ||
      !(
        (permit.operation === "create" && accepted.effect.kind === "session") ||
        (permit.operation === "pause" && accepted.effect.kind === "control" && accepted.effect.operation === "pause")
      )
    )
      fail("PROTOCOL_MISMATCH", "Retained Member command metadata lacks its original acknowledged authority")
    return accepted
  }
  async function validateHistory(
    reader: Record.HistoricalReader,
    key: string[],
    value: unknown,
    readAcceptance: (reader: Record.HistoricalReader, permit: Command.Permit) => Promise<Command.Accepted>,
  ) {
    const kind = key[1]
    if (kind === "command-states") {
      const state = Record.CommandState.parse(value)
      const sessionID = key[2]
      if (!sessionID || !equal(key, Keys.commandState(sessionID)) || state.pendingAttemptID)
        fail("PROTOCOL_MISMATCH", "Closed command history has a pending command")
      const session = reader.read(Record.SessionDirectory, Keys.session(sessionID))
      if (session.sessionID !== sessionID) fail("PROTOCOL_MISMATCH", "Closed command history has another Session")
      let sequence = 0
      for (const row of reader.entries(Keys.sessionCommand(sessionID, 0).slice(0, -1))) {
        const index = Record.CommandAttemptIndex.parse(row.value)
        const permit = reader.read(Record.CommandAttempt, Keys.commandAttempt(index.attemptID)).authorization.permit
        if (
          permit.sessionID !== sessionID ||
          permit.commandSeq !== ++sequence ||
          !equal(row.key, Keys.sessionCommand(sessionID, sequence))
        )
          fail("PROTOCOL_MISMATCH", "Closed command history has an incomplete watermark")
        await readAcceptance(reader, permit)
      }
      if (sequence !== state.commandSeq) fail("PROTOCOL_MISMATCH", "Closed command history has an incomplete watermark")
      return true
    }
    let permit: Command.Permit
    if (kind === "command-attempts") {
      permit = Record.CommandAttempt.parse(value).authorization.permit
      if (!equal(key, Keys.commandAttempt(permit.attemptID)))
        fail("PROTOCOL_MISMATCH", "Closed command history has another attempt key")
    } else if (kind === "command-requests") {
      permit = Record.CommandRequest.parse(value).first
      if (!equal(key, Keys.commandRequest(permit.actor.subjectID, permit.requestID)))
        fail("PROTOCOL_MISMATCH", "Closed command history has another request key")
    } else if (kind === "session-commands" || kind === "request-attempts") {
      permit = reader.read(
        Record.CommandAttempt,
        Keys.commandAttempt(Record.CommandAttemptIndex.parse(value).attemptID),
      ).authorization.permit
      const expected =
        kind === "session-commands"
          ? Keys.sessionCommand(permit.sessionID, permit.commandSeq)
          : Keys.requestAttempt(permit.actor.subjectID, permit.requestID, permit.commandSeq)
      if (!equal(key, expected)) fail("PROTOCOL_MISMATCH", "Closed command history has another index key")
    } else return false
    await readAcceptance(reader, permit)
    return true
  }
  export function validate(reader: Record.HistoricalReader, key: string[], value: unknown) {
    return validateHistory(reader, key, value, accepted)
  }
  export async function retainedMember(reader: Record.HistoricalReader, key: string[], value: unknown) {
    if (key[0] !== "organization") return false
    let runtimeID: string
    if (key[1] === "command-states") {
      const sessionID = key[2]
      if (!sessionID) fail("PROTOCOL_MISMATCH", "Retained Member command state has another address")
      runtimeID = reader.read(Record.SessionDirectory, Keys.session(sessionID)).driverRuntimeID
    } else {
      let permit: Command.Permit
      if (key[1] === "command-attempts") permit = Record.CommandAttempt.parse(value).authorization.permit
      else if (key[1] === "command-requests") permit = Record.CommandRequest.parse(value).first
      else if (key[1] === "session-commands" || key[1] === "request-attempts")
        permit = reader.read(
          Record.CommandAttempt,
          Keys.commandAttempt(Record.CommandAttemptIndex.parse(value).attemptID),
        ).authorization.permit
      else return false
      runtimeID = permit.runtimeID
    }
    if (reader.read(Record.RuntimeRegistration, Keys.runtime(runtimeID)).runtimeKind !== "member") return false
    return validateHistory(reader, key, value, acceptedMemberMetadata)
  }
}
