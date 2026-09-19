import { createHash, randomUUID } from "node:crypto"
import fs from "node:fs/promises"
import { createReadStream } from "node:fs"
import path from "node:path"
import { promisify } from "node:util"
import { gzip as gzipCallback, gunzipSync } from "node:zlib"
import { z } from "zod"
import { AtomicFile } from "./atomic-file"
import { StorageIntegrityError } from "./errors"
import { fileDigest } from "./file-digest"
import { legacyBinaryKey, legacySources, sourcePath } from "./legacy-source"

const MAX_GROUP_BYTES = 4 * 1024 * 1024
const MAX_GROUP_FILES = 1024
const gzip = promisify(gzipCallback)
const COMPRESSION_FLIGHTS = 8
const Entry = z
  .object({
    relative: z.string(),
    size: z.number().int().nonnegative().safe(),
    hash: z.string().regex(/^[a-f0-9]{64}$/),
    linkTarget: z.string().optional(),
  })
  .strict()
const Group = z
  .object({
    version: z.literal(2),
    sequence: z.number().int().nonnegative(),
    codec: z.enum(["frames", "raw"]),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    files: z.number().int().positive().max(MAX_GROUP_FILES),
    bytes: z.number().int().nonnegative().safe(),
    storedBytes: z.number().int().nonnegative().safe(),
    entry: Entry.optional(),
  })
  .strict()
const Manifest = z
  .object({
    version: z.literal(2),
    selection: z.enum(["home", "artifacts"]),
    source: z.string().regex(/^[a-f0-9]{64}$/),
    groups: z.number().int().nonnegative(),
    files: z.number().int().nonnegative(),
    bytes: z.number().int().nonnegative().safe(),
    storedBytes: z.number().int().nonnegative().safe(),
    inventorySHA256: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict()
export type PackedBackupManifest = z.infer<typeof Manifest>
export type PackedBackupEntry = z.infer<typeof Entry> & {
  group: number
  index: number
  data?: Buffer
  filename?: string
  packed: {
    filename: string
    sha256: string
    codec: "raw" | "gzip"
    storedBytes: number
    decodedBytes: number
    blockOffset: number
    offset: number
  }
}

function hash(data: Uint8Array | string) {
  return createHash("sha256").update(data).digest("hex")
}
function groupName(sequence: number) {
  return String(sequence).padStart(10, "0")
}
async function optionalJSON(filename: string): Promise<unknown | undefined> {
  try {
    return JSON.parse(await fs.readFile(filename, "utf8")) as unknown
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return
    throw error
  }
}
async function syncDirectory(directory: string) {
  if (process.platform === "win32") return
  const handle = await fs.open(directory, "r")
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

export class PackedBackup {
  constructor(
    private readonly options: {
      dataRoot: string
      backupRoot: string
      selection?: "home" | "artifacts"
      capacity?: (bytes: number) => Promise<void>
      progress?: (value: { files: number; bytes: number; storedBytes: number }) => void
    },
  ) {}

  private chunk(sequence: number) {
    return path.join(this.options.backupRoot, "chunks", groupName(sequence))
  }
  private descriptor(sequence: number) {
    return path.join(this.options.backupRoot, "groups", groupName(sequence) + ".json")
  }
  async manifest() {
    const value = await optionalJSON(path.join(this.options.backupRoot, "manifest.json"))
    return value === undefined ? undefined : Manifest.parse(value)
  }

  private async readGroup(sequence: number) {
    const text = await fs.readFile(this.descriptor(sequence), "utf8")
    const group = Group.parse(JSON.parse(text))
    const filename = this.chunk(sequence)
    if (
      group.sequence !== sequence ||
      (await fs.stat(filename)).size !== group.storedBytes ||
      (await fileDigest(filename, group.storedBytes)) !== group.sha256
    )
      throw new StorageIntegrityError("Packed backup failed its integrity check")
    const entries: PackedBackupEntry[] = []
    if (group.codec === "raw") {
      if (
        !group.entry ||
        group.files !== 1 ||
        group.entry.linkTarget !== undefined ||
        group.bytes !== group.entry.size ||
        group.entry.hash !== group.sha256
      )
        throw new StorageIntegrityError("Packed backup raw entry is invalid")
      sourcePath(this.options.dataRoot, group.entry.relative)
      entries.push({
        ...group.entry,
        group: sequence,
        index: 0,
        filename,
        packed: {
          filename,
          sha256: group.sha256,
          codec: "raw",
          storedBytes: group.storedBytes,
          decodedBytes: group.bytes,
          blockOffset: 0,
          offset: 0,
        },
      })
    } else {
      if (group.entry) throw new StorageIntegrityError("Packed backup group has conflicting encodings")
      const packed = await fs.readFile(filename)
      if (packed.length < 4) throw new StorageIntegrityError("Packed backup index frame is truncated")
      const indexBytes = packed.readUInt32BE(0)
      if (indexBytes > packed.length - 4) throw new StorageIntegrityError("Packed backup index frame is invalid")
      let metadata: Array<z.infer<typeof Entry> & { codec: "raw" | "gzip"; storedBytes: number }>
      try {
        const decoded = gunzipSync(packed.subarray(4, indexBytes + 4), { maxOutputLength: 8 * 1024 * 1024 })
        metadata = z
          .array(
            Entry.extend({
              codec: z.enum(["raw", "gzip"]),
              storedBytes: z.number().int().nonnegative().max(MAX_GROUP_BYTES),
            }).strict(),
          )
          .max(MAX_GROUP_FILES)
          .parse(JSON.parse(decoded.toString("utf8")))
      } catch {
        throw new StorageIntegrityError("Packed backup index integrity check failed")
      }
      let offset = 4 + indexBytes
      let bytes = 0
      for (const { codec, storedBytes, ...entry } of metadata) {
        sourcePath(this.options.dataRoot, entry.relative)
        if (offset + storedBytes > packed.length || entry.size > MAX_GROUP_BYTES)
          throw new StorageIntegrityError("Packed backup entry content is truncated")
        const stored = packed.subarray(offset, offset + storedBytes)
        let data: Buffer
        try {
          data = codec === "gzip" ? gunzipSync(stored, { maxOutputLength: Math.max(1, entry.size) }) : stored
        } catch {
          throw new StorageIntegrityError("Packed backup compression integrity check failed")
        }
        if (
          (entry.linkTarget === undefined && data.length !== entry.size) ||
          (entry.linkTarget !== undefined && storedBytes !== 0) ||
          hash(entry.linkTarget ?? data) !== entry.hash
        )
          throw new StorageIntegrityError("Packed backup entry integrity check failed")
        entries.push({
          ...entry,
          group: sequence,
          index: entries.length,
          data,
          packed: {
            filename,
            sha256: group.sha256,
            codec,
            storedBytes,
            decodedBytes: data.length,
            blockOffset: offset,
            offset: 0,
          },
        })
        bytes += entry.size
        offset += storedBytes
      }
      if (offset !== packed.length) throw new StorageIntegrityError("Packed backup group has trailing content")
      if (entries.length !== group.files || bytes !== group.bytes)
        throw new StorageIntegrityError("Packed backup group counts are invalid")
    }
    return { group, text, entries }
  }

  async *entries(): AsyncGenerator<PackedBackupEntry> {
    const manifest = await this.manifest()
    if (!manifest) throw new StorageIntegrityError("Packed backup is not sealed")
    const inventory = createHash("sha256")
    let files = 0,
      bytes = 0,
      storedBytes = 0
    for (let sequence = 0; sequence < manifest.groups; sequence++) {
      const result = await this.readGroup(sequence)
      inventory.update(result.text)
      files += result.group.files
      bytes += result.group.bytes
      storedBytes += result.group.storedBytes
      yield* result.entries
    }
    if (
      files !== manifest.files ||
      bytes !== manifest.bytes ||
      storedBytes !== manifest.storedBytes ||
      inventory.digest("hex") !== manifest.inventorySHA256
    )
      throw new StorageIntegrityError("Packed backup inventory integrity check failed")
  }

  private async *sources() {
    for await (const entry of legacySources(this.options.dataRoot))
      if (this.options.selection !== "artifacts" || legacyBinaryKey(entry.relative)) yield entry
  }

  async create(): Promise<PackedBackupManifest> {
    const { dataRoot, backupRoot, progress } = this.options
    const source = hash(await fs.realpath(dataRoot))
    const selection = this.options.selection ?? "home"
    await fs.mkdir(path.join(backupRoot, "chunks"), { recursive: true, mode: 0o700 })
    await fs.mkdir(path.join(backupRoot, "groups"), { recursive: true, mode: 0o700 })
    const sealed = await this.manifest()
    if (sealed && (sealed.source !== source || sealed.selection !== selection))
      throw new StorageIntegrityError("Packed backup source identity changed")
    const identity = path.join(backupRoot, "source.json")
    const previousIdentity = await optionalJSON(identity)
    if (previousIdentity !== undefined && JSON.stringify(previousIdentity) !== JSON.stringify({ source, selection }))
      throw new StorageIntegrityError("Packed backup source identity changed")
    await AtomicFile.writeJsonAtomic(identity, JSON.stringify({ source, selection }), { private: true, durable: true })
    const names = (await fs.readdir(path.join(backupRoot, "groups")))
      .filter((name) => /^\d{10}\.json$/.test(name))
      .sort()
    const sourceFiles = this.sources()[Symbol.asyncIterator]()
    const inventory = createHash("sha256")
    let files = 0,
      bytes = 0,
      storedBytes = 0,
      groups = 0
    try {
      for (const name of names) {
        if (name !== groupName(groups) + ".json")
          throw new StorageIntegrityError("Packed backup group sequence has a gap")
        const result = await this.readGroup(groups)
        for (const entry of result.entries) {
          const next = await sourceFiles.next()
          if (
            next.done ||
            next.value.relative !== entry.relative ||
            next.value.size !== entry.size ||
            next.value.linkTarget !== entry.linkTarget
          )
            throw new StorageIntegrityError("Legacy data changed after the backup checkpoint")
          const digest =
            entry.linkTarget === undefined
              ? await fileDigest(sourcePath(dataRoot, entry.relative), entry.size)
              : hash(entry.linkTarget)
          if (digest !== entry.hash) throw new StorageIntegrityError("Legacy data changed after the backup checkpoint")
        }
        inventory.update(result.text)
        files += result.group.files
        bytes += result.group.bytes
        storedBytes += result.group.storedBytes
        groups++
        progress?.({ files, bytes, storedBytes })
      }
      let frames: Buffer[] = [],
        frameBytes = 0,
        groupFiles = 0,
        groupBytes = 0
      let metadata: Array<z.infer<typeof Entry> & { codec: "raw" | "gzip"; storedBytes: number }> = []
      const publish = async (group: z.infer<typeof Group>) => {
        const text = JSON.stringify(group)
        await AtomicFile.writeJsonAtomic(this.descriptor(groups), text, { private: true, durable: true })
        inventory.update(text)
        files += group.files
        bytes += group.bytes
        storedBytes += group.storedBytes
        groups++
        progress?.({ files, bytes, storedBytes })
      }
      const flush = async () => {
        if (!groupFiles) return
        const index = await gzip(JSON.stringify(metadata), { level: 1 })
        const header = Buffer.alloc(4)
        header.writeUInt32BE(index.length)
        const content = Buffer.concat([header, index, ...frames])
        await this.options.capacity?.(content.length + 16_384)
        await AtomicFile.writeFileAtomic(this.chunk(groups), content, { private: true, durable: true })
        await publish({
          version: 2,
          sequence: groups,
          codec: "frames",
          sha256: hash(content),
          files: groupFiles,
          bytes: groupBytes,
          storedBytes: content.length,
        })
        frames = []
        metadata = []
        frameBytes = 0
        groupFiles = 0
        groupBytes = 0
      }
      // Compress ahead across the zlib threadpool while later source files
      // stream in; resolved entries append in source order so sealed groups
      // stay byte-identical with the synchronous layout.
      type PreparedFlight = {
        entry: { relative: string; size: number; linkTarget?: string }
        item: {
          relative: string
          size: number
          linkTarget?: string
          hash: string
          codec: "raw" | "gzip"
          storedBytes: number
        }
        stored: Buffer
        size: number
      }
      let failure: unknown
      const flights: Array<Promise<PreparedFlight | undefined>> = []
      const drainOne = async () => {
        const prepared = await flights.shift()!
        if (!prepared) throw failure ?? new StorageIntegrityError("Legacy data changed during backup")
        const { entry, item, stored, size } = prepared
        if (frameBytes + size > MAX_GROUP_BYTES || groupFiles === MAX_GROUP_FILES) await flush()
        metadata.push(item)
        frames.push(stored)
        frameBytes += size
        groupBytes += entry.size
        groupFiles++
      }
      for (;;) {
        const next = await sourceFiles.next()
        if (next.done) break
        if (sealed) throw new StorageIntegrityError("New legacy data appeared after the backup was sealed")
        const entry = next.value
        const filename = sourcePath(dataRoot, entry.relative)
        if (entry.linkTarget === undefined && entry.size > MAX_GROUP_BYTES / 2) {
          while (flights.length) await drainOne()
          await flush()
          await this.options.capacity?.(entry.size + 16_384)
          const temporary = this.chunk(groups) + ".tmp-" + randomUUID()
          try {
            await fs.copyFile(filename, temporary)
            const stat = await fs.stat(temporary)
            if (stat.size !== entry.size) throw new StorageIntegrityError("Legacy data changed during backup")
            await fs.chmod(temporary, 0o600)
            const digest = await fileDigest(temporary, entry.size)
            if ((await fileDigest(filename, entry.size)) !== digest)
              throw new StorageIntegrityError("Legacy data changed during backup")
            const handle = await fs.open(temporary, "r+")
            try {
              await handle.sync()
            } finally {
              await handle.close()
            }
            await fs.rename(temporary, this.chunk(groups))
            await syncDirectory(path.dirname(this.chunk(groups)))
            await publish({
              version: 2,
              sequence: groups,
              codec: "raw",
              sha256: digest,
              files: 1,
              bytes: entry.size,
              storedBytes: entry.size,
              entry: { ...entry, hash: digest },
            })
          } finally {
            await fs.rm(temporary, { force: true })
          }
          continue
        }
        if (flights.length >= COMPRESSION_FLIGHTS) await drainOne()
        flights.push(
          (async () => {
            const data = entry.linkTarget === undefined ? await fs.readFile(filename) : Buffer.alloc(0)
            if ((entry.linkTarget === undefined ? data.length : Buffer.byteLength(entry.linkTarget)) !== entry.size)
              throw new StorageIntegrityError("Legacy data changed during backup")
            const value = { ...entry, hash: hash(entry.linkTarget ?? data) }
            const metadataBytes = Buffer.byteLength(JSON.stringify(value))
            if (metadataBytes > 65536) throw new StorageIntegrityError("Legacy path metadata exceeds the backup limit")
            const compressed = await gzip(data, { level: 1 })
            const smaller = compressed.length < data.length * 0.9
            const stored = smaller ? compressed : data
            return {
              entry,
              item: { ...value, codec: smaller ? ("gzip" as const) : ("raw" as const), storedBytes: stored.length },
              stored,
              size: metadataBytes + data.length,
            }
          })().catch((error: unknown) => {
            failure ??= error
            return undefined
          }),
        )
      }
      while (flights.length) await drainOne()
      await flush()
      const manifest: PackedBackupManifest = {
        version: 2,
        selection,
        source,
        groups,
        files,
        bytes,
        storedBytes,
        inventorySHA256: inventory.digest("hex"),
      }
      if (sealed && JSON.stringify(sealed) !== JSON.stringify(manifest))
        throw new StorageIntegrityError("Packed backup manifest integrity check failed")
      if (!sealed)
        await AtomicFile.writeJsonAtomic(path.join(backupRoot, "manifest.json"), JSON.stringify(manifest), {
          private: true,
          durable: true,
        })
      return manifest
    } finally {
      await sourceFiles.return(undefined)
    }
  }

  async restore(dataRoot: string) {
    await fs.mkdir(dataRoot, { recursive: true, mode: 0o700 })
    const destination = await fs.realpath(dataRoot)
    for await (const entry of this.entries()) {
      const target = sourcePath(destination, entry.relative)
      let parent = path.dirname(target)
      const missing: string[] = []
      for (;;) {
        try {
          const stat = await fs.lstat(parent)
          if (!stat.isDirectory() || stat.isSymbolicLink())
            throw new StorageIntegrityError("Backup restore destination crosses a symbolic link")
        } catch (error) {
          if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error
          missing.push(parent)
        }
        const next = path.dirname(parent)
        if (next === parent) break
        parent = next
      }
      for (const directory of missing.reverse()) {
        await fs.mkdir(directory, { mode: 0o700 })
        await syncDirectory(path.dirname(directory))
      }
      if (entry.linkTarget !== undefined) await fs.symlink(entry.linkTarget, target)
      else {
        const handle = await fs.open(target, "wx", 0o600)
        try {
          if (entry.data) await handle.writeFile(entry.data)
          else for await (const chunk of createReadStream(entry.filename!)) await handle.writeFile(chunk)
          await handle.sync()
        } finally {
          await handle.close()
        }
      }
      await syncDirectory(path.dirname(target))
    }
  }
}
