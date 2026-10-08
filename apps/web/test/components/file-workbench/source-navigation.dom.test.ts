import { afterAll, beforeAll, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import path from "node:path"
import { chromium, type Browser, type Page } from "playwright"
import { createServer, type ViteDevServer } from "vite"
import solid from "vite-plugin-solid"
import { fixturePort } from "@ericsanchezok/synergy-testing/fixture"

let browser: Browser, page: Page, server: ViteDevServer, directory: string, url: string
const errors: string[] = []
beforeAll(async () => {
  directory = await mkdtemp(path.join(import.meta.dir, ".source-navigation-"))
  const source = path.resolve(import.meta.dir, "../../../src")
  const bridge = path.join(directory, "bridge.ts")
  await Bun.write(
    bridge,
    `
    import { createSignal } from "solid-js"
    const [navigation, setNavigation] = createSignal()
    export const useFile = () => ({
      resourceKey: "source-navigation", navigation,
      draft: { get: () => undefined },
      view: { sourceScrollTop: () => 0, sourceScrollLeft: () => 0, selectedLines: () => undefined,
        setSourceScroll() {}, setSelectedLines() {} },
    })
    export const useLingui = () => ({ _: value => value.message })
    export const useTheme = () => ({ tokens: () => ({}), mode: () => "light" })
    export const resolveThemeColor = (_, token) => token.startsWith("surface") ? "#ffffff" : "#222222"
    let finish
    export const start = event => { const origin = event.currentTarget; finish = () => setNavigation({ id: Date.now(),
      location: { kind: "text", line: 120 }, focusTarget: () => origin }) }
    window.finishReference = () => finish?.()
  `,
  )
  await Bun.write(
    path.join(directory, "index.html"),
    '<div id="root"></div><script type="module" src="/main.tsx"></script>',
  )
  await Bun.write(
    path.join(directory, "main.tsx"),
    `
    import { render } from "solid-js/web"
    import { start } from "./bridge"
    import { FileSourceView } from ${JSON.stringify(`/@fs/${source}/components/file-workbench/source-view.tsx`)}
    const content = Array.from({length: 200}, (_, i) => "const sample" + (i+1) + " = " + (i+1)).join("\\n")
    render(() => <><button data-resource-reference="a.ts#L120" onClick={start}>First reference</button>
      <button data-resource-reference="b.ts#L2">Next reference</button><input aria-label="Composer" />
      <style>{".file-source-view-editor { width: 700px; height: 420px }"}</style>
      <FileSourceView path="a.ts" content={content} /></>, document.getElementById("root"))
  `,
  )
  server = await createServer({
    configFile: false,
    root: directory,
    cacheDir: path.join(directory, ".vite"),
    plugins: [solid()],
    resolve: {
      alias: [
        { find: "@/context/file", replacement: bridge },
        { find: "@ericsanchezok/synergy-ui/theme", replacement: bridge },
        { find: "@lingui/solid", replacement: bridge },
        { find: "@", replacement: source },
      ],
    },
    optimizeDeps: {
      include: ["solid-js", "solid-js/web", "solid-js/store", "monaco-editor/esm/vs/editor/editor.api.js"],
      noDiscovery: true,
    },
    server: {
      host: "127.0.0.1",
      port: await fixturePort(),
      fs: { allow: [path.resolve(source, "../../.."), directory] },
    },
  })
  await server.listen()
  url = server.resolvedUrls!.local[0]!
  browser = await chromium.launch({ headless: true })
  page = await browser.newPage()
  page.on("pageerror", (error) => errors.push(error.message))
}, 30_000)
afterAll(async () => {
  await browser?.close()
  await server?.close()
  if (directory) await rm(directory, { recursive: true, force: true })
})

test.each(["Next reference", "Composer", "First reference"])(
  "late navigation preserves the current focus owner: %s",
  async (target) => {
    errors.length = 0
    await page.goto(url)
    await page.locator(".monaco-editor .view-lines").waitFor()
    await page.getByRole("button", { name: "First reference", exact: true }).click()
    const control =
      target === "Composer"
        ? page.getByRole("textbox", { name: "Composer" })
        : page.getByRole("button", { name: target, exact: true })
    await control.focus()
    await page.evaluate(() => (window as unknown as { finishReference(): void }).finishReference())
    await page.waitForFunction(() =>
      document.querySelector(".monaco-editor .view-lines")?.textContent?.includes("sample120"),
    )
    if (target === "First reference")
      expect(await page.locator(".monaco-editor").evaluate((el) => el.contains(document.activeElement))).toBe(true)
    else expect(await control.evaluate((el) => el === document.activeElement)).toBe(true)
    expect(errors).toEqual([])
  },
  30_000,
)
