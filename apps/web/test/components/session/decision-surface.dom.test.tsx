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
              reply: (input) => window.decisionSubmit(input),
              reject: (input) => window.decisionSubmit(input),
              list: async () => ({ data: window.serverPending ? [window.currentQuestion] : [] }),
            },
            permission: {
              reply: (input) => window.decisionSubmit(input),
              list: async () => ({ data: window.serverPending ? [window.currentPermission] : [] }),
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
          createSessionDataView(globalThis.__DECISION_SURFACE_DATA, globalThis.__DECISION_SURFACE_RUNTIME)
      `,
    ),
    Bun.write(
      path.join(fixtureDirectory, "main.tsx"),
      `
        import { createComponent, createSignal } from "solid-js"
        import { render } from "solid-js/web"
        import { I18nProvider } from "@lingui/solid"
        import { setupI18n } from "@lingui/core"
        import { DataProvider } from "@ericsanchezok/synergy-ui/context"
        import { MarkedProvider } from "@ericsanchezok/synergy-ui/context/marked"
        import { DialogProvider } from "@ericsanchezok/synergy-ui/context/dialog"
        import { SessionDecisionHost, SessionDecisionOutlet } from ${JSON.stringify(`/@fs/${componentPath}`)}

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

        if (new URLSearchParams(location.search).has("multi")) questionRequest.questions.push({ ...questionRequest.questions[0], header: "Second question" })
        const [currentQuestion, setQuestion] = createSignal(questionRequest)
        window.currentQuestion = questionRequest
        window.setQuestion = (id) => {
          window.currentQuestion = { ...questionRequest, id }
          setQuestion(window.currentQuestion)
        }
        window.serverPending = true
        window.decisionCalls = []
        window.decisionSubmit = (input) => {
          window.decisionCalls.push(input)
          return new Promise((resolve, reject) => {
            window.resolveDecision = resolve
            window.rejectDecision = () => reject({ name: "NetworkError", data: { message: "Connection interrupted" } })
          })
        }
        const permissionRequest = {
          id: "p1",
          sessionID: "s1",
          permission: "bash",
          patterns: [],
          metadata: {},
        }

        window.currentPermission = permissionRequest

        globalThis.__DECISION_SURFACE_DATA = {
          session: [{ id: "s1" }],
          session_diff: {},
          message: {},
          part: {},
        }

        // Session runtime state lives outside the Scope store, so the view
        // resolves it from this accessor bag rather than from the data object.
        const questions = mode !== "none" && mode !== "permission" ? { s1: [questionRequest] } : {}
        const permissions = mode !== "none" && mode !== "question" ? { s1: [permissionRequest] } : {}
        const NO_REQUESTS = []
        globalThis.__DECISION_SURFACE_RUNTIME = {
          statusFor: (id) => (id === "s1" ? { type: "idle" } : undefined),
          permissionsFor: (id) => permissions[id] ?? NO_REQUESTS,
          questionsFor: (id) => questions[id] ? [currentQuestion()] : NO_REQUESTS,
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
                          runtime: globalThis.__DECISION_SURFACE_RUNTIME,
                          directory: "/tmp/fixture",
                          serverUrl: "http://127.0.0.1:5212",
                          onPermissionRespond: () => {},
                          get children() {
                            return createComponent(SessionDecisionHost, {
                              sessionId: "s1",
                              get children() {
                                return new URLSearchParams(location.search).has("outlet")
                                  ? createComponent(SessionDecisionOutlet, {}) : null
                              },
                            })
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
    cacheDir: path.join(fixtureDirectory, ".vite"),
    optimizeDeps: {
      include: [
        "solid-js",
        "solid-js/web",
        "solid-js/jsx-runtime",
        "zod",
        "@lingui/core",
        "@lingui/solid",
        "fuzzysort",
      ],
      noDiscovery: true,
    },
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
      port: 0,
      fs: { allow: [path.resolve(import.meta.dir, "../../../..")] },
    },
  })
  await server.listen()
  await server.warmupRequest("/main.tsx")

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
    await page.goto(`${baseUrl}?mode=question&outlet`)
    await page.getByText("How should we deliver this feature?").waitFor()
    await expect(page.locator('[data-component="dialog"]').count()).resolves.toBe(0)
    await expect(page.locator('[data-component="dialog-overlay"]').count()).resolves.toBe(0)
    await expect(page.getByText("How should we deliver this feature?").count()).resolves.toBe(1)
    await expect(page.locator(".question-prompt-expanded-shell.is-open").count()).resolves.toBe(1)
  })

  test("renders a pending permission inline without a dialog", async () => {
    await page.goto(`${baseUrl}?mode=permission&outlet`)
    await page.getByText("Deny", { exact: true }).waitFor()
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

test("custom shells retain host-owned decisions without rendering the native outlet", async () => {
  await page.goto(`${baseUrl}?mode=combined`)
  await page.getByText("How should we deliver this feature?").waitFor()
  await page.getByText("Deny", { exact: true }).waitFor()
  expect(await page.locator("[data-session-decision-outlet]").count()).toBe(0)
  expect(await page.locator("[data-session-decision-host]").evaluate((node) => getComputedStyle(node).position)).toBe(
    "fixed",
  )
  expect(
    await page
      .locator("[data-session-decision-host]")
      .evaluate((node) => node.closest("[data-plugin-ui]")?.getAttribute("data-plugin-ui")),
  ).toBe("synergy")
})

test("combined decisions remain bounded and scrollable at a narrow viewport", async () => {
  await page.setViewportSize({ width: 375, height: 600 })
  await page.goto(`${baseUrl}?mode=combined&outlet`)
  await page.getByText("Deny", { exact: true }).waitFor()
  const result = await page.locator("[data-session-decision-stack]").evaluate((node) => {
    const element = node as HTMLElement
    const growth = document.createElement("div")
    growth.style.height = "1200px"
    element.append(growth)
    element.scrollTop = element.scrollHeight
    return {
      height: element.getBoundingClientRect().height,
      scrollTop: element.scrollTop,
      overflow: getComputedStyle(element).overflowY,
    }
  })
  expect(result.height).toBeLessThanOrEqual(300)
  expect(result.scrollTop).toBeGreaterThan(0)
  expect(result.overflow).toBe("auto")
  expect(await page.locator("[data-session-decision-outlet] [data-session-decision-host]").count()).toBe(1)
  await page.setViewportSize({ width: 800, height: 600 })
})

interface DecisionWindow extends Window {
  decisionCalls: Array<{ requestID: string; answers?: string[][]; reply?: string }>
  resolveDecision(): void
  rejectDecision(): void
  setQuestion(id: string): void
  serverPending: boolean
}

test("single-choice answers lock while sending, survive failure and reset for a new request", async () => {
  await page.goto(`${baseUrl}?mode=question&outlet`)
  const choice = page.getByRole("radio", { name: /Five PRs/ })
  await choice.click()
  expect(await choice.isDisabled()).toBe(true)
  expect(await page.evaluate(() => (window as unknown as DecisionWindow).decisionCalls)).toEqual([
    { requestID: "q1", answers: [["Five PRs"]] },
  ])
  await page.evaluate(() => (window as unknown as DecisionWindow).rejectDecision())
  await page.getByRole("button", { name: "Retry submission" }).waitFor()
  expect(await choice.getAttribute("aria-checked")).toBe("true")
  await page.getByRole("button", { name: "Retry submission" }).click()
  await page.evaluate(() => (window as unknown as DecisionWindow).setQuestion("q2"))
  expect(await choice.getAttribute("aria-checked")).toBe("false")
  expect(await choice.isDisabled()).toBe(false)
  await page.evaluate(() => (window as unknown as DecisionWindow).resolveDecision())
  expect(await choice.isDisabled()).toBe(false)
  expect(await page.getByText("This request is no longer pending.").count()).toBe(0)
  expect(pageErrors).toEqual([])
})

test("lost permission replies reconcile without repeating the decision", async () => {
  await page.goto(`${baseUrl}?mode=permission&outlet`)
  await page.getByRole("button", { name: "Allow once", exact: true }).click()
  for (const name of ["Deny", "Allow for session", "Always allow", "Allow once"]) {
    expect(await page.getByRole("button", { name, exact: true }).isDisabled()).toBe(true)
  }
  await page.evaluate(() => {
    const fixture = window as unknown as DecisionWindow
    fixture.serverPending = false
    fixture.rejectDecision()
  })
  await page.getByText("This request is no longer pending.").waitFor()
  expect(await page.evaluate(() => (window as unknown as DecisionWindow).decisionCalls)).toEqual([
    { requestID: "p1", reply: "once" },
  ])
  expect(await page.getByRole("button", { name: "Retry submission" }).count()).toBe(0)
  expect(pageErrors).toEqual([])
})

test("multi-question review requires answers and stays locked during submission", async () => {
  await page.goto(`${baseUrl}?mode=question&outlet&multi`)
  expect(await page.getByRole("button", { name: "Next", exact: true }).isDisabled()).toBe(true)
  await page.getByRole("radio", { name: /Five PRs/ }).click()
  expect(await page.getByRole("button", { name: "Next", exact: true }).isDisabled()).toBe(true)
  await page.getByRole("radio", { name: /One PR/ }).click()
  const submit = page.getByRole("button", { name: "Submit", exact: true })
  await submit.click()
  expect(await submit.isDisabled()).toBe(true)
  expect(await page.evaluate(() => (window as unknown as DecisionWindow).decisionCalls)).toEqual([
    { requestID: "q1", answers: [["Five PRs"], ["One PR"]] },
  ])
  await page.evaluate(() => (window as unknown as DecisionWindow).rejectDecision())
  await page.getByRole("button", { name: "Retry submission" }).waitFor()
  expect(await submit.isDisabled()).toBe(false)
  expect(pageErrors).toEqual([])
})
