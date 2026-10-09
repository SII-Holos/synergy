import { AssetReference } from "@ericsanchezok/synergy-util/asset-reference"
import path from "path"
import { Global } from "../global"
import { isPathContained } from "../util/path-contain"
import { RuntimeContext } from "../lifecycle/context"
import { AtomicFile } from "@ericsanchezok/synergy-util/atomic-file"

export namespace Asset {
  export interface Persistence {
    write(id: string, bytes: Uint8Array): Promise<void>
    read(id: string): Promise<Uint8Array | undefined>
  }
  const state = RuntimeContext.state(() => ({ backend: undefined as Persistence | undefined }))

  export function registerStorage(backend: Persistence) {
    RuntimeContext.assertCompositionOpen("Asset storage")
    if (state().backend) throw new Error("Asset storage is already registered")
    state().backend = backend
  }
  export function dir(): string {
    return Global.Path.assets
  }

  export const isValidId = AssetReference.isValidId

  export function filePath(id: string): string {
    return path.join(Global.Path.assets, id)
  }

  export function resolvePath(id: string): string | undefined {
    if (!isValidId(id)) return undefined
    const assetDir = path.resolve(dir())
    const resolved = path.resolve(assetDir, id)
    if (!isPathContained(assetDir, resolved)) return undefined
    return resolved
  }

  export function generateId(buffer: Buffer, mime: string, filename?: string): string {
    const hash = new Bun.CryptoHasher("sha256").update(buffer).digest("hex").slice(0, 16)
    const baseMime = mime.split(";")[0]!.trim().toLowerCase()
    const ext = extFromMime(baseMime) ?? (filename ? extFromName(filename) : undefined) ?? "bin"
    return `${hash}.${ext}`
  }

  export async function write(buffer: Buffer, mime: string, filename?: string): Promise<string> {
    const id = generateId(buffer, mime, filename)
    await publish(id, buffer)
    return id
  }

  export async function publish(id: string, bytes: Uint8Array) {
    if (!isValidId(id) || !new Bun.CryptoHasher("sha256").update(bytes).digest("hex").startsWith(id.split(".")[0]!))
      throw new Error("Asset content does not match its identifier")
    await state().backend?.write(id, bytes)
    await AtomicFile.writeFileAtomic(filePath(id), bytes, { private: true })
  }

  export async function read(id: string): Promise<ReturnType<typeof Bun.file> | undefined> {
    if (!isValidId(id)) return undefined
    const backend = state().backend
    if (backend) {
      const bytes = await backend.read(id)
      if (!bytes) return undefined
      if (!new Bun.CryptoHasher("sha256").update(bytes).digest("hex").startsWith(id.split(".")[0]!))
        throw new Error("Asset content does not match its identifier")
      await AtomicFile.writeFileAtomic(filePath(id), bytes, { private: true })
    }
    const file = Bun.file(filePath(id))
    if (!(await file.exists())) return undefined
    return file
  }

  export async function materialize(id: string): Promise<string | undefined> {
    return (await read(id)) ? filePath(id) : undefined
  }

  /** Publish a verified capture already materialized by the attachment owner. */
  export async function persist(id: string) {
    if (!isValidId(id)) throw new Error("Invalid asset identifier")
    const backend = state().backend
    if (backend) await backend.write(id, await Bun.file(filePath(id)).bytes())
  }

  export const mimeFromExt = AssetReference.mimeFromExt
  export const extFromMime = AssetReference.extFromMime
  export const extFromName = AssetReference.extFromName
  export const extFromId = AssetReference.extFromId
}
