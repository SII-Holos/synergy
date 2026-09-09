import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import path from "node:path"
import { chromium, type Browser, type Page } from "playwright"
import { createServer, type ViteDevServer } from "vite"
import solidPlugin from "vite-plugin-solid"
import { Persist } from "../../../src/utils/persist"

let browser: Browser
let page: Page
let server: ViteDevServer
let fixtureDirectory: string

const DIR = "/tmp/draft-dom-fixture"
const dirtyPromptState = JSON.stringify({
  prompt: [{ type: "text", content: "unsent input", start: 0, end: 12 }],
  context: { items: [] },
})
const storedEntryTarget = Persist.session(DIR, "ses_stored", "prompt")
const storedEntryKey = `${storedEntryTarget.storage}:${storedEntryTarget.key}`

beforeAll(async () => {
  fixtureDirectory = await mkdtemp(path.join(import.meta.dir, ".sidebar-draft-fixture-"))
  const badgePath = path.resolve(import.meta.dir, "../../../src/components/sidebar/session-draft-badge.tsx")
  const draftIndexPath = path.resolve(import.meta.dir, "../../../src/context/prompt/draft-index.ts")

  await Promise.all([
    Bun.write(
      path.join(fixtureDirectory, "index.html"),
      '<div id="root"></div><script type="module" src="/main.tsx"></script>',
    ),
    Bun.write(
      path.join(fixtureDirectory, "main.tsx"),
      `
        import { render } from "solid-js/web"
        import { SessionDraftBadge } from ${JSON.stringify(`/@fs/${badgePath}`)}
        import { markDraftSession, rebuildDraftSessionIndex } from ${JSON.stringify(`/@fs/${draftIndexPath}`)}

        function DraftRow(props: { sessionID: string; title: string }) {
          return (
            <button type="button" data-row={props.sessionID}>
              <SessionDraftBadge sessionID={props.sessionID} label="Draft" />
              <span class="row-title">{props.title}</span>
            </button>
          )
        }

        render(
          () => (
            <div>
              <DraftRow sessionID="ses_local" title="Local draft" />
              <DraftRow sessionID="ses_stored" title="Stored draft" />
            </div>
          ),
          document.querySelector("#root")!,
        )

        ;(window as any).__draft = { mark: markDraftSession, rebuild: rebuildDraftSessionIndex }
      `,
    ),
  ])

  server = await createServer({
    configFile: false,
    root: fixtureDirectory,
    plugins: [solidPlugin()],
    server: {
      host: "127.0.0.1",
      port: 5216,
      strictPort: true,
      fs: { allow: [path.resolve(import.meta.dir, "../../../..")] },
    },
  })
  await server.listen()
  const url = server.resolvedUrls?.local[0]
  if (!url) throw new Error("Expected Vite test server URL")

  browser = await chromium.launch({ headless: true })
  page = await browser.newPage({ viewport: { width: 800, height: 600 } })
  await page.goto(url)
})

afterAll(async () => {
  await page?.close()
  await browser?.close()
  await server?.close()
  if (fixtureDirectory) await rm(fixtureDirectory, { recursive: true, force: true })
})

describe("sidebar session draft badge reactivity", () => {
  test("renders no badge before any draft exists", async () => {
    await expect(page.locator("[data-draft-badge]").count()).resolves.toBe(0)
  })

  test("shows the bracketed label before the row title when the composer marks the session", async () => {
    await page.evaluate(() => {
      ;(window as unknown as { __draft: { mark: (id: string, dirty: boolean) => void } }).__draft.mark(
        "ses_local",
        true,
      )
    })

    await expect(page.locator('[data-draft-badge="ses_local"]').textContent()).resolves.toBe("[Draft]")
    const titleFollowsBadge = await page.evaluate(() => {
      const badge = document.querySelector('[data-draft-badge="ses_local"]')!
      const title = badge.closest("button")!.querySelector(".row-title")!
      return !!(badge.compareDocumentPosition(title) & Node.DOCUMENT_POSITION_FOLLOWING)
    })
    expect(titleFollowsBadge).toBe(true)
  })

  test("clears the badge when the draft is sent", async () => {
    await page.evaluate(() => {
      ;(window as unknown as { __draft: { mark: (id: string, dirty: boolean) => void } }).__draft.mark(
        "ses_local",
        false,
      )
    })
    await expect(page.locator('[data-draft-badge="ses_local"]').count()).resolves.toBe(0)
  })

  test("rebuild derives the badge from persisted prompt entries", async () => {
    await page.evaluate(
      ({ key, state }) => {
        localStorage.setItem(key, state)
        ;(window as unknown as { __draft: { rebuild: () => void } }).__draft.rebuild()
      },
      { key: storedEntryKey, state: dirtyPromptState },
    )

    await expect(page.locator('[data-draft-badge="ses_stored"]').textContent()).resolves.toBe("[Draft]")

    await page.evaluate((key) => {
      localStorage.removeItem(key)
      ;(window as unknown as { __draft: { rebuild: () => void } }).__draft.rebuild()
    }, storedEntryKey)
    await expect(page.locator('[data-draft-badge="ses_stored"]').count()).resolves.toBe(0)
  })
})
