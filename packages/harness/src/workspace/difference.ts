import { createHash } from "node:crypto"
import { z } from "zod"
import { Storage } from "../storage/storage"
import { Global } from "../global"
import { WorkspacePortableTree as Portable } from "./portable-tree"
import { WorkspaceTree } from "./tree"
import type { BlobStore } from "./content"

export namespace WorkspaceDifference {
  const Hash = WorkspaceTree.Hash
  const Count = z.number().int().nonnegative().safe()
  export const Entry = z
    .strictObject({
      path: WorkspaceTree.Path,
      source: WorkspaceTree.Header.nullable(),
      target: WorkspaceTree.Header.nullable(),
    })
    .refine(
      (value) =>
        (value.source !== null || value.target !== null) &&
        (!value.source || value.source.path === value.path) &&
        (!value.target || value.target.path === value.path),
      "Workspace difference must retain its exact compared path",
    )
  export type Entry = z.infer<typeof Entry>
  export const Summary = z.strictObject({
    version: z.literal(1),
    requestHash: Hash,
    sourceSnapshotHash: Hash,
    targetDigest: Hash,
    index: Hash,
    diffHash: Hash,
    entries: Count,
    sourceEntries: Count,
    targetEntries: Count,
    mode: z.strictObject({ source: Portable.Root.shape.mode, target: Portable.Root.shape.mode }),
  })
  export type Summary = z.infer<typeof Summary>
  const Row = z.strictObject({ position: Count.positive(), entry: Entry, hash: Hash })
  const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex")
  const root = (index: string) => ["workspace_move_difference", Hash.parse(index)]
  const position = (index: number) => String(index).padStart(16, "0")
  const order = (left: string, right: string) => Buffer.compare(Buffer.from(left), Buffer.from(right))

  export async function build(input: {
    requestHash: string
    sourceSnapshotHash: string
    source: Portable.Root
    target: Portable.Root
    store: BlobStore
    signal?: AbortSignal
    assert(): void
  }): Promise<Summary> {
    const requestHash = Hash.parse(input.requestHash),
      sourceSnapshotHash = Hash.parse(input.sourceSnapshotHash)
    const source = Portable.Root.parse(input.source),
      target = Portable.Root.parse(input.target)
    const signal = input.signal,
      check = input.assert.bind(input)
    const store = { get: input.store.get.bind(input.store), put: input.store.put.bind(input.store) }
    const targetDigest = digest(target)
    const index = digest([requestHash, sourceSnapshotHash, targetDigest])
    const assert = () => {
      signal?.throwIfAborted()
      check()
    }
    assert()
    await Storage.removeTree(root(index))
    assert()
    await using left = await Portable.open({ root: source, store, directory: Global.Path.cache, signal })
    await using right = await Portable.open({ root: target, store, directory: Global.Path.cache, signal })
    const sourceRows = left.entries()[Symbol.asyncIterator](),
      targetRows = right.entries()[Symbol.asyncIterator]()
    let first = await sourceRows.next(),
      second = await targetRows.next()
    let entries = 0,
      sourceEntries = 0,
      targetEntries = 0
    const mode = { source: source.mode, target: target.mode }
    const hash = createHash("sha256").update(
      JSON.stringify([
        1,
        requestHash,
        sourceSnapshotHash,
        targetDigest,
        mode,
        source.tree.entries,
        target.tree.entries,
      ]) + "\n",
    )
    try {
      while (!first.done || !second.done) {
        assert()
        const comparison = first.done ? 1 : second.done ? -1 : order(first.value.path, second.value.path)
        const sourceEntry = comparison <= 0 && !first.done ? WorkspaceTree.Header.parse(first.value) : null
        const targetEntry = comparison >= 0 && !second.done ? WorkspaceTree.Header.parse(second.value) : null
        if (sourceEntry) sourceEntries++
        if (targetEntry) targetEntries++
        if (JSON.stringify(sourceEntry) !== JSON.stringify(targetEntry)) {
          const entry = Entry.parse({
            path: sourceEntry?.path ?? targetEntry!.path,
            source: sourceEntry,
            target: targetEntry,
          })
          const row = Row.parse({ position: ++entries, entry, hash: digest(entry) })
          hash.update(JSON.stringify(row) + "\n")
          await Storage.write([...root(index), position(entries)], row)
          assert()
        }
        if (sourceEntry) first = await sourceRows.next()
        if (targetEntry) second = await targetRows.next()
      }
      assert()
      if (sourceEntries !== source.tree.entries || targetEntries !== target.tree.entries)
        throw new Error("Workspace difference omitted native entries")
      return Summary.parse({
        version: 1,
        requestHash,
        sourceSnapshotHash,
        targetDigest,
        index,
        diffHash: hash.digest("hex"),
        entries,
        sourceEntries,
        targetEntries,
        mode,
      })
    } finally {
      await Promise.allSettled([sourceRows.return?.(), targetRows.return?.()])
    }
  }

  export async function page(value: Summary, input: { cursor?: string; limit: number; assert(): void }) {
    const summary = Summary.parse(value)
    const query = z
      .strictObject({
        cursor: z
          .string()
          .regex(/^\d{16}$/)
          .optional(),
        limit: z.number().int().min(1).max(64),
      })
      .parse({ cursor: input.cursor, limit: input.limit })
    const assert = input.assert.bind(input)
    assert()
    const rows = await Storage.query({
      prefix: root(summary.index),
      after: query.cursor ? [...root(summary.index), query.cursor] : undefined,
      limit: query.limit + 1,
    })
    assert()
    let expected = query.cursor ? Number(query.cursor) + 1 : 1
    const items = rows.slice(0, query.limit).map((row) => {
      const value = Row.parse(row.value)
      if (
        row.key.length !== 3 ||
        row.key[2] !== position(value.position) ||
        value.position !== expected++ ||
        value.hash !== digest(value.entry) ||
        value.position > summary.entries
      )
        throw new Error("Workspace difference index changed")
      return value.entry
    })
    if (rows.length <= query.limit && expected - 1 !== summary.entries)
      throw new Error("Workspace difference index is truncated")
    return { diffHash: summary.diffHash, items, cursor: rows.length > query.limit ? position(expected - 1) : undefined }
  }

  export async function verify(value: Summary, assert: () => void) {
    const summary = Summary.parse(value)
    const hash = createHash("sha256").update(
      JSON.stringify([
        1,
        summary.requestHash,
        summary.sourceSnapshotHash,
        summary.targetDigest,
        summary.mode,
        summary.sourceEntries,
        summary.targetEntries,
      ]) + "\n",
    )
    let count = 0
    for await (const row of Storage.records({ prefix: root(summary.index), limit: 128 })) {
      assert()
      const entry = Row.parse(row.value)
      if (
        row.key.length !== 3 ||
        row.key[2] !== position(++count) ||
        entry.position !== count ||
        entry.hash !== digest(entry.entry)
      )
        throw new Error("Workspace difference index changed")
      hash.update(JSON.stringify(entry) + "\n")
    }
    assert()
    if (count !== summary.entries || hash.digest("hex") !== summary.diffHash)
      throw new Error("Workspace difference is incomplete")
  }
  export async function discard(value: Summary) {
    if (!Storage.inWriteTransaction())
      throw new Error("Workspace difference replacement must join its original Move transaction")
    await Storage.removeTree(root(Summary.parse(value).index))
  }
}
