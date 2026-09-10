import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import path from "node:path"
import { chromium, type Browser, type Page } from "playwright"
import { createServer, type ViteDevServer } from "vite"
import solidPlugin from "vite-plugin-solid"

// The composer dock mounts through the async plugin-shell swap: the ResizeObserver
// target must be reactive or it is read once at setup (still undefined) and never
// resubscribes, so `--prompt-height` stays unset and the scroll-to-bottom button
// falls back to an offset the dock covers. This suite proves the late-mount,
// resize, and shell-swap contracts against the real helper in a real browser.
const helperPath = path.resolve(import.meta.dir, "../../../src/components/session/prompt-dock-height.ts")

let browser: Browser
let page: Page
let server: ViteDevServer
let fixtureDirectory: string
let baseUrl: string
let pageErrors: string[] = []

async function waitForHeight(target: number, timeoutMs = 5000): Promise<number[]> {
  const deadline = Date.now() + timeoutMs
  let heights: number[] = []
  while (Date.now() < deadline) {
    heights = await page.evaluate(() => (globalThis as unknown as { __heights: number[] }).__heights)
    if (heights.includes(target)) return heights
    await page.waitForTimeout(100)
  }
  throw new Error(`Timed out waiting for dock height ${target}; observed: ${JSON.stringify(heights)}`)
}

beforeAll(async () => {
  fixtureDirectory = await mkdtemp(path.join(import.meta.dir, ".prompt-dock-height-fixture-"))
  await Bun.write(
    path.join(fixtureDirectory, "index.html"),
    '<div id="root"></div><script type="module" src="/main.tsx"></script>',
  )
  await Bun.write(
    path.join(fixtureDirectory, "main.tsx"),
    `
      import { Show, createSignal } from "solid-js"
      import { render } from "solid-js/web"
      import { createPromptDockHeight } from ${JSON.stringify(`/@fs/${helperPath}`)}

      const heights: number[] = []
      globalThis.__heights = heights
      const dock = createPromptDockHeight((height) => heights.push(height))
      const [generation, setGeneration] = createSignal(0)
      const heightFor = (gen: number) => 100 + gen * 50

      const Dock = (props: { gen: number }) => {
        return (
          <div
            ref={(el: HTMLDivElement) => {
              dock.mount(el)
              ;(globalThis as any).__dockElement = el
            }}
            data-dock={props.gen}
            style={{ height: heightFor(props.gen) + "px" }}
          >
            dock {props.gen}
          </div>
        )
      }

      render(
        () => (
          <div>
            <button data-mount onClick={() => setGeneration(1)}>mount</button>
            <button data-swap onClick={() => setGeneration((gen) => gen + 1)}>swap</button>
            <Show when={generation()} keyed>
              {(gen) => <Dock gen={gen} />}
            </Show>
          </div>
        ),
        document.querySelector("#root")!,
      )
    `,
  )

  server = await createServer({
    configFile: false,
    root: fixtureDirectory,
    plugins: [solidPlugin()],
    cacheDir: path.join(fixtureDirectory, ".vite"),
    optimizeDeps: {
      include: ["solid-js", "solid-js/web", "solid-js/jsx-runtime", "@solid-primitives/resize-observer"],
      noDiscovery: true,
    },
    server: { host: "127.0.0.1", port: 0, fs: { allow: [path.resolve(import.meta.dir, "../../../..")] } },
  })
  await server.listen()
  await server.warmupRequest("/main.tsx")

  const url = server.resolvedUrls?.local[0]
  if (!url) throw new Error("Expected Vite test server URL")
  baseUrl = url

  browser = await chromium.launch({ headless: true })
  page = await browser.newPage({ viewport: { width: 800, height: 600 } })
  page.on("pageerror", (error) => pageErrors.push(String(error)))
  page.on("console", (message) => {
    if (message.type() === "error") pageErrors.push(message.text())
  })
})

afterAll(async () => {
  await page?.close()
  await browser?.close()
  await server?.close()
  if (fixtureDirectory) await rm(fixtureDirectory, { recursive: true, force: true })
})

describe("prompt dock height observer", () => {
  test("observes a dock that mounts after setup, and follows shell swaps", async () => {
    await page.goto(baseUrl)
    expect(await page.evaluate(() => (globalThis as unknown as { __heights: number[] }).__heights)).toEqual([])

    // Late mount: the observer was created before any element existed, exactly
    // like the async plugin-shell swap delivering the dock after page setup.
    await page.click("[data-mount]")
    await waitForHeight(150)

    // Resize of the mounted dock reports the new content height.
    await page.evaluate(() => {
      const el = (globalThis as unknown as { __dockElement: HTMLDivElement }).__dockElement
      el.style.height = "175px"
    })
    await waitForHeight(175)

    // Shell swap: the old dock unmounts and a new element mounts at a
    // different height; the observer must resubscribe and report it.
    await page.click("[data-swap]")
    await waitForHeight(200)
    expect(pageErrors).toEqual([])
  })

  test("session page wires the reactive dock mount instead of a bare variable", async () => {
    const source = await Bun.file(path.resolve(import.meta.dir, "../../../src/pages/session.tsx")).text()
    expect(source).toContain("createPromptDockHeight(")
    expect(source).toContain("mount: dockHeight.mount")
    expect(source).not.toContain("createResizeObserver")
  })
})
