import { WorkspaceAccess } from "@ericsanchezok/synergy-harness/workspace/access"
import { FileView } from "./view"
import { NativeFileMutation } from "./mutation-core"
import { createHash } from "node:crypto"

export namespace FileMutation {
  export function readText(filename: string) {
    return FileView.native() ? NativeFileMutation.readText(filename) : FileView.file(filename).text()
  }
  export async function snapshot(
    filename: string,
    signal?: AbortSignal,
  ): ReturnType<typeof NativeFileMutation.snapshot> {
    if (FileView.native()) return NativeFileMutation.snapshot(filename, signal)
    const before = await FileView.stat(filename)
    if (!before) return null
    if (before.kind !== "file") throw new AccessDeniedError("Access denied: path is not a regular file")
    const hash = createHash("sha256")
    for (let offset = 0; offset < before.size; ) {
      signal?.throwIfAborted()
      const bytes = await FileView.bytes(filename, { offset, length: Math.min(before.size - offset, 4 * 1024 * 1024) })
      if (!bytes.length) throw new ConflictError()
      hash.update(bytes)
      offset += bytes.length
    }
    if ((await FileView.stat(filename))?.entryVersion !== before.entryVersion) throw new ConflictError()
    return {
      version: `sha256:${hash.digest("hex")}`,
      mode: before.mode | 0o100000,
      size: before.size,
      mtime: before.mtime,
    }
  }
  export const canonical = FileView.canonical
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
