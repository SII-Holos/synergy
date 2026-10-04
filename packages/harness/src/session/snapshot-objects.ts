import fs from "node:fs/promises"
import path from "node:path"
import { SnapshotGit } from "./snapshot-git"
import { SnapshotStore } from "./snapshot-store"
import { SnapshotLease } from "./snapshot-lease"
import { withFileLock } from "@ericsanchezok/synergy-util/fs-lock"

export namespace SnapshotObjects {
  const BATCH_BYTES = 16 * 1024 * 1024
  type Pending = SnapshotGit.Blob & { missing?: boolean }

  async function importLease(repository: string, signal: AbortSignal) {
    const ready = Promise.withResolvers<void>()
    const released = Promise.withResolvers<void>()
    // Provenance: https://github.com/git/git/blob/v2.55.0/builtin/fast-import.c (keep_pack).
    // Identical concurrent packs compete for an exclusive checksum-named keep.
    const holding = withFileLock(
      { directory: SnapshotLease.directory(), key: `snapshot-import:${repository}`, signal },
      async () => {
        ready.resolve()
        await released.promise
      },
    )
    holding.catch(ready.reject)
    await ready.promise
    return {
      async [Symbol.asyncDispose]() {
        released.resolve()
        await holding
      },
    }
  }

  function quote(filename: string) {
    return (
      '"' +
      filename.replace(/[\x00-\x1f\x7f"\\]/g, (character) =>
        character === '"' || character === "\\"
          ? "\\" + character
          : "\\" + character.charCodeAt(0).toString(8).padStart(3, "0"),
      ) +
      '"'
    )
  }

  export function create(operation: SnapshotStore.Operation, signal: AbortSignal, available: Set<string>) {
    const pending = new Map<string, Pending>()
    const stats = { new: 0, reused: 0, bytes: 0, lookup: 0, write: 0, finalize: 0, wait: 0 }
    let bufferedBytes = 0
    let writer: Awaited<ReturnType<typeof SnapshotGit.blobWriter>> | undefined
    let directory: string | undefined
    let lease: Awaited<ReturnType<typeof importLease>> | undefined
    const run = (args: string[], input: string) =>
      SnapshotGit.run(
        ["git", "--git-dir", operation.repository, ...args],
        path.dirname(operation.repository),
        undefined,
        signal,
        input,
      )
    const lookup = async (unknown: Pending[]) => {
      if (unknown.length) {
        const started = performance.now()
        const result = await run(["cat-file", "--batch-check"], unknown.map((blob) => blob.hash).join("\n") + "\n")
        stats.lookup += performance.now() - started
        const lines = result.text.trim().split("\n")
        if (result.exitCode !== 0 || lines.length !== unknown.length)
          throw new SnapshotStore.StorageError(`Snapshot object lookup failed: ${result.stderr}`)
        for (const [index, blob] of unknown.entries()) {
          if (lines[index] === `${blob.hash} missing`) {
            blob.missing = true
            continue
          }
          if (lines[index] !== `${blob.hash} blob ${blob.bytes.length}`)
            throw new SnapshotStore.StorageError("Snapshot object identity or size is invalid")
          available.add(blob.hash)
          pending.delete(blob.hash)
          bufferedBytes -= blob.bytes.length
          stats.reused++
        }
      }
    }
    const flush = async (final = false) => {
      signal.throwIfAborted()
      await lookup([...pending.values()].filter((blob) => !blob.missing))
      if (!pending.size) return
      if (!writer && (pending.size > 64 || bufferedBytes >= BATCH_BYTES)) {
        if (!lease) {
          const started = performance.now()
          lease = await importLease(operation.repository, signal)
          stats.wait += performance.now() - started
          await lookup([...pending.values()])
        }
        if (!pending.size) {
          await lease[Symbol.asyncDispose]()
          lease = undefined
          return
        }
        if (pending.size > 64 || bufferedBytes >= BATCH_BYTES)
          writer = await SnapshotGit.blobWriter(operation.repository, signal)
      }
      if (!writer && !final) return
      const blobs = [...pending.values()]
      const started = performance.now()
      if (writer) await writer.write(blobs)
      else {
        directory = await fs.mkdtemp(path.join(operation.temporary, "capture-"))
        const filenames = blobs.map((blob) => path.join(directory!, blob.hash))
        const writes = await Promise.allSettled(
          blobs.map((blob, index) => fs.writeFile(filenames[index]!, blob.bytes, { flag: "wx", mode: 0o600 })),
        )
        for (const result of writes) if (result.status === "rejected") throw result.reason
        // Provenance: https://git-scm.com/docs/git-hash-object (--no-filters).
        const result = await run(
          ["hash-object", "-w", "--no-filters", "--stdin-paths"],
          filenames.map(quote).join("\n") + "\n",
        )
        if (result.exitCode !== 0 || result.text.trim() !== blobs.map((blob) => blob.hash).join("\n"))
          throw new SnapshotStore.StorageError(`Snapshot object write failed: ${result.stderr}`)
      }
      stats.write += performance.now() - started
      for (const blob of blobs) {
        available.add(blob.hash)
        stats.new++
        stats.bytes += blob.bytes.length
      }
      pending.clear()
      bufferedBytes = 0
    }
    return {
      stats,
      get bufferedBytes() {
        return bufferedBytes
      },
      async add(blob: SnapshotGit.Blob) {
        if (available.has(blob.hash)) {
          stats.reused++
          return
        }
        if (pending.has(blob.hash)) {
          stats.reused++
          return
        }
        // Flush before admission, so the lookup batch never exceeds 16 MiB.
        if (bufferedBytes + blob.bytes.length > BATCH_BYTES) await flush()
        pending.set(blob.hash, blob)
        bufferedBytes += blob.bytes.length
        if (pending.size >= 512 || bufferedBytes >= BATCH_BYTES) await flush()
      },
      async finish() {
        await flush(true)
        if (!writer) return
        const started = performance.now()
        await writer.finish()
        stats.finalize += performance.now() - started
      },
      async [Symbol.asyncDispose]() {
        try {
          await writer?.[Symbol.asyncDispose]()
        } finally {
          await lease?.[Symbol.asyncDispose]()
          if (directory) await fs.rm(directory, { recursive: true, force: true })
        }
      },
    }
  }
}
