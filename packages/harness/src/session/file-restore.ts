import { randomUUID } from "node:crypto"
import { z } from "zod"
import { Identifier } from "../id/id"
import { ScopeContext } from "../scope/context"
import { Storage } from "../storage/storage"
import { StoragePath } from "../storage/path"
import { Lock } from "../util/lock"
import { SessionManager } from "./manager"
import { Snapshot } from "./snapshot"
import { SnapshotRestore } from "./snapshot-restore"
import { RuntimeContext } from "../lifecycle/context"

export namespace SessionFileRestore {
  export const Result = SnapshotRestore.Result.extend({
    patchPartIDs: z.array(Identifier.schema("part")),
    rollbackID: Identifier.schema("history").optional(),
    messageID: Identifier.schema("message").optional(),
    partID: Identifier.schema("part").optional(),
  }).meta({ ref: "SessionFileRestoreResult" })
  export const Preview = z
    .object({
      id: z.string().uuid(),
      expiresAt: z.number(),
      files: z.array(SnapshotRestore.PreviewFile),
    })
    .meta({ ref: "SessionFileRestorePreview" })
  const Record = z.object({
    version: z.literal(1),
    status: z.enum(["prepared", "applying", "complete"]),
    authority: z.string(),
    expiresAt: z.number(),
    patches: z.array(Snapshot.Patch),
    files: z.array(SnapshotRestore.PreviewFile.pick({ file: true, workspace: true, version: true })),
    metadata: Result.omit({ restoredFiles: true, failedFiles: true }),
    result: Result.optional(),
  })
  const authority = RuntimeContext.state(() => randomUUID())
  function key(sessionID: string, id: string) {
    return StoragePath.sessionFileRestore(
      Identifier.asScopeID(ScopeContext.current.scope.id),
      Identifier.asSessionID(sessionID),
      id,
    )
  }
  export async function prepare(input: {
    sessionID: string
    patches: Snapshot.Patch[]
    metadata: z.infer<typeof Record>["metadata"]
    signal?: AbortSignal
  }) {
    const files = await Snapshot.previewRestore(input.patches, input.sessionID, input.signal)
    const preview = { id: randomUUID(), expiresAt: Date.now() + 60 * 60 * 1000, files }
    await Storage.write(
      key(input.sessionID, preview.id),
      Record.parse({
        version: 1,
        status: "prepared",
        authority: authority(),
        expiresAt: preview.expiresAt,
        patches: input.patches,
        files,
        metadata: input.metadata,
      }),
    )
    return preview
  }
  export async function apply(
    sessionID: string,
    previewID: string,
    signal?: AbortSignal,
  ): Promise<z.infer<typeof Result>> {
    using lock = await Lock.write(`file-restore:${ScopeContext.current.scope.id}:${sessionID}:${previewID}`)
    const recordKey = key(sessionID, previewID)
    const stored = Record.parse(await Storage.read(recordKey))
    if (stored.status === "complete" && stored.result) return stored.result
    if (stored.authority !== authority())
      throw new SnapshotRestore.Invalid({ message: "Refresh the restore preview after reconnecting to this Runtime" })
    if (stored.status === "applying")
      throw new SnapshotRestore.Invalid({
        message: "Restoration was interrupted. Refresh the preview before another attempt.",
      })
    if (stored.expiresAt < Date.now()) throw new SnapshotRestore.Invalid({ message: "The restore preview has expired" })
    return SessionManager.run(
      sessionID,
      async (lease) => {
        const abort = signal ? AbortSignal.any([signal, lease.signal]) : lease.signal
        abort.throwIfAborted()
        await Storage.transaction(async () => {
          const latest = Record.parse(await Storage.read(recordKey))
          if (latest.status !== "prepared")
            throw new SnapshotRestore.Invalid({ message: "This restore request was already submitted" })
          await Storage.write(recordKey, { ...stored, status: "applying" })
        })
        let result: z.infer<typeof Result>
        try {
          const restored = await Snapshot.revert(stored.patches, sessionID, abort, stored.files)
          result = { ...restored, ...stored.metadata }
        } catch (error) {
          result = {
            ...stored.metadata,
            restoredFiles: [],
            failedFiles: stored.files.map((file) => ({
              file: file.file,
              code:
                error instanceof Error && error.name === "WorkspaceFileWriteConflictError"
                  ? "conflict"
                  : "restore_failed",
              message: error instanceof Error ? error.message : "File restoration failed",
            })),
          }
        }
        await Storage.write(recordKey, { ...stored, status: "complete", result })
        return result
      },
      { workspace: "history" },
    )
  }
}
