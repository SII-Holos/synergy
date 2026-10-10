import fs from "node:fs/promises"
import path from "node:path"
import { createHash } from "node:crypto"
import { BlobReader, Uint8ArrayReader, ZipReader, ZipWriter, type FileEntry } from "@zip.js/zip.js"
import { Log } from "../util/log"
import { Global } from "../global"
import { SessionTransferSchema as S } from "./transfer-schema"

export namespace SessionTransferArchive {
  export const limit = 64 * 1024 * 1024
  export const hash = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex")
  export function directory(id: string) {
    return path.join(Global.Path.data, "session-transfers", S.ID.parse(id))
  }
  export function filename(id: string) {
    return path.join(directory(id), "payload.zip")
  }
  export async function cleanPayload(id: string) {
    for (const name of ["payload.zip", "incoming.tmp", "outgoing.tmp"])
      await fs
        .rm(path.join(directory(id), name), { force: true })
        .catch((error) =>
          Log.create({ service: "session-transfer" }).warn("Transfer payload cleanup failed", { error }),
        )
  }
  export async function digest(blob: Blob) {
    const hash = createHash("sha256")
    const reader = blob.stream().getReader()
    try {
      for (;;) {
        const chunk = await reader.read()
        if (chunk.done) break
        hash.update(chunk.value)
      }
    } finally {
      reader.releaseLock()
    }
    return hash.digest("hex")
  }
  export async function save(id: string, blob: Blob) {
    if (blob.size > limit) throw new S.Rejected({ message: "Session transfer exceeds the 64 MiB package limit" })
    await fs.mkdir(directory(id), { recursive: true, mode: 0o700 })
    const temporary = path.join(directory(id), "incoming.tmp")
    await Bun.write(temporary, blob)
    const file = await fs.open(temporary, "r+")
    try {
      await file.sync()
    } finally {
      await file.close()
    }
    await fs.rename(temporary, filename(id))
    await syncDirectory(directory(id))
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
  export async function write(
    id: string,
    manifest: Omit<S.Manifest, "files">,
    produce: (add: (path: string, data: Uint8Array) => Promise<void>) => Promise<void>,
  ) {
    await fs.mkdir(directory(id), { recursive: true, mode: 0o700 })
    const temporary = path.join(directory(id), "outgoing.tmp")
    const file = await fs.open(temporary, "w", 0o600)
    const zip = new ZipWriter(
      new WritableStream<Uint8Array>({
        async write(data) {
          await file.writeFile(data)
        },
      }),
      { level: 0, useWebWorkers: false },
    )
    const files: S.Manifest["files"] = []
    let bytes = 0
    const names = new Set<string>()
    try {
      await produce(async (name, data) => {
        const entry = S.File.parse({ path: name, bytes: data.length, sha256: hash(data) })
        bytes += data.length
        if (bytes > limit || files.length >= 99_999 || names.has(name))
          throw new S.Rejected({ message: "Session transfer archive limit or duplicate entry" })
        names.add(name)
        await zip.add(name, new Uint8ArrayReader(data))
        files.push(entry)
      })
      await zip.add(
        "manifest.json",
        new Uint8ArrayReader(Buffer.from(JSON.stringify(S.Manifest.parse({ ...manifest, files })))),
      )
      await zip.close()
      await file.sync()
      await file.close()
      if ((await fs.stat(temporary)).size > limit)
        throw new S.Rejected({ message: "Session transfer exceeds the 64 MiB package limit" })
      await fs.rename(temporary, filename(id))
      await syncDirectory(directory(id))
    } catch (error) {
      await file.close().catch(() => {})
      await fs.rm(temporary, { force: true })
      throw error
    }
  }
  export async function open(blob: Blob) {
    if (blob.size > limit) throw new S.Rejected({ message: "Session transfer exceeds the 64 MiB package limit" })
    const reader = new ZipReader(new BlobReader(blob), { checkSignature: true, useWebWorkers: false })
    try {
      const entries = new Map<string, FileEntry>()
      let size = 0
      for await (const entry of reader.getEntriesGenerator()) {
        S.File.shape.path.parse(entry.filename)
        size += entry.uncompressedSize
        if (
          entry.directory ||
          entry.encrypted ||
          entry.uncompressedSize > 64 * 1024 * 1024 ||
          size > limit ||
          entries.size >= 100_000 ||
          entries.has(entry.filename)
        )
          throw new S.Rejected({ message: "Invalid Session transfer archive" })
        entries.set(entry.filename, entry)
      }
      const read = async (name: string) => {
        const entry = entries.get(name)
        if (!entry) throw new S.Rejected({ message: "Session transfer archive is incomplete" })
        const chunks: Uint8Array[] = []
        let bytes = 0
        try {
          await entry.getData(
            new WritableStream<Uint8Array>({
              write(chunk) {
                bytes += chunk.length
                if (bytes > entry.uncompressedSize)
                  throw new S.Rejected({ message: "Session transfer entry exceeds declared size" })
                chunks.push(chunk)
              },
            }),
          )
        } catch (error) {
          if (error instanceof S.Rejected) throw error
          throw new S.Rejected({ message: "Invalid Session transfer archive entry" })
        }
        if (bytes !== entry.uncompressedSize) throw new S.Rejected({ message: "Session transfer entry is truncated" })
        return Buffer.concat(chunks, bytes)
      }
      const manifest = S.Manifest.parse(JSON.parse((await read("manifest.json")).toString()))
      const declared = new Map(manifest.files.map((entry) => [entry.path, entry]))
      if (
        declared.size !== manifest.files.length ||
        entries.size !== declared.size + 1 ||
        declared.has("manifest.json")
      )
        throw new S.Rejected({ message: "Session transfer manifest entries do not match archive" })
      const bytes = async (name: string) => {
        const entry = declared.get(name)
        if (!entry) throw new S.Rejected({ message: "Session transfer contains an undeclared entry" })
        const data = await read(name)
        if (entry.bytes !== data.length || entry.sha256 !== hash(data))
          throw new S.Rejected({ message: "Session transfer integrity check failed" })
        return data
      }
      return {
        manifest,
        bytes,
        async verify() {
          for (const name of declared.keys()) await bytes(name)
        },
        async [Symbol.asyncDispose]() {
          await reader.close()
        },
      }
    } catch (error) {
      await reader.close()
      if (error instanceof S.Rejected) throw error
      throw new S.Rejected({ message: "Invalid Session transfer archive" })
    }
  }
}
