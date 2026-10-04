import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import path from "node:path"
import { chromium, type Browser, type Page } from "playwright"
import { createBrowserFixture, type BrowserFixture } from "../../support/browser-fixture"

let browser: Browser
let page: Page
let server: BrowserFixture
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
        export const SDKProvider = (props) => props.children
        export const useSDK = () => ({
          connected: () => true,
          url: "http://fixture",
          scopeID: "scope-one",
          event: { on: () => () => {} },
          client: {
            question: {
              reply: (input) => window.decisionSubmit(input),
              reject: (input) => window.decisionSubmit(input),
              list: async () => { if (window.checkFails) throw new Error("Status unavailable"); return { data: window.serverPending ? [window.currentQuestion] : [] } },
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
        export const createSessionDataRuntime = () => globalThis.__DECISION_SURFACE_RUNTIME
      `,
    ),
    Bun.write(
      path.join(fixtureDirectory, "main.tsx"),
      `
        import { createComponent, createSignal, onCleanup } from "solid-js"
        import "@ericsanchezok/synergy-ui/styles"
        import "/@fs/${path.resolve(import.meta.dir, "../../../src/components/session/session-inbox.css")}"
        import { SessionDecisionProvider, createSessionDecisionState, useSessionDecision } from "@/context/session-decision"
        import { QuestionSnapshotGate } from "@/context/question-snapshot"
        import { useSDK } from "@/context/sdk"
        import { render } from "solid-js/web"
        import { I18nProvider } from "@lingui/solid"
        import { setupI18n } from "@lingui/core"
        import { DataProvider, useData } from "@ericsanchezok/synergy-ui/context"
        import { Router, Route } from "@solidjs/router"
        import DirectoryLayout from "@/pages/directory-layout"
        import { MarkedProvider } from "@ericsanchezok/synergy-ui/context/marked"
        import { DialogProvider } from "@ericsanchezok/synergy-ui/context/dialog"
        import { SessionDecisionHost, SessionDecisionOutlet } from ${JSON.stringify(`/@fs/${componentPath}`)}
        import { PromptDockFloatLayer } from "@/components/session/prompt-dock-float-layer"
        import { DefaultComposer } from "@/plugin/default-composer"
        import { ComposerPresentation, bindComposerPresentation } from "@/components/prompt-input/composer-presentation"
        import "/@fs/${path.resolve(import.meta.dir, "../../../src/index.css")}"

        function ActivityDock() {
          const state = new ComposerPresentation()
          const input = {
            current: () => ({ mode: "normal", revision: 1 }),
            readOnly: () => false,
            composing: () => false,
            dragging: () => false,
            className: () => "",
            primaryAction: () => "send",
            render: slot => slot === "toolbar" ? <div style={{padding:"8px"}}><button type="button" data-send style={{height:"40px"}}>Send</button></div> : null,
            editor: {
              label: () => "Composer",
              mount: () => () => {},
              placeholder: () => "",
              completion: () => undefined,
            },
          }
          onCleanup(bindComposerPresentation(input, { state, preview: () => ({text:"", references:[]}) }))
          return <div class="session-workbench-pane" style={{height:"100dvh","container-type":"inline-size"}}><div data-ui-part="conversation"><div style={{height:"48px"}} /></div><div class="session-prompt-dock-content" style={{position:"fixed",bottom:0,width:"100%"}}>
            <PromptDockFloatLayer sessionID="s1" />
            <SessionDecisionOutlet />
            <div><DefaultComposer context={{input}} /></div>
          </div></div>
        }

        const mode = new URLSearchParams(location.search).get("mode") ?? "question"
        if (new URLSearchParams(location.search).has("storageFailure")) {
          const originalRead = Storage.prototype.getItem
          Storage.prototype.getItem = function (key) {
            if (key.includes("question-drafts-v1")) throw new DOMException("Read denied", "SecurityError")
            return originalRead.call(this, key)
          }
        }

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

        if (new URLSearchParams(location.search).has("multiple")) questionRequest.questions[0].multiple = true
        if (new URLSearchParams(location.search).has("multi")) questionRequest.questions.push({ ...questionRequest.questions[0], header: "Second question" })
        const [currentQuestion, setQuestion] = createSignal(questionRequest)
        window.currentQuestion = questionRequest
        window.setQuestion = (id) => {
          window.currentQuestion = { ...questionRequest, id }
          setQuestion(window.currentQuestion)
          setQuestions({ s1: [window.currentQuestion] })
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

        if (new URLSearchParams(location.search).has("permissionDetails")) {
          permissionRequest.metadata = { command: "echo one\\necho two\\necho three\\necho four\\necho five\\necho six", reason: "This target is outside the workspace", nonBypassable: true }
          permissionRequest.patterns = ["/temporary/fixture/approved-file.txt"]
        }

        window.currentPermission = permissionRequest

        globalThis.__DECISION_SURFACE_DATA = {
          session: [{ id: "s1" }, { id: "child", parentID: "s1", title: "Direct child" }, { id: "grandchild", parentID: "child", title: "Grandchild" }],
          session_diff: {},
          message: {},
          part: {},
          todo: { s1: [{ id:"one", content:"Inspect bottom controls", status:"in_progress", priority:"high" }] },
          dag: { s1: [{ id:"one",content:"Inspect bottom controls",status:"running",deps:[] }] },
        }

        // Session runtime state lives outside the Scope store, so the view
        // resolves it from this accessor bag rather than from the data object.
        const [questions, setQuestions] = createSignal(mode !== "none" && mode !== "permission" ? { s1: [questionRequest] } : {})
        const [permissions, setPermissions] = createSignal(mode !== "none" && mode !== "question" ? { s1: [permissionRequest] } : {})
        if (new URLSearchParams(location.search).has("children")) {
          setPermissions({ s1: [{ ...permissionRequest, id: "p2" }], child: [{ ...permissionRequest, id: "p1", sessionID: "child" }], grandchild: [{ ...permissionRequest, id: "p0", sessionID: "grandchild" }] })
          setQuestions({ s1: [questionRequest], child: [{ ...questionRequest, id: "q2", sessionID: "child" }] })
        }
        const NO_REQUESTS = []
        globalThis.__DECISION_SURFACE_RUNTIME = {
          cortexTasks: () => [{id:"t1",sessionID:"child",parentSessionID:"s1",agent:"developer",status:"running",startedAt:Date.now(),description:"Inspect bottom controls"}],
          statusFor: (id) => (id === "s1" ? { type: "idle" } : undefined),
          permissionsFor: (id) => permissions()[id] ?? NO_REQUESTS,
          questionsFor: (id) => questions()[id] ?? NO_REQUESTS,
        }
        globalThis.__DECISION_SURFACE_SYNC = {
          get permissions() { return permissions() },
          get questions() { return questions() },
          sessionStatus: {},
          cortex: [],
          questionSnapshot: () => undefined,
          captureQuestionSnapshot: () => ({ scopeID: "scope-one", generation: 0, revision: 0 }),
          seedGlobalQuestions: () => false,
          seedSessionPermissions: (id, requests) => setPermissions({ [id]: requests }),
        }
        window.clearPermissions = () => setPermissions({})

        const gate = new QuestionSnapshotGate()
        const [snapshot, setSnapshot] = createSignal()
        const scopeID = new URLSearchParams(location.search).get("scope") ?? "scope-one"
        const decisions = createSessionDecisionState({
          serverURL: new URLSearchParams(location.search).get("server") ?? "http://fixture",
          scopeID,
          client: useSDK().client,
          questions: () => Object.values(questions()).flat(),
          permissions: () => Object.values(permissions()).flat(),
          questionSnapshot: snapshot,
          captureQuestionSnapshot: () => gate.capture(scopeID),
          seedQuestions: (requests, headers, token) => {
            if (!gate.accept(token)) return false
            setQuestions({ s1: requests }); setSnapshot(token); return true
          },
          seedPermissions: (id, requests) => setPermissions({ [id]: requests }),
        })
        window.confirmSnapshot = () => {
          setQuestions({}); setSnapshot(gate.capture(scopeID))
        }
        window.reloadPermissions = () => {
          setPermissions({})
          requestAnimationFrame(() => setPermissions({ s1: [permissionRequest] }))
        }
        window.endQuestion = () => {
          decisions.ended("question", "s1", window.currentQuestion.id)
          setQuestions({})
        }
        window.addQuestion = () => setQuestions({ s1: [...(questions().s1 ?? []), { ...questionRequest, id: "q2" }] })
        const i18n = setupI18n({ locale: "en", messages: {} })

        function CachedPermissionCard() {
          const data = useData()
          const decisions = useSessionDecision()
          const request = { ...permissionRequest }
          return <>
            <button onClick={() => data.respondToPermission({ sessionID: request.sessionID, permissionID: request.id, response: "once" })}>Cached Allow once</button>
            <output aria-label="Cached permission status">{decisions.state(decisions.key("permission", request)).status}</output>
          </>
        }

        if (mode === "legacy") render(() => <Router><Route path="/:dir/session/:id" component={() => <DirectoryLayout><CachedPermissionCard /></DirectoryLayout>} /></Router>, document.querySelector("#root"))
        else render(
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
                          onNavigateToSession: (id) => { window.navigatedSession = id },
                          get children() {
                            return createComponent(SessionDecisionProvider, { value: decisions, get children() {
                            return createComponent(SessionDecisionHost, {
                              sessionId: "s1",
                              get children() {
                                if (new URLSearchParams(location.search).has("activity")) return <ActivityDock />
                                if (new URLSearchParams(location.search).has("dock")) return <div style={{"container-type":"inline-size"}}><div class="session-prompt-dock-content" style={{position:"fixed",bottom:0,width:"100%"}}>
                                  <div style={{height:"44px",flex:"none"}}>Progress</div>
                                  <SessionDecisionOutlet />
                                  <div data-fixture-composer style={{height:"158px",flex:"none",position:"relative"}}>Composer<button aria-label="Inbox" class="session-inbox-anchor" style={{width:"36px",height:"36px"}}>Inbox</button></div>
                                  <div style={{height:"32px",flex:"none"}}>Status</div>
                                </div></div>
                                return new URLSearchParams(location.search).has("outlet")
                                  ? createComponent(SessionDecisionOutlet, {}) : null
                              },
                            })
                            } })
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

  await Promise.all([
    Bun.write(
      path.join(fixtureDirectory, "sync-stub.ts"),
      "export const useGlobalSync = () => globalThis.__DECISION_SURFACE_SYNC",
    ),
    Bun.write(
      path.join(fixtureDirectory, "scope-sync-stub.ts"),
      `export const SyncProvider = (props) => props.children
       export const useSync = () => ({ ready: true, data: { ...globalThis.__DECISION_SURFACE_DATA, path: { directory: "/fixture" } }, session: { get: (id) => globalThis.__DECISION_SURFACE_DATA.session.find((session) => session.id === id) } })`,
    ),
    Bun.write(
      path.join(fixtureDirectory, "layout-boundary-stub.ts"),
      `export const LocalProvider = (props) => props.children
       export const FileProvider = (props) => props.children
       export const ExecutionProvider = (props) => props.children
       export const BrowserCatalogProvider = (props) => props.children
       export const useNavigateToSession = () => () => {}`,
    ),
  ])
  server = await createBrowserFixture({
    root: fixtureDirectory,
    styled: true,
    aliases: Object.entries({
      "@/context/locale": localeStubPath,
      "@/context/sdk": sdkStubPath,
      "@/context/session-data-view": viewStubPath,
      "@/context/global-sync": path.join(fixtureDirectory, "sync-stub.ts"),
      "@/context/sync": path.join(fixtureDirectory, "scope-sync-stub.ts"),
      "@/context/local": path.join(fixtureDirectory, "layout-boundary-stub.ts"),
      "@/context/file": path.join(fixtureDirectory, "layout-boundary-stub.ts"),
      "@/context/execution": path.join(fixtureDirectory, "layout-boundary-stub.ts"),
      "@/components/workspace/browser/browser-catalog": path.join(fixtureDirectory, "layout-boundary-stub.ts"),
      "@/composables/use-navigate-to-session": path.join(fixtureDirectory, "layout-boundary-stub.ts"),
      "@": path.resolve(import.meta.dir, "../../../src"),
    }).map(([find, replacement]) => ({ find, replacement })),
  })
  baseUrl = server.url

  browser = await chromium.launch({ headless: true })
  page = await browser.newPage({ viewport: { width: 800, height: 600 } })
  // Surface runtime failures instead of silently asserting against a dead page.
  page.setDefaultTimeout(8000)
  page.on("pageerror", (error) => pageErrors.push(String(error)))
  page.on("console", (message) => {
    if (message.type() === "error" && !message.text().startsWith("WebSocket connection"))
      pageErrors.push(message.text())
  })
})

afterAll(async () => {
  await page?.close()
  await browser?.close()
  await server?.close()
  if (fixtureDirectory) await rm(fixtureDirectory, { recursive: true, force: true })
})

beforeEach(async () => {
  await page?.close()
  page = await browser.newPage({ viewport: { width: 800, height: 600 } })
  page.setDefaultTimeout(8000)
  page.on("pageerror", (error) => pageErrors.push(String(error)))
  page.on("console", (message) => {
    if (message.type() === "error" && !message.text().startsWith("WebSocket connection"))
      pageErrors.push(message.text())
  })
})

afterEach(() => {
  if (pageErrors.length) console.error("PAGE ERRORS:", pageErrors.join("\n---\n"))
  pageErrors = []
})
interface DecisionWindow extends Window {
  decisionCalls: Array<{ requestID: string; answers?: string[][]; reply?: string }>
  resolveDecision(): void
  rejectDecision(): void
  setQuestion(id: string): void
  serverPending: boolean
  confirmSnapshot(): void
  reloadPermissions(): void
  clearPermissions(): void
  endQuestion(): void
  addQuestion(): void
  checkFails: boolean
  navigatedSession?: string
}

test("DataProvider replies use the coordinator when a cached permission outlives a temporary empty index", async () => {
  await page.goto(`${baseUrl}c2NvcGUtb25l/session/s1?mode=legacy`)
  const allow = page.getByRole("button", { name: "Cached Allow once", exact: true })
  await allow.waitFor()
  await page.evaluate(() => (window as unknown as DecisionWindow).clearPermissions())
  await allow.click()
  await allow.click()
  expect(await page.evaluate(() => (window as unknown as DecisionWindow).decisionCalls)).toEqual([
    { requestID: "p1", reply: "once" },
  ])
  expect(await page.getByLabel("Cached permission status").textContent()).toBe("pending")
  await page.evaluate(async () => {
    ;(window as unknown as DecisionWindow).reloadPermissions()
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
  })
  await page.evaluate(() => (window as unknown as DecisionWindow).resolveDecision())
  await page.getByLabel("Cached permission status").filter({ hasText: "settled" }).waitFor()
  await allow.click()
  expect(await page.evaluate(() => (window as unknown as DecisionWindow).decisionCalls)).toHaveLength(1)
  expect(pageErrors).toEqual([])
})

test("one host-owned card prioritizes permissions, with a queue for questions", async () => {
  await page.goto(`${baseUrl}?mode=combined`)
  await page.getByRole("button", { name: "Deny", exact: true }).waitFor()
  expect(await page.locator('[data-component="dialog"]').count()).toBe(0)
  expect(await page.locator("[data-session-decision-stack]").count()).toBe(1)
  expect(await page.getByRole("button", { name: /Five PRs/ }).count()).toBe(0)
  expect(await page.locator("[data-session-decision-outlet]").count()).toBe(0)
  expect(await page.locator("[data-session-decision-host]").evaluate((node) => getComputedStyle(node).position)).toBe(
    "fixed",
  )
  expect(
    await page
      .locator("[data-session-decision-host]")
      .evaluate((node) => node.closest("[data-plugin-ui]")?.getAttribute("data-plugin-ui")),
  ).toBe("synergy")
  await page.getByRole("button", { name: "Pending 2", exact: true }).click()
  await page.getByRole("button", { name: /How should we deliver/ }).click()
  await page.getByRole("button", { name: /Five PRs/ }).waitFor()
  expect(await page.getByRole("button", { name: "Deny", exact: true }).count()).toBe(0)
})

test("the queue orders direct-child permissions canonically and excludes deeper or child question requests", async () => {
  await page.goto(`${baseUrl}?mode=combined&outlet&children`)
  await page.getByRole("button", { name: "From Direct child", exact: true }).click()
  expect(await page.evaluate(() => (window as unknown as DecisionWindow).navigatedSession)).toBe("child")
  await page.getByRole("button", { name: "Pending 3", exact: true }).click()
  expect(await page.locator(".decision-menu-row").count()).toBe(3)
  await page.getByRole("button", { name: "Pending 3", exact: true }).focus()
  await page.keyboard.press("Escape")
  expect(await page.locator(".decision-card").getAttribute("data-collapsed")).toBe("false")
  await page.locator('[data-component="popover-content"]').waitFor({ state: "hidden" })
  await page.getByRole("button", { name: "Allow once", exact: true }).click()
  expect(await page.evaluate(() => (window as unknown as DecisionWindow).decisionCalls)).toEqual([
    { requestID: "p1", reply: "once" },
  ])
})

test("single-choice native buttons submit once and isolate delayed replies", async () => {
  await page.goto(`${baseUrl}?mode=question&outlet`)
  const choice = page.getByRole("button", { name: /Five PRs/ })
  expect(await choice.getAttribute("aria-label")).toBe("Answer: Five PRs. Split by sub-issue")
  await choice.dblclick()
  expect(await choice.isDisabled()).toBe(true)
  expect(await page.evaluate(() => (window as unknown as DecisionWindow).decisionCalls)).toEqual([
    { requestID: "q1", answers: [["Five PRs"]] },
  ])
  await page.evaluate(() => (window as unknown as DecisionWindow).setQuestion("q2"))
  expect(await choice.isDisabled()).toBe(false)
  await page.evaluate(() => (window as unknown as DecisionWindow).resolveDecision())
  expect(await choice.isDisabled()).toBe(false)
  expect(pageErrors).toEqual([])
})

test("multiselect merges supplement and custom Enter stays multiline", async () => {
  await page.goto(`${baseUrl}?mode=question&outlet&multiple`)
  expect(await page.getByText("Select any that apply", { exact: true }).count()).toBe(0)
  await page.getByRole("checkbox", { name: /Five PRs/ }).check()
  const input = page.getByRole("textbox")
  await input.fill("Additional")
  await input.press("Enter")
  await input.press("Control+Enter")
  expect(await page.evaluate(() => (window as unknown as DecisionWindow).decisionCalls)).toEqual([
    { requestID: "q1", answers: [["Five PRs", "Additional"]] },
  ])
})

test("multi-question navigation preserves choices and text, then sends all answers once", async () => {
  await page.goto(`${baseUrl}?mode=question&outlet&multi`)
  const next = page.getByRole("button", { name: "Next", exact: true })
  await next.waitFor()
  expect(await next.isDisabled()).toBe(true)
  await page.getByRole("radio", { name: /Five PRs/ }).check()
  await page.getByRole("textbox").fill("Custom first")
  await page.getByRole("radio", { name: /Five PRs/ }).check()
  await next.click()
  await page.getByRole("textbox").fill("Custom second")
  await page.getByRole("button", { name: "Previous", exact: true }).click()
  expect(await page.getByRole("textbox").inputValue()).toBe("Custom first")
  expect(await page.getByRole("radio", { name: /Five PRs/ }).isChecked()).toBe(true)
  await next.click()
  await page.getByRole("button", { name: "Send", exact: true }).click()
  expect(await page.evaluate(() => (window as unknown as DecisionWindow).decisionCalls)).toEqual([
    { requestID: "q1", answers: [["Five PRs"], ["Custom second"]] },
  ])
  expect(await page.getByText("Review", { exact: true }).count()).toBe(0)
})

test("draft survives refresh, isolates server and Scope, and waits for an authoritative cleanup", async () => {
  await page.goto(`${baseUrl}?mode=question&outlet&multi`)
  await page.getByRole("textbox").fill("Restore this draft")
  await page.reload()
  expect(await page.getByRole("textbox").inputValue()).toBe("Restore this draft")
  await page.goto(`${baseUrl}?mode=question&outlet&multi&scope=scope-two`)
  expect(await page.getByRole("textbox").inputValue()).toBe("")
  await page.goto(`${baseUrl}?mode=question&outlet&multi&server=http://other`)
  expect(await page.getByRole("textbox").inputValue()).toBe("")
  await page.goto(`${baseUrl}?mode=none`)
  await page.goto(`${baseUrl}?mode=question&outlet&multi`)
  expect(await page.getByRole("textbox").inputValue()).toBe("Restore this draft")
  await page.evaluate(() => (window as unknown as DecisionWindow).confirmSnapshot())
  await page.reload()
  expect(await page.getByRole("textbox").inputValue()).toBe("")
})

test("new requests preserve the active draft and its focus", async () => {
  await page.goto(`${baseUrl}?mode=question&outlet&multi`)
  const input = page.getByRole("textbox")
  await input.fill("Keep focus")
  await page.evaluate(() => (window as unknown as DecisionWindow).addQuestion())
  expect(await input.evaluate((node) => node === document.activeElement)).toBe(true)
  expect(await input.inputValue()).toBe("Keep focus")
  await page.getByRole("button", { name: "Pending 2", exact: true }).waitFor()
})

test("permission loss reconciles without repeating, and persistent errors retain the card", async () => {
  await page.goto(`${baseUrl}?mode=permission&outlet`)
  await page.getByRole("button", { name: "More allow options", exact: true }).click()
  await page.getByRole("button", { name: /^Always allow/ }).click()
  await page.evaluate(() => (window as unknown as DecisionWindow).rejectDecision())
  await page.getByRole("button", { name: "Retry submission", exact: true }).waitFor()
  expect(await page.locator("[data-session-decision-stack]").count()).toBe(1)
  await page.getByRole("button", { name: "Retry submission", exact: true }).click()
  await page.evaluate(() => {
    const fixture = window as unknown as DecisionWindow
    fixture.serverPending = false
    fixture.rejectDecision()
  })
  await page.locator("[data-session-decision-stack]").waitFor({ state: "detached" })
  expect(await page.evaluate(() => (window as unknown as DecisionWindow).decisionCalls)).toEqual([
    { requestID: "p1", reply: "always" },
    { requestID: "p1", reply: "always" },
  ])
})

test("a transient empty permission bucket cannot release an in-flight submission lock", async () => {
  await page.goto(`${baseUrl}?mode=permission&outlet`)
  await page.getByRole("button", { name: "Allow once", exact: true }).click()
  await page.evaluate(() => {
    const fixture = window as unknown as DecisionWindow
    fixture.confirmSnapshot()
    fixture.reloadPermissions()
  })
  await page.getByRole("button", { name: "Submitting…", exact: true }).waitFor()
  expect(await page.getByRole("button", { name: "Submitting…", exact: true }).isDisabled()).toBe(true)
  expect(await page.evaluate(() => (window as unknown as DecisionWindow).decisionCalls.length)).toBe(1)
  await page.evaluate(() => (window as unknown as DecisionWindow).resolveDecision())
  await page.locator("[data-session-decision-stack]").waitFor({ state: "detached" })
})

test("permission details show the complete operation when the tool message is not loaded", async () => {
  await page.goto(`${baseUrl}?mode=permission&outlet&permissionDetails`)
  await page.getByText("This target is outside the workspace", { exact: true }).waitFor()
  await page.locator(".permission-details summary").click()
  await page
    .locator(".permission-details")
    .getByText("echo one\necho two\necho three\necho four\necho five\necho six", { exact: true })
    .waitFor()
  expect(
    await page
      .locator(".permission-details")
      .getByText("echo one\necho two\necho three\necho four\necho five\necho six", { exact: true })
      .isVisible(),
  ).toBe(true)
  expect(
    await page
      .locator(".permission-details")
      .getByText("/temporary/fixture/approved-file.txt", { exact: true })
      .isVisible(),
  ).toBe(true)
})

test("the inline request shrinks above the Composer without hiding its action", async () => {
  await page.setViewportSize({ width: 375, height: 430 })
  await page.goto(`${baseUrl}?mode=question&dock&multi`)
  await page.getByRole("textbox").waitFor()
  const bounds = await page.getByRole("button", { name: "Next", exact: true }).evaluate((action) => {
    const composer = document.querySelector("[data-fixture-composer]")!
    const rect = action.getBoundingClientRect()
    return {
      bottom: rect.bottom,
      composerTop: composer.getBoundingClientRect().top,
      cardBottom: action.closest(".decision-card")!.getBoundingClientRect().bottom,
      hit: document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)?.closest("button") === action,
    }
  })
  expect(bounds.bottom).toBeLessThanOrEqual(bounds.composerTop)
  expect(bounds.bottom).toBeLessThanOrEqual(bounds.cardBottom)
  expect(bounds.hit).toBe(true)
})

test("grant choices show the actual target rules before granting broader access", async () => {
  await page.goto(`${baseUrl}?mode=permission&permissionDetails`)
  await page.getByRole("button", { name: "More allow options", exact: true }).click()
  const menu = page.getByRole("dialog", { name: "More allow options" })
  expect(await menu.getByText("/temporary/fixture/approved-file.txt", { exact: true }).count()).toBe(1)
  expect(await menu.getByText("This operation still requires approval each time.", { exact: true }).isVisible()).toBe(
    true,
  )
})

test("body scrolls while actions remain reachable in a narrow short window", async () => {
  await page.setViewportSize({ width: 375, height: 460 })
  await page.goto(`${baseUrl}?mode=question&outlet&multi`)
  await page.getByRole("textbox").waitFor()
  const result = await page.locator(".decision-body").evaluate((node) => {
    const growth = document.createElement("div")
    growth.style.height = "1200px"
    node.append(growth)
    node.scrollTop = node.scrollHeight
    return {
      scrollTop: node.scrollTop,
      overflow: getComputedStyle(node).overflowY,
      card: node.closest(".decision-card")!.getBoundingClientRect().height,
      width: document.documentElement.scrollWidth,
    }
  })
  expect(result.scrollTop).toBeGreaterThan(0)
  expect(result.overflow).toBe("auto")
  expect(result.card).toBeLessThanOrEqual(230)
  expect(result.width).toBeLessThanOrEqual(375)
  expect(await page.getByRole("button", { name: "Next", exact: true }).isVisible()).toBe(true)
  await page.setViewportSize({ width: 800, height: 600 })
  expect(pageErrors).toEqual([])
})

test("unknown outcomes require a read-only check before explicit retry", async () => {
  await page.goto(`${baseUrl}?mode=question&outlet`)
  await page.getByRole("button", { name: /Five PRs/ }).click()
  await page.evaluate(() => {
    const fixture = window as unknown as DecisionWindow
    fixture.checkFails = true
    fixture.rejectDecision()
  })
  await page.getByRole("button", { name: "Check status", exact: true }).click()
  await page.getByRole("button", { name: "Check status", exact: true }).waitFor()
  expect(await page.evaluate(() => (window as unknown as DecisionWindow).decisionCalls.length)).toBe(1)
  await page.evaluate(() => {
    ;(window as unknown as DecisionWindow).checkFails = false
  })
  await page.getByRole("button", { name: "Check status", exact: true }).click()
  await page.getByRole("button", { name: "Retry submission", exact: true }).waitFor()
  expect(await page.evaluate(() => (window as unknown as DecisionWindow).decisionCalls.length)).toBe(1)
  await page.getByRole("button", { name: "Retry submission", exact: true }).click()
  await page.waitForFunction(() => (window as unknown as DecisionWindow).decisionCalls.length === 2)
  await page.evaluate(() => (window as unknown as DecisionWindow).resolveDecision())
  await page.locator("[data-session-decision-stack]").waitFor({ state: "detached" })
})

test("storage read failure keeps an answering path without deleting stored drafts", async () => {
  await page.goto(`${baseUrl}?mode=question&outlet&multi`)
  await page.getByRole("textbox").fill("Durable text")
  await page.goto(`${baseUrl}?mode=question&outlet&multi&storageFailure`)
  await page.getByRole("textbox").fill("Temporary text")
  expect(await page.getByRole("button", { name: "Next", exact: true }).isDisabled()).toBe(false)
  await page.goto(`${baseUrl}?mode=question&outlet&multi`)
  expect(await page.getByRole("textbox").inputValue()).toBe("Durable text")
  expect(pageErrors).toEqual([])
})

test("skip uses reject and timeout removes the pending card", async () => {
  await page.goto(`${baseUrl}?mode=question&outlet`)
  await page.getByRole("button", { name: "More actions", exact: true }).click()
  await page.getByRole("button", { name: "Skip this question", exact: true }).click()
  expect(await page.evaluate(() => (window as unknown as DecisionWindow).decisionCalls)).toEqual([{ requestID: "q1" }])
  await page.evaluate(() => (window as unknown as DecisionWindow).endQuestion())
  await page.locator("[data-session-decision-stack]").waitFor({ state: "detached" })
})

test("native radios use arrows without advancing and shortcuts respect editing and IME", async () => {
  await page.goto(`${baseUrl}?mode=question&outlet&multi`)
  await page.getByRole("radio", { name: /Five PRs/ }).focus()
  await page.keyboard.press("ArrowDown")
  expect(await page.getByRole("radio", { name: /One PR/ }).isChecked()).toBe(true)
  expect(await page.getByText("Question 1/2", { exact: true }).count()).toBe(1)
  const input = page.getByRole("textbox")
  await input.fill(" ")
  await input.press("1")
  expect(await input.inputValue()).toBe(" 1")
  await input.evaluate((node) =>
    node.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, isComposing: true, bubbles: true })),
  )
  expect(await page.getByText("Question 1/2", { exact: true }).count()).toBe(1)
  expect(await page.evaluate(() => (window as unknown as DecisionWindow).decisionCalls.length)).toBe(0)
})

test("bottom activity coexists with actual question and permission cards during editor resizing", async () => {
  await page.setViewportSize({ width: 375, height: 430 })
  await page.goto(`${baseUrl}?mode=both&activity`)
  await page.locator(".subagent-dock-avatar").waitFor()
  const controls = [".subagent-dock-avatar", ".session-progress-island-header", ".decision-footer", "[data-send]"]
  for (const selector of controls) {
    const box = (await page.locator(selector).boundingBox())!
    expect(box.y).toBeGreaterThanOrEqual(0)
    expect(box.y + box.height).toBeLessThanOrEqual(430)
  }
  const resize = page.getByRole("separator", { name: "Resize editor" })
  await resize.press("ArrowUp")
  await resize.press("ArrowUp")
  const action = page.getByRole("button", { name: "Allow once", exact: true })
  expect(
    await action.evaluate((element) => {
      const rect = element.getBoundingClientRect()
      return document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)?.closest("button") === element
    }),
  ).toBe(true)
  for (const selector of controls) {
    const box = (await page.locator(selector).boundingBox())!
    expect(box.y).toBeGreaterThanOrEqual(0)
    expect(box.y + box.height).toBeLessThanOrEqual(430)
  }
  await page.locator(".session-progress-island-header").click()
  await page.getByRole("dialog", { name: "Session progress", exact: true }).waitFor()
  await page.waitForFunction(() => document.activeElement?.classList.contains("session-progress-island-close"))
  const panel = (await page.locator(".session-progress-island-panel").boundingBox())!
  expect(panel.y).toBeGreaterThanOrEqual(0)
  expect(panel.height).toBeGreaterThan(100)
  expect(panel.y + panel.height).toBeLessThanOrEqual(430)
  await page.getByRole("button", { name: "Close progress", exact: true }).click()
  await page.getByRole("textbox", { name: "Composer", exact: true }).fill("Preserved draft")
  expect(await page.getByRole("textbox", { name: "Composer", exact: true }).textContent()).toBe("Preserved draft")
  await page.getByRole("button", { name: "Expand editor", exact: true }).click()
  await page.waitForFunction(() => {
    const rect = document.querySelector("[data-send]")!.getBoundingClientRect()
    return rect.bottom <= innerHeight
  })
  await page.getByRole("button", { name: "Collapse editor", exact: true }).click()
  await action.waitFor()
  expect(await page.getByRole("textbox", { name: "Composer", exact: true }).textContent()).toBe("Preserved draft")
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.getByRole("button", { name: "Collapse request", exact: true }).click()
  await page.locator(".session-progress-island-header").click()
  await page.getByRole("button", { name: "DAG", exact: true }).click()
  await page.waitForFunction(() => {
    const graph = document.querySelector('[data-component="dag-graph"]')!.getBoundingClientRect()
    const body = document.querySelector(".session-progress-island-body")!.getBoundingClientRect()
    return graph.height > 250 && graph.top >= body.top && graph.bottom <= body.bottom
  })
})
