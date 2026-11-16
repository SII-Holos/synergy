import fs from "node:fs/promises"
import { constants, type Stats } from "node:fs"
import path from "node:path"
import { createHash } from "node:crypto"
import { z } from "zod"
import { AssetReference } from "@ericsanchezok/synergy-util/asset-reference"
import { AtomicFile } from "@ericsanchezok/synergy-util/atomic-file"
import { isRetryableIOError } from "@ericsanchezok/synergy-util/io-retry"
import { Global } from "../global"
import { Lock } from "../util/lock"
import { StorageIntegrityError } from "../storage/errors"

export namespace NativeAssetContent {
  export interface Content {
    id: string
    bytes: number
    sha256: string
    stream(signal?: AbortSignal): AsyncIterable<Uint8Array>
  }
  export interface Install {
    id: string
    bytes: number
    sha256: string
    content: AsyncIterable<Uint8Array>
    signal?: AbortSignal
    durable?: boolean
  }
  const Hash = z.string().regex(/^[a-f0-9]{64}$/)
  const filename = (id: string) => path.join(Global.Path.assets, id)
  const version = (stat: Stats) => JSON.stringify([stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs])
  const valid = (id: string) => {
    if (!AssetReference.isValidId(id)) throw new StorageIntegrityError("Invalid Asset identifier")
  }

  async function file(id: string) {
    valid(id)
    const target = filename(id)
    const stat = await fs.lstat(target)
    if (!stat.isFile() || stat.isSymbolicLink())
      throw new StorageIntegrityError("Asset content is not a regular owned file")
    if ((await fs.realpath(target)) !== path.join(await fs.realpath(Global.Path.assets), id))
      throw new StorageIntegrityError("Asset content escapes its owner directory")
    const handle = await fs.open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    const opened = await handle.stat()
    if (!opened.isFile() || version(opened) !== version(stat)) {
      await handle.close()
      throw new StorageIntegrityError("Asset content changed while opening")
    }
    return { handle, stat: opened }
  }

  async function* read(
    id: string,
    expected: { bytes: number; sha256?: string; version: string },
    signal?: AbortSignal,
  ) {
    signal?.throwIfAborted()
    const opened = await file(id)
    try {
      if (version(opened.stat) !== expected.version)
        throw new StorageIntegrityError("Asset content changed after preparation")
      const hash = createHash("sha256")
      const buffer = Buffer.alloc(Math.min(4 * 1024 * 1024, Math.max(1, expected.bytes)))
      let size = 0
      for (;;) {
        signal?.throwIfAborted()
        const { bytesRead } = await opened.handle.read(buffer, 0, buffer.length, size)
        if (!bytesRead) break
        size += bytesRead
        if (size > expected.bytes) throw new StorageIntegrityError("Asset content byte count changed")
        const bytes = buffer.subarray(0, bytesRead)
        hash.update(bytes)
        yield new Uint8Array(bytes)
      }
      if (size !== expected.bytes || version(await opened.handle.stat()) !== expected.version)
        throw new StorageIntegrityError("Asset content byte count or version changed")
      const sha256 = hash.digest("hex")
      if (!sha256.startsWith(id.split(".")[0]!) || (expected.sha256 !== undefined && expected.sha256 !== sha256))
        throw new StorageIntegrityError("Asset content checksum mismatch")
    } finally {
      await opened.handle.close()
    }
  }

  export async function open(id: string, signal?: AbortSignal): Promise<Content | undefined> {
    valid(id)
    const opened = await file(id).catch((error) => {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return
      throw error
    })
    if (!opened) return
    const expected = { bytes: opened.stat.size, version: version(opened.stat) }
    await opened.handle.close()
    if (!Number.isSafeInteger(expected.bytes))
      throw new StorageIntegrityError("Asset content byte count exceeds a safe integer")
    const hash = createHash("sha256")
    for await (const block of read(id, expected, signal)) hash.update(block)
    const sha256 = hash.digest("hex")
    return { id, bytes: expected.bytes, sha256, stream: (signal) => read(id, { ...expected, sha256 }, signal) }
  }

  export function install(input: Install) {
    return write(input, false)
  }

  export function materialize(input: Install) {
    return write(input, true)
  }

  async function write(input: Install, cache: boolean) {
    valid(input.id)
    Hash.parse(input.sha256)
    z.number().int().nonnegative().safe().parse(input.bytes)
    if (!input.sha256.startsWith(input.id.split(".")[0]!))
      throw new StorageIntegrityError("Asset checksum does not match its identifier")
    using lease = await Lock.write("asset-content:" + input.id)
    input.signal?.throwIfAborted()
    await fs.mkdir(Global.Path.assets, { recursive: true, mode: 0o700 })
    const previous = cache ? undefined : await open(input.id, input.signal)
    if (previous) {
      if (previous.sha256 !== input.sha256 || previous.bytes !== input.bytes)
        throw new StorageIntegrityError("Asset identifier collides with existing content")
      const hash = createHash("sha256")
      let bytes = 0
      for await (const block of input.content) {
        input.signal?.throwIfAborted()
        bytes += block.length
        if (!Number.isSafeInteger(bytes) || bytes > input.bytes)
          throw new StorageIntegrityError("Asset import byte count mismatch")
        hash.update(block)
      }
      if (bytes !== input.bytes || hash.digest("hex") !== input.sha256)
        throw new StorageIntegrityError("Asset import byte count or checksum mismatch")
      if (input.durable !== false) {
        const retained = await file(input.id)
        try {
          await retained.handle.sync()
        } finally {
          await retained.handle.close()
        }
        await AtomicFile.syncDirectories(Global.Path.assets)
      }
      return { id: input.id, bytes: input.bytes, sha256: input.sha256, created: false }
    }
    const temporary = path.join(Global.Path.assets, ".import-" + crypto.randomUUID())
    const handle = await fs.open(temporary, "wx", 0o600)
    let closed = false
    try {
      const hash = createHash("sha256")
      let size = 0
      for await (const bytes of input.content) {
        input.signal?.throwIfAborted()
        if (!Number.isSafeInteger(size + bytes.length) || size + bytes.length > input.bytes)
          throw new StorageIntegrityError("Asset import byte count mismatch")
        hash.update(bytes)
        for (let offset = 0; offset < bytes.length;) {
          const written = await handle.write(bytes, offset, bytes.length - offset, size + offset)
          if (!written.bytesWritten) throw new StorageIntegrityError("Asset import made no progress")
          offset += written.bytesWritten
        }
        size += bytes.length
      }
      if (size !== input.bytes) throw new StorageIntegrityError("Asset import byte count mismatch")
      if (hash.digest("hex") !== input.sha256) throw new StorageIntegrityError("Asset import checksum mismatch")
      if (input.durable !== false) await handle.sync()
      await handle.close()
      closed = true
      input.signal?.throwIfAborted()
      for (let attempt = 1; ; attempt++) {
        try {
          if (cache) await fs.rename(temporary, filename(input.id))
          else await fs.link(temporary, filename(input.id))
          break
        } catch (error) {
          if (error && typeof error === "object" && "code" in error && error.code === "EEXIST") {
            const latest = await open(input.id, input.signal)
            if (latest?.sha256 === input.sha256 && latest.bytes === input.bytes)
              return { id: input.id, bytes: input.bytes, sha256: input.sha256, created: false }
            throw new StorageIntegrityError("Asset identifier collides with concurrent content", { cause: error })
          }
          if (!isRetryableIOError(error) || attempt >= 4) throw error
          input.signal?.throwIfAborted()
          await Bun.sleep(Math.min(200, 50 * 2 ** (attempt - 1)))
        }
      }
      if (input.durable !== false) await AtomicFile.syncDirectories(Global.Path.assets)
      return { id: input.id, bytes: input.bytes, sha256: input.sha256, created: true }
    } finally {
      if (!closed) await handle.close()
      await fs.rm(temporary, { force: true })
    }
  }
}
