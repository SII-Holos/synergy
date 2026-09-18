import fs from "node:fs/promises"
import { Storage } from "../storage/storage"
import { SnapshotStore } from "./snapshot-store"

export namespace SnapshotRecords {
  export async function entries(directory: string) {
    return fs.readdir(directory, { withFileTypes: true }).catch((error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return []
      throw error
    })
  }

  export function partRoots(part: unknown): string[] {
    if (!part || typeof part !== "object") return []
    const value = part as Record<string, unknown>
    const hash =
      value.type === "patch"
        ? value.hash
        : ["snapshot", "step-start", "step-finish"].includes(String(value.type))
          ? value.snapshot
          : undefined
    if (hash === undefined || (hash === "" && ["step-start", "step-finish"].includes(String(value.type)))) return []
    if (typeof hash !== "string" || !SnapshotStore.OID.test(hash))
      throw new SnapshotStore.StorageError("Invalid historical snapshot reference")
    return [hash]
  }

  export async function historicalRoots(scopeID: string, sessionID: string) {
    const roots = new Set<string>()
    for await (const record of Storage.records({ kind: "part", scopeID, sessionID })) {
      for (const hash of partRoots(record.value)) roots.add(hash)
    }
    return [...roots]
  }
}
