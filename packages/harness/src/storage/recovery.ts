import { RuntimeContext } from "../lifecycle/context"
import { createHash } from "node:crypto"
import { Storage } from "./storage"
import { StorageIntegrityError } from "./errors"
import type { StorageStartupProgress } from "@ericsanchezok/synergy-util/runtime-startup"

export namespace StorageRecovery {
  const runtimeState = RuntimeContext.state(() => ({
    owners: new Map<string, (progress?: () => void) => Promise<void>>(),
    sealed: false,
    blocked: new WeakMap<object, Set<string>>(),
  }))

  export function register(name: string, recover: (progress?: () => void) => Promise<void>) {
    const instanceState = runtimeState()

    if (instanceState.owners.get(name) === recover) return
    if (instanceState.sealed)
      throw new StorageIntegrityError("Register storage recovery owners before opening the Runtime")
    instanceState.owners.set(name, recover)
  }
  export async function recoverOwners(progress?: (progress: StorageStartupProgress) => void) {
    const instanceState = runtimeState()

    instanceState.sealed = true
    let current = 0
    const resources = () => progress?.({ stage: "resources", current, total: 0, bytes: 0 })
    resources()
    const advance = () => {
      current++
      resources()
    }
    for (const recover of instanceState.owners.values()) {
      await recover(advance)
      advance()
    }
  }

  export async function validate(progress?: (current: number) => void) {
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

  export async function load(progress?: (current: number) => void) {
    const instanceState = runtimeState()

    const sessions = new Set<string>()
    let current = 0
    for (const sessionID of await Storage.scan(["storage_recovery", "sessions"])) {
      const [state] = await Storage.readMany<{ blocked: boolean }>([
        ["storage_recovery", "sessions", sessionID, "info"],
      ])
      if (state?.blocked) sessions.add(sessionID)
      progress?.(++current)
    }
    instanceState.blocked.set(Storage.current().store, sessions)
  }

  export function assertRunnable(sessionID: string) {
    const instanceState = runtimeState()

    if (Storage.available() && instanceState.blocked.get(Storage.current().store)?.has(sessionID))
      throw new StorageIntegrityError(
        "This session contains quarantined historical data; inspect and repair it before continuing execution",
      )
  }

  export async function reconcileNotifications(progress?: (current: number) => void) {
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
      progress?.(count)
    }
    return count
  }
}
