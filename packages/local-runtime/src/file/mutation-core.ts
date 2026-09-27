import { createHash, randomUUID } from "node:crypto"
import fs from "node:fs/promises"
import { constants } from "node:fs"
import path from "node:path"
import { withFileLock } from "@ericsanchezok/synergy-util/fs-lock"
import { retry } from "@ericsanchezok/synergy-util/retry"
import { FileCoordination } from "./coordination"

export namespace NativeFileMutation {
  export async function readText(input: string): Promise<string> {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(await fs.readFile(input))
  }
  export class ConflictError extends Error {
    override name = "WorkspaceFileWriteConflictError"
    constructor() {
      super("File changed on disk; read it again before writing")
    }
  }
  export const AccessDeniedError = FileCoordination.AccessDeniedError
  export const canonical = FileCoordination.canonical
  export const lockDirectory = FileCoordination.lockDirectory

  export async function snapshot(input: string, signal?: AbortSignal) {
    const flags = constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NONBLOCK | constants.O_NOFOLLOW)
    const file = await fs.open(input, flags).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error
    })
    if (!file) return null
    try {
      const before = await file.stat({ bigint: true })
      if (!before.isFile()) throw new AccessDeniedError("Access denied: path is not a regular file")
      const hash = createHash("sha256")
      const buffer = Buffer.allocUnsafe(64 * 1024)
      for (;;) {
        signal?.throwIfAborted()
        const { bytesRead } = await file.read(buffer, 0, buffer.length, null)
        if (!bytesRead) break
        hash.update(buffer.subarray(0, bytesRead))
      }
      const after = await file.stat({ bigint: true })
      if (before.ctimeNs !== after.ctimeNs || before.mtimeNs !== after.mtimeNs || before.size !== after.size)
        throw new ConflictError()
      return {
        version: `sha256:${hash.digest("hex")}`,
        mode: Number(after.mode),
        size: Number(after.size),
        mtime: Number(after.mtimeNs) / 1e6,
      }
    } finally {
      await file.close()
    }
  }

  export async function write(
    input: {
      path: string
      content: string | Uint8Array
      expectedVersion?: string | null
      createParents?: boolean
      signal?: AbortSignal
      validate?(target: string): Promise<void>
    },
    canonicalTarget?: string,
  ) {
    const target = canonicalTarget ?? (await canonical(input.path))
    return withFileLock({ directory: await lockDirectory(), key: target, signal: input.signal }, async () => {
      input.signal?.throwIfAborted()
      await input.validate?.(target)
      const before = await snapshot(target, input.signal)
      if (input.expectedVersion !== undefined && input.expectedVersion !== (before?.version ?? null))
        throw new ConflictError()
      if (before && (before.mode & 0o222) === 0) throw new AccessDeniedError("Access denied: file is read-only")
      const parent = path.dirname(target)
      if (input.createParents) await fs.mkdir(parent, { recursive: true })
      const parentBefore = await fs.stat(parent, { bigint: true })
      const temporary = path.join(parent, `.${path.basename(target)}.synergy-write-${process.pid}-${randomUUID()}`)
      try {
        const file = await fs.open(temporary, "wx", before ? before.mode & 0o777 : 0o666)
        try {
          await file.writeFile(input.content)
          if (before) await file.chmod(before.mode & 0o777)
          await file.sync()
        } finally {
          await file.close()
        }
        await retry(
          async () => {
            input.signal?.throwIfAborted()
            if ((await canonical(input.path)) !== target) throw new ConflictError()
            await input.validate?.(target)
            const current = await snapshot(target, input.signal)
            const parentAfter = await fs.stat(parent, { bigint: true })
            if (
              (current?.version ?? null) !== (before?.version ?? null) ||
              current?.mode !== before?.mode ||
              parentBefore.dev !== parentAfter.dev ||
              parentBefore.ino !== parentAfter.ino
            )
              throw new ConflictError()
            if (before) await fs.rename(temporary, target)
            else
              await fs.link(temporary, target).catch((error: NodeJS.ErrnoException) => {
                if (error.code === "EEXIST") throw new ConflictError()
                throw error
              })
          },
          {
            attempts: 6,
            delay: 25,
            maxDelay: 150,
            signal: input.signal,
            retryIf: (error) =>
              process.platform === "win32" && ["EBUSY", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? ""),
          },
        )
        if (process.platform !== "win32") {
          const directory = await fs.open(parent, constants.O_RDONLY)
          try {
            await directory.sync()
          } finally {
            await directory.close()
          }
        }
        const after = await fs.stat(target)
        return {
          mtime: after.mtimeMs,
          size: Buffer.byteLength(input.content),
          existed: before !== null,
          contentVersion: `sha256:${createHash("sha256").update(input.content).digest("hex")}`,
        }
      } finally {
        await fs.unlink(temporary).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== "ENOENT") throw error
        })
      }
    })
  }
}
