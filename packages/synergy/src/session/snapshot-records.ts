import fs from "node:fs/promises"
import path from "node:path"
import { Global } from "../global"
import { Storage } from "../storage/storage"
import { StoragePath } from "../storage/path"
import { Identifier } from "../id/id"
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
    if (hash === undefined) return []
    if (typeof hash !== "string" || !SnapshotStore.OID.test(hash))
      throw new SnapshotStore.StorageError("Invalid historical snapshot reference")
    return [hash]
  }

  export async function historicalRoots(scopeID: string, sessionID: string) {
    const roots = new Set<string>()
    const sid = Identifier.asSessionID(sessionID)
    const scope = Identifier.asScopeID(scopeID)
    const messages = StoragePath.sessionMessagesRoot(scope, sid)
    for (const message of await entries(path.join(Global.Path.data, ...messages))) {
      if (!message.isDirectory()) continue
      const parts = StoragePath.messageParts(scope, sid, Identifier.asMessageID(message.name))
      for (const part of await entries(path.join(Global.Path.data, ...parts))) {
        if (!part.isFile() || !part.name.endsWith(".json")) continue
        const value = await Storage.read<unknown>([...parts, part.name.slice(0, -5)])
        for (const hash of partRoots(value)) roots.add(hash)
      }
    }
    return [...roots]
  }
}
