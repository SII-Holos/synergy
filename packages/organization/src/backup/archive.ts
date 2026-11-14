import { createHash } from "node:crypto"
import { constants } from "node:fs"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { z } from "zod"
import { SecretEnvelope, type VaultKeyProvider } from "@ericsanchezok/synergy-harness/secrets/encrypted-store"

const chunkBytes = 4 * 1024 * 1024
const pageSize = 128
const Count = z.number().int().nonnegative().safe()
const Hash = z.string().regex(/^[a-f0-9]{64}$/)
const ID = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-zA-Z0-9_-]+$/)
const BuildVersion = z.string().min(1).max(200)
const RelativePath = z
  .string()
  .min(1)
  .max(1024)
  .refine((value) => {
    const segments = value.split("/")
    return (
      segments.length <= 16 &&
      segments.every(
        (segment) =>
          /^[a-z0-9_-](?:[a-z0-9._-]{0,126}[a-z0-9_-])?$/.test(segment) &&
          !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/.test(segment),
      )
    )
  }, "Recovery paths must be portable relative names")
const ExpectedFile = z.strictObject({ path: RelativePath, bytes: Count, sha256: Hash })
const File = ExpectedFile.extend({ ordinal: Count, chunks: Count }).refine(
  (file) => file.chunks === Math.ceil(file.bytes / chunkBytes),
  "Recovery chunk count must match the exact file size",
)
type File = z.infer<typeof File>
const Page = z.array(File).min(1).max(pageSize)
const Header = z.strictObject({
  format: z.literal("synergy-organization-recovery"),
  version: z.literal(1),
  archiveID: ID,
  encrypted: SecretEnvelope.Ciphertext,
})
const Root = z
  .strictObject({
    buildVersion: BuildVersion,
    createdAt: Count,
    fileCount: Count,
    bytes: Count,
    filePages: Count,
    pagesHash: Hash,
  })
  .refine(
    (root) => root.filePages === Math.ceil(root.fileCount / pageSize),
    "Recovery page count must match the exact inventory",
  )
type Root = z.infer<typeof Root>
const position = (value: number) => String(value).padStart(16, "0")
const sha256 = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex")

class ArchiveError extends Error {
  override readonly name = "OrganizationRecoveryArchiveError"
}
function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value)
  if (!result.success) throw new ArchiveError("Recovery archive structure is invalid or unsupported")
  return result.data
}
function decode<T>(schema: z.ZodType<T>, bytes: Uint8Array): T {
  try {
    return parse(schema, JSON.parse(Buffer.from(bytes).toString("utf8")))
  } catch {
    throw new ArchiveError("Recovery authenticated metadata is invalid")
  }
}
function absolute(value: string) {
  if (!path.isAbsolute(value)) throw new ArchiveError("Recovery archive directories must be absolute")
  return path.resolve(value)
}
async function directory(value: string) {
  const info = await fs.lstat(value)
  if (!info.isDirectory() || info.isSymbolicLink())
    throw new ArchiveError("Recovery directories cannot be symbolic links")
}
async function writeJSON(filename: string, value: unknown) {
  const file = await fs.open(filename, "wx", 0o600)
  try {
    await file.writeFile(JSON.stringify(value))
    await file.sync()
  } finally {
    await file.close()
  }
}
async function readJSON(filename: string, maximum: number) {
  const before = await fs.lstat(filename)
  if (!before.isFile() || before.isSymbolicLink() || before.size > maximum)
    throw new ArchiveError("Recovery content must be a bounded ordinary file")
  const file = await fs.open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const info = await file.stat()
    if (!info.isFile() || info.dev !== before.dev || info.ino !== before.ino || info.size !== before.size)
      throw new ArchiveError("Recovery content changed during inspection")
    const buffer = Buffer.alloc(info.size + 1)
    let bytes = 0
    while (bytes < buffer.length) {
      const read = await file.read(buffer, bytes, buffer.length - bytes, bytes)
      if (!read.bytesRead) break
      bytes += read.bytesRead
    }
    if (bytes !== info.size) throw new ArchiveError("Recovery content changed during inspection")
    try {
      return JSON.parse(buffer.subarray(0, bytes).toString("utf8")) as unknown
    } catch {
      throw new ArchiveError("Recovery content is not valid authenticated JSON")
    }
  } finally {
    await file.close()
  }
}
async function claim(root: string, logicalPath: string) {
  try {
    const file = await fs.open(path.join(root, sha256(logicalPath)), "wx", 0o600)
    await file.close()
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "EEXIST")
      throw new ArchiveError("Recovery inventory repeats a logical path")
    throw error
  }
}
function sealBytes(archiveID: string, id: string, keyVersion: string, key: Uint8Array, bytes: Uint8Array) {
  return SecretEnvelope.seal({ authority: ["synergy-organization-recovery-v1", archiveID], id, keyVersion, key, bytes })
}
function openBytes(archiveID: string, id: string, keyVersion: string, key: Uint8Array, value: unknown) {
  return SecretEnvelope.open({
    authority: ["synergy-organization-recovery-v1", archiveID],
    id,
    keyVersion,
    key,
    envelope: parse(SecretEnvelope.Ciphertext, value),
  })
}
async function* chunks(source: AsyncIterable<Uint8Array>, signal?: AbortSignal) {
  let buffer = Buffer.alloc(chunkBytes)
  let used = 0
  try {
    for await (const value of source) {
      signal?.throwIfAborted()
      if (!(value instanceof Uint8Array)) throw new ArchiveError("Recovery file source must yield bytes")
      for (let offset = 0; offset < value.length;) {
        const count = Math.min(chunkBytes - used, value.length - offset)
        buffer.set(value.subarray(offset, offset + count), used)
        used += count
        offset += count
        if (used !== chunkBytes) continue
        yield buffer
        buffer.fill(0)
        buffer = Buffer.alloc(chunkBytes)
        used = 0
      }
    }
    signal?.throwIfAborted()
    if (used) yield buffer.subarray(0, used)
  } finally {
    buffer.fill(0)
  }
}

export namespace OrganizationRecoveryArchive {
  export interface Source {
    path: string
    bytes: number
    sha256: string
    read(signal?: AbortSignal): AsyncIterable<Uint8Array>
  }
  export interface Report {
    archiveID: string
    buildVersion: string
    createdAt: number
    fileCount: number
    bytes: number
    pagesHash: string
  }
  function report(archiveID: string, root: Root): Report {
    const { filePages: _, ...value } = root
    return { archiveID, ...value }
  }

  export async function seal(input: {
    directory: string
    archiveID: string
    buildVersion: string
    keys: VaultKeyProvider
    files: AsyncIterable<Source>
    signal?: AbortSignal
  }): Promise<Report> {
    const destination = absolute(input.directory)
    parse(ID, input.archiveID)
    parse(BuildVersion, input.buildVersion)
    const current = await input.keys.current()
    const key = Buffer.from(current.key)
    let owned = false
    let complete = false
    try {
      input.signal?.throwIfAborted()
      await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 })
      await fs.mkdir(destination, { mode: 0o700 })
      owned = true
      const claims = path.join(destination, ".claims")
      const content = path.join(destination, "content")
      const pages = path.join(destination, "pages")
      await Promise.all([claims, content, pages].map((name) => fs.mkdir(name, { mode: 0o700 })))
      let fileCount = 0
      let bytes = 0
      let filePages = 0
      let page: File[] = []
      const inventory = createHash("sha256")
      async function flush() {
        if (!page.length) return
        const plaintext = Buffer.from(JSON.stringify(page))
        try {
          inventory.update(plaintext)
          await writeJSON(
            path.join(pages, `${position(filePages)}.json`),
            sealBytes(input.archiveID, `page:${filePages}`, current.version, key, plaintext),
          )
        } finally {
          plaintext.fill(0)
        }
        filePages++
        page = []
      }
      for await (const source of input.files) {
        input.signal?.throwIfAborted()
        const expected = parse(ExpectedFile, { path: source.path, bytes: source.bytes, sha256: source.sha256 })
        await claim(claims, expected.path)
        const fileRoot = path.join(content, position(fileCount))
        await fs.mkdir(fileRoot, { mode: 0o700 })
        const hash = createHash("sha256")
        let received = 0
        let count = 0
        for await (const chunk of chunks(source.read(input.signal), input.signal)) {
          received += chunk.length
          if (received > expected.bytes) throw new ArchiveError("Recovery file exceeds its captured size")
          hash.update(chunk)
          await writeJSON(
            path.join(fileRoot, `${position(count)}.json`),
            sealBytes(input.archiveID, `file:${fileCount}:chunk:${count}`, current.version, key, chunk),
          )
          count++
        }
        input.signal?.throwIfAborted()
        if (received !== expected.bytes || hash.digest("hex") !== expected.sha256)
          throw new ArchiveError("Recovery file does not match its captured checksum")
        page.push(parse(File, { ...expected, ordinal: fileCount, chunks: count }))
        fileCount = parse(Count, fileCount + 1)
        bytes = parse(Count, bytes + received)
        if (page.length === pageSize) await flush()
      }
      input.signal?.throwIfAborted()
      await flush()
      const root = parse(Root, {
        buildVersion: input.buildVersion,
        createdAt: Date.now(),
        fileCount,
        bytes,
        filePages,
        pagesHash: inventory.digest("hex"),
      })
      await fs.rm(claims, { recursive: true })
      const plaintext = Buffer.from(JSON.stringify(root))
      try {
        input.signal?.throwIfAborted()
        await writeJSON(
          path.join(destination, "archive.json"),
          Header.parse({
            format: "synergy-organization-recovery",
            version: 1,
            archiveID: input.archiveID,
            encrypted: sealBytes(input.archiveID, "root", current.version, key, plaintext),
          }),
        )
      } finally {
        plaintext.fill(0)
      }
      input.signal?.throwIfAborted()
      complete = true
      return report(input.archiveID, root)
    } finally {
      key.fill(0)
      if (owned && !complete) await fs.rm(destination, { recursive: true, force: true })
    }
  }

  async function inspect(
    input: { directory: string; keys: VaultKeyProvider; signal?: AbortSignal },
    output?: string,
  ): Promise<Report> {
    const source = absolute(input.directory)
    if (output === source || output?.startsWith(`${source}${path.sep}`))
      throw new ArchiveError("Recovery plaintext must use an independent output directory")
    await directory(source)
    const header = parse(Header, await readJSON(path.join(source, "archive.json"), 64 * 1024))
    const key = Buffer.from(await input.keys.resolve(header.encrypted.keyVersion))
    let claims: string | undefined
    let owned = false
    let complete = false
    try {
      input.signal?.throwIfAborted()
      const rootBytes = openBytes(header.archiveID, "root", header.encrypted.keyVersion, key, header.encrypted)
      let root: Root
      try {
        root = decode(Root, rootBytes)
      } finally {
        rootBytes.fill(0)
      }
      if (output) {
        await fs.mkdir(path.dirname(output), { recursive: true, mode: 0o700 })
        await fs.mkdir(output, { mode: 0o700 })
        owned = true
      }
      claims = await fs.mkdtemp(path.join(os.tmpdir(), "synergy-recovery-inventory-"))
      await fs.chmod(claims, 0o700)
      await Promise.all([directory(path.join(source, "pages")), directory(path.join(source, "content"))])
      let fileCount = 0
      let bytes = 0
      const inventory = createHash("sha256")
      for (let pageIndex = 0; pageIndex < root.filePages; pageIndex++) {
        input.signal?.throwIfAborted()
        const plaintext = openBytes(
          header.archiveID,
          `page:${pageIndex}`,
          header.encrypted.keyVersion,
          key,
          await readJSON(path.join(source, "pages", `${position(pageIndex)}.json`), 512 * 1024),
        )
        let page: z.infer<typeof Page>
        try {
          inventory.update(plaintext)
          page = decode(Page, plaintext)
        } finally {
          plaintext.fill(0)
        }
        if (pageIndex < root.filePages - 1 && page.length !== pageSize)
          throw new ArchiveError("Recovery inventory has an incomplete page")
        for (const file of page) {
          if (file.ordinal !== fileCount || fileCount >= root.fileCount)
            throw new ArchiveError("Recovery inventory order is incomplete")
          await claim(claims, file.path)
          const fileRoot = path.join(source, "content", position(fileCount))
          await directory(fileRoot)
          let target: Awaited<ReturnType<typeof fs.open>> | undefined
          const hash = createHash("sha256")
          let received = 0
          try {
            if (output) {
              const filename = path.join(output, file.path)
              await fs.mkdir(path.dirname(filename), { recursive: true, mode: 0o700 })
              target = await fs.open(filename, "wx", 0o600)
            }
            for (let index = 0; index < file.chunks; index++) {
              input.signal?.throwIfAborted()
              const chunk = openBytes(
                header.archiveID,
                `file:${fileCount}:chunk:${index}`,
                header.encrypted.keyVersion,
                key,
                await readJSON(path.join(fileRoot, `${position(index)}.json`), 6 * 1024 * 1024),
              )
              try {
                if (chunk.length !== Math.min(chunkBytes, file.bytes - received))
                  throw new ArchiveError("Recovery chunk does not match its captured position")
                received += chunk.length
                hash.update(chunk)
                if (target) await target.writeFile(chunk)
              } finally {
                chunk.fill(0)
              }
            }
            if (received !== file.bytes || hash.digest("hex") !== file.sha256)
              throw new ArchiveError("Recovery file checksum is incomplete")
            await target?.sync()
          } finally {
            await target?.close()
          }
          fileCount++
          bytes = parse(Count, bytes + received)
        }
      }
      input.signal?.throwIfAborted()
      if (fileCount !== root.fileCount || bytes !== root.bytes || inventory.digest("hex") !== root.pagesHash)
        throw new ArchiveError("Recovery inventory checksum or totals are incomplete")
      complete = true
      return report(header.archiveID, root)
    } finally {
      key.fill(0)
      if (claims) await fs.rm(claims, { recursive: true, force: true })
      if (owned && !complete && output) await fs.rm(output, { recursive: true, force: true })
    }
  }

  export async function verify(input: { directory: string; keys: VaultKeyProvider; signal?: AbortSignal }) {
    return inspect(input)
  }
  export async function open(input: {
    directory: string
    outputDirectory: string
    keys: VaultKeyProvider
    signal?: AbortSignal
  }) {
    return inspect(input, absolute(input.outputDirectory))
  }
}
