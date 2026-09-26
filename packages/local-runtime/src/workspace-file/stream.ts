import fs from "node:fs/promises"
import { constants } from "node:fs"
import { WorkspaceAccess } from "@ericsanchezok/synergy-harness/workspace/access"
import { WorkspaceState } from "@ericsanchezok/synergy-harness/workspace/state"
import { Log } from "@ericsanchezok/synergy-harness/util/log"
import { FileMutation } from "../file/mutation"

export namespace WorkspaceFileStream {
  const log = Log.create({ service: "workspace-file-stream" })
  interface Resource {
    close(reason?: Error): Promise<void>
  }
  const resources = WorkspaceState.create(
    () => new Set<Resource>(),
    async (owned) => {
      const closed = await Promise.allSettled(
        [...owned].map((resource) => resource.close(new Error("Workspace file resources closed"))),
      )
      const errors = closed.flatMap((result) => (result.status === "rejected" ? [result.reason] : []))
      if (errors.length) throw new AggregateError(errors, "Workspace file streams could not be closed")
    },
  )
  export class TooLargeError extends Error {
    override name = "WorkspaceFileTooLargeError"
  }
  export async function open(input: {
    path: string
    limit: number
    signal?: AbortSignal
    validate(path: string): Promise<void>
  }) {
    const lease = await WorkspaceAccess.pin(input.signal)
    let file: Awaited<ReturnType<typeof fs.open>> | undefined
    let resource: Resource | undefined
    try {
      const target = await FileMutation.canonical(input.path)
      await input.validate(target)
      file = await fs.open(
        target,
        constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NONBLOCK | constants.O_NOFOLLOW),
      )
      await input.validate(target)
      if ((await FileMutation.canonical(input.path)) !== target) throw new FileMutation.ConflictError()
      const [stat, current] = await Promise.all([file.stat(), fs.stat(target)])
      if (!stat.isFile()) throw new FileMutation.AccessDeniedError("Access denied: path is not a regular file")
      if (stat.dev !== current.dev || stat.ino !== current.ino) throw new FileMutation.ConflictError()
      if (stat.size > input.limit)
        throw new TooLargeError(`File too large to stream (${stat.size} bytes, limit ${input.limit})`)
      input.signal?.throwIfAborted()
      const owned = resources()
      const handle = file
      let controller: ReadableStreamDefaultController<Uint8Array> | undefined
      let closing: Promise<void> | undefined
      let reading: Promise<unknown> = Promise.resolve()
      let offset = 0
      const close = (reason?: Error) => {
        if (closing) return closing
        if (reason) controller?.error(reason)
        input.signal?.removeEventListener("abort", abort)
        return (closing = (async () => {
          try {
            await reading.catch(() => {})
            await handle.close()
          } finally {
            try {
              await lease.release()
            } finally {
              owned.delete(resource!)
            }
          }
        })())
      }
      const abort = () => {
        const reason = input.signal?.reason
        void close(reason instanceof Error ? reason : new Error("File stream cancelled")).catch((error) =>
          log.warn("cancelled file stream cleanup failed", { error }),
        )
      }
      resource = { close }
      owned.add(resource)
      const stream = new ReadableStream<Uint8Array>(
        {
          start(value) {
            controller = value
          },
          async pull(value) {
            if (closing) return
            try {
              input.signal?.throwIfAborted()
              if (offset >= stat.size) {
                await close()
                value.close()
                return
              }
              const bytes = Buffer.allocUnsafe(Math.min(64 * 1024, stat.size - offset))
              const pending = handle.read(bytes, 0, bytes.length, offset)
              reading = pending
              const { bytesRead } = await pending
              if (closing) return
              if (bytesRead === 0) throw new FileMutation.ConflictError()
              offset += bytesRead
              value.enqueue(bytes.subarray(0, bytesRead))
            } catch (error) {
              if (!closing) {
                value.error(error)
                await close()
              }
            }
          },
          cancel() {
            return close()
          },
        },
        { highWaterMark: 0 },
      )
      input.signal?.addEventListener("abort", abort, { once: true })
      if (input.signal?.aborted) abort()
      return { stream, stat }
    } catch (error) {
      if (resource) await resource.close()
      else {
        try {
          await file?.close()
        } finally {
          await lease.release()
        }
      }
      throw error
    }
  }
}
