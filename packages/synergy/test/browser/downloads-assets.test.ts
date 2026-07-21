import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { BrowserDownloads } from "../../src/browser/downloads.js"
import { BrowserAssets } from "../../src/browser/assets.js"
import { BrowserDownloadsTool } from "../../src/tool/browser-downloads.js"
import type { BrowserOwner } from "../../src/browser/owner.js"

const ownerA: BrowserOwner.Info = { mode: "session", scopeID: "scope-a", sessionID: "session-a", directory: "/tmp/a" }
const ownerB: BrowserOwner.Info = { mode: "session", scopeID: "scope-b", sessionID: "session-b", directory: "/tmp/b" }

function record(
  id: string,
  state: BrowserDownloads.DownloadRecord["state"] = "pending",
): BrowserDownloads.DownloadRecord {
  return {
    id,
    pageID: "page-1",
    url: "https://example.com/file.zip",
    suggestedFilename: "file.zip",
    mimeType: "application/zip",
    state,
    createdAt: Date.now(),
  }
}

describe("BrowserDownloads owner isolation", () => {
  beforeEach(() => BrowserDownloads.clearForTest())
  afterEach(() => BrowserDownloads.clearForTest())

  test("never exposes records across owners", () => {
    BrowserDownloads.add(ownerA, record("a"))
    BrowserDownloads.add(ownerB, record("b"))
    expect(BrowserDownloads.list(ownerA).map((item) => item.id)).toEqual(["a"])
    expect(BrowserDownloads.get(ownerA, "b")).toBeUndefined()
  })

  test("wait observes terminal state and cancel updates the owner record", async () => {
    BrowserDownloads.add(ownerA, record("wait"))
    BrowserDownloads.add(ownerA, record("cancel"))
    setTimeout(() => BrowserDownloads.update(ownerA, "wait", { state: "completed", size: 42 }), 20)
    expect(await BrowserDownloads.wait(ownerA, "wait", 500)).toMatchObject({ state: "completed", size: 42 })
    expect(await BrowserDownloads.cancel(ownerA, "cancel")).toMatchObject({ state: "cancelled" })
    await expect(BrowserDownloads.cancel(ownerA, "wait")).rejects.toThrow("completed state")
  })

  test("bounds retained download metadata per owner", () => {
    let accepted = 0
    for (let index = 0; index < 10_000; index++) {
      if (
        BrowserDownloads.add(ownerA, {
          id: `download-${index}`,
          pageID: "page-a",
          url: "https://example.com/file",
          suggestedFilename: "file.txt",
          state: "completed",
          createdAt: index,
        })
      )
        accepted++
    }
    expect(accepted).toBe(10_000)
    expect(
      BrowserDownloads.add(ownerA, {
        id: "download-over-limit",
        pageID: "page-a",
        url: "https://example.com/file",
        suggestedFilename: "file.txt",
        state: "completed",
        createdAt: 10_001,
      }),
    ).toBe(false)
    expect(BrowserDownloads.list(ownerA)).toHaveLength(10_000)
  })

  test("tool schema requires ids and export paths", async () => {
    const schema = (await BrowserDownloadsTool.init()).parameters
    expect(schema.safeParse({ action: "list" }).success).toBe(true)
    expect(schema.safeParse({ action: "wait" }).success).toBe(false)
    expect(schema.safeParse({ action: "cancel", id: "x" }).success).toBe(true)
    expect(schema.safeParse({ action: "export", id: "x" }).success).toBe(false)
    expect(schema.safeParse({ action: "export", id: "x", path: "out/file.zip" }).success).toBe(true)
  })
})

describe("BrowserAssets", () => {
  test("classifies known MIME families and filters deterministically", () => {
    expect(BrowserAssets.classifyByMime("image/png")).toBe("image")
    expect(BrowserAssets.classifyByMime("application/javascript")).toBe("script")
    expect(BrowserAssets.classifyByMime("text/css")).toBe("stylesheet")
    expect(BrowserAssets.classifyByMime("font/woff2")).toBe("font")
    expect(BrowserAssets.classifyByMime("application/octet-stream")).toBe("other")
    const assets: BrowserAssets.PageAsset[] = [
      { id: "1", pageID: "page", url: "https://x/a.png", type: "image" },
      { id: "2", pageID: "page", url: "https://x/a.js", type: "script" },
    ]
    expect(BrowserAssets.filterByType(assets, ["script"])).toEqual([assets[1]])
  })
})
