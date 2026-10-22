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
      '<div id="actions"></div><div id="recent"></div><div id="worktree"></div><div id="paused"></div><div id="empty"></div><div id="grouped"></div><div id="mixed"></div><div id="account"></div><script type="module" src="/main.ts"></script>',
    ),
    Bun.write(
      path.join(fixtureDirectory, "main.ts"),
      `
        import { createComponent } from "solid-js"
        import { render } from "solid-js/web"
        import {
          MobileDrawerAddProjectButton,
          MobileDrawerAccountRow,
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

        const homeVisual = (label: string, icon: string) => ({
          visual: {
            icon,
            label: { id: "session.state.home.unread", message: label },
            tone: "default",
            completionUnread: label === "Home session; response ready" ? true : undefined,
          },
          label,
        })

        const runningVisual = (label: string) => ({
          visual: {
            icon: "loader-circle",
            label: { id: "session.state.running", message: label },
            tone: "active",
            pulse: true,
          },
          label,
        })

        const worktreeVisual = (label: string) => ({
          visual: {
            icon: "git-fork",
            label: { id: "session.state.worktree", message: label },
            tone: "worktree",
          },
          label,
        })

        const pausedVisual = (label: string) => ({
          visual: {
            icon: "circle-pause",
            label: { id: "session.state.paused", message: label },
            tone: "paused",
          },
          label,
        })

        render(
          () =>
            createComponent(MobileDrawerRecent, {
              label: "Recent",
              emptyLabel: "No recent sessions",
              loadMoreLabel: "Load more",
              untitledLabel: "Untitled",
              draftLabel: "Draft",
              hasDraft: () => false,
              entries: [entry("ses_recent", "Recent session", true), entry("ses_other", "Other session")],
              currentSessionID: "ses_recent",
              visualFor: (value) =>
                value.id === "ses_recent" ? homeVisual("Home session; response ready", "home") : runningVisual("Running session"),
              hasMore: true,
              onSelect: (value) => selected.push(value.id),
              onLoadMore: () => loadMoreCalls++,
            }),
          document.querySelector("#recent")!,
        )

        render(
          () =>
            createComponent(MobileDrawerRecent, {
              label: "Paused",
              emptyLabel: "No recent sessions",
              loadMoreLabel: "Load more",
              untitledLabel: "Untitled",
              draftLabel: "Draft",
              hasDraft: () => false,
              entries: [entry("ses_paused", "Paused session")],
              visualFor: () => pausedVisual("Session paused"),
              hasMore: false,
              onSelect: () => {},
              onLoadMore: () => {},
            }),
          document.querySelector("#paused")!,
        )

        render(
          () =>
            createComponent(MobileDrawerRecent, {
              label: "Worktree",
              emptyLabel: "No recent sessions",
              loadMoreLabel: "Load more",
              untitledLabel: "Untitled",
              draftLabel: "Draft",
              hasDraft: () => false,
              entries: [entry("ses_wt", "Worktree session")],
              visualFor: () => worktreeVisual("Worktree session"),
              hasMore: false,
              onSelect: () => {},
              onLoadMore: () => {},
            }),
          document.querySelector("#worktree")!,
        )

        render(
          () =>
            createComponent(MobileDrawerRecent, {
              label: "Recent",
              emptyLabel: "No recent sessions",
              loadMoreLabel: "Load more",
              untitledLabel: "Untitled",
              draftLabel: "Draft",
              hasDraft: () => false,
              entries: [],
              visualFor: () => worktreeVisual(""),
              hasMore: false,
              onSelect: () => {},
              onLoadMore: () => {},
            }),
          document.querySelector("#empty")!,
        )

        render(
          () =>
            createComponent(MobileDrawerRecent, {
              label: "Recent",
              emptyLabel: "No recent sessions",
              loadMoreLabel: "Load more",
              untitledLabel: "Untitled",
              draftLabel: "Draft",
              hasDraft: () => false,
              entries: [
                { ...entry("ses_today", "Today session"), lastActivityAt: Date.now() },
                { ...entry("ses_earlier", "Earlier session"), lastActivityAt: 1 },
              ],
              visualFor: () => homeVisual("", "home"),
              hasMore: false,
              onSelect: () => {},
              onLoadMore: () => {},
              groups: { pinned: "Pinned", today: "Today", earlier: "Earlier" },
            }),
          document.querySelector("#grouped")!,
        )

        // Production order puts pinned sessions first regardless of age, so a
        // pinned old session sits above a fresh unpinned one. Rendering that
        // order must not split the date groups into Earlier/Today/Earlier.
        render(
          () =>
            createComponent(MobileDrawerRecent, {
              label: "Mixed",
              emptyLabel: "No recent sessions",
              loadMoreLabel: "Load more",
              untitledLabel: "Untitled",
              draftLabel: "Draft",
              hasDraft: () => false,
              entries: [
                { ...entry("ses_pinned_old", "Pinned old"), pinned: 2, lastActivityAt: 1 },
                { ...entry("ses_today_two", "Today unpinned"), lastActivityAt: Date.now() },
                { ...entry("ses_earlier_two", "Earlier unpinned"), lastActivityAt: 2 },
              ],
              visualFor: () => homeVisual("", "home"),
              hasMore: false,
              onSelect: () => {},
              onLoadMore: () => {},
              groups: { pinned: "Pinned", today: "Today", earlier: "Earlier" },
            }),
          document.querySelector("#mixed")!,
        )

        render(
          () =>
            createComponent(MobileDrawerAccountRow, {
              name: "Eric",
              description: "Connected to Holos",
              avatarSrc: "/avatar.png",
              onClick: () => actions.push("account"),
            }),
          document.querySelector("#account")!,
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

  test("renders a live spinner icon for running recent sessions", async () => {
    await withFixture(async (page) => {
      const row = page.locator('#recent [data-session-id="ses_other"]')
      await expect(row.locator("span.sb-session-icon-pulse").count()).resolves.toBe(1)
      await expect(row.getByText("Running session").count()).resolves.toBe(1)
    })
  })

  test("renders the worktree glyph and label for worktree sessions", async () => {
    await withFixture(async (page) => {
      const section = page.locator("#worktree")
      const row = section.locator('[data-session-id="ses_wt"]')
      await expect(row.locator('[data-slot="icon-svg"]').count()).resolves.toBe(1)
      await expect(row.locator('[data-slot="icon-svg"].text-icon-success-base').count()).resolves.toBe(0)
      expect(await row.locator("span.text-13-medium").textContent()).toBe("Worktree session")
      await expect(section.locator(".sr-only", { hasText: "Worktree session" }).count()).resolves.toBe(1)
    })
  })

  test("gives a paused session its own tint instead of falling through to resting", async () => {
    await withFixture(async (page) => {
      const row = page.locator('#paused [data-session-id="ses_paused"]')
      await expect(row.locator('[data-slot="icon-svg"].text-icon-warning-base').count()).resolves.toBe(1)
      await expect(row.locator("span.sb-session-icon-pulse").count()).resolves.toBe(0)
      await expect(page.locator("#paused").locator(".sr-only", { hasText: "Session paused" }).count()).resolves.toBe(1)
    })
  })

  test("shows the recent empty state without a stale session row", async () => {
    await withFixture(async (page) => {
      const empty = page.locator("#empty")
      await expect(empty.getByText("No recent sessions").count()).resolves.toBe(1)
      expect(await empty.locator("[data-session-id]").count()).toBe(0)
    })
  })

  test("groups recents under today and earlier headings when the caller supplies labels", async () => {
    await withFixture(async (page) => {
      const grouped = page.locator("#grouped")
      expect(await grouped.locator("h3").allTextContents()).toEqual(["Today", "Earlier"])
      expect(await grouped.locator("[data-session-id]").count()).toBe(2)
      const order = await grouped
        .locator("[data-session-id]")
        .evaluateAll((rows) => rows.map((row) => row.getAttribute("data-session-id")))
      expect(order).toEqual(["ses_today", "ses_earlier"])
    })
  })

  test("keeps the flat recent list when no grouping labels are supplied", async () => {
    await withFixture(async (page) => {
      const recent = page.locator("#recent")
      expect(await recent.locator("h3").count()).toBe(0)
      expect(await recent.locator("[data-session-id]").count()).toBe(2)
    })
  })

  test("keeps pinned sessions in one group when production order interleaves them with dates", async () => {
    await withFixture(async (page) => {
      const mixed = page.locator("#mixed")
      // Each heading appears once, in fixed order: pinned, today, earlier.
      expect(await mixed.locator("h3").allTextContents()).toEqual(["Pinned", "Today", "Earlier"])
      const order = await mixed
        .locator("[data-session-id]")
        .evaluateAll((rows) => rows.map((row) => row.getAttribute("data-session-id")))
      expect(order).toEqual(["ses_pinned_old", "ses_today_two", "ses_earlier_two"])
    })
  })

  test("renders the account row with its identity and opens account settings", async () => {
    await withFixture(async (page) => {
      const account = page.locator("#account")
      await expect(account.getByText("Eric", { exact: true }).count()).resolves.toBe(1)
      await expect(account.getByText("Connected to Holos", { exact: true }).count()).resolves.toBe(1)
      expect(await account.locator("img").getAttribute("src")).toBe("/avatar.png")
      await account.getByRole("button").click()
      const actions = await page.evaluate(() => (window as any).__mobileDrawerState.actions)
      expect(actions).toContain("account")
    })
  })
})
