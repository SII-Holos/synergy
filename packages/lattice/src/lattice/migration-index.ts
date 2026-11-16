import { createHash } from "node:crypto"
import { z } from "zod"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { LatticeTypes } from "./types"

export namespace LatticeMigrationIndex {
  const root = ["lattice_migration_retained"]
  const record = (value: unknown) =>
    value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
  const identity = z.object({ scopeID: z.string(), sessionID: z.string().optional() })
  const key = (scopeID: string, runID: string) => [...root, "runs", scopeID, runID]
  const pending = (sessionID: string, noteID: string, digest: string) =>
    createHash("sha256")
      .update(JSON.stringify([sessionID, noteID, digest]))
      .digest("hex")

  export async function rebuild() {
    await Storage.removeTree(root)
    for await (const row of Storage.records({ prefix: ["lattice", "runs"], limit: 128 })) {
      if (row.key.length !== 4) continue
      const scopeID = row.key[2]
      const raw = record(row.value)
      const parsed = LatticeTypes.Run.safeParse(raw)
      if (!parsed.success && (raw?.schemaVersion === undefined || raw.schemaVersion === 1)) continue
      const sessionID = typeof raw?.sessionID === "string" ? raw.sessionID : undefined
      await Storage.transaction(async () => {
        await Storage.write(key(scopeID, row.key[3]), { scopeID, sessionID })
        if (typeof raw?.id === "string" && raw.id !== row.key[3])
          await Storage.write(key(scopeID, raw.id), { scopeID, sessionID })
        if (!parsed.success) return
        const run = parsed.data
        for (const step of run.pathway)
          for (const loop of step.loopHistory)
            await Storage.write([...root, "loops", scopeID, loop.loopID, run.id], { runID: run.id })
        if (run.effect?.kind === "start_blueprint_loop")
          await Storage.write([...root, "loops", scopeID, run.effect.loopID, run.id], { runID: run.id })
        if (run.effect?.kind === "create_blueprint_loop")
          await Storage.write(
            [
              ...root,
              "pending",
              scopeID,
              pending(run.sessionID, run.effect.blueprintNoteID, run.effect.sourceDigest),
              run.id,
            ],
            { runID: run.id },
          )
      })
    }
  }

  export async function retained(scopeID: string, runID: string) {
    const [value] = await Storage.readMany([key(scopeID, runID)])
    return value === undefined ? undefined : identity.parse(value)
  }

  export async function ownsLoop(scopeID: string, loopID: string, loop: Record<string, unknown>) {
    for await (const _ of Storage.records({ prefix: [...root, "loops", scopeID, loopID], limit: 1 })) return true
    const orchestration = record(loop.orchestration)
    if (
      orchestration?.kind === "lattice" &&
      typeof orchestration.runID === "string" &&
      (await retained(scopeID, orchestration.runID))
    )
      return true
    if (
      loop.source !== "lattice" ||
      typeof loop.sessionID !== "string" ||
      typeof loop.noteID !== "string" ||
      typeof loop.sourceDigest !== "string"
    )
      return false
    for await (const _ of Storage.records({
      prefix: [...root, "pending", scopeID, pending(loop.sessionID, loop.noteID, loop.sourceDigest)],
      limit: 1,
    }))
      return true
    return false
  }
}
