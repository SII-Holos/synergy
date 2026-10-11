import { z } from "zod"
import { Storage } from "../../storage/storage"
import { StoragePath } from "../../storage/path"
import { RolloutSchema } from "./schema"
import { record, RolloutRecordingError } from "./error"

export namespace RolloutPending {
  const Document = z.discriminatedUnion("version", [
    z.object({ version: z.literal(1), owners: z.array(RolloutSchema.Owner) }).strict(),
    z.object({ version: z.literal(2), epoch: z.string().uuid(), owners: z.array(RolloutSchema.Owner) }).strict(),
  ])
  type Document = z.infer<typeof Document>
  type Loaded = { kind: "absent" } | { kind: "ok"; document: Document } | { kind: "untrusted"; raw: unknown }
  const runtimeState = Storage.state(() => ({ suspended: false, touched: new Map<string, RolloutSchema.Owner>() }))

  // Only the exclusive startup/shutdown pass may suspend tracking globally.
  export function suspendTracking() {
    runtimeState().suspended = true
  }
  export function resumeTracking() {
    runtimeState().suspended = false
  }
  export function resetTouched() {
    runtimeState().touched.clear()
  }
  export function touched() {
    return [...runtimeState().touched.values()]
  }
  const key = StoragePath.rolloutRecoveryPending

  async function load(): Promise<Loaded> {
    const raw = await Storage.read(key(), { silentNotFound: true }).catch((error) => {
      if (error instanceof Storage.NotFoundError) return undefined
      throw error
    })
    if (raw === undefined) return { kind: "absent" }
    const parsed = Document.safeParse(raw)
    return parsed.success ? { kind: "ok", document: parsed.data } : { kind: "untrusted", raw }
  }

  function sameOwner(a: RolloutSchema.Owner, b: RolloutSchema.Owner) {
    return (
      a.scopeID === b.scopeID &&
      a.kind === b.kind &&
      (a.kind === "session"
        ? b.kind === "session" && a.sessionID === b.sessionID
        : b.kind === "operation" && a.operationID === b.operationID)
    )
  }

  function receipt(owner: RolloutSchema.Owner) {
    return owner.kind === "session"
      ? ["sessions", owner.scopeID, owner.sessionID, "rollout", "recovery-v2"]
      : ["operations", owner.scopeID, owner.operationID, "rollout", "recovery-v2"]
  }

  async function undiscoveredOwners() {
    const [compat] = await Storage.readMany<{
      discovered?: boolean
      counts?: { pending: number; partial: number; quarantined: number }
    }>([["compat_import", "info"]])
    return (
      compat &&
      (!compat.discovered ||
        !compat.counts ||
        compat.counts.pending + compat.counts.partial + compat.counts.quarantined > 0)
    )
  }

  export async function tracked(): Promise<Document | undefined> {
    const state = await load()
    if (state.kind !== "ok") return
    if (state.document.version === 1 && (await undiscoveredOwners())) return
    return state.document
  }

  /** Unknown historical coverage is retained as an epoch, never relabeled as globally clean. */
  export async function defer(): Promise<Document> {
    return Storage.transaction(async () => {
      const state = await load()
      if (state.kind === "ok" && state.document.version === 2) return state.document
      const epoch = crypto.randomUUID()
      if (state.kind === "untrusted") await Storage.write(["meta", "rollout", "untrusted", epoch], state.raw)
      const document: Document = { version: 2, epoch, owners: state.kind === "ok" ? state.document.owners : [] }
      await Storage.write(key(), document)
      return document
    })
  }

  export async function needsRecovery(owner: RolloutSchema.Owner) {
    const state = await load()
    if (state.kind !== "ok") throw new RolloutRecordingError({ message: "Rollout recovery coverage is unavailable" })
    if (state.document.version === 1) return state.document.owners.some((entry) => sameOwner(entry, owner))
    const [completed] = await Storage.readMany<{ epoch: string }>([receipt(owner)])
    return completed?.epoch !== state.document.epoch || state.document.owners.some((entry) => sameOwner(entry, owner))
  }

  export async function recovered(owner: RolloutSchema.Owner) {
    await Storage.transaction(async () => {
      const state = await load()
      if (state.kind !== "ok") throw new RolloutRecordingError({ message: "Rollout recovery coverage is unavailable" })
      const checkpoint = receipt(owner)
      const [head] = await Storage.readMany([[...checkpoint.slice(0, -1), "journal", "head"]])
      if (state.document.version === 2 && head) await Storage.write(checkpoint, { epoch: state.document.epoch })
      await Storage.write(key(), {
        ...state.document,
        owners: state.document.owners.filter((entry) => !sameOwner(entry, owner)),
      })
    })
  }

  export async function track(owner: RolloutSchema.Owner): Promise<void> {
    if (runtimeState().suspended) return
    const identity = RolloutSchema.Owner.parse(owner)
    Storage.afterCommit(() => {
      runtimeState().touched.set(JSON.stringify(identity), identity)
    })
    const probe = await load()
    if (probe.kind === "absent") return
    if (probe.kind === "ok" && probe.document.owners.some((entry) => sameOwner(entry, identity))) return
    await record(() =>
      Storage.transaction(async () => {
        const current = await load()
        if (current.kind === "untrusted")
          throw new RolloutRecordingError({ message: "Rollout recovery pending set is unreadable" })
        if (current.kind === "absent" || current.document.owners.some((entry) => sameOwner(entry, identity))) return
        await Storage.write(key(), { ...current.document, owners: [...current.document.owners, identity] })
      }),
    )
  }

  export async function markClean(): Promise<void> {
    const previous = await load()
    if ((previous.kind !== "ok" || previous.document.version === 1) && (await undiscoveredOwners())) return
    await record(() =>
      Storage.transaction(async () => {
        const current = await load()
        await Storage.write(
          key(),
          current.kind === "ok" ? { ...current.document, owners: [] } : { version: 1, owners: [] },
        )
      }),
    )
  }
}
