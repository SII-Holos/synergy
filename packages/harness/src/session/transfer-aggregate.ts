import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import { Database } from "bun:sqlite"
import { z } from "zod"
import { Global } from "../global"
import { Storage } from "../storage/storage"
import { initializeSqliteEngine } from "../storage/sqlite-engine"
import { Lock } from "../util/lock"
import { Session } from "."
import { SessionTransferOwners as Owners } from "./transfer-owners"
import { SessionTransferEpochs as Epochs } from "./transfer-epochs"
import type { SessionTransferStream as Stream } from "./transfer-stream"

export namespace SessionTransferAggregate {
  const ID = z.string().min(1)
  const Count = z.number().int().nonnegative().safe()
  const Versions = z.record(ID, z.number().int().positive().safe())
  export const Node = z.strictObject({
    version: z.literal(1),
    handoffID: ID,
    rootSessionID: ID,
    scopeID: ID,
    sessionID: ID,
    parentID: ID.optional(),
    owners: Versions,
    children: Count,
    references: Count,
  })
  const State = Node.extend({ phase: z.enum(["building", "sealed"]) })
  export const Edge = z.strictObject({ kind: z.enum(["child", "owner"]), ownerID: ID, sessionID: ID })
  export type Node = z.infer<typeof Node>
  export type Edge = z.infer<typeof Edge>
  export interface Member {
    identity: { sessionID: string; scopeID: string; parentID?: string }
    owners: Readonly<Record<string, number>>
    node: unknown
    edges: AsyncIterable<unknown>
  }
  const prefix = (context: Owners.SourceContext) => [
    "session_transfer_membership",
    context.handoffID,
    context.session.id,
  ]
  const stateKey = (context: Owners.SourceContext) => [...prefix(context), "state"]
  const edgesKey = (context: Owners.SourceContext) => [...prefix(context), "edges"]
  const sorted = (value: Readonly<Record<string, number>>) =>
    Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
  export const portableKey = (session: Readonly<Pick<Session.Info, "id" | "scope">>) => [
    "session_core_membership",
    session.scope.id,
    session.id,
  ]
  export function owns(session: Readonly<Pick<Session.Info, "id" | "scope">>, key: readonly string[]) {
    const root = portableKey(session)
    return key.length > root.length && root.every((segment, index) => key[index] === segment)
  }
  const node = (state: z.infer<typeof State>) => {
    const { phase: _phase, ...result } = state
    return Node.parse(result)
  }
  function fail(message: string): never {
    throw new Owners.Rejected({ message })
  }
  function same(context: Owners.SourceContext, value: Node) {
    if (
      context.handoffID !== value.handoffID ||
      context.rootSessionID !== value.rootSessionID ||
      context.session.id !== value.sessionID ||
      context.session.scope.id !== value.scopeID ||
      context.session.parentID !== value.parentID
    )
      fail("Sealed aggregate membership belongs to another Session")
  }

  export async function capture(context: Owners.SourceContext): Promise<Node> {
    context.signal.throwIfAborted()
    using lock = await Lock.write(
      "session-transfer-membership:" + JSON.stringify([context.handoffID, context.session.id]),
    )
    await Epochs.assertFrozen(context.session.id, context.handoffID)
    const binding = await Epochs.ownerPreparationBinding({
      sessionID: context.session.id,
      handoffID: context.handoffID,
    })
    if (
      binding.scopeID !== context.session.scope.id ||
      (binding.rootSessionID ?? binding.sessionID) !== context.rootSessionID
    )
      fail("Aggregate membership has another frozen root or Scope")
    if ((context.session.id === context.rootSessionID) !== !context.session.parentID)
      fail("Aggregate source root and canonical parent lineage disagree")
    const retained = await Storage.read(stateKey(context), { silentNotFound: true }).catch((error) => {
      if (error instanceof Storage.NotFoundError) return
      throw error
    })
    if (retained) {
      const state = State.parse(retained)
      same(context, state)
      if (state.phase === "sealed") return node(state)
    }
    await Storage.removeTree(prefix(context))
    const owners = await Owners.selected(context)
    let children = 0
    let references = 0
    for await (const child of Session.childIndexEntries(context.session.scope.id, context.session.id, context.signal)) {
      context.signal.throwIfAborted()
      await Storage.write(
        [...edgesKey(context), "child", "session-core", child.id],
        Edge.parse({ kind: "child", ownerID: "session-core", sessionID: child.id }),
      )
      children++
    }
    for (const ownerID of owners) {
      if (ownerID === "session-core") continue
      const inspection = await Owners.inspect(context, [ownerID])
      if (inspection.requirements.length)
        throw new Owners.Rejected({
          message: "Aggregate native owner has unresolved dependencies",
          requirements: inspection.requirements,
        })
      for await (const sessionID of inspection.children) {
        context.signal.throwIfAborted()
        const key = [...edgesKey(context), "owner", ownerID, ID.parse(sessionID)]
        if ((await Storage.readMany([key]))[0] !== undefined) continue
        await Storage.write(key, Edge.parse({ kind: "owner", ownerID, sessionID }))
        references++
      }
    }
    const result = Node.parse({
      version: 1,
      handoffID: context.handoffID,
      rootSessionID: context.rootSessionID,
      scopeID: context.session.scope.id,
      sessionID: context.session.id,
      parentID: context.session.parentID,
      owners: Owners.versions(owners),
      children,
      references,
    })
    await Epochs.assertFrozen(context.session.id, context.handoffID)
    await Storage.write(stateKey(context), { ...result, phase: "sealed" })
    return result
  }

  export async function* edges(context: Owners.SourceContext): AsyncGenerator<Edge> {
    await Epochs.assertFrozen(context.session.id, context.handoffID)
    const state = State.parse(await Storage.read(stateKey(context)))
    same(context, state)
    if (state.phase !== "sealed") fail("Aggregate source membership is not sealed")
    for await (const row of Storage.records({ prefix: edgesKey(context), limit: 128 })) {
      context.signal.throwIfAborted()
      yield Edge.parse(row.value)
    }
  }

  export async function* entries(context: Owners.SourceContext): AsyncGenerator<Stream.Input> {
    const value = await capture(context)
    const record = (key: string[], value: unknown): Stream.Input => ({
      id: JSON.stringify(["session-core", "membership", key]),
      kind: "record",
      metadata: { key },
      content: (async function* () {
        yield new TextEncoder().encode(JSON.stringify(value))
      })(),
    })
    yield record([...portableKey(context.session), "node"], value)
    for await (const edge of edges(context))
      yield record([...portableKey(context.session), "edges", edge.kind, edge.ownerID, edge.sessionID], edge)
  }

  export async function stagedRecords(
    session: Readonly<Pick<Session.Info, "id" | "scope">>,
    records: Pick<Owners.TargetContext["staged"], "record" | "records">,
    signal: AbortSignal,
  ) {
    const root = portableKey(session)
    const header = await records.record([...root, "node"])
    if (!header) fail("Portable Core membership node is missing")
    const node = Node.parse(header.value)
    return {
      node,
      edges: (async function* () {
        let nodes = 0
        for await (const record of records.records()) {
          signal.throwIfAborted()
          if (!owns(session, record.key)) continue
          if (record.key.length === root.length + 1 && record.key.at(-1) === "node") {
            if (JSON.stringify(Node.parse(record.value)) !== JSON.stringify(node))
              fail("Portable Core membership node changed")
            nodes++
            continue
          }
          const edge = Edge.parse(record.value)
          if (
            record.key.length !== root.length + 4 ||
            record.key[root.length] !== "edges" ||
            record.key[root.length + 1] !== edge.kind ||
            record.key[root.length + 2] !== edge.ownerID ||
            record.key[root.length + 3] !== edge.sessionID
          )
            fail("Portable Core membership contains an unrelated record")
          yield edge
        }
        if (nodes !== 1) fail("Portable Core membership requires one canonical node")
      })(),
    }
  }

  export async function validate(input: {
    handoffID: string
    rootSessionID: string
    scopeID: string
    members: AsyncIterable<Member>
    signal: AbortSignal
  }) {
    input.signal.throwIfAborted()
    const base = path.join(Global.Path.cache, "session-transfer-membership")
    await fs.mkdir(base, { recursive: true })
    const directory = await fs.mkdtemp(path.join(base, "verify-"))
    initializeSqliteEngine()
    const database = new Database(path.join(directory, "graph.sqlite"))
    try {
      database.exec(
        "PRAGMA journal_mode=OFF; PRAGMA synchronous=OFF; PRAGMA temp_store=FILE; PRAGMA cache_size=-2048; CREATE TABLE members (id TEXT PRIMARY KEY, parent TEXT, node TEXT NOT NULL, visited INTEGER NOT NULL DEFAULT 0); CREATE INDEX parents ON members(parent,id); CREATE TABLE edges (parent TEXT NOT NULL, kind TEXT NOT NULL, owner TEXT NOT NULL, child TEXT NOT NULL, PRIMARY KEY(parent,kind,owner,child)); CREATE TABLE pending (id TEXT PRIMARY KEY)",
      )
      using memberInsert = database.prepare("INSERT OR IGNORE INTO members(id,parent,node) VALUES (?,?,?)")
      using edgeInsert = database.prepare("INSERT OR IGNORE INTO edges VALUES (?,?,?,?)")
      let members = 0
      let edgeCount = 0
      for await (const member of input.members) {
        input.signal.throwIfAborted()
        const value = Node.parse(member.node)
        if (value.scopeID !== input.scopeID || member.identity.scopeID !== input.scopeID)
          fail("Aggregate canonical member belongs to another Scope")
        if (
          value.handoffID !== input.handoffID ||
          value.rootSessionID !== input.rootSessionID ||
          value.sessionID !== member.identity.sessionID ||
          value.parentID !== member.identity.parentID
        )
          fail("Aggregate canonical member identity disagrees with its sealed node")
        if (JSON.stringify(sorted(value.owners)) !== JSON.stringify(sorted(Versions.parse(member.owners))))
          fail("Aggregate canonical member omits a required native owner partition")
        if (!memberInsert.run(value.sessionID, value.parentID ?? null, JSON.stringify(value)).changes)
          fail("Aggregate canonical member is duplicated")
        members++
        let children = 0
        let references = 0
        for await (const source of member.edges) {
          input.signal.throwIfAborted()
          const edge = Edge.parse(source)
          if (!Object.hasOwn(value.owners, edge.ownerID) || (edge.kind === "child" && edge.ownerID !== "session-core"))
            fail("Aggregate edge has no native owner proof")
          if (!edgeInsert.run(value.sessionID, edge.kind, edge.ownerID, edge.sessionID).changes)
            fail("Aggregate native dependency edge is duplicated")
          edgeCount++
          if (edge.kind === "child") children++
          else references++
        }
        if (children !== value.children || references !== value.references)
          fail("Aggregate child or owner dependency inventory is incomplete")
      }
      using findRoot = database.prepare<{ parent: string | null }, [string]>("SELECT parent FROM members WHERE id=?")
      const root = findRoot.get(input.rootSessionID)
      if (!root || root.parent !== null) fail("Aggregate root must be present without a canonical parent")
      using missingParent = database.prepare(
        "SELECT m.id FROM members m LEFT JOIN members p ON p.id=m.parent WHERE m.id<>? AND (m.parent IS NULL OR p.id IS NULL) LIMIT 1",
      )
      if (missingParent.get(input.rootSessionID)) fail("Aggregate child has no canonical parent member")
      using missingChild = database.prepare(
        "SELECT e.child FROM edges e LEFT JOIN members m ON m.id=e.child WHERE m.id IS NULL LIMIT 1",
      )
      if (missingChild.get()) fail("Aggregate omitted a required child or native owner dependency")
      using wrongParent = database.prepare(
        "SELECT e.child FROM edges e JOIN members m ON m.id=e.child WHERE e.kind='child' AND (m.parent IS NULL OR m.parent<>e.parent) LIMIT 1",
      )
      if (wrongParent.get()) fail("Aggregate native child edge disagrees with canonical parent lineage")
      using missingEdge = database.prepare(
        "SELECT m.id FROM members m LEFT JOIN edges e ON e.parent=m.parent AND e.kind='child' AND e.child=m.id WHERE m.id<>? AND e.child IS NULL LIMIT 1",
      )
      if (missingEdge.get(input.rootSessionID))
        fail("Aggregate canonical child is absent from its parent's sealed inventory")
      using enqueue = database.prepare("INSERT OR IGNORE INTO pending VALUES (?)")
      using dequeue = database.prepare("DELETE FROM pending WHERE id=?")
      using visit = database.prepare("UPDATE members SET visited=1 WHERE id=?")
      using next = database.prepare<{ id: string }, []>("SELECT id FROM pending ORDER BY id LIMIT 128")
      using descendants = database.prepare<{ id: string }, [string]>(
        "SELECT id FROM members WHERE parent=? AND visited=0 ORDER BY id",
      )
      enqueue.run(input.rootSessionID)
      let visited = 0
      for (;;) {
        input.signal.throwIfAborted()
        const batch = next.all()
        if (!batch.length) break
        for (const item of batch) {
          visit.run(item.id)
          for (const child of descendants.iterate(item.id)) enqueue.run(child.id)
          dequeue.run(item.id)
          visited++
        }
      }
      if (visited !== members) fail("Aggregate canonical parent tree is cyclic or unreachable from its root")
      const hash = createHash("sha256")
      using orderedMembers = database.prepare<{ node: string }, []>("SELECT node FROM members ORDER BY id")
      for (const value of orderedMembers.iterate()) hash.update(value.node)
      using orderedEdges = database.prepare<{ parent: string; kind: string; owner: string; child: string }, []>(
        "SELECT parent,kind,owner,child FROM edges ORDER BY parent,kind,owner,child",
      )
      for (const value of orderedEdges.iterate()) hash.update(JSON.stringify(value))
      return { members, edges: edgeCount, digest: hash.digest("hex") }
    } finally {
      database.close(true)
      await fs.rm(directory, { recursive: true, force: true })
    }
  }
}
