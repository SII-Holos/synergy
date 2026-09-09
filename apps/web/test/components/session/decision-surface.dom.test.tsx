import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import path from "node:path"
import { chromium, type Browser, type Page } from "playwright"
import { createServer, type ViteDevServer } from "vite"
import solidPlugin from "vite-plugin-solid"

let browser: Browser
let page: Page
let server: ViteDevServer
let fixtureDirectory: string
let baseUrl: string
let pageErrors: string[] = []

const componentPath = path.resolve(import.meta.dir, "../../../src/components/session/decision-surface.tsx")

beforeAll(async () => {
  fixtureDirectory = await mkdtemp(path.join(import.meta.dir, ".decision-surface-fixture-"))
  const localeStubPath = path.join(fixtureDirectory, "locale-stub.tsx")
  const sdkStubPath = path.join(fixtureDirectory, "sdk-stub.ts")
  const viewStubPath = path.join(fixtureDirectory, "session-data-view-stub.ts")

  await Promise.all([
    Bun.write(
      path.join(fixtureDirectory, "index.html"),
      '<div id="root"></div><script type="module" src="/main.tsx"></script>',
    ),
    // The real app locale provider pulls the full Lingui catalog chain; a
    // minimal stub keeps the fixture hermetic. Lingui core still renders
    // descriptor fallback messages, so product copy stays observable.
    Bun.write(
      localeStubPath,
      `
        import { setupI18n } from "@lingui/core"
        const i18n = setupI18n({ locale: "en", messages: {} })
        export const useLocale = () => ({ i18n, fmt: { time: (value: number) => String(value) } })
      `,
    ),
    Bun.write(
      sdkStubPath,
      `
        export const useSDK = () => ({
          client: {
            question: {
              reply: () => Promise.resolve(),
              reject: () => Promise.resolve(),
            },
          },
        })
      `,
    ),
    Bun.write(
      viewStubPath,
      `
        import { createSessionDataView } from "@ericsanchezok/synergy-ui/context/session-data-view"
        export const useSessionDataView = () => () =>
          createSessionDataView(globalThis.__DECISION_SURFACE_DATA)
      `,
    ),
    Bun.write(
      path.join(fixtureDirectory, "main.tsx"),
      `
        import { createComponent } from "solid-js"
        import { render } from "solid-js/web"
        import { I18nProvider } from "@lingui/solid"
        import { setupI18n } from "@lingui/core"
        import { DataProvider } from "@ericsanchezok/synergy-ui/context"
        import { MarkedProvider } from "@ericsanchezok/synergy-ui/context/marked"
        import { DialogProvider } from "@ericsanchezok/synergy-ui/context/dialog"
        import { SessionDecisionSurface } from ${JSON.stringify(`/@fs/${componentPath}`)}

        const mode = new URLSearchParams(location.search).get("mode") ?? "question"

        const questionRequest = {
          id: "q1",
          sessionID: "s1",
          questions: [
            {
              question: "How should we deliver this feature?",
              header: "Delivery",
              options: [
                { label: "Five PRs", description: "Split by sub-issue" },
                { label: "One PR", description: "Single combined diff" },
              ],
            },
          ],
        }

        const permissionRequest = {
          id: "p1",
          sessionID: "s1",
          permission: "bash",
          patterns: [],
          metadata: {},
        }

        globalThis.__DECISION_SURFACE_DATA = {
          session: [{ id: "s1" }],
          session_status: { s1: { type: "idle" } },
          session_diff: {},
          message: {},
          part: {},
          question: mode === "question" ? { s1: [questionRequest] } : {},
          permission: mode === "permission" ? { s1: [permissionRequest] } : {},
        }

        const i18n = setupI18n({ locale: "en", messages: {} })

        render(
          () =>
            createComponent(I18nProvider, {
              i18n,
              get children() {
                return createComponent(MarkedProvider, {
                  get children() {
                    return createComponent(DialogProvider, {
                      get children() {
                        return createComponent(DataProvider, {
                          data: globalThis.__DECISION_SURFACE_DATA,
                          directory: "/tmp/fixture",
                          serverUrl: "http://127.0.0.1:5212",
                          onPermissionRespond: () => {},
                          get children() {
                            return createComponent(SessionDecisionSurface, { sessionId: "s1" })
                          },
                        })
                      },
                    })
                  },
                })
              },
            }),
          document.querySelector("#root")!,
        )
      `,
    ),
  ])

  server = await createServer({
    configFile: false,
    root: fixtureDirectory,
    plugins: [solidPlugin()],
    resolve: {
      alias: {
        "@/context/locale": localeStubPath,
        "@/context/sdk": sdkStubPath,
        "@/context/session-data-view": viewStubPath,
        "@": path.resolve(import.meta.dir, "../../../src"),
      },
    },
    server: {
      host: "127.0.0.1",
      port: 5212,
      strictPort: true,
      fs: { allow: [path.resolve(import.meta.dir, "../../../..")] },
    },
  })
  await server.listen()

  const url = server.resolvedUrls?.local[0]
  if (!url) throw new Error("Expected Vite test server URL")
  baseUrl = url

  browser = await chromium.launch({ headless: true })
  page = await browser.newPage({ viewport: { width: 800, height: 600 } })
  // Surface runtime failures instead of silently asserting against a dead page.
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

afterEach(() => {
  if (pageErrors.length) console.error("PAGE ERRORS:", pageErrors.join("\n---\n"))
  pageErrors = []
})
describe("inline session decision surface", () => {
  test("renders a pending question inline without a dialog", async () => {
    await page.goto(`${baseUrl}?mode=question`)
    await expect(page.locator('[data-component="dialog"]').count()).resolves.toBe(0)
    await expect(page.locator('[data-component="dialog-overlay"]').count()).resolves.toBe(0)
    await expect(page.getByText("How should we deliver this feature?").count()).resolves.toBe(1)
    await expect(page.locator(".question-prompt-expanded-shell.is-open").count()).resolves.toBe(1)
  })

  test("renders a pending permission inline without a dialog", async () => {
    await page.goto(`${baseUrl}?mode=permission`)
    await expect(page.locator('[data-component="dialog"]').count()).resolves.toBe(0)
    await expect(page.locator('[data-component="dialog-overlay"]').count()).resolves.toBe(0)
    await expect(page.locator(".workbench-card-surface").count()).resolves.toBe(1)
    await expect(page.getByText("Deny").count()).resolves.toBe(1)
  })

  test("renders nothing when no decision is pending", async () => {
    await page.goto(`${baseUrl}?mode=none`)
    await expect(page.locator('[data-component="dialog"]').count()).resolves.toBe(0)
    await expect(page.locator(".question-prompt-shell").count()).resolves.toBe(0)
    await expect(page.locator(".workbench-card-surface").count()).resolves.toBe(0)
  })
})
