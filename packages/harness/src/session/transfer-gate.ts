import { RuntimeContext } from "../lifecycle/context"
import { z } from "zod"
import { NamedError } from "@ericsanchezok/synergy-util/error"
import { Storage } from "../storage/storage"
import { StorageMutationGuard } from "../storage/mutation-guard"

export namespace SessionTransferGate {
  export const Blocked = NamedError.create(
    "SessionTransferBlocked",
    z.object({ sessionID: z.string(), migrationID: z.string(), message: z.string() }),
  )
  export const key = (sessionID: string) => ["session_transfer_gate", sessionID]
  export const Info = z
    .object({
      version: z.literal(1),
      migrationID: z.string(),
      scopeID: z.string(),
      targetID: z.string(),
      phase: z.enum(["preparing", "prepared", "committed", "completed"]),
    })
    .strict()
  export const reservationKey = (sessionID: string) => ["session_transfer_reservation", sessionID]
  const activation = RuntimeContext.createAsyncContext<{ runtime: RuntimeContext.Instance; migrationID: string }>()
  export function activating<T>(migrationID: string, fn: () => Promise<T>) {
    return activation.run({ runtime: RuntimeContext.current(), migrationID }, fn)
  }

  export async function assert(sessionID: string) {
    const [gate] = await Storage.readMany<z.infer<typeof Info>>([key(sessionID)])
    if (gate)
      throw new Blocked({
        sessionID,
        migrationID: gate.migrationID,
        message: "Session transfer owns this Session; resume it on the destination or cancel before cutover",
      })
  }

  export function register() {
    StorageMutationGuard.register("session-transfer", async (tx, keys, tree) => {
      const owners = [
        ...new Set(
          keys.flatMap((key) =>
            key[0] === "sessions" && key.length >= 3
              ? [key[2]]
              : key[0] === "session_index" && key.length === 2
                ? [key[1]]
                : key[0] === "snapshot-v2" && ["owners", "deletions", "migrations"].includes(key[2]) && key.length >= 4
                  ? [key[3]]
                  : [],
          ),
        ),
      ]
      const broad =
        tree &&
        keys.some(
          (key) =>
            !key.length ||
            (key[0] === "session_index" && key.length < 2) ||
            (key[0] === "sessions" && key.length < 3) ||
            (key[0] === "snapshot-v2" && key.length < 4),
        )
      const affected = (scopeID: string) =>
        keys.some(
          (prefix) =>
            !prefix.length ||
            prefix[0] === "session_index" ||
            (["sessions", "snapshot-v2"].includes(prefix[0]) && (!prefix[1] || prefix[1] === scopeID)),
        )
      const reserved = broad
        ? (await tx.query({ kind: "session_transfer_reservation" }))
            .map((record) => record.value as { migrationID: string; scopeID: string })
            .filter((record) => affected(record.scopeID))
        : await tx.readMany<{ migrationID: string }>(owners.map(reservationKey))
      const active = activation.getStore()
      for (const [index, record] of reserved.entries())
        if (record && (active?.runtime !== RuntimeContext.current() || active.migrationID !== record.migrationID))
          throw new Blocked({
            sessionID: broad ? "*" : owners[index],
            migrationID: record.migrationID,
            message: "Session transfer reserves this identity on the destination",
          })
      const gates: unknown[] = broad
        ? (await tx.query({ kind: "session_transfer_gate" }))
            .map((record) => Info.parse(record.value))
            .filter((record) => affected(record.scopeID))
        : await tx.readMany<z.infer<typeof Info>>(owners.map(key))
      const first = gates.find(Boolean)
      if (!first) return
      const gate = Info.parse(first)
      throw new Blocked({
        sessionID: broad ? "*" : owners[gates.indexOf(first)],
        migrationID: gate.migrationID,
        message: "Session transfer prevents changes to retained source data",
      })
    })
  }
}
