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
  fixtureDirectory = await mkdtemp(path.join(import.meta.dir, ".message-part-error-boundary-fixture-"))
  const messagePartPath = path.resolve(import.meta.dir, "../../src/components/message-part.tsx")

  await Promise.all([
    Bun.write(
      path.join(fixtureDirectory, "index.html"),
      '<div id="root"></div><script type="module" src="/main.ts"></script>',
    ),
    Bun.write(
      path.join(fixtureDirectory, "main.ts"),
      `
        import { createComponent, ErrorBoundary } from "solid-js"
        import { render } from "solid-js/web"
        import { I18nProvider } from "@lingui/solid"
        import { setupI18n } from ${JSON.stringify(`/@fs/${path.resolve(import.meta.dir, "../../src/testing/i18n.tsx")}`)}
        import { Part, registerPartComponent } from ${JSON.stringify(`/@fs/${messagePartPath}`)}

        const originalConsoleError = console.error
        const reports: string[] = []
        console.error = (...args) => {
          reports.push(args.map((value) => value instanceof Error ? value.message : JSON.stringify(value)).join(" "))
          originalConsoleError(...args)
        }

        let stale = false
        const part = {
          id: "part-renderer-failure",
          sessionID: "session-switch-target",
          messageID: "message-renderer-failure",
          type: "stale-boundary-fixture",
          secretPayload: "must-not-enter-diagnostics",
        }
        const message = {
          id: part.messageID,
          sessionID: part.sessionID,
          role: "assistant",
          time: { created: 1 },
          parentID: "message-user",
          modelID: "test-model",
          providerID: "test-provider",
          mode: "build",
          path: { cwd: "/private/project", root: "/private/project" },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        }

        registerPartComponent(part.type, () => {
          stale = true
          throw new Error("original renderer failure")
        })

        const i18n = setupI18n()
        let escapedError: string | undefined
        const root = document.querySelector("#root")!
        render(
          () => createComponent(ErrorBoundary, {
            fallback(error) {
              escapedError = error instanceof Error ? error.message : String(error)
              const node = document.createElement("div")
              node.dataset.escapedError = escapedError
              return node
            },
            get children() {
              return createComponent(I18nProvider, {
                i18n,
                get children() {
                  return createComponent(Part, {
                    get part() {
                      if (stale) throw new Error("Stale read from <Show>.")
                      return part
                    },
                    message,
                  })
                },
              })
            },
          }),
          root,
        )

        ;(window as any).__messagePartResult = () => ({
          escapedError,
          reports,
          text: root.textContent,
          hasLocalError: !!root.querySelector(".plugin-error-card"),
        })
      `,
    ),
  ])

  server = await createServer({
    configFile: false,
    root: fixtureDirectory,
    plugins: [solidPlugin()],
    server: {
      host: "127.0.0.1",
      port: 0,
      strictPort: false,
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

describe("message part renderer error boundary", () => {
  test("keeps the original renderer failure local after its reactive owner becomes stale", async () => {
    const result = await page.evaluate(() => (window as any).__messagePartResult())

    expect(result.escapedError).toBeUndefined()
    expect(result.hasLocalError).toBe(true)
    expect(result.text).toContain("original renderer failure")
    expect(result.text).toContain("stale-boundary-fixture")
    expect(result.reports).toHaveLength(1)
    expect(result.reports[0]).toContain("original renderer failure")
    expect(result.reports[0]).toContain("session-switch-target")
    expect(result.reports[0]).toContain("message-renderer-failure")
    expect(result.reports[0]).toContain("part-renderer-failure")
    expect(result.reports[0]).not.toContain("must-not-enter-diagnostics")
    expect(result.reports[0]).not.toContain("/private/project")
  })
})
