import { expect, test } from "bun:test"
import { WorkspacePortableSchema as Schema } from "../../src/session/workspace-portable-schema"
import { SessionTransferStream as Stream } from "../../src/session/transfer-stream"

const binding = {
  sessionID: "ses_root",
  scopeID: "home",
  handoffID: "handoff",
  sourceID: "source",
  targetID: "target",
  fromEpoch: 1,
  toEpoch: 2,
}
const session = { id: binding.sessionID, scope: { id: binding.scopeID } }
async function fixture() {
  const frames = new Map<string, Uint8Array>()
  const tree = await Stream.write({
    store: {
      async put(hash, bytes) {
        frames.set(hash, bytes.slice())
      },
      async get(hash) {
        const value = frames.get(hash)
        if (!value) throw new Error("Missing frame")
        return value
      },
    },
    owners: { "workspace-files": 1 },
    entries: (async function* () {
      yield {
        id: "file.txt",
        kind: "file",
        metadata: { version: 1, kind: "file", mode: 0o644 },
        content: (async function* () {
          yield new Uint8Array([1, 2, 3])
        })(),
      }
    })(),
  })
  const workspaceID = "logical/workspace"
  const rows: Schema.Row[] = [
    { kind: "member", value: { version: 1, sessionID: session.id, scopeID: "home", current: workspaceID } },
    {
      kind: "reference",
      sessionID: session.id,
      value: { version: 1, id: workspaceID, scopeID: "home", current: true, generation: 7 },
    },
    {
      kind: "workspace",
      value: { version: 1, workspaceID, scopeID: "home", generation: 7, files: { version: 1, mode: 0o755, tree } },
    },
    ...[...frames].map(([hash, bytes]): Schema.Row => ({
      kind: "frame",
      workspaceID,
      scopeID: "home",
      value: { version: 1, hash, bytes: bytes.length },
    })),
  ]
  rows.sort((a, b) => Buffer.compare(Buffer.from(Schema.order(a)), Buffer.from(Schema.order(b))))
  return { rows, workspaceID }
}
async function* stream(rows: Schema.Row[]) {
  yield* rows
}

test("canonical Workspace closure is reconstructed from member partitions independently of private source paths", async () => {
  const { rows, workspaceID } = await fixture()
  const decoded = rows.map((row) => Schema.parseRecord(session, Schema.key(session, row), row.value, workspaceID))
  expect(decoded).toEqual(rows)
  expect(Schema.workspaceKey(session, workspaceID)).not.toContain(workspaceID)
  const receipt = await Schema.digest(binding, stream(rows))
  expect(receipt).toMatchObject({ members: 1, workspaces: 1, references: 1, entries: 1, bytes: 3 })
  expect(await Schema.digest(binding, stream(decoded))).toEqual(receipt)
  expect((await Schema.digest({ ...binding, handoffID: "different-handoff" }, stream(rows))).hash).not.toBe(
    receipt.hash,
  )
  expect(() =>
    Schema.parseRecord({ ...session, id: "foreign" }, Schema.key(session, rows[0]), rows[0].value, workspaceID),
  ).toThrow("member")
})

test("closure traversal rejects duplicates, reordered rows, another Scope and an omitted root", async () => {
  const { rows } = await fixture()
  await expect(Schema.digest(binding, stream([rows[0], ...rows]))).rejects.toThrow("order")
  await expect(Schema.digest(binding, stream([...rows].reverse()))).rejects.toThrow("order")
  await expect(Schema.digest({ ...binding, scopeID: "foreign" }, stream(rows))).rejects.toThrow("Scope")
  await expect(Schema.digest(binding, stream(rows.filter((row) => row.kind !== "member")))).rejects.toThrow("root")
})
