import { fileURLToPath } from "node:url"
import { open, rename, unlink } from "node:fs/promises"
import { Asset } from "../../asset/asset"
import { Attachment } from "../../attachment"
import { RolloutArtifact } from "./artifact"
import { record } from "./error"
import type { RolloutSchema } from "./schema"

export namespace RolloutAttachment {
  type Part = { url: string; mime: string; artifact?: RolloutArtifact.Ref }
  export async function capture<T extends Part>(
    owner: RolloutSchema.Owner,
    part: T,
    options: { allowFile?: boolean } = {},
  ): Promise<T & { artifact?: RolloutArtifact.Ref }> {
    if (part.artifact) {
      await record(async () => {
        const stored = await RolloutArtifact.get(owner, part.artifact!.id)
        if (
          stored.sha256 !== part.artifact!.sha256 ||
          stored.bytes !== part.artifact!.bytes ||
          stored.status !== part.artifact!.status
        )
          throw new Error("Attachment evidence does not match its owner")
      })
      return part
    }
    const url = new URL(part.url)
    let source: AsyncIterable<Uint8Array> | undefined
    if (url.protocol === "data:") {
      const bytes = Attachment.decodeDataUrl(part.url).buffer
      source = (async function* () {
        yield bytes
      })()
    } else {
      const filepath =
        url.protocol === "asset:"
          ? Asset.resolvePath(url.hostname + url.pathname)
          : url.protocol === "file:" && options.allowFile
            ? fileURLToPath(url)
            : undefined
      if (filepath) {
        const file = Bun.file(filepath)
        const stat = await file.stat()
        if (stat.isFile())
          source = (async function* () {
            const reader = file.stream().getReader()
            try {
              while (true) {
                const { done, value } = await reader.read()
                if (done) return
                yield value
              }
            } finally {
              await reader.cancel()
              reader.releaseLock()
            }
          })()
      }
    }
    if (!source) return part
    return { ...part, artifact: await RolloutArtifact.write(owner, source, part.mime) }
  }

  export async function materialize(owner: RolloutSchema.Owner, ref: RolloutArtifact.Ref) {
    if (ref.status !== "complete" || !ref.sha256) throw new Error("Cannot materialize incomplete attachment evidence")
    const id = `${ref.sha256.slice(0, 16)}.${Asset.extFromMime(ref.mediaType) ?? "bin"}`
    const target = Asset.filePath(id)
    const temporary = `${target}.${crypto.randomUUID()}.tmp`
    const file = await open(temporary, "wx", 0o600)
    try {
      for await (const chunk of RolloutArtifact.read(owner, ref)) {
        let offset = 0
        while (offset < chunk.byteLength) {
          const { bytesWritten } = await file.write(chunk.subarray(offset))
          if (!bytesWritten) throw new Error("Could not materialize attachment")
          offset += bytesWritten
        }
      }
      await file.sync()
      await file.close()
      await rename(temporary, target)
      return `asset://${id}`
    } catch (error) {
      await file.close().catch(() => {})
      await unlink(temporary).catch(() => {})
      throw error
    }
  }
}
