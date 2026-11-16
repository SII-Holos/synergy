import { z } from "zod"
import { createHash } from "node:crypto"
import { isDeepStrictEqual as same } from "node:util"
import { NamespaceRetirement } from "@ericsanchezok/synergy-harness/lifecycle/namespace-retirement"
import {
  OrganizationQueuedSnapshotProtocol as Queued,
  OrganizationCommandProtocol as Command,
} from "@ericsanchezok/synergy-organization-protocol"
import { OrganizationRecord as Record } from "../storage/records"
import { OrganizationStoragePath as Keys } from "../storage/path"
import { OrganizationCommandHistory as Commands } from "../command-history"
import { OrganizationExecutionIndex as Index } from "../execution-index"
import { OrganizationInstallationReference } from "./installation-reference"
import { fail } from "../error"

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex")
export namespace OrganizationQueuedExecutionHistory {
  export type Source = {
    source: NamespaceRetirement.Reference
    proof: Queued.SignedProof
    items: readonly Queued.Item[]
  }
  export type Facts = { items: ReadonlyMap<string, Queued.Item>; sources: ReadonlyMap<string, Source> }
  function invalid(): never {
    return fail("PROTOCOL_MISMATCH", "Queued history lacks its original frozen native snapshot owner")
  }
  export async function inspect(
    reader: Record.HistoricalReader,
    input: readonly Source[],
    target: z.infer<typeof OrganizationInstallationReference>,
    originals: ReadonlyMap<string, { reference: NamespaceRetirement.Reference }>,
    publication: boolean,
    assert: () => void,
  ): Promise<Facts> {
    const result = new Map<string, Queued.Item>(),
      runtimes = new Map<string, Source>()
    const controls = new Map<string, number>()
    for (const row of reader.entries(["organization", "command-attempts"])) {
      const attempt = Record.CommandAttempt.parse(row.value)
      const accepted = attempt.result?.accepted
      if (!accepted || accepted.effect.kind !== "control") continue
      const id = accepted.permit.sessionID
      controls.set(id, Math.max(controls.get(id) ?? 0, accepted.effect.controlVersion))
    }
    const captured = input.map((value) => ({
      source: NamespaceRetirement.Reference.parse(structuredClone(value.source)),
      proof: Queued.SignedProof.parse(structuredClone(value.proof)),
      items: value.items.map((item) => Queued.Item.parse(item)),
    }))
    for (const value of captured) {
      assert()
      const source = value.source
      const signed = value.proof
      const items = value.items
      const identity = source.namespace.identity
      if (
        source.namespace.owner !== "organization-runtime" ||
        identity.kind !== "hosted" ||
        source.maintenance.phase !== "frozen" ||
        source.maintenance.purpose !== "organization-backup" ||
        source.target.installationID !== target.installationID ||
        source.target.incarnation !== target.incarnation ||
        hash(source.target.request) !== target.requestHash ||
        source.target.request.restoreID !== target.restoreID ||
        source.target.request.sourceHash !== target.sourceHash ||
        runtimes.has(identity.runtimeID)
      )
        invalid()
      const runtime = reader.read(Record.RuntimeRegistration, Keys.runtime(identity.runtimeID))
      const proof = signed.proof
      if (
        runtime.runtimeKind !== "hosted" ||
        runtime.runtimeID !== identity.runtimeID ||
        runtime.publicKey !== identity.publicKey ||
        runtime.orgID !== identity.orgID ||
        runtime.deploymentIncarnation !== identity.deploymentIncarnation ||
        proof.orgID !== identity.orgID ||
        proof.deploymentIncarnation !== identity.deploymentIncarnation ||
        proof.runtimeID !== identity.runtimeID ||
        proof.namespaceHash !== hash(source.archive) ||
        proof.maintenanceID !== source.maintenance.maintenanceID ||
        proof.count !== items.length ||
        proof.itemsHash !== (await Queued.digest(items)) ||
        !(await Queued.verify(proof, signed.signature, identity.publicKey))
      )
        invalid()
      const original = originals.get(identity.runtimeID)
      if (publication && (!original || hash(original.reference) !== hash(source))) invalid()
      runtimes.set(identity.runtimeID, { source, proof: signed, items })
      for (const item of items) {
        const grant = reader.read(Record.ExecutionGrant, Keys.executionGrant(item.grantID))
        const permit = reader.read(Record.CommandAttempt, Keys.commandAttempt(grant.attemptID)).authorization.permit
        const accepted = Command.InputAccepted.parse(await Commands.accepted(reader, permit))
        const session = reader.read(Record.SessionDirectory, Keys.session(item.sessionID))
        const state = reader.read(Record.CommandState, Keys.commandState(item.sessionID))
        if (
          result.has(item.grantID) ||
          grant.state !== "provisional" ||
          grant.provenance ||
          grant.grantID !== item.grantID ||
          grant.grantID !== permit.provisionalGrantID ||
          grant.orgID !== proof.orgID ||
          grant.sessionID !== item.sessionID ||
          grant.projectID !== permit.projectID ||
          grant.runtimeID !== proof.runtimeID ||
          grant.runtimeID !== permit.runtimeID ||
          grant.bindingEpoch !== permit.bindingEpoch ||
          grant.deploymentIncarnation !== permit.deploymentIncarnation ||
          grant.admissionID !== permit.admissionID ||
          grant.attemptID !== permit.attemptID ||
          !same(grant.actor, permit.actor) ||
          hash(accepted) !== item.acceptedHash ||
          accepted.effect.mode !== "task" ||
          accepted.effect.itemID !== item.inboxID ||
          accepted.effect.messageID !== item.rootID ||
          session.sessionID !== item.sessionID ||
          session.orgID !== proof.orgID ||
          session.handoffID ||
          session.driverRuntimeID !== proof.runtimeID ||
          session.bindingEpoch !== grant.bindingEpoch ||
          state.pendingAttemptID ||
          state.commandSeq !== item.commandSeq ||
          accepted.intakeSeq > item.intakeSeq ||
          (controls.get(item.sessionID) ?? 0) !== item.controlVersion
        )
          invalid()
        const contract = reader.read(Record.SessionResources, Keys.sessionResources(item.sessionID))
        if (contract.revision !== grant.selectionRevision || !same(contract.selection, grant.selection)) invalid()
        for (const row of reader.entries(Keys.rootGrant(item.sessionID, grant.bindingEpoch, item.rootID).slice(0, -1)))
          if (same(row.key, Keys.rootGrant(item.sessionID, grant.bindingEpoch, item.rootID))) invalid()
        if ([...reader.entries(Keys.gatewayCall(grant.grantID, "").slice(0, -1))].length) invalid()
        result.set(item.grantID, item)
      }
    }
    const sessions = new Set([...result.values()].map((item) => item.sessionID))
    for (const sessionID of sessions) {
      const session = reader.read(Record.SessionDirectory, Keys.session(sessionID))
      assertSession(reader, session, { items: result, sources: runtimes })
    }
    assert()
    return { items: result, sources: runtimes }
  }
  export function assertSession(reader: Record.HistoricalReader, session: Record.SessionDirectory, facts: Facts) {
    const selected = new Set(
      [...facts.items.values()].filter((item) => item.sessionID === session.sessionID).map((item) => item.grantID),
    )
    if (session.retainedExecutionGrants !== selected.size) invalid()
    Index.assertRetainedHistory(reader, session, selected)
  }
  export function record(reader: Record.HistoricalReader, key: string[], value: unknown, facts: Facts) {
    if (key[0] !== "organization") return false
    if (key[1] === "execution-grants") {
      const grant = Record.ExecutionGrant.parse(value),
        item = facts.items.get(grant.grantID)
      if (!item) return false
      if (
        grant.state !== "provisional" ||
        !same(key, Keys.executionGrant(item.grantID)) ||
        !same(grant, reader.read(Record.ExecutionGrant, key))
      )
        invalid()
      return grant
    }
    if (key[1] === "retained-execution-grants") {
      const grant = Index.retainedHistoryEntry(reader, key, value)
      if (!facts.items.has(grant.grantID)) invalid()
      const session = reader.read(Record.SessionDirectory, Keys.session(grant.sessionID))
      assertSession(reader, session, facts)
      return grant
    }
    return false
  }
}
