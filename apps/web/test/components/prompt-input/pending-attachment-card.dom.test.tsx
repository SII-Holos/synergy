import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import path from "node:path"
import { chromium, type Browser, type Page } from "playwright"
import { createServer, type ViteDevServer } from "vite"
import solidPlugin from "vite-plugin-solid"

let browser: Browser
let page: Page
let server: ViteDevServer
let fixtureDirectory: string
let url: string

beforeAll(async () => {
  fixtureDirectory = await mkdtemp(path.join(import.meta.dir, ".pending-attachment-card-fixture-"))
  const cardPath = path.resolve(import.meta.dir, "../../../src/components/prompt-input/pending-attachment-card.tsx")

  await Promise.all([
    Bun.write(
      path.join(fixtureDirectory, "index.html"),
      '<div id="root"></div><script type="module" src="/main.tsx"></script>',
    ),
    Bun.write(
      path.join(fixtureDirectory, "main.tsx"),
      `
        import { createSignal } from "solid-js"
        import { render } from "solid-js/web"
        import { PendingAttachmentCard } from ${JSON.stringify(`/@fs/${cardPath}`)}

        const [entry, setEntry] = createSignal({
          id: "prt-1",
          filename: "video.mp4",
          mime: "video/mp4",
          size: 5 * 1024 * 1024,
          status: "uploading",
        })
        const removed: string[] = []

        function Harness() {
          return (
            <PendingAttachmentCard
              entry={entry()}
              uploadingLabel="Uploading…"
              uploadedLabel="Uploaded"
              removeLabel={"Remove " + entry().filename}
              onRemove={(id) => removed.push(id)}
            />
          )
        }

        render(Harness, document.querySelector("#root")!)
        ;(window as any).__card = { setEntry, removed }
      `,
    ),
  ])

  server = await createServer({
    configFile: false,
    root: fixtureDirectory,
    plugins: [solidPlugin()],
    server: {
      host: "127.0.0.1",
      port: 5232,
      strictPort: true,
      fs: { allow: [path.resolve(import.meta.dir, "../../../..")] },
    },
  })
  await server.listen()
  url = server.resolvedUrls?.local[0] ?? ""
  if (!url) throw new Error("Expected Vite test server URL")

  browser = await chromium.launch({ headless: true })
  page = await browser.newPage({ viewport: { width: 800, height: 600 } })
  await page.goto(url)
}, 120_000)

afterAll(async () => {
  await page?.close()
  await browser?.close()
  await server?.close()
  if (fixtureDirectory) await rm(fixtureDirectory, { recursive: true, force: true })
})

describe("pending attachment card upload feedback", () => {
  test("renders a busy card with a spinner and size while uploading", async () => {
    const card = page.locator('[data-component="attachment-card"]')
    await card.waitFor({ state: "attached", timeout: 30000 })
    expect(await card.getAttribute("data-upload-state")).toBe("uploading")
    expect(await card.getAttribute("aria-busy")).toBe("true")
    expect(await card.locator('[data-component="spinner"]').count()).toBe(1)
    expect(await card.locator('[data-slot="attachment-card-filename"]').textContent()).toBe("video.mp4")
    expect(await card.locator('[data-slot="attachment-card-meta"]').textContent()).toBe("5.0 MB · Uploading…")
  })

  test("switches to the uploaded state with a success icon once the upload settles", async () => {
    await page.evaluate(() => {
      ;(window as unknown as { __card: { setEntry: (value: unknown) => void } }).__card.setEntry({
        id: "prt-1",
        filename: "video.mp4",
        mime: "video/mp4",
        size: 5 * 1024 * 1024,
        status: "uploaded",
      })
    })

    const card = page.locator('[data-component="attachment-card"]')
    await page.waitForFunction(
      () =>
        document.querySelector('[data-component="attachment-card"]')?.getAttribute("data-upload-state") === "uploaded",
    )
    expect(await card.getAttribute("aria-busy")).toBe("false")
    expect(await card.locator('[data-component="spinner"]').count()).toBe(0)
    expect(await card.locator('[data-slot="attachment-card-meta"]').textContent()).toBe("Uploaded")
  })

  test("removing the card reports the pending entry id", async () => {
    await page.locator('button[aria-label="Remove video.mp4"]').click()
    const removed = await page.evaluate(() => (window as unknown as { __card: { removed: string[] } }).__card.removed)
    expect(removed).toEqual(["prt-1"])
  })
})
