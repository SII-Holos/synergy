import { WorkspaceAccess } from "@ericsanchezok/synergy-harness/workspace/access"
import { NativeFileMutation } from "./mutation-core"

export namespace FileMutation {
  export const readText = NativeFileMutation.readText
  export const snapshot = NativeFileMutation.snapshot
  export const canonical = NativeFileMutation.canonical
  export const lockDirectory = NativeFileMutation.lockDirectory
  export const ConflictError = NativeFileMutation.ConflictError
  export const AccessDeniedError = NativeFileMutation.AccessDeniedError

  export async function write(input: Parameters<typeof NativeFileMutation.write>[0]) {
    const target = await canonical(input.path)
    return WorkspaceAccess.write([target], () => NativeFileMutation.write(input, target), input.signal)
  }
}
