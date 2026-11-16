import { createHash } from "node:crypto"
import { z } from "zod"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { AssetReference } from "@ericsanchezok/synergy-util/asset-reference"

export namespace LatticeLegacyArchive {
  export const Entry = z.strictObject({
    version: z.literal(1),
    scopeID: z.string(),
    sessionID: z.string(),
    key: z.array(z.string()).min(1),
    hash: z.string().regex(/^[a-f0-9]{64}$/),
    value: z.unknown(),
  })
  export type Entry = z.infer<typeof Entry>
  export const root = (scopeID: string, sessionID?: string) => [
    "lattice_legacy_archive",
    scopeID,
    ...(sessionID ? [sessionID] : []),
  ]
  const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex")

  export function validate(key: string[], value: unknown, scopeID: string, sessionID: string) {
    const entry = Entry.parse(value)
    if (
      key.length !== 4 ||
      key[0] !== "lattice_legacy_archive" ||
      key[1] !== scopeID ||
      key[2] !== sessionID ||
      entry.scopeID !== scopeID ||
      entry.sessionID !== sessionID ||
      key[3] !== hash(entry.key) ||
      entry.hash !== hash(entry.value)
    )
      throw new Error("Legacy Lattice archive identity or retained content changed")
    const original = entry.key
    const allowed =
      (original[0] === "lattice" &&
        original[2] === scopeID &&
        ((original[1] === "runs" && original.length === 4) || (original[1] === "events" && original.length === 5))) ||
      (original[0] === "sessions" && original[1] === scopeID && original.length === 4 && original[3] === "info") ||
      (original[0] === "blueprint_loops" && original[1] === scopeID && original.length === 3) ||
      (original[0] === "notes" && original[1] === scopeID && original.length === 3)
    if (!allowed) throw new Error("Legacy Lattice archive contains foreign owner data")
    return entry
  }

  export async function preserve(scopeID: string, sessionID: string, key: string[], value: unknown) {
    if (!Storage.inWriteTransaction()) throw new Error("Legacy Lattice preservation requires its mutation transaction")
    const destination = [...root(scopeID, sessionID), hash(key)]
    const [previous] = await Storage.readMany([destination])
    if (previous !== undefined) {
      validate(destination, previous, scopeID, sessionID)
      return
    }
    const entry = Entry.parse({ version: 1, scopeID, sessionID, key, hash: hash(value), value })
    validate(destination, entry, scopeID, sessionID)
    await Storage.write(destination, entry)
  }

  export async function* records(scopeID: string, sessionID: string) {
    for await (const row of Storage.records({ prefix: root(scopeID, sessionID), limit: 128 }))
      yield { key: row.key, value: validate(row.key, row.value, scopeID, sessionID) }
  }

  export async function* dependencies(scopeID: string, sessionID: string) {
    for await (const entry of records(scopeID, sessionID)) {
      const frames: Iterator<unknown>[] = [[entry.value.value][Symbol.iterator]()]
      while (frames.length) {
        const next = frames.at(-1)!.next()
        if (next.done) {
          frames.pop()
          continue
        }
        if (typeof next.value === "string") {
          const reference = AssetReference.parse(next.value)
          if (reference) yield { kind: "asset" as const, reference: reference.url }
        } else if (Array.isArray(next.value)) frames.push(next.value.values())
        else if (next.value && typeof next.value === "object") frames.push(Object.values(next.value).values())
      }
    }
  }
}
