import type { SnapshotStore } from "./snapshot-store"
import type { StorageCheckpoint } from "../storage/checkpoint"

export namespace SnapshotCaptureAuthority {
  export interface Owner {
    readonly scopeID: string
    readonly sessionID: string
    readonly backend: SnapshotStore.Owner["backend"]
  }
  interface Binding {
    scopeID: string
    sessionID: string
    owner: Readonly<SnapshotStore.Owner>
    layout: "native" | "stored" | "legacy"
    namespace: Readonly<StorageCheckpoint.Manifest>
    assertCurrent(): void
    roots?(): AsyncIterable<string>
  }
  const owners = new WeakMap<Owner, Binding>()

  export function issue(binding: Binding): Owner {
    binding.assertCurrent()
    const owner = Object.freeze({
      scopeID: binding.scopeID,
      sessionID: binding.sessionID,
      backend: binding.owner.backend,
    })
    owners.set(owner, binding)
    return owner
  }

  export function current(owner: Owner) {
    const binding = owners.get(owner)
    if (!binding) throw new Error("Snapshot read requires an authentic captured owner")
    binding.assertCurrent()
    return binding
  }
}
