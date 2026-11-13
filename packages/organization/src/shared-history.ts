import { OrganizationSyncProtocol as Sync } from "@ericsanchezok/synergy-organization-protocol"
import { digest } from "./auth/secret"
import { fail } from "./error"
import { OrganizationRecord as Record } from "./storage/records"
import { OrganizationStoragePath as Keys } from "./storage/path"
import { OrganizationSharedProjection as Projection } from "./shared-projection"
import { OrganizationSharedTasks as Tasks } from "./shared-tasks"
import { OrganizationSharedBlobs as Blobs } from "./shared-blob"

export namespace OrganizationSharedHistory {
  export interface Source extends Record.HistoricalReader {
    accept(key: string[]): void
    first(group: string[], value: unknown): boolean
    binary(key: string[], maximum: number): Promise<Uint8Array>
  }
  const equal = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right)
  function invalid(message: string): never {
    fail("PROTOCOL_MISMATCH", "Historical shared transcript " + message)
  }
  function sourceSessionID(event: Sync.Event, root: string) {
    if (event.type === "session") return event.session.sessionID
    return event.sessionID ?? root
  }
  export async function history(source: Source) {
    transcripts(source)
    await Blobs.history(source)
  }
  export function transcripts(source: Source) {
    for (const row of source.entries(["organization", "shared-state"])) {
      const state = Record.SharedState.parse(row.value)
      if (!equal(row.key, Keys.sharedState(state.sessionID))) invalid("has another state address")
      const session = source.read(Record.SessionDirectory, Keys.session(state.sessionID))
      if (
        session.sessionID !== state.sessionID ||
        session.shareState !== "shared" ||
        state.shareGeneration !== session.shareGeneration ||
        state.bindingEpoch !== session.bindingEpoch ||
        state.syncState !== "synced" ||
        state.nextSeq < 1
      )
        invalid("requires its current synchronized generation")
      const generation = state.shareGeneration
      if (!source.first(["shared-transcript", session.sessionID, String(generation)], state)) continue
      const reference = (content: Sync.Content | undefined) => {
        if (content?.kind !== "blob") return
        Blobs.historicalReference(source, {
          sessionID: session.sessionID,
          shareGeneration: generation,
          hash: content.hash,
          bytes: content.bytes,
        })
      }
      const projection = (id: string) => {
        const key = Keys.sharedSession(session.sessionID, generation, id)
        const stored = source.read(Record.SharedSession, key)
        const value = stored.projection
        if (
          stored.rootSessionID !== session.sessionID ||
          value.sessionID !== id ||
          value.projectID !== session.projectID ||
          value.creatorID !== session.creatorID ||
          value.driverRuntimeID !== session.driverRuntimeID ||
          value.bindingEpoch !== session.bindingEpoch ||
          value.shareGeneration !== generation
        )
          invalid("has another root or Session binding")
        return value
      }
      const lineage = (id: string) => {
        const visited = new Set<string>()
        let current = id
        for (;;) {
          if (visited.has(current)) invalid("contains a cyclic Cortex lineage")
          visited.add(current)
          const value = projection(current)
          if (current === session.sessionID) {
            if (value.rootSessionID !== undefined || value.parentSessionID !== undefined || value.cortex !== undefined)
              invalid("has another authoritative root projection")
            return
          }
          if (
            value.rootSessionID !== session.sessionID ||
            !value.parentSessionID ||
            !value.cortex ||
            value.cortex.parentSessionID !== value.parentSessionID
          )
            invalid("contains a child without its original parent")
          current = value.parentSessionID
        }
      }
      let sequence = 0
      for (const eventRow of source.entries(Keys.sharedEvents(session.sessionID, generation))) {
        const stored = Record.SharedEvent.parse(eventRow.value)
        const event = stored.event
        if (
          event.sequence !== sequence + 1 ||
          event.sequence >= state.nextSeq ||
          !equal(eventRow.key, Keys.sharedEvent(session.sessionID, generation, event.sequence))
        )
          invalid("has an incomplete canonical event sequence")
        if (sequence === 0 && (event.type !== "session" || event.session.sessionID !== session.sessionID))
          invalid("does not begin with its original root projection")
        const id = sourceSessionID(event, session.sessionID)
        lineage(id)
        if (event.type === "session") {
          const value = event.session
          const current = projection(id)
          if (
            value.projectID !== current.projectID ||
            value.creatorID !== current.creatorID ||
            value.driverRuntimeID !== current.driverRuntimeID ||
            value.bindingEpoch !== current.bindingEpoch ||
            value.shareGeneration !== current.shareGeneration ||
            value.rootSessionID !== current.rootSessionID ||
            value.parentSessionID !== current.parentSessionID ||
            value.cortex?.taskID !== current.cortex?.taskID
          )
            invalid("contains an unsupported historical Session binding")
        }
        if (event.type === "cortex") {
          const child = projection(event.sessionID)
          if (
            !child.cortex ||
            child.cortex.taskID !== event.taskID ||
            child.cortex.parentSessionID !== event.parentSessionID ||
            child.cortex.parentMessageID !== event.parentMessageID
          )
            invalid("contains an unrelated Cortex event")
        }
        if (event.type === "notification") {
          lineage(event.childSessionID)
          const child = projection(event.childSessionID)
          if (!child.cortex || child.cortex.taskID !== event.taskID || child.cortex.parentSessionID !== event.sessionID)
            invalid("contains an unrelated child notification")
        }
        if ((event.type === "attachment" || event.type === "blob") && event.state === "available") {
          Blobs.historicalReference(source, {
            sessionID: session.sessionID,
            shareGeneration: generation,
            hash: event.hash,
            bytes: event.bytes,
          })
        }
        if (event.type === "part" && event.part) {
          const part = event.part
          if ("content" in part) reference(part.content)
          if (part.type === "tool") {
            reference(part.input)
            reference(part.output)
            reference(part.error)
          }
        }
        sequence = event.sequence
        source.accept(eventRow.key)
      }
      if (sequence !== state.nextSeq - 1) invalid("does not reach its acknowledged watermark")
      let firstSeq = 1
      for (const batchRow of source.entries([
        "organization",
        "shared-batches",
        session.sessionID,
        String(generation),
      ])) {
        const batch = Record.SharedBatch.parse(batchRow.value)
        if (
          batch.sessionID !== session.sessionID ||
          batch.projectID !== session.projectID ||
          batch.bindingEpoch !== session.bindingEpoch ||
          batch.shareGeneration !== generation ||
          batch.firstSeq !== firstSeq ||
          batch.lastSeq < firstSeq ||
          batch.lastSeq >= state.nextSeq ||
          batch.lastSeq - firstSeq >= 256 ||
          !equal(batchRow.key, Keys.sharedBatch(session.sessionID, generation, firstSeq))
        )
          invalid("has inconsistent canonical batch receipts")
        const events: Sync.Event[] = []
        for (let next = firstSeq; next <= batch.lastSeq; next++)
          events.push(source.read(Record.SharedEvent, Keys.sharedEvent(session.sessionID, generation, next)).event)
        if (
          !events.some((event) => event.type === "session" && event.session.sessionID === session.sessionID) &&
          digest(JSON.stringify({ firstSeq, lastSeq: batch.lastSeq, events })) !== batch.payloadHash
        )
          invalid("has a changed immutable batch payload")
        firstSeq = batch.lastSeq + 1
        source.accept(batchRow.key)
      }
      if (firstSeq !== state.nextSeq) invalid("has an incomplete canonical batch roster")
      Projection.history(source, { sessionID: session.sessionID, generation, watermark: sequence })
      Tasks.history(source, { sessionID: session.sessionID, generation, watermark: sequence })
      for (const projectionRow of source.entries(Keys.sharedSessions(session.sessionID, generation))) {
        const stored = Record.SharedSession.parse(projectionRow.value)
        const id = stored.projection.sessionID
        if (!equal(projectionRow.key, Keys.sharedSession(session.sessionID, generation, id)))
          invalid("has another child projection address")
        lineage(id)
        const latest = Projection.historicalSession(source, session.sessionID, generation, id)
        const normalized =
          id === session.sessionID ? { ...stored.projection, createdAt: session.createdAt } : stored.projection
        if (latest.type !== "session" || !equal(latest.session, normalized))
          invalid("has a changed canonical Session projection")
        source.accept(projectionRow.key)
      }
      source.accept(row.key)
    }
  }
}
