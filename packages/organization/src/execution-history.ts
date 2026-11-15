import {
  OrganizationCommandProtocol as Command,
  OrganizationExecutionProtocol as Execution,
  OrganizationHandoffProtocol as Handoff,
} from "@ericsanchezok/synergy-organization-protocol"
import { isDeepStrictEqual as same } from "node:util"
import { OrganizationRecord as Record } from "./storage/records"
import { OrganizationStoragePath as Keys } from "./storage/path"
import { OrganizationCommandHistory as Commands } from "./command-history"
import { OrganizationHandoffHistory as Handoffs } from "./handoff-history"
import { OrganizationHandoffRecord as HandoffRecord } from "./handoff-record"
import { fail } from "./error"
import { OrganizationExecutionIndex as Index } from "./execution-index"

export namespace OrganizationExecutionHistory {
  function invalid(): never {
    return fail("PROTOCOL_MISMATCH", "Execution history lacks its original closed lineage")
  }
  function root(grant: Execution.Grant) {
    return grant.state === "bound"
      ? grant.rootID
      : (grant.provenance?.rootID ??
          (grant.state === "closed" ? (grant.handoffClosure?.rootID ?? grant.controlClosure?.rootID) : undefined))
  }
  async function reception(reader: Record.HistoricalReader, grant: Execution.Grant) {
    const permit = reader.read(Record.CommandAttempt, Keys.commandAttempt(grant.attemptID)).authorization.permit
    const accepted = Command.InputAccepted.parse(await Commands.accepted(reader, permit))
    if (
      accepted.effect.mode !== "task" ||
      grant.orgID !== permit.orgID ||
      grant.deploymentIncarnation !== permit.deploymentIncarnation ||
      grant.sessionID !== permit.sessionID ||
      grant.projectID !== permit.projectID ||
      grant.admissionID !== permit.admissionID ||
      grant.attemptID !== permit.attemptID ||
      !same(grant.actor, permit.actor) ||
      (grant.provenance ? grant.provenance.originGrantID : grant.grantID) !== permit.provisionalGrantID ||
      (root(grant) !== undefined && root(grant) !== accepted.effect.messageID) ||
      (!grant.provenance && (grant.runtimeID !== permit.runtimeID || grant.bindingEpoch !== permit.bindingEpoch))
    )
      invalid()
    return accepted
  }
  async function lineage(reader: Record.HistoricalReader, value: Execution.Grant, accepted: Command.InputAccepted) {
    let grant = value
    const originID = accepted.permit.provisionalGrantID!
    while (grant.provenance) {
      const provenance = grant.provenance
      const control = Command.ControlAccepted.parse(await Commands.accepted(reader, provenance.control.permit))
      if (
        !same(control, provenance.control) ||
        control.effect.operation !== "continue" ||
        control.effect.rootID !== accepted.effect.messageID ||
        provenance.rootID !== accepted.effect.messageID ||
        provenance.originGrantID !== originID ||
        grant.grantID === provenance.predecessorGrantID ||
        control.permit.orgID !== grant.orgID ||
        control.permit.projectID !== grant.projectID ||
        control.permit.sessionID !== grant.sessionID ||
        control.permit.deploymentIncarnation !== grant.deploymentIncarnation ||
        control.permit.runtimeID !== grant.runtimeID ||
        control.permit.bindingEpoch !== grant.bindingEpoch
      )
        invalid()
      const session = reader.read(Record.SessionDirectory, Keys.session(grant.sessionID))
      const handoff = await Handoffs.terminal(reader, session, provenance.handoffID)
      const cancelled = handoff.phase === "cancelled"
      if (
        control.permit.commandSeq <= handoff.commandSeq ||
        grant.runtimeID !== (cancelled ? handoff.sourceRuntimeID : handoff.targetRuntimeID) ||
        grant.bindingEpoch !== (cancelled ? handoff.fromEpoch : handoff.toEpoch)
      )
        invalid()
      const previous = reader.read(Record.ExecutionGrant, Keys.executionGrant(provenance.predecessorGrantID))
      if (
        previous.grantID !== provenance.predecessorGrantID ||
        previous.orgID !== grant.orgID ||
        previous.sessionID !== grant.sessionID ||
        previous.projectID !== grant.projectID ||
        (root(previous) !== undefined && root(previous) !== accepted.effect.messageID) ||
        previous.deploymentIncarnation !== grant.deploymentIncarnation ||
        previous.admissionID !== grant.admissionID ||
        previous.attemptID !== grant.attemptID ||
        !same(previous.actor, grant.actor) ||
        !same(previous.limits, grant.limits) ||
        (previous.provenance
          ? previous.provenance.originGrantID !== originID ||
            previous.provenance.control.permit.commandSeq >= control.permit.commandSeq
          : previous.grantID !== originID) ||
        !(
          (previous.runtimeID === handoff.sourceRuntimeID && previous.bindingEpoch === handoff.fromEpoch) ||
          (previous.runtimeID === grant.runtimeID && previous.bindingEpoch === grant.bindingEpoch)
        )
      )
        invalid()
      const mapped = Handoffs.continuationSelection(handoff)
      const exact = previous.selectionRevision === grant.selectionRevision && same(previous.selection, grant.selection)
      const consented =
        mapped &&
        mapped.before.revision === previous.selectionRevision &&
        same(mapped.before.selection, previous.selection) &&
        mapped.after.revision === grant.selectionRevision &&
        same(mapped.after.selection, grant.selection)
      if (!exact && !consented) invalid()
      Index.assertControlHistory(reader, grant)
      if (previous.state === "provisional") invalid()
      if (previous.state === "bound") {
        if (previous.retention.state === "held") invalid()
        await releasedGenerations(reader, previous)
        if (previous.retention.state === "control_closed") {
          if (previous.retention.successorGrantID !== grant.grantID) invalid()
        } else await generation(reader, previous, previous.retention.generation)
      } else if (previous.controlClosure) {
        if (
          previous.controlClosure.successorGrantID !== grant.grantID ||
          previous.controlClosure.rootID !== accepted.effect.messageID
        )
          invalid()
      } else if (previous.handoffClosure) await handoffClosure(reader, previous, accepted.effect.messageID)
      else {
        const released = reader.read(Record.ExecutionRelease, Keys.executionRelease(previous.grantID, 0))
        releaseIdentity(previous, released, accepted.effect.messageID, 0)
        if (released.releasedAt !== previous.closedAt) invalid()
      }
      grant = previous
    }
    if (grant.grantID !== originID) invalid()
    await reception(reader, grant)
  }
  async function pointer(
    reader: Record.HistoricalReader,
    grant: Execution.BoundGrant,
    accepted: Command.InputAccepted,
  ) {
    const selected = reader.read(Record.RootGrant, Keys.rootGrant(grant.sessionID, grant.bindingEpoch, grant.rootID))
    if (selected.grantID === grant.grantID) return
    let current = reader.read(Record.ExecutionGrant, Keys.executionGrant(selected.grantID))
    if (
      current.runtimeID !== grant.runtimeID ||
      current.bindingEpoch !== grant.bindingEpoch ||
      current.sessionID !== grant.sessionID ||
      current.orgID !== grant.orgID ||
      root(current) !== grant.rootID
    )
      invalid()
    await lineage(reader, current, accepted)
    while (current.provenance) {
      current = reader.read(Record.ExecutionGrant, Keys.executionGrant(current.provenance.predecessorGrantID))
      if (current.grantID === grant.grantID) return
    }
    invalid()
  }
  function releaseIdentity(
    grant: Execution.Grant,
    receipt: Execution.ReleaseReceipt,
    rootID: string,
    generation: number,
  ) {
    if (
      receipt.orgID !== grant.orgID ||
      receipt.deploymentIncarnation !== grant.deploymentIncarnation ||
      receipt.runtimeID !== grant.runtimeID ||
      receipt.sessionID !== grant.sessionID ||
      receipt.bindingEpoch !== grant.bindingEpoch ||
      receipt.grantID !== grant.grantID ||
      receipt.rootID !== rootID ||
      receipt.generation !== generation
    )
      invalid()
  }
  async function handoffClosure(reader: Record.HistoricalReader, grant: Execution.Grant, rootID: string) {
    const closure =
      grant.state === "bound" && grant.retention.state === "handoff_closed"
        ? grant.retention
        : grant.state === "closed"
          ? grant.handoffClosure
          : undefined
    if (!closure) invalid()
    const generation = grant.state === "bound" ? grant.retention.generation : 0
    const receipt = reader.read(Execution.HandoffCloseReceipt, Keys.executionHandoffClosure(grant.grantID, generation))
    const session = reader.read(Record.SessionDirectory, Keys.session(grant.sessionID))
    const handoff = await Handoffs.terminal(reader, session, closure.handoffID)
    if (
      !handoff.prepared ||
      !handoff.manifestHash ||
      HandoffRecord.bindingFields.some((field) => receipt[field] !== handoff[field]) ||
      receipt.grantID !== grant.grantID ||
      receipt.rootID !== rootID ||
      receipt.generation !== generation ||
      receipt.sourceRuntimeID !== grant.runtimeID ||
      receipt.fromEpoch !== grant.bindingEpoch ||
      receipt.manifestHash !== closure.manifestHash ||
      receipt.manifestHash !== handoff.manifestHash ||
      receipt.preparedHash !== closure.preparedHash ||
      receipt.preparedHash !== (await Handoff.proofHash(handoff.prepared.proof)) ||
      receipt.closedAt !== closure.closedAt ||
      (grant.state === "closed" && receipt.closedAt !== grant.closedAt)
    )
      invalid()
    return receipt
  }
  async function successor(
    reader: Record.HistoricalReader,
    grant: Execution.Grant,
    rootID: string,
    accepted: Command.InputAccepted,
  ) {
    const closure =
      grant.state === "bound" && grant.retention.state === "control_closed"
        ? grant.retention
        : grant.state === "closed"
          ? grant.controlClosure
          : undefined
    if (!closure || closure.successorGrantID === grant.grantID) invalid()
    const next = reader.read(Record.ExecutionGrant, Keys.executionGrant(closure.successorGrantID))
    if (
      next.grantID !== closure.successorGrantID ||
      next.provenance?.predecessorGrantID !== grant.grantID ||
      root(next) !== rootID
    )
      invalid()
    await lineage(reader, next, accepted)
    return closure
  }
  async function releasedGenerations(reader: Record.HistoricalReader, grant: Execution.BoundGrant) {
    const through = grant.retention.generation - (grant.retention.state === "released" ? 0 : 1)
    const seen = new Set<number>()
    for (const row of reader.entries(Keys.executionRelease(grant.grantID, 0).slice(0, -1))) {
      const receipt = Record.ExecutionRelease.parse(row.value)
      if (
        receipt.generation <= 0 ||
        receipt.generation > through ||
        seen.has(receipt.generation) ||
        !same(row.key, Keys.executionRelease(grant.grantID, receipt.generation))
      )
        invalid()
      seen.add(receipt.generation)
      await generation(reader, grant, receipt.generation)
    }
    if (seen.size !== through) invalid()
  }
  export async function generation(reader: Record.HistoricalReader, grant: Execution.BoundGrant, at: number) {
    if (
      !Number.isSafeInteger(at) ||
      at <= 0 ||
      at > grant.retention.generation ||
      grant.retention.state === "held" ||
      !same(grant, reader.read(Record.ExecutionGrant, Keys.executionGrant(grant.grantID)))
    )
      invalid()
    if (at === grant.retention.generation && grant.retention.state !== "released") {
      if (grant.retention.state === "handoff_closed") return handoffClosure(reader, grant, grant.rootID)
      const accepted = await reception(reader, grant)
      return successor(reader, grant, grant.rootID, accepted)
    }
    const receipt = reader.read(Record.ExecutionRelease, Keys.executionRelease(grant.grantID, at))
    releaseIdentity(grant, receipt, grant.rootID, at)
    if (
      at === grant.retention.generation &&
      grant.retention.state === "released" &&
      (receipt.outcome !== grant.retention.outcome || receipt.releasedAt !== grant.retention.releasedAt)
    )
      invalid()
    return receipt
  }
  export async function terminal(reader: Record.HistoricalReader, grantID: string) {
    const grant = reader.read(Record.ExecutionGrant, Keys.executionGrant(grantID))
    if (grant.grantID !== grantID || grant.state === "provisional") invalid()
    if (grant.state === "closed" && !grant.provenance && !grant.controlClosure && !grant.handoffClosure) {
      let release: Execution.ReleaseReceipt | undefined
      for (const row of reader.entries(Keys.executionRelease(grantID, 0).slice(0, -1))) {
        const candidate = Record.ExecutionRelease.parse(row.value)
        if (!same(row.key, Keys.executionRelease(grantID, 0)) || candidate.generation !== 0 || release) invalid()
        release = candidate
      }
      if (!release) {
        const attempt = await Commands.closedAttempt(
          reader,
          reader.read(Record.CommandAttempt, Keys.commandAttempt(grant.attemptID)).authorization.permit,
        )
        const permit = attempt.authorization.permit
        if (
          permit.provisionalGrantID !== grantID ||
          permit.admissionID !== grant.admissionID ||
          permit.orgID !== grant.orgID ||
          permit.deploymentIncarnation !== grant.deploymentIncarnation ||
          permit.runtimeID !== grant.runtimeID ||
          permit.bindingEpoch !== grant.bindingEpoch ||
          permit.sessionID !== grant.sessionID ||
          permit.projectID !== grant.projectID ||
          !same(permit.actor, grant.actor) ||
          attempt.result?.accepted?.permit.attemptID === permit.attemptID
        )
          invalid()
        return { grant, accepted: undefined, rootID: undefined, kind: "unreceived" as const }
      }
      const accepted = await reception(reader, grant)
      releaseIdentity(grant, release, accepted.effect.messageID, 0)
      if (release.releasedAt !== grant.closedAt) invalid()
      return { grant, accepted, rootID: accepted.effect.messageID, kind: "released" as const }
    }
    const accepted = await reception(reader, grant)
    await lineage(reader, grant, accepted)
    const rootID = accepted.effect.messageID
    if (grant.state === "bound") {
      await pointer(reader, grant, accepted)
      await releasedGenerations(reader, grant)
      if (grant.retention.state !== "released") await generation(reader, grant, grant.retention.generation)
    } else if (grant.handoffClosure) await handoffClosure(reader, grant, rootID)
    else if (grant.controlClosure) await successor(reader, grant, rootID, accepted)
    else {
      const receipt = reader.read(Record.ExecutionRelease, Keys.executionRelease(grantID, 0))
      releaseIdentity(grant, receipt, rootID, 0)
      if (receipt.releasedAt !== grant.closedAt) invalid()
    }
    return { grant, accepted, rootID, kind: "closed" as const }
  }
  export async function record(
    reader: Record.HistoricalReader,
    key: string[],
    value: unknown,
  ): Promise<Awaited<ReturnType<typeof terminal>> | false> {
    const kind = key[1]
    const indexed = Index.historicalControl(reader, key, value)
    if (indexed) return terminal(reader, indexed)
    if (
      key[0] !== "organization" ||
      !["execution-grants", "execution-releases", "root-grants", "execution-handoff-closures"].includes(kind ?? "")
    )
      return false
    const grantID =
      kind === "execution-grants"
        ? Record.ExecutionGrant.parse(value).grantID
        : kind === "execution-releases"
          ? Record.ExecutionRelease.parse(value).grantID
          : kind === "execution-handoff-closures"
            ? Execution.HandoffCloseReceipt.parse(value).grantID
            : Record.RootGrant.parse(value).grantID
    const current = await terminal(reader, grantID)
    let expected: string[]
    if (kind === "execution-grants") expected = Keys.executionGrant(grantID)
    else if (kind === "execution-releases") {
      const receipt = Record.ExecutionRelease.parse(value)
      expected = Keys.executionRelease(grantID, receipt.generation)
      const canonical =
        current.grant.state === "bound"
          ? Execution.ReleaseReceipt.parse(await generation(reader, current.grant, receipt.generation))
          : reader.read(Record.ExecutionRelease, Keys.executionRelease(grantID, 0))
      if (current.grant.state !== "bound" && receipt.generation !== 0) invalid()
      if (!same(receipt, canonical)) invalid()
    } else if (kind === "execution-handoff-closures") {
      const receipt = Execution.HandoffCloseReceipt.parse(value)
      if (!current.rootID || !same(receipt, await handoffClosure(reader, current.grant, current.rootID))) invalid()
      expected = Keys.executionHandoffClosure(grantID, receipt.generation)
    } else {
      if (!current.rootID || (current.grant.state !== "bound" && !current.grant.provenance)) invalid()
      expected = Keys.rootGrant(current.grant.sessionID, current.grant.bindingEpoch, current.rootID)
    }
    if (!same(key, expected)) invalid()
    return current
  }
  export async function bound(reader: Record.HistoricalReader, grantID: string) {
    const current = await terminal(reader, grantID)
    if (current.grant.state !== "bound") invalid()
    return current.grant
  }
}
