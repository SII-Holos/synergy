import { OrganizationPublications as Publications } from "./publications"

export async function searchPublication(
  uploadID: string,
  query: string,
  authorize: () => Promise<unknown>,
  signal?: AbortSignal,
) {
  const needle = query.toLocaleLowerCase()
  for await (const file of Publications.allFiles(uploadID)) {
    signal?.throwIfAborted()
    await authorize()
    if (!file.mediaType.startsWith("text/") && !/(?:json|xml|yaml)/.test(file.mediaType)) continue
    const decoder = new TextDecoder()
    let tail = ""
    for (let offset = 0; offset < file.bytes; offset += 128 * 1024) {
      signal?.throwIfAborted()
      await authorize()
      const bytes = await Publications.readRange(uploadID, file, offset, Math.min(128 * 1024, file.bytes - offset))
      const text = tail + decoder.decode(bytes, { stream: true }).toLocaleLowerCase()
      if (text.includes(needle)) {
        await authorize()
        return true
      }
      tail = text.slice(-Math.max(1, needle.length - 1))
    }
    if ((tail + decoder.decode().toLocaleLowerCase()).includes(needle)) {
      await authorize()
      return true
    }
  }
  return false
}
