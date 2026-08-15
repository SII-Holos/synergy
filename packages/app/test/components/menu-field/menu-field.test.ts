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

beforeAll(async () => {
  fixtureDirectory = await mkdtemp(path.join(import.meta.dir, ".menu-field-fixture-"))
  const menuFieldPath = path.resolve(import.meta.dir, "../../../src/components/menu-field/MenuField.tsx")

  await Promise.all([
    Bun.write(
      path.join(fixtureDirectory, "index.html"),
      '<div id="root"></div><script type="module" src="/main.ts"></script>',
    ),
    Bun.write(
      path.join(fixtureDirectory, "main.ts"),
      `
        import { createComponent, createSignal } from "solid-js"
        import { render } from "solid-js/web"
        import { MenuField } from ${JSON.stringify(`/@fs/${menuFieldPath}`)}
        function App() {
          const [value, setValue] = createSignal("a")
          const [changes, setChanges] = createSignal<string[]>([])
          window.__changes = () => changes()
          return createComponent(MenuField, {
            get value() {
              return value()
            },
            ariaLabel: "Pick an option",
            options: [
              { value: "a", label: "Alpha" },
              { value: "b", label: "Beta" },
              { value: "c", label: "Gamma" },
            ],
            onChange: (v: string) => {
              setValue(v)
              setChanges((prev) => [...prev, v])
            },
          })
        }

        render(() => createComponent(App), document.querySelector("#root"))
      `,
    ),
  ])

  server = await createServer({
    configFile: false,
    root: fixtureDirectory,
    plugins: [solidPlugin()],
    server: {
      host: "127.0.0.1",
      port: 5202,
      strictPort: true,
      fs: { allow: [path.resolve(import.meta.dir, "../../..")] },
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

describe("MenuField interaction contract", () => {
  test("exposes listbox semantics, selects once, guards repeated picks, and supports keyboard", async () => {
    // The whole contract runs as one browser session: bun test reaps the
    // Playwright browser between tests, so a single sequential test keeps
    // the page alive (same pattern as packages/ui/test/components/tooltip.test.ts).
    const trigger = page.getByRole("button", { name: /Pick an option/ })
    await expect(trigger.count()).resolves.toBe(1)
    expect(await trigger.getAttribute("aria-haspopup")).toBe("dialog")
    expect(await trigger.getAttribute("aria-expanded")).toBe("false")

    // 1. Listbox/option semantics with the current value announced.
    await trigger.click()
    await expect(page.getByRole("listbox").count()).resolves.toBe(1)
    await expect(page.getByRole("option").count()).resolves.toBe(3)
    const alpha = page.getByRole("option", { name: "Alpha" })
    const beta = page.getByRole("option", { name: "Beta" })
    expect(await alpha.getAttribute("aria-selected")).toBe("true")
    expect(await beta.getAttribute("aria-selected")).toBe("false")
    expect(await trigger.getAttribute("aria-expanded")).toBe("true")

    // 2. Selecting an option reports the change once.
    await beta.click()
    expect(await page.evaluate(() => (window as unknown as { __changes: () => string[] }).__changes())).toEqual(["b"])
    expect((await trigger.textContent()) ?? "").toContain("Beta")

    // 3. Pressing the active option again does not fire onChange.
    await trigger.click()
    await beta.click()
    expect(await page.evaluate(() => (window as unknown as { __changes: () => string[] }).__changes())).toEqual(["b"])

    // 4. Arrow-key navigation and typeahead work in the listbox.
    await trigger.click()
    const listbox = page.getByRole("listbox")
    await expect(listbox.count()).resolves.toBe(1)
    await alpha.focus()
    await page.keyboard.press("ArrowDown")
    expect(await beta.getAttribute("data-highlighted")).toBe("")
    await page.keyboard.press("g") // typeahead to Gamma
    const gamma = page.getByRole("option", { name: "Gamma" })
    expect(await gamma.getAttribute("data-highlighted")).toBe("")
    await page.keyboard.press("Enter")
    const changes = await page.evaluate(() => (window as unknown as { __changes: () => string[] }).__changes())
    expect(changes.at(-1)).toBe("c")
    expect((await trigger.textContent()) ?? "").toContain("Gamma")
  })
})
