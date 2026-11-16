import { z } from "zod"
import { ActorStamp } from "@ericsanchezok/synergy-util/actor-stamp"
import { ScopeContext } from "../scope/context"
import { Storage } from "../storage/storage"
import { StoragePath } from "../storage/path"
import { StorageConflictError, StorageIntegrityError } from "../storage/errors"

export namespace SessionDecisionReceipts {
  export const Outcome = z.discriminatedUnion("kind", [
    z.strictObject({
      kind: z.literal("permission"),
      reply: z.enum(["once", "session", "always", "reject"]),
      causedBy: z.string().optional(),
    }),
    z.strictObject({
      kind: z.literal("question"),
      reply: z.enum(["answer", "reject"]),
      answers: z.array(z.array(z.string())).optional(),
    }),
  ])
  export const Receipt = z.strictObject({
    schemaVersion: z.literal(1),
    scopeID: z.string(),
    sessionID: z.string(),
    requestID: z.string(),
    actor: ActorStamp.Info.optional(),
    decidedAt: z.number().int().nonnegative(),
    outcome: Outcome,
  })
  export type Receipt = z.infer<typeof Receipt>
  export type Target = { sessionID: string; requestID: string; kind: Receipt["outcome"]["kind"] }
  export type Result =
    { status: "resolved" | "already_resolved"; receipt: Receipt } | { status: "expired"; receipt?: never }

  const key = (target: Target) =>
    StoragePath.sessionDecisionReceipt(ScopeContext.current.scope.id, target.sessionID, target.kind, target.requestID)
  export async function read(target: Target) {
    const [stored] = await Storage.readMany<unknown>([key(target)])
    if (stored === undefined) return
    const receipt = Receipt.parse(stored)
    if (
      receipt.scopeID !== ScopeContext.current.scope.id ||
      receipt.sessionID !== target.sessionID ||
      receipt.requestID !== target.requestID ||
      receipt.outcome.kind !== target.kind
    )
      throw new StorageIntegrityError("Native decision receipt identity does not match its owner")
    return receipt
  }

  export async function record(input: Omit<Receipt, "schemaVersion" | "scopeID" | "decidedAt">) {
    if (!Storage.inTransaction())
      throw new StorageConflictError("Native decision receipts require the owning write transaction")
    const target = { ...input, kind: input.outcome.kind }
    if (await read(target)) throw new StorageConflictError("Native decision is already resolved")
    const receipt = Receipt.parse({
      ...input,
      schemaVersion: 1,
      scopeID: ScopeContext.current.scope.id,
      decidedAt: Date.now(),
    })
    await Storage.write(key(target), receipt)
    return receipt
  }
}
