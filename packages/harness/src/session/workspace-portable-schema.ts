import { createHash } from "node:crypto"
import { z } from "zod"
import { SessionTransferEpochs as Epochs } from "./transfer-epochs"
import { SessionTransferStream as Stream } from "./transfer-stream"
import { WorkspacePortableTree } from "../workspace/portable-tree"

export namespace WorkspacePortableSchema {
  const ID = z.string().min(1).max(4096)
  const Hash = z.string().regex(/^[a-f0-9]{64}$/)
  const Count = z.number().int().nonnegative().safe()
  export const Member = z.strictObject({ version: z.literal(1), sessionID: ID, scopeID: ID, current: ID.nullable() })
  export type Member = z.infer<typeof Member>
  export const Reference = z.strictObject({
    version: z.literal(1),
    id: ID,
    scopeID: ID,
    current: z.boolean(),
    generation: Count.min(1).optional(),
  })
  export type Reference = z.infer<typeof Reference>
  export const Captured = z.strictObject({
    version: z.literal(1),
    workspaceID: ID,
    scopeID: ID,
    generation: Count.min(1),
    files: WorkspacePortableTree.Root,
  })
  export type Captured = z.infer<typeof Captured>
  export const Frame = z.strictObject({ version: z.literal(1), hash: Hash, bytes: Count.max(Stream.chunkBytes) })
  export type Frame = z.infer<typeof Frame>
  export const Receipt = z.strictObject({
    version: z.literal(1),
    binding: Epochs.Binding,
    members: Count.min(1),
    workspaces: Count,
    references: Count,
    entries: Count,
    bytes: Count,
    hash: Hash,
  })
  export type Receipt = z.infer<typeof Receipt>
  export const Row = z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("member"), value: Member }),
    z.strictObject({ kind: z.literal("reference"), sessionID: ID, value: Reference }),
    z.strictObject({ kind: z.literal("workspace"), value: Captured }),
    z.strictObject({ kind: z.literal("frame"), workspaceID: ID, scopeID: ID, value: Frame }),
  ])
  export type Row = z.infer<typeof Row>
  export interface Session {
    readonly id: string
    readonly scope: { readonly id: string }
  }
  function fail(message: string): never {
    throw new Error("Portable Workspace metadata " + message)
  }
  export function workspaceSegment(scopeID: string, id: string) {
    return createHash("sha256")
      .update(JSON.stringify([ID.parse(scopeID), ID.parse(id)]))
      .digest("hex")
  }
  export function portablePrefix(session: Session) {
    return ["session_workspaces", ID.parse(session.scope.id), ID.parse(session.id)]
  }
  export function memberKey(session: Session) {
    return [...portablePrefix(session), "member"]
  }
  export function referenceKey(session: Session, workspaceID: string) {
    return [...portablePrefix(session), "refs", workspaceSegment(session.scope.id, workspaceID)]
  }
  export function workspaceKey(session: Session, workspaceID: string) {
    return [...portablePrefix(session), "workspaces", workspaceSegment(session.scope.id, workspaceID), "tree"]
  }
  export function frameKey(session: Session, workspaceID: string, hash: string) {
    return [
      ...portablePrefix(session),
      "workspaces",
      workspaceSegment(session.scope.id, workspaceID),
      "objects",
      Hash.parse(hash),
    ]
  }
  export function artifactKey(session: Session, workspaceID: string, hash: string) {
    return [
      ...portablePrefix(session),
      "workspaces",
      workspaceSegment(session.scope.id, workspaceID),
      "bytes",
      Hash.parse(hash),
    ]
  }
  export function logicalKey(input: Row): string[] {
    const row = Row.parse(input)
    switch (row.kind) {
      case "member":
        return ["members", row.value.sessionID, "identity"]
      case "reference":
        return ["members", row.sessionID, "refs", row.value.id]
      case "workspace":
        return ["workspaces", row.value.workspaceID, "tree"]
      case "frame":
        return ["workspaces", row.workspaceID, "objects", row.value.hash]
    }
  }
  export function order(row: Row) {
    return JSON.stringify(logicalKey(row))
  }
  export function key(session: Session, row: Row): string[] {
    switch (row.kind) {
      case "member":
        return memberKey(session)
      case "reference":
        return referenceKey(session, row.value.id)
      case "workspace":
        return workspaceKey(session, row.value.workspaceID)
      case "frame":
        return frameKey(session, row.workspaceID, row.value.hash)
    }
  }
  export function parseRecord(session: Session, key: string[], value: unknown, workspaceID?: string): Row {
    const prefix = portablePrefix(session)
    if (!prefix.every((part, index) => key[index] === part)) fail("belongs to another member")
    const tail = key.slice(prefix.length)
    let row: Row
    if (tail.length === 1 && tail[0] === "member") row = { kind: "member", value: Member.parse(value) }
    else if (tail.length === 2 && tail[0] === "refs")
      row = { kind: "reference", sessionID: session.id, value: Reference.parse(value) }
    else if (tail.length === 3 && tail[0] === "workspaces" && tail[2] === "tree")
      row = { kind: "workspace", value: Captured.parse(value) }
    else if (tail.length === 4 && tail[0] === "workspaces" && tail[2] === "objects" && workspaceID)
      row = { kind: "frame", workspaceID, scopeID: session.scope.id, value: Frame.parse(value) }
    else fail("contains an unsupported owner record")
    if (JSON.stringify(key) !== JSON.stringify(WorkspacePortableSchema.key(session, row)))
      fail("key disagrees with its identity")
    const scopeID = row.kind === "frame" ? row.scopeID : row.value.scopeID
    if (scopeID !== session.scope.id || (row.kind === "member" && row.value.sessionID !== session.id))
      fail("belongs to another member")
    return row
  }
  export async function digest(
    value: Epochs.Binding,
    rows: AsyncIterable<Row>,
    signal?: AbortSignal,
  ): Promise<Receipt> {
    const binding = Epochs.Binding.parse(value)
    signal?.throwIfAborted()
    if (binding.rootSessionID && binding.rootSessionID !== binding.sessionID) fail("requires its aggregate root")
    const hash = createHash("sha256")
      .update("synergy.session.workspace-closure.v1\n")
      .update(JSON.stringify(binding) + "\n")
    let previous: string | undefined
    let root = false
    let members = 0
    let workspaces = 0
    let references = 0
    let entries = 0
    let bytes = 0
    for await (const value of rows) {
      signal?.throwIfAborted()
      const row = Row.parse(value)
      const position = order(row)
      if (previous !== undefined && Buffer.compare(Buffer.from(previous), Buffer.from(position)) >= 0)
        fail("order contains duplicate or reversed metadata")
      previous = position
      const scopeID = row.kind === "frame" ? row.scopeID : row.value.scopeID
      if (scopeID !== binding.scopeID) fail("belongs to another Scope")
      if (row.kind === "member") {
        root ||= row.value.sessionID === binding.sessionID
        members = Count.parse(members + 1)
      }
      if (row.kind === "reference") references = Count.parse(references + 1)
      if (row.kind === "workspace") {
        workspaces = Count.parse(workspaces + 1)
        entries = Count.parse(entries + row.value.files.tree.entries)
        bytes = Count.parse(bytes + row.value.files.tree.bytes)
      }
      hash.update(JSON.stringify([logicalKey(row), row.value]) + "\n")
    }
    signal?.throwIfAborted()
    if (!root) fail("omits its canonical root member")
    return Receipt.parse({
      version: 1,
      binding,
      members,
      workspaces,
      references,
      entries,
      bytes,
      hash: hash.digest("hex"),
    })
  }
}
