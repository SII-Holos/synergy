import { z } from "zod"
import { RuntimeContext } from "../lifecycle/context"
import { Storage } from "../storage/storage"
import { RolloutContext } from "../session/rollout/context"
import { RolloutSchema } from "../session/rollout/schema"
import { NamedError } from "@ericsanchezok/synergy-util/error"

export namespace ProcessAccessSource {
  export const Unknown = NamedError.create(
    "ProcessControlOutcomeUnknown",
    z.strictObject({
      outcome: z.literal("unknown"),
      retryable: z.literal(false),
      action: z.string(),
      processID: z.string().optional(),
      message: z.string(),
    }),
  )
  export const Ownership = RolloutSchema.ProcessRecord.pick({
    id: true,
    owner: true,
    runID: true,
    toolExecutionID: true,
  })
  export type Ownership = z.infer<typeof Ownership>
  const Caller = z.strictObject({
    sessionID: z.string().min(1),
    messageID: z.string().min(1),
    callID: z.string().min(1),
    owner: RolloutSchema.Owner,
    runID: z.string().min(1),
  })
  export type Caller = z.infer<typeof Caller>
  export interface Access {
    allows(ownership: Readonly<Ownership>): Promise<boolean>
    assert(): void
    recheck(): Promise<void>
  }
  export interface Source {
    resolve(input: Readonly<{ caller: Caller; signal: AbortSignal }>): Promise<Access>
  }
  export interface Scope {
    readonly restricted: boolean
    allows(ownership: Ownership | undefined): Promise<boolean>
    assert(): void
    recheck(): Promise<void>
  }
  const state = RuntimeContext.state(() => ({
    source: undefined as Source | undefined,
    owner: undefined as (() => void) | undefined,
  }))

  export function has() {
    return !!state().source
  }

  export function register(source: Source) {
    RuntimeContext.assertCompositionOpen("Process access source")
    const current = state()
    if (current.source) throw new Error("Process access source is already registered")
    const runtime = RuntimeContext.current()
    let original:
      | {
          primary: NonNullable<typeof runtime.storage>
          store: ReturnType<typeof Storage.current>["store"]
          directory: string
          objects: ReturnType<typeof Storage.current>["artifactObjects"]
          options: string
          blobs: unknown
          writerID: unknown
          now: unknown
        }
      | undefined
    current.source = { resolve: source.resolve.bind(source) }
    current.owner = () => {
      const primary = runtime.storage
      const storage = Storage.current()
      if (
        RuntimeContext.current() !== runtime ||
        !primary ||
        storage.store !== primary.store ||
        storage.artifactDirectory !== primary.artifactDirectory ||
        storage.artifactObjects !== primary.artifactObjects
      )
        throw new Error("Process access requires its original Runtime and actual primary Store")
      original ??= {
        primary,
        store: primary.store,
        directory: primary.artifactDirectory,
        objects: primary.artifactObjects,
        options: JSON.stringify(primary.store.options),
        blobs: primary.artifactObjects?.blobs,
        writerID: primary.artifactObjects?.writerID,
        now: primary.artifactObjects?.now,
      }
      if (
        primary !== original.primary ||
        primary.store !== original.store ||
        primary.artifactDirectory !== original.directory ||
        primary.artifactObjects !== original.objects ||
        JSON.stringify(primary.store.options) !== original.options ||
        primary.artifactObjects?.blobs !== original.blobs ||
        primary.artifactObjects?.writerID !== original.writerID ||
        primary.artifactObjects?.now !== original.now
      )
        throw new Error("Process access lost its original primary Store or artifact ports")
    }
  }

  export async function withAccess<T>(
    input: { sessionID?: string; messageID?: string; callID?: string; signal?: AbortSignal },
    body: (access: Scope) => Promise<T>,
  ): Promise<T> {
    const registration = state()
    const source = registration.source
    if (!source) return body({ restricted: false, allows: async () => true, assert() {}, async recheck() {} })
    const owner = registration.owner
    if (!owner) throw new Error("Process access source lost its registered primary owner")
    owner()
    if (Storage.inTransaction()) throw new Error("Process access source I/O must run outside a Storage transaction")
    const signal = input.signal
    const rollout = RolloutContext.current()
    if (!signal || !rollout || rollout.owner.kind !== "session" || rollout.owner.sessionID !== input.sessionID)
      throw new Error("Process access requires its genuine current Session Run caller")
    const caller = Caller.parse(
      structuredClone({
        sessionID: input.sessionID,
        messageID: input.messageID,
        callID: input.callID,
        owner: rollout.owner,
        runID: rollout.runID,
      }),
    )
    signal.throwIfAborted()
    const resolved = await source.resolve(Object.freeze({ caller, signal }))
    owner()
    signal.throwIfAborted()
    let open = true
    const pending = new Set<Promise<unknown>>()
    const assert = () => {
      owner()
      signal.throwIfAborted()
      if (!open) throw new Error("Process access callback has ended")
      resolved.assert()
    }
    const call = async <R>(action: () => Promise<R>): Promise<R> => {
      assert()
      if (Storage.inTransaction()) throw new Error("Process access source I/O must run outside a Storage transaction")
      const promise = (async () => {
        const result = await action()
        assert()
        return result
      })()
      pending.add(promise)
      try {
        return await promise
      } finally {
        pending.delete(promise)
      }
    }
    const access = Object.freeze({
      restricted: true,
      assert,
      async recheck() {
        await call(() => resolved.recheck())
      },
      async allows(value: Ownership | undefined) {
        assert()
        if (!value) return false
        const ownership = Ownership.parse(structuredClone(value))
        const allowed = await call(() => resolved.allows(ownership))
        if (typeof allowed !== "boolean") throw new Error("Process access source returned an unknown decision")
        return allowed
      },
    })
    try {
      assert()
      const result = await body(access)
      await access.recheck()
      return result
    } finally {
      open = false
      await Promise.allSettled(pending)
    }
  }
}
