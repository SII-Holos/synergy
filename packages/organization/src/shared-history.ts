import { OrganizationSyncProtocol as Sync } from "@ericsanchezok/synergy-organization-protocol"
import { digest } from "./auth/secret"
import { fail } from "./error"
import { OrganizationRecord as Record } from "./storage/records"
import { OrganizationStoragePath as Keys } from "./storage/path"
import { OrganizationSharedProjection as Projection } from "./shared-projection"
import { OrganizationSharedTasks as Tasks } from "./shared-tasks"
import { OrganizationSharedBlobs as Blobs } from "./shared-blob"
import { OrganizationHandoffHistory as HandoffHistory } from "./handoff-history"
import { OrganizationServiceHome as ServiceHome } from "./service-home"
import { OrganizationRecoveryPublicationRecords as Publications } from "./backup/publication-records"
import { OrganizationSharedGeneration as Generations } from "./shared-generation"

export namespace OrganizationSharedHistory {
  export interface Source extends Record.HistoricalReader {
    accept(key: string[]): void
    first(group: string[], value: unknown): boolean
    binary(key: string[], maximum: number): Promise<Uint8Array>
    retainedOrigin?(origin: Generations.ArchiveOrigin): boolean
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
    const generations = await transcripts(source)
    await Blobs.history(source, generations)
  }
  async function privateHandoffControl(source: Source, session: Record.SessionDirectory, state: Record.SharedState) {
    if (session.shareState !== "private") return false
    if (
      session.sessionID !== state.sessionID ||
      session.shareGeneration !== 0 ||
      state.shareGeneration !== 0 ||
      state.bindingEpoch !== session.bindingEpoch ||
      state.syncState !== "blocked" ||
      state.nextSeq !== 1
    )
      invalid("private control marker has another original empty generation")
    const prefixes = [
      Keys.sharedEvents(session.sessionID, 0),
      Keys.sharedSessions(session.sessionID, 0),
      Keys.sharedBatch(session.sessionID, 0, 1).slice(0, -1),
      Projection.generationPrefix(session.sessionID, 0),
      Tasks.generationPrefix(session.sessionID, 0),
      Keys.sharedBlobs(session.sessionID, 0),
    ]
    for (const generation of prefixes)
      for (const _row of source.entries(generation.slice(0, -1)))
        invalid("private control marker cannot hide shared data")
    let selected: Awaited<ReturnType<typeof HandoffHistory.terminal>> | undefined
    for (const row of source.entries(["organization", "session-handoffs", session.sessionID])) {
      if (row.key.length !== 4 || !row.key[3]) invalid("private control marker has another Handoff index")
      const record = await HandoffHistory.terminal(source, session, row.key[3])
      if (record.phase !== "completed" || record.toEpoch !== session.bindingEpoch) continue
      if (selected || record.targetRuntimeID !== session.driverRuntimeID || record.shareGeneration !== 0)
        invalid("private control marker has another completed destination")
      selected = record
    }
    const checkpoint =
      selected?.version === 5 && selected.frozen?.proof.purpose === "source-frozen"
        ? selected.frozen.proof.syncCheckpoint
        : undefined
    if (!checkpoint || checkpoint.pendingBatch !== null)
      invalid("private control marker lacks its original completed empty sync transfer")
    return true
  }
  export async function transcripts(source: Source) {
    const generations = new Set<string>()
    const origin = (value: Generations.RetainedOrigin) => {
      if (value.kind === "home-maintenance") return
      if (!ServiceHome.needsRetainedSharedGenerations(value.sourceOwner))
        invalid("retained archive inventory claims a current writer")
      if (source.retainedOrigin?.(value)) return
      const receipt = Publications.validate(
        source.read(Publications.Receipt, Publications.key(value.installationID)),
        value.installationID,
      )
      if (
        receipt.target.incarnation !== value.incarnation ||
        receipt.source.current.namespaceHash !== value.namespaceHash ||
        receipt.source.current.nativeHash !== value.nativeHash ||
        !equal(value.sourceOwner, receipt.source.owner)
      )
        invalid("retained archive inventory lacks its original publication")
    }
    const closed = new Map<string, Map<number, Generations.Closed>>()
    const empty = new Map<string, Generations.EmptyRange[]>()
    for (const row of source.entries(Generations.emptyRoot)) {
      const range = Generations.EmptyRange.parse(row.value)
      const session = source.read(Record.SessionDirectory, Keys.session(range.identity.sessionID))
      Generations.inspectEmpty(range, session)
      origin(range.origin)
      if (!equal(row.key, Generations.emptyKey(session.sessionID, range.firstGeneration)))
        invalid("has another retained empty range address")
      let ranges = empty.get(session.sessionID)
      if (!ranges) empty.set(session.sessionID, (ranges = []))
      ranges.push(range)
      source.accept(row.key)
    }
    for (const [sessionID, ranges] of empty) {
      ranges.sort((left, right) => left.firstGeneration - right.firstGeneration)
      for (const family of Generations.generationFamilies)
        for (const row of source.entries(["organization", family, sessionID])) {
          const selected = Number(row.key[3])
          let low = 0,
            high = ranges.length
          while (low < high) {
            const middle = Math.floor((low + high) / 2)
            if (ranges[middle]!.lastGeneration < selected) low = middle + 1
            else high = middle
          }
          if (ranges[low] && ranges[low]!.firstGeneration <= selected)
            invalid("retained empty inventory cannot hide shared rows")
        }
    }
    const roster = (session: Record.SessionDirectory) => {
      const segments = [
        ...[...(closed.get(session.sessionID)?.keys() ?? [])].map((generation) => ({
          first: generation,
          last: generation,
        })),
        ...(empty.get(session.sessionID) ?? []).map((range) => ({
          first: range.firstGeneration,
          last: range.lastGeneration,
        })),
      ].sort((left, right) => left.first - right.first)
      let next = 1
      for (const segment of segments) {
        if (segment.first !== next) invalid("has an incomplete closed generation roster")
        next = segment.last + 2
      }
      if (next !== 2 * Math.floor(session.shareGeneration / 2) + 1)
        invalid("has an incomplete closed generation roster")
    }
    const id = (sessionID: string, generation: number) => JSON.stringify([sessionID, generation])
    for (const row of source.entries(Generations.root)) {
      if (row.key.length === 6 && row.key[4] === "inventory") {
        const original = source.read(Generations.Closed, row.key.slice(0, 4))
        if (!equal(row.key.slice(0, 4), Generations.key(original.identity.sessionID, original.generation)))
          invalid("has another retained inventory owner")
        continue
      }
      const original = Generations.Closed.parse(row.value)
      if (!equal(row.key, Generations.key(original.identity.sessionID, original.generation)))
        invalid("has another closed generation address")
      const session = source.read(Record.SessionDirectory, Keys.session(original.identity.sessionID))
      const endpoint = Generations.inspect(original, session)
      if (original.proof.kind === "retained-inventory") origin(original.proof.origin)
      const binding = await HandoffHistory.bindingAtEpoch(source, session, original.binding.bindingEpoch)
      if (!equal(binding, original.binding)) invalid("has another original closed generation binding")
      let previous = closed.get(session.sessionID)
      if (!previous) closed.set(session.sessionID, (previous = new Map()))
      if (previous.has(original.generation)) invalid("has duplicate closed generations")
      previous.set(original.generation, original)
      if (source.first(["closed-shared-generation", session.sessionID, String(original.generation)], original)) {
        Generations.history(source, original)
        await generation(source, endpoint, Generations.nextSeq(original))
      }
      source.accept(row.key)
      generations.add(id(session.sessionID, original.generation))
    }
    for (const row of source.entries(["organization", "shared-state"])) {
      const state = Record.SharedState.parse(row.value)
      if (!equal(row.key, Keys.sharedState(state.sessionID))) invalid("has another state address")
      const session = source.read(Record.SessionDirectory, Keys.session(state.sessionID))
      if (session.shareGeneration % 2 !== (session.shareState === "shared" ? 1 : 0))
        invalid("has another sharing lifecycle parity")
      roster(session)
      if (session.shareState === "private") {
        if (session.shareGeneration === 0) {
          await privateHandoffControl(source, session, state)
        } else if (
          state.sessionID !== session.sessionID ||
          state.shareGeneration !== session.shareGeneration ||
          state.bindingEpoch !== session.bindingEpoch ||
          state.syncState !== "blocked" ||
          state.nextSeq !== 1
        )
          invalid("has another current private revocation marker")
        source.accept(row.key)
        continue
      }
      if (
        session.sessionID !== state.sessionID ||
        state.shareGeneration !== session.shareGeneration ||
        state.bindingEpoch !== session.bindingEpoch ||
        state.syncState !== "synced" ||
        state.nextSeq < 1
      )
        invalid("requires its current synchronized generation")
      await generation(source, session, state.nextSeq)
      source.accept(row.key)
      generations.add(id(session.sessionID, state.shareGeneration))
    }
    for (const row of source.entries(Keys.sessions())) {
      const session = Record.SessionDirectory.parse(row.value)
      if (session.shareGeneration === 0) continue
      const state = source.read(Record.SharedState, Keys.sharedState(session.sessionID))
      if (state.shareGeneration !== session.shareGeneration || state.bindingEpoch !== session.bindingEpoch)
        invalid("has an incomplete sharing lifecycle")
      roster(session)
    }
    return generations
  }
  async function generation(source: Source, session: Record.SessionDirectory, nextSeq: number) {
    const generation = session.shareGeneration
    if (!source.first(["shared-transcript", session.sessionID, String(generation)], { session, nextSeq })) return
    const bindings = nextSeq === 1 ? [] : await HandoffHistory.windows(source, session, generation)
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
        event.sequence >= nextSeq ||
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
        const original = HandoffHistory.at(bindings, event.sequence)
        if (
          value.projectID !== current.projectID ||
          value.creatorID !== current.creatorID ||
          value.driverRuntimeID !== original.driverRuntimeID ||
          value.bindingEpoch !== original.bindingEpoch ||
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
    if (sequence !== nextSeq - 1) invalid("does not reach its acknowledged watermark")
    let firstSeq = 1
    for (const batchRow of source.entries(["organization", "shared-batches", session.sessionID, String(generation)])) {
      const batch = Record.SharedBatch.parse(batchRow.value)
      const original = HandoffHistory.at(bindings, batch.firstSeq)
      if (
        batch.sessionID !== session.sessionID ||
        batch.projectID !== session.projectID ||
        batch.bindingEpoch !== original.bindingEpoch ||
        HandoffHistory.at(bindings, batch.lastSeq) !== original ||
        batch.shareGeneration !== generation ||
        batch.firstSeq !== firstSeq ||
        batch.lastSeq < firstSeq ||
        batch.lastSeq >= nextSeq ||
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
    if (firstSeq !== nextSeq) invalid("has an incomplete canonical batch roster")
    Projection.history(source, {
      sessionID: session.sessionID,
      generation,
      watermark: sequence,
    })
    Tasks.history(source, {
      sessionID: session.sessionID,
      generation,
      watermark: sequence,
    })
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
  }
}
