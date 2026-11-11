import fs from "node:fs/promises"
import path from "node:path"
import { Database } from "bun:sqlite"
import { z } from "zod"
import { Session } from "."
import { Global } from "../global"
import { Lock } from "../util/lock"
import { Storage } from "../storage/storage"
import { initializeSqliteEngine } from "../storage/sqlite-engine"
import { SessionLifecycle } from "./lifecycle"
import { SessionManager } from "./manager"
import { LoopJob } from "./loop-job"
import { SessionInteraction } from "./interaction"
import { SessionTransferEpochs as Epochs } from "./transfer-epochs"
import { SessionTransferOwners as Owners } from "./transfer-owners"
import { SessionTransferStream as Stream } from "./transfer-stream"
import { SessionTransferAggregate as Aggregate } from "./transfer-aggregate"
import type { BlobStore } from "../storage/blobs"

export namespace SessionTransferSource {
  const Member = z.strictObject({
    version: z.literal(1),
    binding: Epochs.Binding,
    owners: z.record(z.string(), z.number().int().positive().safe()),
  })
  const Prepared = z.strictObject({
    version: z.literal(1),
    binding: Epochs.Binding,
    root: Stream.Root,
    manifestHash: z.string().regex(/^[a-f0-9]{64}$/),
    closureHash: z.string().regex(/^[a-f0-9]{64}$/),
    members: z.number().int().positive().safe(),
  })
  const prefix = (binding: Epochs.Binding) => ["session_transfer_source", binding.handoffID, binding.sessionID]
  const memberKey = (binding: Epochs.Binding, sessionID: string) => [...prefix(binding), "members", sessionID]
  const stateKey = (binding: Epochs.Binding) => [...prefix(binding), "state"]
  const candidateKey = (binding: Epochs.Binding) => [...prefix(binding), "candidate"]
  function fail(message: string): never {
    throw new Owners.Rejected({ message })
  }
  function same(a: Epochs.Binding, b: Epochs.Binding) {
    return Object.keys(Epochs.Binding.shape).every(
      (key) => a[key as keyof Epochs.Binding] === b[key as keyof Epochs.Binding],
    )
  }
  function memberBinding(root: Epochs.Binding, sessionID: string): Epochs.Binding {
    return Epochs.Binding.parse({
      ...root,
      sessionID,
      ...(sessionID !== root.sessionID ? { rootSessionID: root.sessionID } : {}),
    })
  }
  function context(binding: Epochs.Binding, session: Session.Info, signal: AbortSignal): Owners.SourceContext {
    return { session, rootSessionID: binding.sessionID, handoffID: binding.handoffID, signal }
  }

  export async function status(value: Epochs.Binding) {
    const binding = Epochs.Binding.parse(value)
    const [raw] = await Storage.readMany([stateKey(binding)])
    if (raw === undefined) return
    const record = Prepared.parse(raw)
    if (!same(record.binding, binding) || Stream.digest(record.root) !== record.manifestHash)
      fail("Source package belongs to another immutable handoff binding")
    const epoch = await Epochs.inspect(binding)
    if (epoch.phase === "cancelled") return
    if (!["frozen", "surrendered"].includes(epoch.phase) || epoch.manifestHash !== record.manifestHash)
      fail("Source package no longer has its canonical frozen epoch")
    return {
      root: record.root,
      manifestHash: record.manifestHash,
      closureHash: record.closureHash,
      members: record.members,
    }
  }

  export async function* members(value: Epochs.Binding, signal?: AbortSignal) {
    const binding = Epochs.Binding.parse(value)
    for await (const row of Storage.records({ prefix: [...prefix(binding), "members"], limit: 128 })) {
      signal?.throwIfAborted()
      const member = Member.parse(row.value)
      if (!same(memberBinding(binding, member.binding.sessionID), member.binding))
        fail("Source cohort member belongs to another handoff")
      yield member
    }
  }

  async function complete(
    binding: Epochs.Binding,
    record: z.infer<typeof Prepared>,
    verify: () => Promise<void>,
    signal: AbortSignal,
  ) {
    if (!same(record.binding, binding) || Stream.digest(record.root) !== record.manifestHash)
      fail("Source candidate belongs to another immutable handoff")
    let count = 0
    let root = false
    for await (const member of members(binding, signal)) {
      await Epochs.assertFrozen(member.binding.sessionID, binding.handoffID)
      await Epochs.seal(member.binding, record.manifestHash)
      root ||= member.binding.sessionID === binding.sessionID
      count++
    }
    if (!root || count !== record.members) fail("Source candidate has incomplete epoch membership")
    await verify()
    await Storage.write(stateKey(binding), record)
    return {
      root: record.root,
      manifestHash: record.manifestHash,
      closureHash: record.closureHash,
      members: record.members,
    }
  }

  export async function prepare(input: {
    binding: Epochs.Binding
    store: BlobStore
    signal: AbortSignal
    verify(): Promise<void>
  }) {
    const binding = Epochs.Binding.parse(input.binding)
    input.signal.throwIfAborted()
    if (binding.rootSessionID && binding.rootSessionID !== binding.sessionID)
      fail("Source preparation requires the aggregate root")
    using lock = await Lock.writeWithSignal("session-transfer-source:" + binding.sessionID, input.signal)
    input.signal.throwIfAborted()
    if (!lock) fail("Source preparation could not acquire its native lock")
    await input.verify()
    const retained = await status(binding)
    if (retained) return retained
    const [candidate] = await Storage.readMany([candidateKey(binding)])
    if (candidate !== undefined) return complete(binding, Prepared.parse(candidate), input.verify, input.signal)
    const root = await Session.get(binding.sessionID)
    if (
      root.parentID ||
      root.scope.id !== binding.scopeID ||
      root.time.archived ||
      SessionInteraction.isUnattended(root.interaction)
    )
      fail("Source preparation requires an available interactive aggregate root")
    const base = path.join(Global.Path.cache, "session-transfer-source")
    await fs.mkdir(base, { recursive: true })
    const directory = await fs.mkdtemp(path.join(base, "prepare-"))
    initializeSqliteEngine()
    const database = new Database(path.join(directory, "cohort.sqlite"))
    try {
      database.exec(
        "PRAGMA journal_mode=OFF; PRAGMA synchronous=OFF; PRAGMA temp_store=FILE; PRAGMA cache_size=-2048; CREATE TABLE members (id TEXT PRIMARY KEY, parent TEXT, owners TEXT, discovered INTEGER NOT NULL DEFAULT 0, held INTEGER NOT NULL DEFAULT 0, drained INTEGER NOT NULL DEFAULT 0, depth INTEGER); CREATE INDEX children ON members(parent,id); CREATE TABLE queue (id TEXT PRIMARY KEY)",
      )
      using insert = database.prepare("INSERT OR IGNORE INTO members(id,parent) VALUES (?,?)")
      using refreshParent = database.prepare("UPDATE members SET parent=? WHERE id=?")
      using find = database.prepare<{ id: string; parent: string | null; owners: string | null }, [string]>(
        "SELECT id,parent,owners FROM members WHERE id=?",
      )
      const lineage = z.object({ id: z.string(), parentID: z.string().optional(), scope: z.object({ id: z.string() }) })
      await using recording = LoopJob.preserveRecordingFailures(async (sessionID) => {
        if (find.get(sessionID)) return true
        const visited = new Set<string>()
        let current: string | undefined = sessionID
        while (current) {
          if (visited.has(current)) fail("Source recording has a cyclic native parent lineage")
          visited.add(current)
          const [raw] = await Storage.readMany<unknown>([["sessions", binding.scopeID, current, "info"]])
          if (raw === undefined) return false
          const info = lineage.parse(raw)
          if (info.id !== current || info.scope.id !== binding.scopeID) return false
          if (current === root.id) return true
          current = info.parentID
        }
        return false
      })
      const add = async (sessionID: string) => {
        const session = await Session.get(sessionID)
        if (session.scope.id !== binding.scopeID || (session.id === root.id ? !!session.parentID : !session.parentID))
          fail("Source aggregate dependency belongs to another Scope or canonical root")
        const added = insert.run(session.id, session.parentID ?? null).changes > 0
        refreshParent.run(session.parentID ?? null, session.id)
        return added
      }
      await add(root.id)
      await SessionLifecycle.pause({ sessionID: root.id, reason: "interrupted" })
      await Epochs.beginSource(binding)
      const discover = async () => {
        let added = 0
        using pending = database.prepare<{ id: string; owners: string | null }, []>(
          "SELECT id,owners FROM members WHERE discovered=0 ORDER BY id LIMIT 128",
        )
        using mark = database.prepare(
          "UPDATE members SET discovered=1,owners=?,drained=CASE WHEN owners IS NULL OR owners<>? THEN 0 ELSE drained END WHERE id=?",
        )
        for (;;) {
          const batch = pending.all()
          if (!batch.length) return added
          for (const row of batch) {
            input.signal.throwIfAborted()
            const session = await Session.get(row.id)
            const source = context(binding, session, input.signal)
            const owners = await Owners.selected(source, ["session-core"])
            for await (const child of Session.childIndexEntries(binding.scopeID, row.id, input.signal))
              if (await add(child.id)) added++
            const inspected = await Owners.inspect(source, owners)
            for await (const sessionID of inspected.children) if (await add(sessionID)) added++
            const encoded = JSON.stringify(owners)
            if (row.owners !== null && row.owners !== encoded) added++
            mark.run(encoded, encoded, row.id)
          }
        }
      }
      const assignDepths = () => {
        database.exec("UPDATE members SET depth=NULL; DELETE FROM queue")
        using rootDepth = database.prepare("UPDATE members SET depth=0 WHERE id=?")
        using enqueue = database.prepare("INSERT OR IGNORE INTO queue VALUES (?)")
        using next = database.prepare<{ id: string; depth: number }, []>(
          "SELECT m.id,m.depth FROM queue q JOIN members m ON m.id=q.id ORDER BY m.id LIMIT 128",
        )
        using children = database.prepare<{ id: string }, [string]>(
          "SELECT id FROM members WHERE parent=? AND depth IS NULL ORDER BY id",
        )
        using assignDepth = database.prepare("UPDATE members SET depth=? WHERE id=?")
        using dequeue = database.prepare("DELETE FROM queue WHERE id=?")
        rootDepth.run(root.id)
        enqueue.run(root.id)
        for (;;) {
          input.signal.throwIfAborted()
          const batch = next.all()
          if (!batch.length) break
          for (const row of batch) {
            for (const child of children.iterate(row.id)) {
              assignDepth.run(row.depth + 1, child.id)
              enqueue.run(child.id)
            }
            dequeue.run(row.id)
          }
        }
        using unreachable = database.prepare("SELECT id FROM members WHERE depth IS NULL LIMIT 1")
        if (unreachable.get()) fail("Source aggregate has a cyclic or foreign native parent lineage")
      }
      for (;;) {
        await discover()
        using pending = database.prepare<{ id: string; owners: string }, []>(
          "SELECT id,owners FROM members WHERE held=0 ORDER BY (parent IS NOT NULL),id LIMIT 128",
        )
        using held = database.prepare("UPDATE members SET held=1 WHERE id=?")
        for (;;) {
          const batch = pending.all()
          if (!batch.length) break
          for (const row of batch) {
            input.signal.throwIfAborted()
            const session = await Session.get(row.id)
            const member = memberBinding(binding, row.id)
            if (!SessionInteraction.isUnattended(session.interaction) && !session.cortex) {
              await SessionLifecycle.pause({ sessionID: row.id, reason: "interrupted" })
            }
            await Epochs.beginSource(member)
            await Storage.write(
              memberKey(binding, row.id),
              Member.parse({
                version: 1,
                binding: member,
                owners: Owners.versions(z.array(z.string()).parse(JSON.parse(row.owners))),
              }),
            )
            held.run(row.id)
          }
        }
        assignDepths()
        using undrained = database.prepare<{ id: string; owners: string }, []>(
          "SELECT id,owners FROM members WHERE drained=0 ORDER BY depth DESC,id LIMIT 128",
        )
        using drained = database.prepare("UPDATE members SET drained=1 WHERE id=?")
        for (;;) {
          const batch = undrained.all()
          if (!batch.length) break
          for (const row of batch) {
            input.signal.throwIfAborted()
            const member = memberBinding(binding, row.id)
            const epoch = await Epochs.inspect(member)
            if (epoch.phase === "draining") {
              const source = context(binding, await Session.get(row.id), input.signal)
              await Owners.freeze(
                source,
                z
                  .array(z.string())
                  .parse(JSON.parse(row.owners))
                  .filter((id) => id !== "session-core"),
              )
            }
            drained.run(row.id)
          }
        }
        database.exec("UPDATE members SET discovered=0")
        if (!(await discover())) break
      }
      using ordinary = database.prepare<{ id: string }, []>("SELECT id FROM members ORDER BY depth DESC,id")
      for (const row of ordinary.iterate()) {
        input.signal.throwIfAborted()
        const session = await Session.get(row.id)
        if (!session.cortex && !SessionInteraction.isUnattended(session.interaction))
          SessionManager.signalAbort(row.id, { pauseTurn: true })
      }
      assignDepths()
      await input.verify()
      using ordered = database.prepare<{ id: string; owners: string }, []>(
        "SELECT id,owners FROM members ORDER BY depth DESC,id",
      )
      const union = new Set<string>()
      let count = 0
      for (const row of ordered.iterate()) {
        input.signal.throwIfAborted()
        const ids = z.array(z.string()).parse(JSON.parse(row.owners))
        for (const id of ids) union.add(id)
        const member = memberBinding(binding, row.id)
        const verify = async () => {
          for await (const child of Session.childIndexEntries(binding.scopeID, row.id, input.signal)) {
            if (!find.get(child.id)) fail("Native child membership changed during final source freeze")
            await Epochs.assertFrozen(child.id, binding.handoffID)
          }
          if (row.id === root.id) await input.verify()
        }
        const epoch = await Epochs.inspect(member)
        if (epoch.phase === "draining") {
          const source = context(binding, await Session.get(row.id), input.signal)
          const owner = await Owners.freeze(source, ids)
          await Epochs.freeze(member, { owner, verify })
        } else {
          await Epochs.assertFrozen(row.id, binding.handoffID)
          await Storage.snapshot(verify)
        }
        count++
      }
      const closure = await Aggregate.validate({
        handoffID: binding.handoffID,
        rootSessionID: root.id,
        scopeID: binding.scopeID,
        signal: input.signal,
        members: (async function* () {
          for (const row of ordered.iterate()) {
            const session = await Session.get(row.id)
            const source = context(binding, session, input.signal)
            yield {
              identity: { sessionID: session.id, scopeID: session.scope.id, parentID: session.parentID },
              owners: Owners.versions(z.array(z.string()).parse(JSON.parse(row.owners))),
              node: await Aggregate.capture(source),
              edges: Aggregate.edges(source),
            }
          }
        })(),
      })
      const entries = (async function* () {
        using rows = database.prepare<{ id: string; owners: string }, []>(
          "SELECT id,owners FROM members ORDER BY depth,id",
        )
        for (const row of rows.iterate()) {
          const source = context(binding, await Session.get(row.id), input.signal)
          yield* Owners.entries(source, z.array(z.string()).parse(JSON.parse(row.owners)))
        }
      })()
      const manifest = await Stream.write({
        store: input.store,
        owners: Owners.versions([...union].sort()),
        entries,
        signal: input.signal,
      })
      const manifestHash = Stream.digest(manifest)
      const record = Prepared.parse({
        version: 1,
        binding,
        root: manifest,
        manifestHash,
        closureHash: closure.digest,
        members: count,
      })
      await Storage.write(candidateKey(binding), record)
      await input.verify()
      return await complete(binding, record, input.verify, input.signal)
    } finally {
      database.close(true)
      await fs.rm(directory, { recursive: true, force: true })
    }
  }
}
