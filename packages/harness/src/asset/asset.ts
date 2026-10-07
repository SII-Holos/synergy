import { AssetReference } from "@ericsanchezok/synergy-util/asset-reference"
import path from "path"
import { Global } from "../global"
import { isPathContained } from "../util/path-contain"

export namespace Asset {
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
    await Bun.write(filePath(id), buffer)
    return id
  }

  export async function read(id: string): Promise<ReturnType<typeof Bun.file> | undefined> {
    const file = Bun.file(filePath(id))
    if (!(await file.exists())) return undefined
    return file
  }

  export const mimeFromExt = AssetReference.mimeFromExt
  export const extFromMime = AssetReference.extFromMime
  export const extFromName = AssetReference.extFromName
  export const extFromId = AssetReference.extFromId
}
