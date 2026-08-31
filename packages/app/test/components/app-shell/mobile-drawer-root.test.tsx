import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import path from "node:path"
import { chromium, type Browser, type Page } from "playwright"
import { createServer, type ViteDevServer } from "vite"
import solidPlugin from "vite-plugin-solid"

let browser: Browser
let server: ViteDevServer
let fixtureDirectory: string
let fixtureUrl: string

beforeAll(async () => {
  fixtureDirectory = await mkdtemp(path.join(import.meta.dir, ".mobile-drawer-root-fixture-"))
  const componentPath = path.resolve(import.meta.dir, "../../../src/components/app-shell/mobile-drawer-root.tsx")

  await Promise.all([
    Bun.write(
      path.join(fixtureDirectory, "index.html"),
      '<div id="actions"></div><div id="recent"></div><div id="empty"></div><script type="module" src="/main.ts"></script>',
    ),
    Bun.write(
      path.join(fixtureDirectory, "main.ts"),
      `
        import { createComponent } from "solid-js"
        import { render } from "solid-js/web"
        import {
          MobileDrawerAddProjectButton,
          MobileDrawerRecent,
          MobileDrawerSettingsButton,
        } from ${JSON.stringify(`/@fs/${componentPath}`)}

        const actions: string[] = []
        const selected: string[] = []
        let loadMoreCalls = 0
        ;(window as any).__mobileDrawerState = {
          actions,
          selected,
          loadMoreCalls: () => loadMoreCalls,
        }

        render(
          () => [
            createComponent(MobileDrawerAddProjectButton, {
              label: "Add project",
              onClick: () => actions.push("project"),
            }),
            createComponent(MobileDrawerSettingsButton, {
              label: "Settings",
              onClick: () => actions.push("settings"),
            }),
          ],
          document.querySelector("#actions")!,
        )

        const entry = (id: string, title: string, unread = false) => ({
          id,
          scopeID: "home",
          scopeType: "home",
          title,
          category: "home",
          lastActivityAt: 1,
          pinned: 0,
          archived: false,
          completionNotice: { unread, unreadCount: unread ? 1 : 0 },
        })

        render(
          () =>
            createComponent(MobileDrawerRecent, {
              label: "Recent",
              emptyLabel: "No recent sessions",
              loadMoreLabel: "Load more",
              untitledLabel: "Untitled",
              draftLabel: "Draft",
              entries: [entry("ses_recent", "Recent session", true), entry("ses_other", "Other session")],
              currentSessionID: "ses_recent",
              unreadLabel: (value) =>
                value.completionNotice.unread ? "Home session; response ready" : undefined,
              hasMore: true,
              onSelect: (value) => selected.push(value.id),
              onLoadMore: () => loadMoreCalls++,
            }),
          document.querySelector("#recent")!,
        )

        render(
          () =>
            createComponent(MobileDrawerRecent, {
              label: "Recent",
              emptyLabel: "No recent sessions",
              loadMoreLabel: "Load more",
              untitledLabel: "Untitled",
              draftLabel: "Draft",
              entries: [],
              unreadLabel: () => undefined,
              hasMore: false,
              onSelect: () => {},
              onLoadMore: () => {},
            }),
          document.querySelector("#empty")!,
        )
      `,
    ),
  ])

  server = await createServer({
    configFile: false,
    root: fixtureDirectory,
    plugins: [solidPlugin()],
    server: {
      host: "127.0.0.1",
      port: 5199,
      strictPort: true,
      fs: { allow: [path.resolve(import.meta.dir, "../../../..")] },
    },
  })
  await server.listen()
  fixtureUrl = server.resolvedUrls?.local[0] ?? ""
  if (!fixtureUrl) throw new Error("Expected Vite test server URL")
  browser = await chromium.launch({ headless: true })
})

afterAll(async () => {
  await browser?.close()
  await server?.close()
  if (fixtureDirectory) await rm(fixtureDirectory, { recursive: true, force: true })
})

async function withFixture(run: (page: Page) => Promise<void>) {
  const page = await browser.newPage({ viewport: { width: 375, height: 667 } })
  try {
    await page.goto(fixtureUrl)
    await run(page)
  } finally {
    await page.close()
  }
}

describe("mobile drawer root navigation", () => {
  test("keeps Add project and Settings reachable as labeled actions", async () => {
    await withFixture(async (page) => {
      await page.getByRole("button", { name: "Add project" }).click()
      await page.getByRole("button", { name: "Settings" }).click()
      const actions = await page.evaluate(() => (window as any).__mobileDrawerState.actions)
      expect(actions).toEqual(["project", "settings"])
    })
  })

  test("shows recent sessions at the drawer root and exposes active navigation", async () => {
    await withFixture(async (page) => {
      const recent = page.locator("#recent")
      await expect(recent.getByRole("heading", { name: "Recent" }).count()).resolves.toBe(1)
      await expect(recent.getByText("Recent session").count()).resolves.toBe(1)
      await expect(recent.getByText("Other session").count()).resolves.toBe(1)
      expect(await recent.locator('[data-session-id="ses_recent"]').getAttribute("aria-current")).toBe("page")
      await expect(recent.getByRole("button", { name: /Recent session.*response ready/ }).count()).resolves.toBe(1)

      await recent.locator('[data-session-id="ses_other"]').click()
      await recent.locator('[data-action="load-more-recent"]').click()
      const state = await page.evaluate(() => ({
        selected: (window as any).__mobileDrawerState.selected,
        loadMoreCalls: (window as any).__mobileDrawerState.loadMoreCalls(),
      }))
      expect(state).toEqual({ selected: ["ses_other"], loadMoreCalls: 1 })
    })
  })

  test("shows the recent empty state without a stale session row", async () => {
    await withFixture(async (page) => {
      const empty = page.locator("#empty")
      await expect(empty.getByText("No recent sessions").count()).resolves.toBe(1)
      expect(await empty.locator("[data-session-id]").count()).toBe(0)
    })
  })
})
