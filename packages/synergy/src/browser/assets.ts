export namespace BrowserAssets {
  export interface PageAsset {
    id: string
    pageID: string
    url: string
    type: "image" | "script" | "stylesheet" | "font" | "media" | "document" | "other"
    mimeType?: string
    status?: number
    size?: number
    initiator?: string
  }

  const MIME_TO_TYPE: [RegExp, PageAsset["type"]][] = [
    [/^image\//, "image"],
    [/^text\/javascript$/, "script"],
    [/^application\/javascript$/, "script"],
    [/^application\/x-javascript$/, "script"],
    [/^text\/css$/, "stylesheet"],
    [/^font\//, "font"],
    [/^application\/font-/, "font"],
    [/^video\//, "media"],
    [/^audio\//, "media"],
    [/^text\/html$/, "document"],
    [/^application\/xhtml\+xml$/, "document"],
    [/^application\/pdf$/, "document"],
  ]

  export function classifyByMime(mimeType: string): PageAsset["type"] {
    const normalized = mimeType.trim().toLowerCase()
    if (!normalized) return "other"
    for (const [pattern, type] of MIME_TO_TYPE) {
      if (pattern.test(normalized)) return type
    }
    return "other"
  }

  export function filterByType(assets: PageAsset[], types: PageAsset["type"][]): PageAsset[] {
    const typeSet = new Set(types)
    return assets.filter((a) => typeSet.has(a.type))
  }
}
