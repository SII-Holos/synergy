import { afterAll, expect, test } from "bun:test"
import { BrowserSessionImpl } from "../src/session"
import { BrowserProfiles } from "../src/profiles"
import type { BrowserPageBackend } from "../src/page"
import { testRuntime } from "./support/runtime"

const runtime = await testRuntime()
afterAll(() => runtime.close())
const owner = { mode: "scope" as const, scopeID: "pages-contract", directory: null }

function session() {
  return new BrowserSessionImpl(owner, async ({ id, url }) => {
    let alive = true
    const page: BrowserPageBackend = {
      id,
      backend: "host",
      url: url ?? "about:blank",
      title: "",
      loading: false,
      lastActiveAt: null,
      isAlive: () => alive,
      execute: async () => ({ type: "void" }),
      close: async () => {
        alive = false
      },
    }
    return page
  })
}

test("eight real independent pages retain immutable profiles and page-scoped closure", () =>
  runtime.run(async () => {
    const browser = session()
    const work = await BrowserProfiles.create({ name: "Work" })
    const pages = await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        browser.openPage({
          url: `https://example.com/${index}`,
          ...(index === 3 ? { profileId: work.id } : {}),
        }),
      ),
    )
    expect(new Set(pages.map((page) => page.id)).size).toBe(8)
    expect(browser.pages).toHaveLength(8)
    expect(browser.pages[3]?.profileId).toBe(work.id)
    await browser.closePage(pages[2]!.id)
    expect(browser.getPage(pages[2]!.id)).toBeUndefined()
    expect(browser.getPage(pages[3]!.id)?.isAlive()).toBe(true)
    await browser.dispose()
  }))

test("restore reads descriptors without creating pages and resume preserves identity", () =>
  runtime.run(async () => {
    const first = session()
    const page = await first.openPage({ url: "https://example.com/restore" })
    const profileId = first.pages[0]!.profileId
    await first.dispose()
    const next = session()
    expect(await next.restore()).toBe(true)
    expect(next.pages[0]?.status).toBe("suspended")
    expect(next.getPage(page.id)).toBeUndefined()
    expect((await next.resumePage(page.id)).id).toBe(page.id)
    expect(next.pages[0]?.profileId).toBe(profileId)
    await next.dispose()
  }))

test("disabled identity cannot reopen a page and concurrent opens respect the limit", () =>
  runtime.run(async () => {
    const browser = session()
    const profile = await BrowserProfiles.create({ name: "Disabled" })
    await BrowserProfiles.update(profile.id, { enabled: false })
    await expect(browser.openPage({ profileId: profile.id })).rejects.toThrow("disabled")
    const results = await Promise.allSettled(Array.from({ length: 20 }, () => browser.openPage({})))
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(16)
    expect(browser.pages).toHaveLength(16)
    await browser.dispose()
  }))

test("open requests deduplicate concurrent allocation and never recreate a closed page", () =>
  runtime.run(async () => {
    const browser = session()
    const request = { requestId: "open-once", url: "https://example.com/deduplicate" }
    const [a, b] = await Promise.all([browser.openPage(request), browser.openPage(request)])
    expect(a.id).toBe(b.id)
    expect(browser.pages).toHaveLength(1)
    await expect(browser.openPage({ ...request, url: "https://example.com/other" })).rejects.toMatchObject({
      code: "browser_command_id_conflict",
    })
    await browser.closePage(a.id)
    await expect(browser.openPage(request)).rejects.toMatchObject({ code: "browser_page_suspended" })
    expect(browser.pages).toHaveLength(0)
    await browser.dispose()
  }))
