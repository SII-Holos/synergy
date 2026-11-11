import { createHash } from "node:crypto"
import { z } from "zod"
import { RuntimeContext } from "@ericsanchezok/synergy-harness/lifecycle/context"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { Lock } from "@ericsanchezok/synergy-harness/util/lock"
import { OrganizationIdentity as Identity, OrganizationPublicationProtocol as Publication } from "@ericsanchezok/synergy-organization-protocol"
import { authorize } from "./authorization"
import type { Credentials } from "./auth/session"
import { authorizePublicationScope } from "./publication-access"
import { fail } from "./error"

const Upload = Publication.Upload.extend({ schemaVersion: z.literal(1), requestHash: z.string(), seal: Publication.Seal.optional() })
type Upload = z.infer<typeof Upload>
const File = Publication.File.extend({ schemaVersion: z.literal(1), receivedBytes: z.number().int().nonnegative().safe() })
const Chunk = z.strictObject({ bytes: z.number().int().positive(), sha256: z.string() })
const keys = {
  upload: (id: string) => ["organization-publications", "uploads", id],
  request: (orgID: string, accountID: string, id: string) => ["organization-publications", "requests", orgID, accountID, id],
  files: (id: string) => ["organization-publications", "files", id],
  file: (id: string, fileID: string) => ["organization-publications", "files", id, fileID],
  path: (id: string, hash: string) => ["organization-publications", "paths", id, hash],
  chunk: (id: string, fileID: string, offset: number) => ["organization-publications", "chunks", id, fileID, String(offset)],
  bytes: (id: string, fileID: string, offset: number) => ["organization-publications", "bytes", id, fileID, String(offset)],
}
const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex")

async function read<T>(schema: z.ZodType<T>, key: string[]) {
  const [value] = await Storage.readMany<unknown>([key])
  return value === undefined ? undefined : schema.parse(value)
}

async function access(credentials: Credentials, uploadID: string, write = false) {
  const upload = await read(Upload, keys.upload(Identity.ID.parse(uploadID)))
  if (!upload) fail("NOT_FOUND", "Publication upload not found")
  const account = await authorizePublicationScope(credentials, upload.scope, write)
  if (account.orgID !== upload.orgID || account.accountID !== upload.authorID)
    fail("NOT_FOUND", "Publication upload not found")
  if (upload.purpose === "artifact") {
    const source = await authorize(credentials, "session.read", { sessionID: upload.sourceSessionID! })
    if (upload.scope.kind !== "project" || source.session.projectID !== upload.scope.projectID)
      fail("NOT_FOUND", "Publication source not found")
  }
  return upload
}

function view(upload: Upload): Publication.Upload {
  return Publication.Upload.parse(Publication.Upload.strip().parse(upload))
}

function publicFile(file: z.infer<typeof File>): Publication.File {
  return Publication.File.parse(Publication.File.strip().parse(file))
}

export namespace OrganizationPublications {
  export async function create(credentials: Credentials, value: Publication.Create) {
    const input = Publication.Create.parse(value)
    return Storage.transaction(async () => {
      const account = await authorizePublicationScope(credentials, input.scope, true)
      if (input.purpose === "artifact") {
        const source = await authorize(credentials, "session.read", { sessionID: input.sourceSessionID! })
        if (input.scope.kind !== "project" || source.session.projectID !== input.scope.projectID)
          fail("NOT_FOUND", "Publication source not found")
      }
      const requestKey = keys.request(account.orgID, account.accountID, input.requestID)
      const requestHash = hash(JSON.stringify(input))
      const prior = await read(z.strictObject({ uploadID: Identity.ID, requestHash: z.string() }), requestKey)
      if (prior) {
        if (prior.requestHash !== requestHash) fail("REVISION_CONFLICT", "Upload request identity changed")
        return view(await access(credentials, prior.uploadID, true))
      }
      const upload = Upload.parse({
        schemaVersion: 1, uploadID: crypto.randomUUID(), orgID: account.orgID,
        purpose: input.purpose, scope: input.scope, sourceSessionID: input.sourceSessionID,
        authorID: account.accountID, state: "open", fileCount: 0, totalBytes: 0,
        createdAt: Date.now(), requestHash,
      })
      await Storage.write(keys.upload(upload.uploadID), upload)
      await Storage.write(requestKey, { uploadID: upload.uploadID, requestHash })
      return view(upload)
    })
  }

  export async function status(credentials: Credentials, uploadID: string) {
    return Storage.snapshot(async () => view(await access(credentials, uploadID)))
  }

  export async function putFile(credentials: Credentials, uploadID: string, value: z.infer<typeof Publication.FileInput>) {
    const input = Publication.FileInput.parse(value)
    return Storage.transaction(async () => {
      const upload = await access(credentials, uploadID, true)
      if (upload.state !== "open") fail("REVISION_CONFLICT", "Publication upload is sealed or being verified")
      const fileID = hash(input.path)
      const previous = await read(File, keys.file(uploadID, fileID))
      if (previous) {
        if (JSON.stringify(publicFile(previous)) !== JSON.stringify({ ...input, fileID }))
          fail("REVISION_CONFLICT", "A publication file cannot change after declaration")
        return publicFile(previous)
      }
      const pathKey = keys.path(uploadID, hash(input.path.normalize("NFC").toLocaleLowerCase("en-US")))
      const collision = await read(z.strictObject({ fileID: z.string() }), pathKey)
      if (collision && collision.fileID !== fileID)
        fail("REVISION_CONFLICT", "Publication paths collide on a supported filesystem")
      const file = File.parse({ ...input, fileID, schemaVersion: 1, receivedBytes: 0 })
      const totalBytes = upload.totalBytes + input.bytes
      if (!Number.isSafeInteger(totalBytes)) fail("INVALID_REQUEST", "Publication byte count is not representable")
      await Storage.write(keys.file(uploadID, fileID), file)
      await Storage.write(pathKey, { fileID })
      await Storage.write(keys.upload(uploadID), { ...upload, fileCount: upload.fileCount + 1, totalBytes })
      return publicFile(file)
    })
  }

  export async function putChunk(credentials: Credentials, uploadID: string, fileID: string, offset: number, value: Uint8Array) {
    Identity.ID.parse(uploadID)
    const bytes = new Uint8Array(value)
    if (!Number.isSafeInteger(offset) || offset < 0 || offset % Publication.chunkBytes || !bytes.byteLength || bytes.byteLength > Publication.chunkBytes)
      fail("INVALID_REQUEST", "Publication chunks require an aligned offset and at most 4 MiB")
    await Storage.snapshot(() => access(credentials, uploadID, true))
    const chunk = Chunk.parse({ bytes: bytes.byteLength, sha256: hash(bytes) })
    using prepared = await Storage.prepareBinary(keys.bytes(uploadID, fileID, offset), bytes)
    return await Storage.transaction(async () => {
      const upload = await access(credentials, uploadID, true)
      const file = await read(File, keys.file(uploadID, fileID))
      if (!file) fail("NOT_FOUND", "Publication file not found")
      if (bytes.byteLength !== Math.min(Publication.chunkBytes, file.bytes - offset))
        fail("INVALID_REQUEST", "Publication chunk does not match its declared file range")
      const previous = await read(Chunk, keys.chunk(uploadID, fileID, offset))
      if (previous) {
        if (previous.sha256 !== chunk.sha256 || previous.bytes !== chunk.bytes)
          fail("REVISION_CONFLICT", "An uploaded chunk cannot be overwritten")
      } else {
        if (upload.state !== "open") fail("REVISION_CONFLICT", "Publication upload is sealed or being verified")
        await Storage.publishPreparedBinary(prepared)
        await Storage.write(keys.chunk(uploadID, fileID, offset), chunk)
        await Storage.write(keys.file(uploadID, fileID), { ...file, receivedBytes: file.receivedBytes + bytes.length })
      }
      return Publication.ChunkStatus.parse({ uploadID, fileID, receivedBytes: file.receivedBytes + (previous ? 0 : bytes.length), bytes: file.bytes, chunkBytes: Publication.chunkBytes })
    })
  }

  export async function page(uploadID: string, value: z.input<typeof Publication.PageQuery>) {
    const input = Publication.PageQuery.parse(value)
    const prefix = keys.files(uploadID)
    const rows = await Storage.query({ prefix, after: input.cursor ? [...prefix, input.cursor] : undefined, limit: input.limit + 1 })
    const items = rows.slice(0, input.limit).map((row) => publicFile(File.parse(row.value)))
    return { items, cursor: rows.length > input.limit ? items.at(-1)?.fileID : undefined }
  }

  export async function* allFiles(uploadID: string) {
    let cursor: string | undefined
    do {
      const result = await page(uploadID, { limit: 100, cursor })
      for (const file of result.items) yield file
      cursor = result.cursor
    } while (cursor)
  }

  export async function files(credentials: Credentials, uploadID: string, value: z.input<typeof Publication.PageQuery>) {
    return Storage.snapshot(async () => {
      await access(credentials, uploadID)
      return page(uploadID, value)
    })
  }

  export async function seal(credentials: Credentials, uploadID: string, value: z.infer<typeof Publication.Seal>) {
    const input = Publication.Seal.parse(value)
    using lock = await Lock.write(`organization-publication:${uploadID}`)
    const upload = await Storage.transaction(async () => {
      const current = await access(credentials, uploadID, true)
      if (current.fileCount !== input.fileCount || current.totalBytes !== input.totalBytes)
        fail("REVISION_CONFLICT", "Publication manifest counts changed")
      if (current.seal && JSON.stringify(current.seal) !== JSON.stringify(input))
        fail("REVISION_CONFLICT", "Publication sealing request changed")
      if (current.state === "sealed") return current
      const next = Upload.parse({ ...current, state: "sealing", seal: input })
      await Storage.write(keys.upload(uploadID), next)
      return next
    })
    if (upload.state === "sealed") return view(upload)
    try {
      const manifest = createHash("sha256")
      let fileCount = 0
      let totalBytes = 0
      for await (const file of allFiles(uploadID)) {
        const digest = createHash("sha256")
        for (let offset = 0; offset < file.bytes; offset += Publication.chunkBytes) {
          const bytes = await readChunk(uploadID, file.fileID, offset)
          if (bytes.byteLength !== Math.min(Publication.chunkBytes, file.bytes - offset))
            fail("INVALID_REQUEST", "Publication file has a missing or truncated chunk")
          digest.update(bytes)
        }
        if (digest.digest("hex") !== file.sha256) fail("INVALID_REQUEST", "Publication file checksum does not match")
        manifest.update(Publication.manifestLine(file))
        fileCount++
        totalBytes += file.bytes
      }
      const manifestHash = manifest.digest("hex")
      if (fileCount !== input.fileCount || totalBytes !== input.totalBytes || (input.manifestHash && input.manifestHash !== manifestHash))
        fail("INVALID_REQUEST", "Publication manifest does not match its declared contents")
      return await Storage.transaction(async () => {
        const current = await access(credentials, uploadID, true)
        if (current.state !== "sealing") fail("REVISION_CONFLICT", "Publication upload changed during verification")
        const next = Upload.parse({ ...current, state: "sealed", manifestHash })
        await Storage.write(keys.upload(uploadID), next)
        return view(next)
      })
    } catch (error) {
      await Storage.transaction(async () => {
        const current = await read(Upload, keys.upload(uploadID))
        if (current?.state === "sealing") await Storage.write(keys.upload(uploadID), { ...current, state: "open", seal: undefined })
      })
      if (error instanceof Storage.NotFoundError) fail("INVALID_REQUEST", "Publication file has a missing chunk")
      throw error
    }
  }

  export async function ready(credentials: Credentials, uploadID: string, purpose: Publication.Create["purpose"]) {
    const upload = await access(credentials, uploadID, true)
    if (upload.purpose !== purpose || upload.state !== "sealed" || !upload.manifestHash)
      fail("INVALID_REQUEST", "Publication requires a verified upload of the selected kind")
    return upload
  }

  export async function file(uploadID: string, fileID: string) {
    const file = await read(File, keys.file(uploadID, fileID))
    if (!file) fail("NOT_FOUND", "Published file not found")
    return publicFile(file)
  }

  export async function readChunk(uploadID: string, fileID: string, offset: number) {
    return Storage.readBinary(keys.bytes(uploadID, fileID, offset), { maxBytes: Publication.chunkBytes })
  }

  export async function readRange(uploadID: string, file: Publication.File, offset: number, length: number) {
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 || offset + length > file.bytes)
      fail("INVALID_REQUEST", "Published file range is invalid")
    const output = new Uint8Array(length)
    let copied = 0
    while (copied < length) {
      const position = offset + copied
      const chunkOffset = Math.floor(position / Publication.chunkBytes) * Publication.chunkBytes
      const chunk = await readChunk(uploadID, file.fileID, chunkOffset)
      const start = position - chunkOffset
      const size = Math.min(chunk.length - start, length - copied)
      if (size <= 0) fail("SERVICE_UNAVAILABLE", "Published file data is incomplete")
      output.set(chunk.subarray(start, start + size), copied)
      copied += size
    }
    return output
  }

  export async function content(input: {
    uploadID: string; fileID: string; range?: string; signal?: AbortSignal; authorize(): Promise<unknown>
  }) {
    await input.authorize()
    const descriptor = await file(input.uploadID, input.fileID)
    const range = parseRange(input.range, descriptor.bytes)
    if (!range) return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${descriptor.bytes}` } })
    let offset = range.start
    const bind = RuntimeContext.current().bind
    const body = new ReadableStream<Uint8Array>({
      pull: bind(async (controller) => {
        input.signal?.throwIfAborted()
        await input.authorize()
        if (offset > range.end) { controller.close(); return }
        const size = Math.min(Publication.chunkBytes, range.end - offset + 1)
        controller.enqueue(await readRange(input.uploadID, descriptor, offset, size))
        offset += size
      }),
    })
    return new Response(body, {
      status: input.range ? 206 : 200,
      headers: {
        "Content-Type": descriptor.mediaType, "Content-Length": String(Math.max(0, range.end - range.start + 1)),
        "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(descriptor.path.split("/").at(-1)!)}`,
        ETag: `"${descriptor.sha256}"`, "Accept-Ranges": "bytes", "Cache-Control": "private, no-store",
        ...(input.range ? { "Content-Range": `bytes ${range.start}-${range.end}/${descriptor.bytes}` } : {}),
      },
    })
  }
}

function parseRange(range: string | undefined, size: number) {
  if (!range) return { start: 0, end: size - 1 }
  const match = /^bytes=(\d*)-(\d*)$/.exec(range)
  if (!match || (!match[1] && !match[2]) || !size) return
  const start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]))
  const end = match[1] && match[2] ? Math.min(size - 1, Number(match[2])) : size - 1
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= size || end < start) return
  return { start, end }
}
