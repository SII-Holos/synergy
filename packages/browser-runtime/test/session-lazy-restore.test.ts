import { afterAll, expect, test } from "bun:test"
import { BrowserSessionImpl } from "../src/session"
import { BrowserProfiles } from "../src/profiles"
import { BrowserStorage } from "../src/storage"
import { BrowserEvent } from "../src/event"
import { BrowserDownloads } from "../src/downloads"
import type { BrowserPageEventHandlers, BrowserPageBackend } from "../src/page"
import type { BrowserEvent as Event } from "@ericsanchezok/synergy-browser-core"
import { testRuntime } from "./support/runtime"
const runtime = await testRuntime()
afterAll(() => runtime.close())
const owner = () => ({ mode: "scope" as const, scopeID: `restore-${crypto.randomUUID()}`, directory: null })
function backend(id: string, url: string): BrowserPageBackend {
  let alive = true
  return {
    id,
    url,
    title: "Example",
    backend: "host",
    loading: false,
    lastActiveAt: null,
    isAlive: () => alive,
    execute: async () => ({ type: "void" }),
    close: async () => {
      alive = false
    },
  }
}
test("suspended catalog reads never start a native page; explicit resume keeps page and profile", () =>
  runtime.run(async () => {
    const target = owner(),
      profile = await BrowserProfiles.defaultProfile()
    await BrowserStorage.save(target, {
      pages: [
        {
          id: "restored",
          url: "https://example.com",
          title: "Saved",
          isLoading: false,
          lastActiveAt: 1,
          profileId: profile.id,
          status: "suspended",
        },
      ],
      timestamp: 1,
    })
    let creates = 0
    const session = new BrowserSessionImpl(target, async ({ id, url }) => {
      creates++
      return backend(id, url!)
    })
    expect(await session.restore()).toBe(true)
    expect(creates).toBe(0)
    expect(session.status).toBe("suspended")
    const page = await session.resumePage("restored")
    expect(await session.resumePage("restored")).toBe(page)
    expect(creates).toBe(1)
    expect(session.pages[0]?.profileId).toBe(profile.id)
    await session.dispose()
  }))
test("temporary page descriptors never survive a restart", () =>
  runtime.run(async () => {
    const target = owner(),
      profile = await BrowserProfiles.create({ name: "Private", kind: "temporary" })
    const session = new BrowserSessionImpl(target, async ({ id, url }) => backend(id, url!))
    await session.openPage({ profileId: profile.id })
    expect(session.pages).toHaveLength(1)
    expect((await BrowserStorage.load(target))?.pages).toEqual([])
    await session.dispose()
  }))
test("failed page closure preserves a retryable resource handle", () =>
  runtime.run(async () => {
    let attempts = 0
    const session = new BrowserSessionImpl(owner(), async ({ id, url }) => {
      const page = backend(id, url!)
      page.close = async () => {
        if (++attempts === 1) throw new Error("close failed")
      }
      return page
    })
    const page = await session.openPage({})
    await expect(session.closePage(page.id)).rejects.toThrow("close failed")
    expect(session.getPage(page.id)).toBe(page)
    await session.closePage(page.id)
    expect(session.pages).toEqual([])
  }))
test("native events preserve page attribution and redact private download paths", () =>
  runtime.run(async () => {
    const target = owner(),
      events: Event[] = []
    let handlers: BrowserPageEventHandlers = {}
    const unsubscribe = BrowserEvent.subscribe(target, (event) => events.push(event))
    const session = new BrowserSessionImpl(target, async ({ id, url, events }) => {
      handlers = events
      return backend(id, url!)
    })
    const page = await session.openPage({ url: "https://example.com" })
    page.title = "Updated"
    handlers.onLoaded?.(page)
    handlers.onStatus?.(page, "failed")
    expect(session.pages[0]?.status).toBe("failed")
    handlers.onStatus?.(page, "ready")
    const download = {
      id: "download",
      url: "https://example.com/result.txt",
      fileName: "result.txt",
      mimeType: "text/plain",
      state: "completed" as const,
      totalBytes: 1,
      receivedBytes: 1,
      timestamp: 1,
      path: "/private/managed/result.txt",
    }
    handlers.onDownload?.(page, download)
    handlers.onDialog?.(page, { requestId: "prompt", type: "prompt", message: "Name" })
    await session.save()
    expect((await BrowserStorage.load(target))?.pages[0]?.title).toBe("Updated")
    expect(BrowserDownloads.get(target, "download")?.path).toBe(download.path)
    expect(events.find((event) => event.type === "download.updated")).not.toHaveProperty("entry.path")
    expect(events.find((event) => event.type === "dialog.opened")).toMatchObject({ pageId: page.id })
    await session.closePage(page.id)
    expect(() => handlers.onLoaded?.(page)).not.toThrow()
    unsubscribe()
  }))
test("annotations round trip without allocating a browser", () =>
  runtime.run(async () => {
    const target = owner()
    const session = new BrowserSessionImpl(target, async () => {
      throw new Error("must stay lazy")
    })
    const annotation = await session.addAnnotation({
      createdBy: "user",
      comment: "Increase contrast",
      pageID: "annotation-page",
      pageURL: "https://example.com",
    })
    const restored = new BrowserSessionImpl(target, async () => {
      throw new Error("must stay lazy")
    })
    await restored.restore()
    expect(restored.annotations[0]?.id).toBe(annotation.id)
    expect(await restored.removeAnnotation(annotation.id)).toBe(true)
    expect((await BrowserStorage.load(target))?.annotations).toEqual([])
  }))
