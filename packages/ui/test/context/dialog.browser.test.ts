import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import path from "node:path"
import { chromium, type Browser, type Page } from "playwright"
import { build, normalizePath } from "vite"
import solid from "vite-plugin-solid"

interface DialogFixture {
  holdFrames(): void
  flushFrames(): void
  replaceOrigin(): void
  removeOrigin(): void
  replaceDialog(): void
  unmount(): void
}
type FixtureWindow = typeof window & { fixture: DialogFixture }
let directory: string
let browser: Browser
let page: Page
let server: ReturnType<typeof Bun.serve>
const errors: string[] = []

beforeAll(async () => {
  directory = await mkdtemp(path.join(import.meta.dir, ".dialog-fixture-"))
  const source = (file: string) =>
    JSON.stringify(`/@fs/${normalizePath(path.resolve(import.meta.dir, `../../src/${file}.tsx`))}`)
  await Bun.write(
    path.join(directory, "index.html"),
    '<!doctype html><div id="root"></div><script type="module" src="/main.tsx"></script>',
  )
  await Bun.write(
    path.join(directory, "main.tsx"),
    `
    import { createSignal, Show } from "solid-js"
    import { render } from "solid-js/web"
    import { setupI18n } from "@lingui/core"
    import { I18nProvider } from "@lingui/solid"
    import { DialogProvider, useDialog } from ${source("context/dialog")}
    import { Dialog } from ${source("components/dialog")}
    const [mounted, setMounted] = createSignal(true)
    const [origin, setOrigin] = createSignal("streaming")
    const [imageOpens, setImageOpens] = createSignal(0)
    const [documentOpens, setDocumentOpens] = createSignal(0)
    const nativeRequest = window.requestAnimationFrame.bind(window)
    const nativeCancel = window.cancelAnimationFrame.bind(window)
    const frames = new Map()
    let nextFrame = -1
    window.fixture = {
      holdFrames() {
        window.requestAnimationFrame = callback => { const id = nextFrame--; frames.set(id, callback); return id }
        window.cancelAnimationFrame = id => { if (!frames.delete(id)) nativeCancel(id) }
      },
      flushFrames() {
        window.requestAnimationFrame = nativeRequest
        window.cancelAnimationFrame = nativeCancel
        const pending = [...frames.values()]
        frames.clear()
        for (const callback of pending) callback(performance.now())
      },
      replaceOrigin: () => setOrigin("settled"),
      removeOrigin: () => setOrigin(undefined),
      unmount: () => setMounted(false),
    }
    function Controls() {
      const dialog = useDialog()
      const panel = title => <Dialog title={title}><button>{title} action</button></Dialog>
      const onClose = new URLSearchParams(location.search).has("dynamic")
        ? () => queueMicrotask(() => document.getElementById("image-origin")?.focus())
        : undefined
      window.fixture.replaceDialog = () => dialog.show(() => panel("Replacement"))
      const openImage = () => {
        setImageOpens(imageOpens() + 1)
        dialog.show(() => panel("Image preview"), onClose)
      }
      return <>
        <Show when={origin()} keyed>{version => <button id="image-origin" data-version={version} onClick={openImage}>Image</button>}</Show>
        <button onClick={() => dialog.show(() => <Dialog title="Parent"><button onClick={() => dialog.push(() => panel("Child"))}>Open child</button></Dialog>)}>Open parent</button>
      </>
    }
    const i18n = setupI18n({locale:"en",messages:{en:{}}})
    render(() => <I18nProvider i18n={i18n}>
      <Show when={mounted()}><DialogProvider><Controls /></DialogProvider></Show>
      <button onClick={() => setDocumentOpens(documentOpens() + 1)}>Report.txt</button>
      <output data-testid="image-opens">{imageOpens()}</output>
      <output data-testid="document-opens">{documentOpens()}</output>
    </I18nProvider>, document.getElementById("root"))
  `,
  )
  const dist = path.join(directory, "dist")
  await build({
    configFile: false,
    root: directory,
    plugins: [solid()],
    logLevel: "error",
    build: { outDir: dist, target: "esnext", minify: false },
  })
  const assets = new Map<string, ReturnType<typeof Bun.file>>()
  for await (const file of new Bun.Glob("**/*").scan(dist)) assets.set(`/${file}`, Bun.file(path.join(dist, file)))
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const pathname = new URL(request.url).pathname
      const file = assets.get(pathname === "/" ? "/index.html" : pathname)
      return file ? new Response(file) : new Response("Not found", { status: 404 })
    },
  })
  browser = await chromium.launch({ headless: true })
}, 60_000)

beforeEach(async () => {
  errors.length = 0
  page = await browser.newPage()
  page.setDefaultTimeout(4000)
  page.on("pageerror", (error) => errors.push(error.message))
})

afterEach(async () => {
  await page?.close()
  expect(errors).toEqual([])
})

afterAll(async () => {
  await browser?.close()
  await server?.stop(true)
  if (directory) await rm(directory, { recursive: true, force: true })
}, 30_000)

async function openImage(dynamic = false) {
  await page.goto(`${server.url}${dynamic ? "?dynamic" : ""}`)
  await page.getByRole("button", { name: "Image", exact: true }).press("Enter")
  await page.waitForFunction(() => !!document.activeElement?.closest('[data-component="dialog"]'))
  await page.evaluate(() => (window as FixtureWindow).fixture.holdFrames())
}

async function closeImage() {
  await page.keyboard.press("Escape")
  await page.getByRole("dialog").waitFor({ state: "detached" })
}

async function flushFrames() {
  await page.evaluate(() => (window as FixtureWindow).fixture.flushFrames())
}

async function focusedButton() {
  return page.evaluate(() => document.activeElement?.textContent)
}

test("a delayed dialog return cannot override the next control's focus or Enter activation", async () => {
  await openImage(true)
  await closeImage()
  await page.waitForFunction(() => document.activeElement?.id === "image-origin")
  await page.getByRole("button", { name: "Report.txt", exact: true }).focus()
  await flushFrames()
  expect(await focusedButton()).toBe("Report.txt")
  await page.keyboard.press("Enter")
  expect(await page.getByTestId("document-opens").textContent()).toBe("1")
  expect(await page.getByTestId("image-opens").textContent()).toBe("1")
  expect(await page.getByRole("dialog").count()).toBe(0)
})

test("lost focus still returns to the connected opener", async () => {
  await openImage()
  await closeImage()
  expect(await page.evaluate(() => document.activeElement === document.body)).toBe(true)
  await flushFrames()
  expect(await focusedButton()).toBe("Image")
  await page.keyboard.press("Enter")
  expect(await page.getByTestId("image-opens").textContent()).toBe("2")
  await page.getByRole("dialog", { name: "Image preview", exact: true }).waitFor()
})

test("a dynamic close target retains focus after its streaming opener is replaced", async () => {
  await openImage(true)
  await page.evaluate(() => (window as FixtureWindow).fixture.replaceOrigin())
  await closeImage()
  await page.waitForFunction(() => document.activeElement?.getAttribute("data-version") === "settled")
  await flushFrames()
  expect(await focusedButton()).toBe("Image")
  expect(await page.locator("#image-origin").getAttribute("data-version")).toBe("settled")
  await page.keyboard.press("Enter")
  expect(await page.getByTestId("image-opens").textContent()).toBe("2")
})

test("closing a stacked child returns to its connected parent control", async () => {
  await page.goto(server.url.toString())
  await page.getByRole("button", { name: "Open parent", exact: true }).press("Enter")
  await page.getByRole("button", { name: "Open child", exact: true }).press("Enter")
  await page.getByRole("button", { name: "Child action", exact: true }).focus()
  await page.evaluate(() => (window as FixtureWindow).fixture.holdFrames())
  await page.keyboard.press("Escape")
  await page.getByRole("dialog", { name: "Child", exact: true }).waitFor({ state: "detached" })
  await flushFrames()
  expect(await focusedButton()).toBe("Open child")
  expect(await page.getByRole("dialog", { name: "Parent", exact: true }).count()).toBe(1)
})

test("a replacement dialog owns focus before an older return frame runs", async () => {
  await openImage()
  await closeImage()
  await page.evaluate(() => (window as FixtureWindow).fixture.replaceDialog())
  await page.waitForFunction(() => !!document.activeElement?.closest('[data-component="dialog"]'))
  await page.getByRole("button", { name: "Replacement action", exact: true }).focus()
  await flushFrames()
  expect(await focusedButton()).toBe("Replacement action")
  expect(await page.getByRole("dialog", { name: "Replacement", exact: true }).count()).toBe(1)
})

test("removing an opener does not restore focus to a detached control", async () => {
  await openImage()
  await closeImage()
  await page.evaluate(() => (window as FixtureWindow).fixture.removeOrigin())
  await flushFrames()
  expect(await page.evaluate(() => document.activeElement === document.body)).toBe(true)
  expect(await page.locator("#image-origin").count()).toBe(0)
})

test("unmounting the dialog provider preserves the remaining control's focus", async () => {
  await openImage()
  await page.evaluate(() => (window as FixtureWindow).fixture.unmount())
  await page.getByRole("dialog").waitFor({ state: "detached" })
  await page.getByRole("button", { name: "Report.txt", exact: true }).focus()
  await flushFrames()
  expect(await focusedButton()).toBe("Report.txt")
  await page.keyboard.press("Enter")
  expect(await page.getByTestId("document-opens").textContent()).toBe("1")
})
