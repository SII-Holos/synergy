import { WorkspaceAccess } from "@ericsanchezok/synergy-harness/workspace/access"
import { FileView } from "./view"
import { NativeFileMutation } from "./mutation-core"

export namespace FileMutation {
  export function readText(filename: string) {
    return FileView.native() ? NativeFileMutation.readText(filename) : FileView.file(filename).text()
  }
  export const snapshot = NativeFileMutation.snapshot
  export const canonical = NativeFileMutation.canonical
  export const lockDirectory = NativeFileMutation.lockDirectory
  export const ConflictError = NativeFileMutation.ConflictError
  export const AccessDeniedError = NativeFileMutation.AccessDeniedError

  export async function write(input: Parameters<typeof NativeFileMutation.write>[0] & { protectSensitive?: boolean }) {
    if (!FileView.native()) {
      if (input.validate) await input.validate(FileView.resolve(input.path))
      const data = typeof input.content === "string" ? new TextEncoder().encode(input.content) : input.content
      const current =
        input.expectedVersion === undefined
          ? (await FileView.file(input.path).exists())
            ? `sha256:${new Bun.CryptoHasher("sha256").update(await FileView.bytes(input.path)).digest("hex")}`
            : null
          : input.expectedVersion
      if (
        !input.createParents &&
        !(await FileView.stat(FileView.display(input.path).split("/").slice(0, -1).join("/")))
      )
        throw new Error("Workspace parent directory is absent")
      return FileView.write(input.path, data, current, input.signal, input.protectSensitive)
    }
    const target = await canonical(input.path)
    return WorkspaceAccess.write([target], () => NativeFileMutation.write(input, target), input.signal)
  }
}
