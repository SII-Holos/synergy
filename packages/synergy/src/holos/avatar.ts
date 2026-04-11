import { Asset } from "@/asset/asset"
import { Log } from "@/util/log"

const log = Log.create({ service: "holos.avatar" })

export namespace Avatar {
  export async function encode(assetId: string): Promise<string | undefined> {
    const file = await Asset.read(assetId)
    if (!file) return undefined

    const buffer = Buffer.from(await file.arrayBuffer())
    const ext = Asset.extFromId(assetId)
    const mime = Asset.mimeFromExt(ext)
    return `data:${mime};base64,${buffer.toString("base64")}`
  }

  export async function cache(avatarData: string): Promise<string | undefined> {
    try {
      if (avatarData.startsWith("data:")) {
        return await cacheFromDataUri(avatarData)
      }
      if (avatarData.startsWith("http://") || avatarData.startsWith("https://")) {
        return await cacheFromUrl(avatarData)
      }
      log.warn("unrecognized avatar format", { prefix: avatarData.slice(0, 30) })
      return undefined
    } catch (err) {
      log.warn("failed to cache avatar", { error: err instanceof Error ? err.message : String(err) })
      return undefined
    }
  }
}

async function cacheFromDataUri(dataUri: string): Promise<string | undefined> {
  const match = dataUri.match(/^data:([^;]+);base64,(.+)$/)
  if (!match) return undefined

  const mime = match[1]
  const buffer = Buffer.from(match[2], "base64")
  return Asset.write(buffer, mime)
}

async function cacheFromUrl(url: string): Promise<string | undefined> {
  const res = await fetch(url)
  if (!res.ok) return undefined

  const buffer = Buffer.from(await res.arrayBuffer())
  const mime = res.headers.get("content-type") ?? "application/octet-stream"
  return Asset.write(buffer, mime)
}
