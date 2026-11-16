import { z } from "zod"
import {
  OrganizationCommandProtocol as Command,
  OrganizationProtocol as Protocol,
  OrganizationIdentity as Identity,
} from "@ericsanchezok/synergy-organization-protocol"

export const DecisionOutboxOwner = z.strictObject({
  connectionKey: z.string().min(1),
  accountID: Identity.ID,
  projectID: Identity.ID,
  rootSessionID: Identity.ID,
  sourceSessionID: Identity.ID,
})
export type DecisionOutboxOwner = z.infer<typeof DecisionOutboxOwner>
export const DecisionOutboxRecord = DecisionOutboxOwner.extend({
  version: z.literal(1),
  requestID: Identity.ID,
  nativeID: Identity.ID,
  kind: z.enum(["question", "permission"]),
  orgID: Identity.ID,
  runtimeID: Identity.ID,
  bindingEpoch: Protocol.Epoch,
  requestHash: Protocol.Digest,
  sensitive: z.boolean(),
  createdAt: z.number().int().nonnegative().safe(),
}).strict()
export type DecisionOutboxRecord = z.infer<typeof DecisionOutboxRecord>
export async function prepareDecisionOutboxRecord(input: {
  owner: DecisionOutboxOwner
  binding: Protocol.SessionBinding
  command: Command.DecisionRequest
  sensitive: boolean
  createdAt: number
}) {
  const owner = DecisionOutboxOwner.parse(input.owner)
  const binding = Protocol.SessionBinding.parse(input.binding)
  const command = Command.DecisionRequest.parse(input.command)
  if (
    command.orgID !== binding.orgID ||
    command.projectID !== binding.projectID ||
    command.runtimeID !== binding.driverRuntimeID ||
    command.projectID !== owner.projectID ||
    command.sessionID !== owner.rootSessionID ||
    (command.decision.sourceSessionID ?? command.sessionID) !== owner.sourceSessionID
  )
    throw new Error("The response does not belong to the captured conversation")
  return DecisionOutboxRecord.parse({
    ...owner,
    version: 1,
    requestID: command.requestID,
    nativeID: command.decision.requestID,
    kind: command.decision.kind,
    orgID: command.orgID,
    runtimeID: command.runtimeID,
    bindingEpoch: binding.bindingEpoch,
    requestHash: await Command.digestDecision(command),
    sensitive: input.sensitive,
    createdAt: input.createdAt,
  })
}
export async function decisionOutboxCommandMatches(record: DecisionOutboxRecord, value: unknown): Promise<boolean> {
  const parsed = Command.DecisionRequest.safeParse(value)
  if (!parsed.success) return false
  const command = parsed.data
  return (
    command.requestID === record.requestID &&
    command.orgID === record.orgID &&
    command.projectID === record.projectID &&
    command.runtimeID === record.runtimeID &&
    command.sessionID === record.rootSessionID &&
    command.decision.kind === record.kind &&
    command.decision.requestID === record.nativeID &&
    (command.decision.sourceSessionID ?? command.sessionID) === record.sourceSessionID &&
    (await Command.digestDecision(command)) === record.requestHash
  )
}
export function decisionOutboxOwnerKey(owner: DecisionOutboxOwner): [string, string, string, string, string] {
  return [owner.connectionKey, owner.accountID, owner.projectID, owner.rootSessionID, owner.sourceSessionID]
}
export function confirmDecisionOutboxReceipt(record: DecisionOutboxRecord, value: unknown) {
  const accepted = Command.DecisionAccepted.parse(value)
  const permit = accepted.permit
  if (
    permit.requestID !== record.requestID ||
    permit.payloadHash !== record.requestHash ||
    permit.orgID !== record.orgID ||
    permit.projectID !== record.projectID ||
    permit.runtimeID !== record.runtimeID ||
    permit.sessionID !== record.rootSessionID ||
    permit.bindingEpoch !== record.bindingEpoch ||
    permit.actor.subjectID !== record.accountID ||
    accepted.effect.requestID !== record.nativeID ||
    accepted.effect.sourceSessionID !== record.sourceSessionID ||
    (accepted.effect.decision.status !== "expired" && accepted.effect.decision.winner.outcome.kind !== record.kind)
  )
    throw new Error("The original response receipt could not be confirmed")
  return accepted
}
