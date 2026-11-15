import { createHash } from "node:crypto"
import { isDeepStrictEqual as same } from "node:util"
import { z } from "zod"
import {
  OrganizationCommandProtocol as Command,
  OrganizationRuntimeProtocol as Runtime,
  OrganizationQueuedSnapshotProtocol as Queued,
  OrganizationSessionProtocol as Sessions,
} from "@ericsanchezok/synergy-organization-protocol"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { SessionTransferCore as Core } from "@ericsanchezok/synergy-harness/session/transfer"
import { SessionInbox } from "@ericsanchezok/synergy-harness/session/inbox"
import { SessionManager } from "@ericsanchezok/synergy-harness/session/manager"
import { MessageV2 } from "@ericsanchezok/synergy-harness/session/message-v2"
import { RolloutLedger } from "@ericsanchezok/synergy-harness/session/rollout/ledger"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { OrganizationExecutionLeases as Leases } from "../execution-leases"
import { OrganizationCommandRecords as Records } from "../command-records"
import { OrganizationIntakePath as Keys } from "../storage/path"

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex")
export namespace OrganizationQueuedCapture {
  async function read<T>(schema: z.ZodType<T>, key: string[]) {
    const [raw] = await Storage.readMany([key])
    return raw === undefined ? undefined : schema.parse(raw)
  }
  async function absent(body: () => Promise<unknown>) {
    try {
      await body()
      return false
    } catch (error) {
      if (error instanceof Storage.NotFoundError) return true
      throw error
    }
  }
  export async function inspect(registration: Runtime.HostedRegistrationRecord) {
    const entries = await Leases.captureEntries()
    const result: Queued.Item[] = []
    const roots = new Map<string, Leases.Entry[]>()
    for (const value of entries) {
      const key = JSON.stringify([value.authority.sessionID, value.authority.rootID])
      const values = roots.get(key) ?? []
      values.push(value)
      roots.set(key, values)
    }
    for (const entry of entries) {
      if (entry.state !== "pending") continue
      const authority = entry.authority
      if (
        entry.uncertainUntil !== undefined ||
        entry.settlement ||
        authority.control ||
        authority.orgID !== registration.orgID ||
        authority.runtimeID !== registration.runtimeID
      )
        return
      const request = await read(
        Records.Request,
        Keys.request(authority.orgID, authority.input.subjectID, authority.input.requestID),
      )
      const parsed = Command.InputAccepted.safeParse(request?.accepted)
      if (!parsed.success || parsed.data.effect.mode !== "task") return
      const accepted = parsed.data,
        permit = accepted.permit
      if (
        !Leases.queuedOriginal(
          roots.get(JSON.stringify([authority.sessionID, authority.rootID])) ?? [],
          entry,
          accepted,
        )
      )
        return
      const { info: session } = await Core.storedInfo({ scopeID: permit.projectID, sessionID: permit.sessionID })
      const binding = Sessions.Binding.safeParse(session.organization)
      if (!binding.success) return
      if (
        session.id !== permit.sessionID ||
        !session.paused ||
        session.time.archived ||
        session.cortex ||
        SessionManager.isRunning(session.id) ||
        session.scope.id !== permit.projectID ||
        binding.data.orgID !== permit.orgID ||
        binding.data.projectID !== permit.projectID ||
        binding.data.driverRuntimeID !== registration.runtimeID ||
        binding.data.bindingEpoch !== permit.bindingEpoch ||
        authority.bindingEpoch !== permit.bindingEpoch ||
        authority.sessionID !== permit.sessionID ||
        authority.projectID !== permit.projectID ||
        authority.deploymentIncarnation !== permit.deploymentIncarnation ||
        authority.runtimeID !== permit.runtimeID ||
        authority.input.subjectID !== permit.actor.subjectID ||
        authority.input.requestID !== permit.requestID ||
        authority.rootID !== accepted.effect.messageID ||
        authority.originGrantID !== permit.provisionalGrantID ||
        authority.input.admissionID !== permit.admissionID ||
        authority.input.attemptID !== permit.attemptID ||
        authority.input.acceptedHash !== Leases.acceptedHash(accepted)
      )
        return
      const attempt = await read(Command.Attempt, Keys.attempt(permit.orgID, permit.sessionID, permit.attemptID))
      const state = await read(Records.State, Keys.state(permit.orgID, permit.sessionID))
      const slot = await read(Records.Slot, Keys.slot(permit.orgID, permit.sessionID, permit.commandSeq))
      const control = await read(Records.ControlState, Keys.control(permit.orgID, permit.sessionID))
      const counter = await read(Records.Counter, Keys.intake(permit.orgID, registration.runtimeID))
      const release = await read(Records.Release, Keys.release(permit.orgID, permit.actor.subjectID, permit.requestID))
      if (
        !same(request?.identity, Records.identity(permit)) ||
        attempt?.status !== "accepted" ||
        !same(attempt.permit, permit) ||
        attempt.acceptedAttemptID !== permit.attemptID ||
        slot?.attemptID !== permit.attemptID ||
        !state ||
        state.orgID !== permit.orgID ||
        state.projectID !== permit.projectID ||
        state.sessionID !== permit.sessionID ||
        state.runtimeID !== permit.runtimeID ||
        state.bindingEpoch !== permit.bindingEpoch ||
        state.commandSeq < permit.commandSeq ||
        !control ||
        !counter ||
        counter.intakeSeq < accepted.intakeSeq ||
        !release ||
        release.subjectID !== permit.actor.subjectID ||
        release.requestID !== permit.requestID ||
        release.state !== "pending" ||
        release.receipt ||
        release.reconciledAt !== undefined ||
        release.rootID !== authority.rootID ||
        release.grantID !== authority.originGrantID ||
        release.sessionID !== permit.sessionID ||
        release.projectID !== permit.projectID ||
        release.orgID !== permit.orgID ||
        release.runtimeID !== permit.runtimeID ||
        release.bindingEpoch !== permit.bindingEpoch ||
        release.admissionID !== permit.admissionID ||
        release.attemptID !== permit.attemptID ||
        release.acceptedAt !== accepted.acceptedAt ||
        !same(release.actor, permit.actor)
      )
        return
      const captured = await ScopeContext.provide({
        scope: session.scope,
        workspace: null,
        fn: async () => {
          const item = await SessionInbox.getStored(session.id, accepted.effect.itemID)
          if (
            item.mode !== "task" ||
            item.status ||
            item.id !== accepted.effect.itemID ||
            item.messageID !== authority.rootID ||
            item.sessionID !== session.id ||
            item.deliveryKey !== `organization:${permit.orgID}:${permit.actor.subjectID}:${permit.requestID}` ||
            !same(item.message?.actor, permit.actor) ||
            (await SessionInbox.hasMaterialized(session.id, item.id)) ||
            !(await absent(() =>
              MessageV2.readInfo({ scopeID: session.scope.id, sessionID: session.id, messageID: authority.rootID }),
            )) ||
            !(await absent(() =>
              RolloutLedger.getRun(
                { kind: "session", scopeID: session.scope.id, sessionID: session.id },
                authority.rootID,
              ),
            ))
          )
            return
          return Queued.Item.parse({
            version: 1,
            sessionID: session.id,
            rootID: authority.rootID,
            grantID: authority.originGrantID,
            acceptedHash: Leases.acceptedHash(accepted),
            entryID: entry.entryID,
            inboxID: item.id,
            inboxRevision: item.revision,
            inboxHash: hash(item),
            pausedSince: session.paused!.since,
            controlVersion: control.controlVersion,
            commandSeq: state.commandSeq,
            intakeSeq: counter.intakeSeq,
          })
        },
      })
      if (!captured) return
      result.push(captured)
    }
    return result
  }
}
