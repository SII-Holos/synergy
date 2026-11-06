import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { isDeepEqual } from "remeda"

export async function migrateNoteHomeScope(kind: string) {
  for (const scopeID of ["global", "home"]) {
    for (const id of await Storage.scan(["notes", scopeID])) {
      if (id.startsWith("_")) continue
      await Storage.transaction(async (tx) => {
        const from = ["notes", scopeID, id]
        const to = ["notes", "home", id]
        const [source, target] = await tx.readMany<Record<string, unknown>>([from, to])
        if (!source || (source.kind ?? "note") !== kind) return
        const next = { ...source, ...(source.originScope === "global" ? { originScope: "home" } : {}) }
        if (scopeID === "global" && target && !isDeepEqual(next, target))
          throw new Error(`Note scope migration conflict: ${id}`)
        if (scopeID === "home" && isDeepEqual(source, next)) return
        await tx.write(to, next)
        if (scopeID !== "home") await tx.remove(from)
        await tx.remove(["notes", scopeID, "_index"])
        await tx.remove(["notes", "home", "_index"])
      })
    }
  }
}
