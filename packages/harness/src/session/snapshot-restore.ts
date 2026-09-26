import { z } from "zod"
import { NamedError } from "@ericsanchezok/synergy-util/error"
import { RuntimeContext } from "../lifecycle/context"
import { SnapshotSchema } from "./snapshot-schema"

export namespace SnapshotRestore {
  export const Result = z.object({
    restoredFiles: z.array(z.string()),
    failedFiles: z.array(z.object({ file: z.string(), code: z.string(), message: z.string() })),
  })
  export type Result = z.infer<typeof Result>
  export const Invalid = NamedError.create("SnapshotRestoreUnavailable", z.object({ message: z.string() }))
  export interface File {
    file: string
    workspace: SnapshotSchema.Workspace
    mode: "100644" | "100755" | "120000" | null
    read(): Promise<Uint8Array>
  }
  export interface Host {
    restore(input: { files: File[]; signal?: AbortSignal }): Promise<Result>
  }
  const state = RuntimeContext.state(() => ({ host: undefined as Host | undefined }))
  export function register(host: Host) {
    RuntimeContext.assertCompositionOpen("Snapshot restore")
    if (state().host) throw new Error("Snapshot restore Host is already registered")
    state().host = host
  }
  export function apply(input: Parameters<Host["restore"]>[0]) {
    if (!input.files.length) return Promise.resolve({ restoredFiles: [], failedFiles: [] })
    const host = state().host
    if (!host) throw new Invalid({ message: "This Runtime cannot restore local files" })
    return host.restore(input)
  }
}
