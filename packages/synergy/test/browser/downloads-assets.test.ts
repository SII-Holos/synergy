import { describe, test, expect, spyOn, mock, beforeEach, afterEach } from "bun:test"
import { BrowserDownloads } from "../../src/browser/downloads.js"
import { BrowserAssets } from "../../src/browser/assets.js"
import { BrowserDownloadsTool } from "../../src/tool/browser-downloads.js"
import { BrowserAssetsTool } from "../../src/tool/browser-assets.js"

// ── helpers ────────────────────────────────────────────────────────────

function uid(): string {
  return "00000000-0000-0000-0000-000000000001".replace(/0/g, () => Math.floor(Math.random() * 16).toString(16))
}

function sampleRecord(overrides?: Partial<BrowserDownloads.DownloadRecord>): BrowserDownloads.DownloadRecord {
  return {
    id: uid(),
    pageID: "page-1",
    url: "https://example.com/file.zip",
    suggestedFilename: "file.zip",
    mimeType: "application/zip",
    state: "pending",
    createdAt: Date.now(),
    ...overrides,
  }
}

function sampleAsset(overrides?: Partial<BrowserAssets.PageAsset>): BrowserAssets.PageAsset {
  return {
    id: "req-1",
    pageID: "page-1",
    url: "https://example.com/logo.png",
    type: "image",
    mimeType: "image/png",
    status: 200,
    size: 1024,
    ...overrides,
  }
}

// ════════════════════════════════════════════════════════════════════════
//  BrowserDownloads
// ════════════════════════════════════════════════════════════════════════

describe("BrowserDownloads", () => {
  beforeEach(() => {
    BrowserDownloads.clear()
  })

  afterEach(() => {
    BrowserDownloads.clear()
  })

  // ── existing CRUD ─────────────────────────────────────────────────
  describe("list / add / remove / get / update", () => {
    test("list returns empty array initially", () => {
      expect(BrowserDownloads.list()).toEqual([])
    })

    test("add pushes a record and list reflects it", () => {
      const rec = sampleRecord()
      BrowserDownloads.add(rec)
      expect(BrowserDownloads.list()).toEqual([rec])
    })

    test("get returns record by id", () => {
      const rec = sampleRecord()
      BrowserDownloads.add(rec)
      expect(BrowserDownloads.get(rec.id)).toEqual(rec)
    })

    test("get returns undefined for unknown id", () => {
      expect(BrowserDownloads.get("no-such")).toBeUndefined()
    })

    test("remove deletes a record and returns true", () => {
      const rec = sampleRecord()
      BrowserDownloads.add(rec)
      expect(BrowserDownloads.remove(rec.id)).toBe(true)
      expect(BrowserDownloads.list()).toEqual([])
    })

    test("remove returns false for unknown id", () => {
      expect(BrowserDownloads.remove("no-such")).toBe(false)
    })

    test("update patches fields on existing record", () => {
      const rec = sampleRecord()
      BrowserDownloads.add(rec)
      BrowserDownloads.update(rec.id, { state: "completed", size: 4096 })
      const updated = BrowserDownloads.get(rec.id)
      expect(updated?.state).toBe("completed")
      expect(updated?.size).toBe(4096)
      expect(updated?.url).toBe(rec.url) // untouched field
    })

    test("update on unknown id is a no-op", () => {
      BrowserDownloads.update("no-such", { state: "completed" })
      expect(BrowserDownloads.list()).toEqual([])
    })

    test("clear empties all records", () => {
      BrowserDownloads.add(sampleRecord())
      BrowserDownloads.add(sampleRecord())
      BrowserDownloads.clear()
      expect(BrowserDownloads.list()).toEqual([])
    })
  })

  // ── waitForDownload (RED — function does not exist yet) ───────────
  describe("waitForDownload", () => {
    test("resolves when matching record reaches completed state", async () => {
      const rec = sampleRecord({ state: "pending" })
      BrowserDownloads.add(rec)

      const complete = async () => {
        await new Promise((r) => setTimeout(r, 20))
        BrowserDownloads.update(rec.id, { state: "completed", size: 8192 })
      }

      const [result] = await Promise.all([BrowserDownloads.waitForDownload(rec.id, 5000), complete()])

      expect(result.state).toBe("completed")
      expect(result.size).toBe(8192)
    })

    test("resolves when record is already completed", async () => {
      const rec = sampleRecord({ state: "completed" })
      BrowserDownloads.add(rec)

      const result = await BrowserDownloads.waitForDownload(rec.id)
      expect(result.state).toBe("completed")
    })

    test("rejects when timeout is exceeded", async () => {
      const rec = sampleRecord({ state: "pending" })
      BrowserDownloads.add(rec)

      await expect(BrowserDownloads.waitForDownload(rec.id, 50)).rejects.toThrow(/timed out|timeout/i)
    })

    test("rejects when record does not exist", async () => {
      await expect(BrowserDownloads.waitForDownload("no-such-id", 100)).rejects.toThrow(/not found|no-such/i)
    })

    test("resolves for failed state (terminal state)", async () => {
      const rec = sampleRecord({ state: "failed" })
      BrowserDownloads.add(rec)

      const result = await BrowserDownloads.waitForDownload(rec.id)
      expect(result.state).toBe("failed")
    })
  })
})

// ════════════════════════════════════════════════════════════════════════
//  browser_downloads tool schema (RED: needs "wait" action)
// ════════════════════════════════════════════════════════════════════════

describe("browser_downloads tool schema", () => {
  test("RED: action enum does not yet include wait", async () => {
    const info = await BrowserDownloadsTool.init()
    const schema = info.parameters

    // "list" and "remove" are currently supported
    expect(schema.safeParse({ action: "list" }).success).toBe(true)
    expect(schema.safeParse({ action: "remove", id: "x" }).success).toBe(true)

    // RED: "wait" is not yet in the action enum — this fails
    const waitResult = schema.safeParse({ action: "wait", id: "x" })
    expect(waitResult.success).toBe(true)
  })

  test("RED: current schema allows remove without id (runtime validation, not schema guard)", async () => {
    // Currently `id` is z.string().optional(), so { action: "remove" } passes schema
    // validation even though it will fail at runtime. The RED gap is that the schema
    // should use a discriminated union or refine to require id for remove.
    const info = await BrowserDownloadsTool.init()
    const schema = info.parameters

    const result = schema.safeParse({ action: "remove" })
    // RED: this succeeds today; we want schema to reject remove without id
    expect(result.success).toBe(false)
  })
})

// ════════════════════════════════════════════════════════════════════════
//  BrowserAssets.exportBundle (RED — function does not exist yet)
// ════════════════════════════════════════════════════════════════════════

describe("BrowserAssets", () => {
  describe("classifyByMime", () => {
    test("classifies image/*", () => {
      expect(BrowserAssets.classifyByMime("image/png")).toBe("image")
      expect(BrowserAssets.classifyByMime("image/jpeg")).toBe("image")
      expect(BrowserAssets.classifyByMime("image/svg+xml")).toBe("image")
    })

    test("classifies text/javascript", () => {
      expect(BrowserAssets.classifyByMime("text/javascript")).toBe("script")
      expect(BrowserAssets.classifyByMime("application/javascript")).toBe("script")
    })

    test("classifies text/css", () => {
      expect(BrowserAssets.classifyByMime("text/css")).toBe("stylesheet")
    })

    test("classifies font/*", () => {
      expect(BrowserAssets.classifyByMime("font/woff2")).toBe("font")
    })

    test("classifies text/html as document", () => {
      expect(BrowserAssets.classifyByMime("text/html")).toBe("document")
    })

    test("returns other for unknown mime types", () => {
      expect(BrowserAssets.classifyByMime("application/octet-stream")).toBe("other")
    })

    test("returns other for empty string", () => {
      expect(BrowserAssets.classifyByMime("")).toBe("other")
    })

    test("trims whitespace", () => {
      expect(BrowserAssets.classifyByMime("  image/png  ")).toBe("image")
    })
  })

  describe("filterByType", () => {
    const assets: BrowserAssets.PageAsset[] = [
      sampleAsset({ id: "r1", type: "image", url: "/a.png" }),
      sampleAsset({ id: "r2", type: "script", url: "/b.js" }),
      sampleAsset({ id: "r3", type: "stylesheet", url: "/c.css" }),
      sampleAsset({ id: "r4", type: "image", url: "/d.jpg" }),
    ]

    test("filters to matching types", () => {
      const result = BrowserAssets.filterByType(assets, ["image"])
      expect(result).toHaveLength(2)
      expect(result.every((a) => a.type === "image")).toBe(true)
    })

    test("returns empty when no types match", () => {
      const result = BrowserAssets.filterByType(assets, ["font"])
      expect(result).toHaveLength(0)
    })

    test("respects multiple type filters", () => {
      const result = BrowserAssets.filterByType(assets, ["image", "stylesheet"])
      expect(result).toHaveLength(3)
    })

    test("empty types array returns no assets", () => {
      const result = BrowserAssets.filterByType(assets, [])
      expect(result).toHaveLength(0)
    })
  })

  describe("exportBundle", () => {
    test("RED: returns path, count, and totalSize for a set of assets", async () => {
      const assets: BrowserAssets.PageAsset[] = [
        sampleAsset({ id: "r1", type: "image", url: "/a.png", size: 1024 }),
        sampleAsset({ id: "r2", type: "script", url: "/b.js", size: 2048 }),
      ]
      const outputDir = "/tmp/test-bundle"

      const result = await BrowserAssets.exportBundle(assets, outputDir)

      expect(typeof result.path).toBe("string")
      expect(result.count).toBe(2)
      expect(result.totalSize).toBe(3072)
    })

    test("RED: returns count 0 and totalSize 0 for empty assets", async () => {
      const result = await BrowserAssets.exportBundle([], "/tmp/test-bundle-empty")
      expect(result.count).toBe(0)
      expect(result.totalSize).toBe(0)
    })

    test("RED: writes a manifest.json at the output path", async () => {
      const assets: BrowserAssets.PageAsset[] = [sampleAsset({ id: "r1", type: "image", url: "/a.png", size: 512 })]
      const outputDir = "/tmp/test-bundle-manifest"

      const result = await BrowserAssets.exportBundle(assets, outputDir)

      // The returned path should reference a manifest file
      expect(result.path).toContain("manifest")
    })

    test("RED: creates outputDir if it does not exist", async () => {
      const assets: BrowserAssets.PageAsset[] = [sampleAsset({ id: "r1", type: "image", url: "/a.png", size: 100 })]
      const outputDir = `/tmp/synergy-test-bundle-${Date.now()}`

      await expect(BrowserAssets.exportBundle(assets, outputDir)).resolves.toBeDefined()
    })
  })
})

// ════════════════════════════════════════════════════════════════════════
//  browser_assets tool schema (RED: needs "export" action)
// ════════════════════════════════════════════════════════════════════════

describe("browser_assets tool schema", () => {
  test("RED: action enum does not yet include export", async () => {
    const info = await BrowserAssetsTool.init()
    const schema = info.parameters

    // "list" is already supported
    expect(schema.safeParse({ action: "list" }).success).toBe(true)
    // RED: "export" is not yet in the action enum — this fails
    const exportResult = schema.safeParse({ action: "export" })
    expect(exportResult.success).toBe(true)
  })
})
