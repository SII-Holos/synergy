import z from "zod"
import { Storage } from "../../storage/storage"
import { StoragePath } from "../../storage/path"
import { Lock } from "../../util/lock"
import { RolloutSchema } from "./schema"
import { record, RolloutRecordingError } from "./error"
export namespace RolloutPending {
  type Document = { version: 1; owners: RolloutSchema.Owner[] }
  type Loaded = { kind: "absent" } | { kind: "ok"; owners: RolloutSchema.Owner[] } | { kind: "untrusted" }
  const options = { compact: true, durable: true, private: true } as const
  const lockKey = "rollout-recovery-pending"

  // Recovery-scoped suspension: while recovery settles owners, journal
  // writes must not consult the ledger. Listed owners are already listed,
  // and an untrusted ledger stays untrusted until the recovery pass re-arms
  // it, so a crash inside the window cannot leave mutated work unlisted.
  let suspended = false

  /**
   * Suspends ledger tracking for the duration of a recovery pass. Recovery
   * settles only owners the ledger already lists, and an untrusted ledger
   * stays untrusted until the pass re-arms it, so a crash inside the window
   * cannot leave mutated work unlisted.
   */
  export function suspendTracking(): void {
    suspended = true
  }

  export function resumeTracking(): void {
    suspended = false
  }

  function key() {
    return StoragePath.rolloutRecoveryPending()
  }

  async function load(): Promise<Loaded> {
    let raw: unknown
    try {
      raw = await Storage.read(key(), { silentNotFound: true })
    } catch (error) {
      if (error instanceof Storage.NotFoundError) return { kind: "absent" }
      return { kind: "untrusted" }
    }
    const full = z
      .object({ version: z.literal(1), owners: z.array(RolloutSchema.Owner) })
      .strict()
      .safeParse(raw)
    return full.success ? { kind: "ok", owners: full.data.owners } : { kind: "untrusted" }
  }

  function sameOwner(a: RolloutSchema.Owner, b: RolloutSchema.Owner): boolean {
    if (a.kind !== b.kind || a.scopeID !== b.scopeID) return false
    return a.kind === "session"
      ? b.kind === "session" && a.sessionID === b.sessionID
      : b.kind === "operation" && a.operationID === b.operationID
  }

  /**
   * Returns the durable pending set, or undefined when it cannot be trusted:
   * missing, malformed, or unreadable. Recovery treats undefined as unknown
   * pending state and falls back to the exhaustive scan, so every failure
   * mode lands on the safe side.
   */
  export async function tracked(): Promise<Document | undefined> {
    const state = await load()
    return state.kind === "ok" ? { version: 1, owners: state.owners } : undefined
  }

  /**
   * Adds an owner to the durable set before any journal mutation. The set file
   * is written ahead of the mutation, so a crash can leave the set
   * over-inclusive but never omit mutated work. The unlocked membership probe
   * keeps already-tracked writes lock-free; concurrent first writes re-check
   * under the lock so neither owner's entry can be lost.
   */
  export async function track(owner: RolloutSchema.Owner): Promise<void> {
    if (suspended) return
    const identity = RolloutSchema.Owner.parse(owner)
    const probe = await load()
    // A migration can write before the first recovery pass. Only recovery
    // can establish that a missing ledger covers every historical owner.
    if (probe.kind === "absent") return
    if (probe.kind === "ok" && probe.owners.some((entry) => sameOwner(entry, identity))) return
    await record(async () => {
      using lock = await Lock.write(lockKey)
      const current = await load()
      // An unreadable ledger must not be silently reset: it may list other
      // owners. Fail the recording so execution admission stops, and let the
      // next exhaustive recovery re-arm the ledger.
      if (current.kind === "untrusted")
        throw new RolloutRecordingError({ message: "Rollout recovery pending set is unreadable" })
      if (current.kind === "ok" && current.owners.some((entry) => sameOwner(entry, identity))) return
      if (current.kind === "absent") return
      const owners = [...current.owners, identity]
      await Storage.write(key(), { version: 1, owners }, options)
    })
  }

  /** Re-arms the fast path after a verified recovery pass. */
  export async function markClean(): Promise<void> {
    await record(async () => {
      using lock = await Lock.write(lockKey)
      await Storage.write(key(), { version: 1, owners: [] } satisfies Document, options)
    })
  }
}
