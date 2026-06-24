import type { Page } from "playwright"

import fs from "fs/promises"
import type { NetworkRequest } from "./tab.js"

export namespace BrowserAssets {
  export interface PageAsset {
    id: string
    tabID: string
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

  // ── classifyByMime ──────────────────────────────────────────────────

  export function classifyByMime(mimeType: string): PageAsset["type"] {
    const normalized = mimeType.trim().toLowerCase()
    if (!normalized) return "other"
    for (const [pattern, type] of MIME_TO_TYPE) {
      if (pattern.test(normalized)) return type
    }
    return "other"
  }

  // ── fromNetworkBuffer ───────────────────────────────────────────────

  export function fromNetworkBuffer(requests: NetworkRequest[], tabID: string): PageAsset[] {
    return requests.map((req) => ({
      id: req.requestId,
      tabID,
      url: req.url,
      type: classifyByMime(req.mimeType ?? ""),
      mimeType: req.mimeType,
      status: req.status,
      size: undefined,
      initiator: undefined,
    }))
  }

  // ── filterByType ────────────────────────────────────────────────────

  export function filterByType(assets: PageAsset[], types: PageAsset["type"][]): PageAsset[] {
    const typeSet = new Set(types)
    return assets.filter((a) => typeSet.has(a.type))
  }

  // ── exportBundle ────────────────────────────────────────────────────

  export interface ExportBundleResult {
    path: string
    count: number
    totalSize: number
  }

  export async function exportBundle(assets: PageAsset[], outputDir: string): Promise<ExportBundleResult> {
    await fs.mkdir(outputDir, { recursive: true })
    const manifestPath = `${outputDir}/manifest.json`
    await Bun.write(Bun.file(manifestPath), JSON.stringify(assets, null, 2))
    const totalSize = assets.reduce((sum, a) => sum + (a.size ?? 0), 0)
    return { path: manifestPath, count: assets.length, totalSize }
  }

  // ── attachToPage ─────────────────────────────────────────────────────

  /**
   * Wire Playwright page network events to populate asset records.
   * Called once per BrowserTab page to track loaded resources.
   */
  export function attachToPage(page: Page): { getAssets: () => PageAsset[]; clear: () => void } {
    const assetRecords: Map<string, PageAsset> = new Map()
    const tabID = ((page as unknown as Record<string, unknown>)._synergyTabID as string) ?? "unknown"
    let seq = 0

    page.on("request", (req) => {
      const url = req.url()
      const method = req.method()
      const id = `${method}:${url}:${++seq}`
      assetRecords.set(id, {
        id,
        tabID,
        url,
        type: "other",
        status: undefined,
      })
    })

    page.on("response", (resp) => {
      const respUrl = resp.url()
      const status = resp.status()
      const mimeType = resp.headers()["content-type"] ?? ""
      for (const [id, asset] of assetRecords) {
        if (asset.url === respUrl && asset.status === undefined) {
          asset.status = status
          asset.mimeType = mimeType
          asset.type = classifyByMime(mimeType)
        }
      }
    })

    return {
      getAssets: () => Array.from(assetRecords.values()),
      clear: () => assetRecords.clear(),
    }
  }
}

export const { classifyByMime, fromNetworkBuffer, filterByType } = BrowserAssets
