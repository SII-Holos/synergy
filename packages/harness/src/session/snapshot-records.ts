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
    const operation =
      value.type === "patch" && value.operation && typeof value.operation === "object"
        ? (value.operation as Record<string, unknown>)
        : undefined
    const empty =
      hash === "" &&
      (["step-start", "step-finish"].includes(String(value.type)) ||
        operation?.status === "pending" ||
        operation?.status === "incomplete")
    const hashes = [empty ? undefined : hash, operation?.afterHash].filter((item) => item !== undefined)
    if (hashes.some((item) => typeof item !== "string" || !SnapshotStore.OID.test(item)))
      throw new SnapshotStore.StorageError("Invalid historical snapshot reference")
    return [...new Set(hashes)] as string[]
  }

  export async function historicalRoots(scopeID: string, sessionID: string) {
    const roots = new Set<string>()
    for await (const record of Storage.records({ kind: "part", scopeID, sessionID })) {
      for (const hash of partRoots(record.value)) roots.add(hash)
    }
    return [...roots]
  }
}
