import { z } from "zod"
import {
  OrganizationCommandProtocol as Command,
  OrganizationIdentity as Identity,
} from "@ericsanchezok/synergy-organization-protocol"
import { Persist } from "@/utils/persist"

const Summary = Command.DecisionRequest.omit({ schemaVersion: true, decision: true }).extend({
  nativeID: Identity.ID,
  kind: z.enum(["question", "permission"]),
  sourceSessionID: Identity.ID,
  requestHash: z.string().regex(/^[a-f0-9]{64}$/),
})
const Entry = z.discriminatedUnion("sensitive", [
  Summary.extend({ sensitive: z.literal(true) }).strict(),
  Summary.extend({ sensitive: z.literal(false), command: Command.DecisionRequest }).strict(),
])
const Entries = z.array(Entry).max(128)
export type OrganizationDecisionCommand = z.infer<typeof Summary> & {
  sensitive: boolean
  command?: Command.DecisionRequest
}
export function confirmOrganizationDecision(
  entry: OrganizationDecisionCommand,
  value: unknown,
  accountID: string,
  bindingEpoch: number,
) {
  const accepted = Command.DecisionAccepted.parse(value)
  const permit = accepted.permit
  if (
    permit.requestID !== entry.requestID ||
    permit.payloadHash !== entry.requestHash ||
    permit.orgID !== entry.orgID ||
    permit.projectID !== entry.projectID ||
    permit.runtimeID !== entry.runtimeID ||
    permit.sessionID !== entry.sessionID ||
    permit.bindingEpoch !== bindingEpoch ||
    permit.actor.subjectID !== accountID ||
    accepted.effect.requestID !== entry.nativeID ||
    accepted.effect.sourceSessionID !== entry.sourceSessionID ||
    (accepted.effect.decision.status !== "expired" && accepted.effect.decision.winner.outcome.kind !== entry.kind)
  )
    throw new Error("The original decision receipt could not be confirmed")
  return accepted
}
type CommandStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">

export function createOrganizationDecisionCommands(storage: CommandStorage, connection: string, owner: string) {
  const target = Persist.connection(connection, `organization-decisions:${owner}`)
  const key = `${target.storage}:${target.key}`
  const volatile = new Map<string, Command.DecisionRequest>()
  function entries() {
    const value = storage.getItem(key)
    return value ? Entries.parse(JSON.parse(value)) : []
  }
  function pending(): OrganizationDecisionCommand[] {
    return entries().map((entry) => ({
      ...entry,
      command: entry.sensitive ? volatile.get(entry.requestHash) : entry.command,
    }))
  }
  return {
    pending,
    release(nativeID: string) {
      for (const entry of entries()) if (entry.nativeID === nativeID) volatile.delete(entry.requestHash)
    },
    async begin(value: Command.DecisionRequest, sensitive: boolean): Promise<OrganizationDecisionCommand> {
      const command = Command.DecisionRequest.parse(value)
      if (new TextEncoder().encode(JSON.stringify(command)).byteLength > 60_000)
        throw Object.assign(new Error("The answer is too long to submit"), { code: "DECISION_TOO_LARGE" })
      const requestHash = await Command.digestDecision(command)
      const previous = pending().find((entry) => entry.nativeID === command.decision.requestID)
      if (previous) {
        if (previous.requestHash !== requestHash || previous.sensitive !== sensitive)
          throw new Error("Check the original decision before submitting another response")
        return previous
      }
      const entry = Entry.parse({
        orgID: command.orgID,
        requestID: command.requestID,
        sessionID: command.sessionID,
        projectID: command.projectID,
        runtimeID: command.runtimeID,
        nativeID: command.decision.requestID,
        kind: command.decision.kind,
        sourceSessionID: command.decision.sourceSessionID ?? command.sessionID,
        requestHash,
        sensitive,
        ...(!sensitive ? { command } : {}),
      })
      storage.setItem(key, JSON.stringify(Entries.parse([...entries(), entry])))
      if (sensitive) volatile.set(requestHash, command)
      return { ...entry, command }
    },
    clear(nativeID: string, requestID: string) {
      const previous = entries()
      const retained = previous.filter((entry) => entry.nativeID !== nativeID || entry.requestID !== requestID)
      if (retained.length === previous.length) return
      if (retained.length) storage.setItem(key, JSON.stringify(retained))
      else storage.removeItem(key)
      for (const entry of previous)
        if (entry.nativeID === nativeID && entry.requestID === requestID) volatile.delete(entry.requestHash)
    },
  }
}
