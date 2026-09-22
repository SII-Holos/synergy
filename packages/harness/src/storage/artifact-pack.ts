import fs from "node:fs/promises"
import path from "node:path"
import { pipeline } from "node:stream/promises"
import { createReadStream, createWriteStream } from "node:fs"
import { randomUUID, createHash } from "node:crypto"
import { gzipSync, gunzipSync } from "node:zlib"
import { ArtifactLocation, MAX_COMPRESSED_ARTIFACT_BYTES } from "./artifact-location"
import { StorageConflictError, StorageIntegrityError } from "./errors"
import { isRetryableIOError } from "../util/io-retry"
import { StorageQueue } from "./queue"

function digest(bytes: Uint8Array) {
  return createHash("sha256").update(bytes).digest("hex")
}
export class ArtifactPack {
  private readonly queue = new StorageQueue("artifact.pack")
  private readonly active = new Map<string, { name: string; bytes: number }>()
  private ready = false
  constructor(private readonly root: string) {}

  private async prepareDirectory() {
    if (this.ready) return
    const created = await fs.mkdir(this.root, { recursive: true, mode: 0o700 })
    if (created && process.platform !== "win32") {
      const last = path.dirname(created)
      let current = this.root
      for (;;) {
        const directory = await fs.open(current, "r")
        try {
          await directory.sync()
        } finally {
          await directory.close()
        }
        if (current === last) break
        current = path.dirname(current)
      }
    }
    this.ready = true
  }

  async orphaned(referenced: ReadonlySet<string>) {
    const result: string[] = []
    try {
      const directory = await fs.opendir(this.root)
      for await (const entry of directory)
        if (ArtifactLocation.shape.pack.safeParse(entry.name).success && !referenced.has(entry.name))
          result.push(entry.name)
    } catch (error) {
      if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error
    }
    return result
  }

  append(content: Uint8Array, owner = ""): Promise<ArtifactLocation> {
    const original = Buffer.from(content)
    return this.queue.run(async () => {
      for (let attempt = 1; ; attempt++) {
        try {
          return await this.appendBytes(original, owner)
        } catch (error) {
          this.active.delete(owner)
          if (!isRetryableIOError(error) || attempt >= 4) throw error
          await Bun.sleep(Math.min(200, 50 * 2 ** (attempt - 1)))
        }
      }
    })
  }

  private async appendBytes(original: Buffer, owner: string): Promise<ArtifactLocation> {
    const compressed = original.length <= MAX_COMPRESSED_ARTIFACT_BYTES ? gzipSync(original, { level: 1 }) : undefined
    const smaller = compressed !== undefined && compressed.length < original.length * 0.9
    const bytes = smaller ? compressed : original
    await this.prepareDirectory()
    const previous = this.active.get(owner)
    const fresh = !previous || previous.bytes + bytes.length > 64 * 1024 * 1024
    const active = fresh ? { name: randomUUID() + ".pack", bytes: 0 } : previous
    this.active.delete(owner)
    this.active.set(owner, active)
    if (this.active.size > 128) this.active.delete(this.active.keys().next().value!)
    const file = await fs.open(path.join(this.root, active.name), fresh ? "wx" : "r+", 0o600)
    try {
      let written = 0
      while (written < bytes.length) {
        const result = await file.write(bytes, written, bytes.length - written, active.bytes + written)
        if (!result.bytesWritten) throw new StorageIntegrityError("Artifact pack write made no progress")
        written += result.bytesWritten
      }
      await file.sync()
      if (fresh && process.platform !== "win32") {
        const directory = await fs.open(this.root, "r")
        try {
          await directory.sync()
        } finally {
          await directory.close()
        }
      }
      const location: ArtifactLocation = {
        pack: active.name,
        blockOffset: active.bytes,
        blockBytes: bytes.length,
        decodedBytes: original.length,
        offset: 0,
        size: original.length,
        codec: smaller ? "gzip" : "raw",
        sha256: digest(original),
      }
      active.bytes += bytes.length
      return location
    } catch (error) {
      this.active.delete(owner)
      throw error
    } finally {
      await file.close()
    }
  }

  async prune(packs: string[]) {
    for (const pack of packs) {
      ArtifactLocation.shape.pack.parse(pack)
      await fs.rm(path.join(this.root, pack), { force: true })
      for (const [owner, active] of this.active) if (active.name === pack) this.active.delete(owner)
    }
    if (packs.length && process.platform !== "win32") {
      try {
        const directory = await fs.open(this.root, "r")
        try {
          await directory.sync()
        } finally {
          await directory.close()
        }
      } catch (error) {
        if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error
      }
    }
  }

  async adopt(input: { filename: string; sha256: string }, signal?: AbortSignal) {
    signal?.throwIfAborted()
    await this.prepareDirectory()
    const pack = input.sha256 + ".pack"
    if (!/^[a-f0-9]{64}\.pack$/.test(pack)) throw new StorageIntegrityError("Invalid immutable artifact pack identity")
    const target = path.join(this.root, pack)
    try {
      await fs.link(input.filename, target)
    } catch (error) {
      if (!(error && typeof error === "object" && "code" in error)) throw error
      if (error.code === "EXDEV") {
        const temporary = target + ".tmp-" + randomUUID()
        try {
          await pipeline(createReadStream(input.filename), createWriteStream(temporary, { flags: "wx", mode: 0o600 }), {
            signal,
          })
          const file = await fs.open(temporary, "r+")
          try {
            await file.sync()
          } finally {
            await file.close()
          }
          await fs.rename(temporary, target)
        } finally {
          await fs.rm(temporary, { force: true })
        }
      } else if (error.code === "EEXIST") {
        const stat = await fs.lstat(target)
        if (!stat.isFile() || stat.isSymbolicLink())
          throw new StorageIntegrityError("Invalid immutable artifact pack destination")
        const actual = createHash("sha256")
        for await (const bytes of createReadStream(target, { signal })) actual.update(bytes)
        if (actual.digest("hex") !== input.sha256)
          throw new StorageIntegrityError("Immutable artifact pack identity collision")
      } else throw error
    }
    if (process.platform !== "win32") {
      const directory = await fs.open(this.root, "r")
      try {
        await directory.sync()
      } finally {
        await directory.close()
      }
    }
    return pack
  }

  async read(input: ArtifactLocation, maxBytes?: number): Promise<Uint8Array> {
    const location = ArtifactLocation.parse(input)
    if (maxBytes !== undefined && location.size > maxBytes)
      throw new StorageConflictError("Binary record exceeds its byte limit")
    const file = await fs.open(path.join(this.root, location.pack), "r")
    try {
      const raw = location.codec === "raw"
      const length = raw ? location.size : location.blockBytes
      if (
        raw &&
        (location.blockBytes !== length || length > MAX_COMPRESSED_ARTIFACT_BYTES || length === 0) &&
        location.blockOffset + location.blockBytes > (await file.stat()).size
      )
        throw new StorageIntegrityError("Artifact pack is truncated")
      const stored = Buffer.alloc(length)
      const start = location.blockOffset + (raw ? location.offset : 0)
      let offset = 0
      while (offset < stored.length) {
        const read = await file.read(stored, offset, stored.length - offset, start + offset)
        if (!read.bytesRead) throw new StorageIntegrityError("Artifact pack is truncated")
        offset += read.bytesRead
      }
      let decoded: Buffer
      try {
        decoded =
          location.codec === "gzip"
            ? gunzipSync(stored, { maxOutputLength: Math.max(1, location.decodedBytes) })
            : stored
      } catch {
        throw new StorageIntegrityError("Artifact pack compression integrity check failed")
      }
      if (decoded.length !== (raw ? location.size : location.decodedBytes))
        throw new StorageIntegrityError("Artifact pack byte count is invalid")
      const value = raw ? decoded : decoded.subarray(location.offset, location.offset + location.size)
      if (digest(value) !== location.sha256)
        throw new StorageIntegrityError("Artifact pack content integrity check failed")
      return new Uint8Array(value)
    } finally {
      await file.close()
    }
  }

  async verify(input: ArtifactLocation, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted()
    const location = ArtifactLocation.parse(input)
    if (location.size <= MAX_COMPRESSED_ARTIFACT_BYTES) {
      await this.read(location)
      return
    }
    const file = await fs.open(path.join(this.root, location.pack), "r")
    try {
      if (location.blockOffset + location.blockBytes > (await file.stat()).size)
        throw new StorageIntegrityError("Artifact pack is truncated")
      const hash = createHash("sha256")
      const buffer = Buffer.alloc(1024 * 1024)
      let offset = 0
      while (offset < location.size) {
        signal?.throwIfAborted()
        const read = await file.read(
          buffer,
          0,
          Math.min(buffer.length, location.size - offset),
          location.blockOffset + location.offset + offset,
        )
        if (!read.bytesRead) throw new StorageIntegrityError("Artifact pack is truncated")
        hash.update(buffer.subarray(0, read.bytesRead))
        offset += read.bytesRead
      }
      if (hash.digest("hex") !== location.sha256)
        throw new StorageIntegrityError("Artifact pack content integrity check failed")
    } finally {
      await file.close()
    }
  }
}
