import { createHash } from "node:crypto"
import { z } from "zod"
import { Storage } from "../../storage/storage"
import { StorageIntegrityError } from "../../storage/errors"
import type { Migration } from "../../migration/types"
import { RolloutArtifact } from "./artifact"
import { RolloutSchema } from "./schema"
import { UpgradeWork } from "../../storage/upgrade-work"

export namespace RolloutToolPartIndex {
  export const Query = RolloutSchema.ToolExecutionRecord.pick({
    runID: true,
    messageID: true,
    toolCallID: true,
    tool: true,
  }).strip()
  export type Query = z.infer<typeof Query>
  const Entry = z.strictObject({
    version: z.literal(1),
    toolID: z.uuid(),
    started: z.number(),
    inputHash: z.string().length(64).nullable(),
    ambiguous: z.boolean(),
  })
  const digest = (query: Query) =>
    createHash("sha256")
      .update(JSON.stringify([query.messageID, query.toolCallID, query.tool]))
      .digest("hex")
  const key = (owner: RolloutSchema.Owner, query: Query) => [
    ...RolloutArtifact.root(owner),
    "tool_parts",
    query.runID,
    digest(query),
  ]
  const toolKey = (owner: RolloutSchema.Owner, query: Query, id: string) => [
    ...RolloutArtifact.root(owner),
    "runs",
    query.runID,
    "tools",
    id,
  ]

  export async function capture(owner: RolloutSchema.Owner, sourceKey: string[], raw: unknown) {
    const base = RolloutArtifact.root(owner)
    if (
      sourceKey.length !== base.length + 4 ||
      sourceKey[base.length] !== "runs" ||
      sourceKey[base.length + 2] !== "tools"
    )
      return
    if (!Storage.inWriteTransaction())
      throw new StorageIntegrityError("Tool Part index requires the native record transaction")
    const value = RolloutSchema.ToolExecutionRecord.parse(raw)
    if (
      JSON.stringify(RolloutArtifact.root(value.owner)) !== JSON.stringify(base) ||
      JSON.stringify(sourceKey) !== JSON.stringify(toolKey(owner, value, value.id))
    )
      throw new StorageIntegrityError("Tool Part index belongs to another execution owner")
    const destination = key(owner, value)
    const previous = await Storage.read(destination, { silentNotFound: true }).catch((error) => {
      if (error instanceof Storage.NotFoundError) return
      throw error
    })
    const current = previous === undefined ? undefined : Entry.parse(previous)
    if (current && current.started > value.started) return
    const equal = current?.started === value.started
    const ambiguous = !!(
      equal &&
      (current.ambiguous ||
        (current.toolID !== value.id &&
          (current.inputHash === null || value.input.sha256 === null || current.inputHash !== value.input.sha256)))
    )
    const selected = equal && current.toolID > value.id ? current.toolID : value.id
    await Storage.write(
      destination,
      Entry.parse({
        version: 1,
        toolID: selected,
        started: value.started,
        inputHash: selected === value.id ? value.input.sha256 : current!.inputHash,
        ambiguous,
      }),
    )
  }

  export async function get(owner: RolloutSchema.Owner, input: Query) {
    const query = Query.parse(input)
    const raw = await Storage.read(key(owner, query), { silentNotFound: true }).catch((error) => {
      if (error instanceof Storage.NotFoundError) return
      throw error
    })
    if (raw === undefined) return
    const entry = Entry.parse(raw)
    if (entry.ambiguous) throw new StorageIntegrityError("Tool Part input has ambiguous native evidence")
    const value = RolloutSchema.ToolExecutionRecord.parse(await Storage.read(toolKey(owner, query, entry.toolID)))
    if (
      JSON.stringify(RolloutArtifact.root(value.owner)) !== JSON.stringify(RolloutArtifact.root(owner)) ||
      JSON.stringify(Query.parse(value)) !== JSON.stringify(query) ||
      value.started !== entry.started ||
      value.input.sha256 !== entry.inputHash
    )
      throw new StorageIntegrityError("Tool Part index disagrees with native execution evidence")
    return value
  }

  async function* children(prefix: string[]) {
    let after: string | undefined
    for (;;) {
      const page = await Storage.childKeys({ prefix, after, limit: 64, includeBranches: true })
      for (const key of page.keys) yield key.at(-1)!
      if (!page.after) return
      after = page.after
    }
  }

  async function rebuild(owner: RolloutSchema.Owner) {
    let count = 0
    for await (const runID of children([...RolloutArtifact.root(owner), "runs"])) {
      for await (const row of Storage.records({
        prefix: [...RolloutArtifact.root(owner), "runs", runID, "tools"],
        limit: 128,
      })) {
        UpgradeWork.signal()?.throwIfAborted()
        await Storage.transaction(async () => capture(owner, row.key, await Storage.read(row.key)))
        count++
      }
    }
    return count
  }

  async function all(kind: "session" | "operation", progress: (current: number, total: number) => void) {
    let count = 0
    for await (const scopeID of children([kind === "session" ? "sessions" : "operations"])) {
      for await (const id of children([kind === "session" ? "sessions" : "operations", scopeID])) {
        const owner: RolloutSchema.Owner =
          kind === "session" ? { kind, scopeID, sessionID: id } : { kind, scopeID, operationID: id }
        count += await rebuild(owner)
        progress(count, 0)
      }
    }
    progress(count, count)
  }

  export const sessionMigration: Migration = {
    id: "20261111-rollout-session-tool-part-index",
    description: "Index exact native tool inputs by message and tool call",
    scope: "session",
    execution: "session",
    emptyInput: [["sessions"]],
    async upSession(owner, progress) {
      const count = await rebuild({ kind: "session", ...owner })
      progress(count, count)
    },
    up: (progress) => all("session", progress),
  }
  export const operationMigration: Migration = {
    id: "20261111-rollout-operation-tool-part-index",
    description: "Index exact operation tool inputs by message and tool call",
    scope: "session",
    execution: "owner",
    emptyInput: [["operations"]],
    async upOwner(owner, progress) {
      const count = owner.kind === "operation" ? await rebuild(owner) : 0
      progress(count, count)
    },
    up: (progress) => all("operation", progress),
  }
}
