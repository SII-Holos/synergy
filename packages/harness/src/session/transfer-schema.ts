import { SessionTransferState } from "./transfer-state"
import { NamedError } from "@ericsanchezok/synergy-util/error"
import { z } from "zod"
import { Scope } from "../scope"
import { RuntimeComponents } from "../lifecycle/components"
import { WorkspaceTree } from "../workspace/tree"
import { WorkspaceCatalog } from "../workspace/catalog"

export namespace SessionTransferSchema {
  export const Rejected = NamedError.create("SessionTransferRejected", z.object({ message: z.string() }))
  export const ID = z.string().uuid()
  export const Hash = z.string().regex(/^[a-f0-9]{64}$/)
  export const Host = z
    .object({ id: ID, version: z.string(), platform: z.string(), components: z.array(RuntimeComponents.Info) })
    .meta({ ref: "SessionTransferHost" })
  export const Prepare = z.object({ migrationID: ID, targetID: ID }).strict().meta({ ref: "SessionTransferPrepare" })
  export const Receipt = z
    .object({
      migrationID: ID,
      sessionID: z.string(),
      sourceID: ID,
      targetID: ID,
      digest: Hash,
      phase: z.enum(["prepared", "activated"]),
    })
    .strict()
    .meta({ ref: "SessionTransferReceipt" })
  export const Activation = Receipt.extend({ phase: z.literal("prepared"), secret: Hash })
    .strict()
    .meta({ ref: "SessionTransferActivation" })
  export const Cancellation = z
    .object({ migrationID: ID, sessionID: z.string(), sourceID: ID, targetID: ID, secret: Hash })
    .strict()
    .meta({ ref: "SessionTransferCancellation" })
  export const State = SessionTransferState
  export const File = z
    .object({
      path: z
        .string()
        .regex(/^[a-zA-Z0-9_/-]+(?:\.[a-z]+)?$/)
        .refine((value) => value.split("/").every((part) => !!part && part !== "." && part !== "..")),
      bytes: z
        .number()
        .int()
        .nonnegative()
        .max(64 * 1024 * 1024),
      sha256: Hash,
    })
    .strict()
  export const Manifest = z
    .object({
      format: z.literal("synergy-session-transfer"),
      version: z.literal(1),
      migrationID: ID,
      sessionID: z.string(),
      source: Host,
      targetID: ID,
      activationHash: Hash,
      cancellationHash: Hash,
      scope: Scope.Runtime,
      records: z.array(z.string()),
      artifacts: z.array(z.object({ key: z.array(z.string().min(1)), file: z.string() }).strict()),
      workspace: z
        .object({
          info: WorkspaceCatalog.Info,
          tree: WorkspaceTree.Manifest,
          chunks: z.array(z.object({ hash: WorkspaceTree.Hash, file: z.string() }).strict()),
        })
        .strict()
        .optional(),
      snapshots: z.object({ roots: z.array(z.string().regex(/^[a-f0-9]{40}$/)), packs: z.array(z.string()) }).strict(),
      files: z.array(File).max(100_000),
    })
    .strict()
  export type Manifest = z.infer<typeof Manifest>
  export type Receipt = z.infer<typeof Receipt>
  export type Activation = z.infer<typeof Activation>
  export type State = z.infer<typeof State>
  export const Record = z.object({ key: z.array(z.string().min(1)).min(1), value: z.unknown() }).strict()
}
