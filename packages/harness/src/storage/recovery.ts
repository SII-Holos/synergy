import { createHash } from "node:crypto"
import { Storage } from "./storage"
import { StorageIntegrityError } from "./errors"

export namespace StorageRecovery {
  const owners = new Map<string, () => Promise<void>>()
  let sealed = false
  export function register(name: string, recover: () => Promise<void>) {
    if (owners.get(name) === recover) return
    if (sealed) throw new StorageIntegrityError("Register storage recovery owners before opening the Runtime")
    owners.set(name, recover)
  }
  export async function recoverOwners() {
    sealed = true
    await Storage.collectArtifactGarbage({ scanOrphans: true })
    for (const recover of owners.values()) await recover()
  }

  const blocked = new WeakMap<object, Set<string>>()

  export async function validate(progress?: (current: number, timeoutMs?: number) => void) {
    const report = await Storage.current().store.verify(progress)
    for (const issue of report.issues) {
      if (issue.key[0] !== "sessions" || !issue.key[2])
        throw new StorageIntegrityError("Authoritative data failed validation")
      await Storage.transaction(async () => {
        const sessionID = issue.key[2]
        await Storage.write(["storage_recovery", "sessions", sessionID, "info"], {
          blocked: true,
          reason: "historical_data_gap",
          scopeID: issue.key[1],
        })
        const id = createHash("sha256").update(JSON.stringify(issue)).digest("hex")
        await Storage.write(["storage_recovery", "sessions", sessionID, "issues", id], issue)
      })
    }
    return report
  }

  export async function load() {
    const sessions = new Set<string>()
    for (const sessionID of await Storage.scan(["storage_recovery", "sessions"])) {
      const [state] = await Storage.readMany<{ blocked: boolean }>([
        ["storage_recovery", "sessions", sessionID, "info"],
      ])
      if (state?.blocked) sessions.add(sessionID)
    }
    blocked.set(Storage.current().store, sessions)
  }

  export function assertRunnable(sessionID: string) {
    if (Storage.available() && blocked.get(Storage.current().store)?.has(sessionID))
      throw new StorageIntegrityError(
        "This session contains quarantined historical data; inspect and repair it before continuing execution",
      )
  }

  export async function reconcileNotifications() {
    const store = Storage.current().store
    let count = 0
    for (;;) {
      const events = await store.pendingEvents(100)
      if (!events.length) break
      count += events.length
      await store.write(["storage_meta", "notification-reconciliation"], {
        reason: "runtime_epoch_changed",
        count,
        at: Date.now(),
      })
      // A new Runtime has a new event epoch and clients must reload snapshots.
      // Replaying arbitrary Bus subscribers could repeat an external effect.
      await store.acknowledgeEvents(events.map((event) => event.id))
    }
    return count
  }
}
