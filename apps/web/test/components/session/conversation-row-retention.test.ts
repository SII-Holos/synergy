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
const pageErrors: string[] = []

declare global {
  interface Window {
    __setTimeline: (messages: unknown[]) => void
    __holdExecutions: () => void
    __pendingExecutions: () => number
    __settleExecutions: () => void
  }
}

// Deterministic message factory so the fixture and the test share ids.
function msg(id: string, role: "user" | "assistant", text: string) {
  return JSON.stringify({ id, sessionID: "ses_1", role, text, time: { created: 1 } })
}

function aliasConfig(stubPath: string) {
  // Conversation imports several heavyweight UI modules (SessionTurn,
  // BrowserViewEffects, perf navMark, ...) whose full dependency chains do
  // not load under a minimal Vite fixture. Route them to a single stub file
  // that renders a detectable row and counts mounts, so the test can observe
  // row identity (retention) and data propagation without rendering the real
  // session-turn internals. resolve.alias runs before Vite's core resolver.
  const stubbed = [
    "@ericsanchezok/synergy-ui/session-turn",
    "@ericsanchezok/synergy-ui/mailbox-message",
    "@ericsanchezok/synergy-ui/command-result-output",
    "@ericsanchezok/synergy-ui/message-slots",
    "@ericsanchezok/synergy-ui/button",
    "@ericsanchezok/synergy-ui/icon",
    "@ericsanchezok/synergy-ui/icon-button",
    "@ericsanchezok/synergy-ui/semantic-icon",
    "@/utils/perf",
    "@/components/workspace/browser/browser-view-effects",
    "@/context/locale",
    "@/context/execution",
    "@/context/sdk",
    "@/context/global-sync",
    "@/context/sync",
    "@/context/session-data-view",
    "@/context/session-optimistic-message",
    "./session-submission-status",
    "./session-preparation",
    "@/context/session-transition",
  ]
  return stubbed.map((find) => ({ find, replacement: stubPath }))
}

beforeAll(async () => {
  fixtureDirectory = await mkdtemp(path.join(import.meta.dir, ".conversation-row-fixture-"))
  const conversationPath = path.resolve(import.meta.dir, "../../../src/components/session/conversation.tsx")
  const stubPath = path.join(fixtureDirectory, "stubs.tsx")
  const processPath = path.resolve(import.meta.dir, "../../../../../packages/ui/src/components/session-turn-process.ts")
  const arrivalPath = path.resolve(import.meta.dir, "../../../src/context/part-arrival.ts")
  const transitionPath = path.resolve(import.meta.dir, "../../../src/context/session-transition.tsx")
  const completionPath = path.resolve(
    import.meta.dir,
    "../../../../../packages/ui/src/components/execution-completion.tsx",
  )

  await Promise.all([
    Bun.write(
      path.join(fixtureDirectory, "index.html"),
      '<style>html,body,#root{height:700px;margin:0}.h-full{height:100%}.overflow-y-auto{overflow-y:auto}[data-slot="session-turn-stub"]{min-height:80px}</style><div id="root"></div><script type="module" src="/main.tsx"></script>',
    ),
    Bun.write(
      stubPath,
      `
        import { createMemo, createSignal } from "solid-js"
        import { ExecutionCompletion } from ${JSON.stringify(`/@fs/${completionPath}`)}
        import { createPartArrivalState } from ${JSON.stringify(`/@fs/${arrivalPath}`)}
        import { createSessionTransitionState } from ${JSON.stringify(`/@fs/${transitionPath}`)}
        export { draftTransitionKey } from ${JSON.stringify(`/@fs/${transitionPath}`)}

        export { resolveActivityDisclosure } from ${JSON.stringify(`/@fs/${processPath}`)}
        let mountCount = 0
        ;(window as any).__sessionTurnMounts = () => mountCount
        const [executionAvailable, setExecutionAvailable] = createSignal(true)
        const openedExecution: string[] = []
        Object.assign(window, {
          __setExecutionAvailable: setExecutionAvailable,
          __openedExecution: openedExecution,
        })

        export function SessionTurn(props: any) {
          const [mounted] = createSignal(++mountCount)
          const root = createMemo(() => props.rootMessage)
          return (
            <div data-slot="session-turn-stub" data-message-id={props.messageID} data-mount={mounted()} data-part-count={props.segment?.parts.length} data-execution={props.executionState?.status}>
              <span data-root-text>{root()?.text ?? ""}</span>
              <ExecutionCompletion onDetails={props.onExecutionDetails} />
            </div>
          )
        }
        export const MailboxMessage = (props: any) => <div data-slot="mailbox-stub">{props.message?.text ?? ""}</div>
        export const CommandResultOutput = (props: any) => (
          <div data-slot="command-stub">{props.message?.text ?? ""}</div>
        )
        export const MessageSlotOutlet = () => null
        export const Button = (props: any) => <button type="button">{props.children}</button>
        export const Icon = () => null
        export const IconButton = () => null
        export const getSemanticIcon = () => "circle"
        export const navMark = () => {}
        export const BrowserViewEffects = () => null
        export const useLocale = () => ({
          i18n: { _: (d: { message?: string; id: string }) => d.message ?? d.id },
          fmt: {},
        })
        let holdExecutions = false
        const pendingExecutions = []
        window.__holdExecutions = () => { holdExecutions = true }
        window.__pendingExecutions = () => pendingExecutions.length
        window.__settleExecutions = () => {
          holdExecutions = false
          for (const {request, resolve} of pendingExecutions.splice(0)) {
            resolve({data: request.rootIDs.map(rootID => ({rootID, status: "running"}))})
          }
        }
        export const useSDK = () => ({
          url: "http://fixture", scopeKey: "scope", connected: () => true,
          client: { session: { turnExecution: async (request) => holdExecutions
            ? new Promise(resolve => pendingExecutions.push({request, resolve}))
            : ({ data: [] }) } },
          event: { on: () => () => {} },
        })
        export const useSessionDataView = () => () => ({ statusFor: () => undefined, sessionFor: () => ({ id: "ses_1" }) })
        export const useSync = () => ({ data: { partSummary: {}, part: {}, partVersion: {} } })
        export const useSessionPreparation = () => ({ ready: () => true })
        const partArrival = createPartArrivalState()
        export const useGlobalSync = () => ({ partArrival, peekScopeState: () => undefined })
        export const SessionSubmissionStatus = () => null
        const transitions = createSessionTransitionState()
        export const useSessionTransition = () => transitions
        export const submissionForRoot = () => undefined
        export const useExecution = () => ({
          available: executionAvailable,
          round: () => undefined,
          open: (id: string) => openedExecution.push(id),
        })
        export const messageAllowsCanonicalActions = () => false
        export const isOptimisticMessagePending = () => false
      `,
    ),
    Bun.write(
      path.join(fixtureDirectory, "main.tsx"),
      `
        import { createComponent, createSignal, Suspense } from "solid-js"
        import { render } from "solid-js/web"
        import { setupI18n } from "@lingui/core"
        import { I18nProvider } from "@lingui/solid"
        import { DialogProvider } from "@ericsanchezok/synergy-ui/context/dialog"
        import { SessionConversation } from ${JSON.stringify(`/@fs/${conversationPath}`)}

        type AnyMsg = { id: string; role: "user" | "assistant"; text?: string }

        function App() {
          const [timeline, setTimeline] = createSignal<AnyMsg[]>([])
          const [contentEnabled, setContentEnabled] = createSignal(false)
          let scrolledUp = false
          ;(window as any).__readingHistory = () => { scrolledUp = true }
          ;(window as any).__enableContent = () => setContentEnabled(true)
          let locate: ((id: string, behavior: ScrollBehavior, partID?: string) => Promise<boolean>) | undefined
          ;(window as any).__locate = (id: string, partID?: string) => locate?.(id, "auto", partID)
          ;(window as any).__setTimeline = (msgs: AnyMsg[]) => setTimeline(msgs)
          const autoScroll = {
            contentRef: () => {},
            forceScrollToBottom: () => {},
            handleInteraction: () => {},
            handleScroll: () => {},
            scrollRef: () => {},
          }
          const turnProjection = () => ({
            turnMessagesFor: (m: AnyMsg) => [m],
            compactionParentIDs: () => [],
          })
          return createComponent(SessionConversation, { context: {
            get content() { return contentEnabled() ? {
              summaries: id => Array.from({length: id === "huge" ? 1001 : 1}, (_, index) => ({id: "part-"+String(index).padStart(4,"0"),messageID:id,sessionID:"ses_1",type:"text",preview:"",content:{version:"one",bytes:10}})),
              page: () => ({hasMore:false}),load: async () => {},retain: () => ({ready:Promise.resolve(),release() {}}),
            } : undefined },
            registerMessageLocator: fn => { locate=fn; return () => { if(locate===fn) locate=undefined } },
            onFirstTurnMounted() {},
            canRewind: () => true,
            get sessionID() { return "ses_1" },
            get paramsDir() { return "dir" },
            get timeline() { return () => timeline() },
            get turnProjection() { return () => turnProjection() },
            get activityDisplay() { return () => "summary" as const },
            get visibleUserMessages() { return () => timeline().filter((m) => m.role === "user") },
            get hasCanonicalRoot() { return () => timeline().length > 0 },
            get lastUserMessage() { return () => timeline().filter((m) => m.role === "user").at(-1) },
            get activeMessage() { return () => undefined },
            get workspaceOpen() { return () => false },
            get isWorking() { return () => false },
            get compactReasoning() { return () => false },
            get turnStart() { return 0 },
            get turnBatch() { return 20 },
            get onSetTurnStart() { return () => {} },
            get historyMore() { return () => false },
            get historyLoading() { return () => false },
            get historyMode() { return () => "latest" as const },
            get historyPendingLatest() { return () => false },
            get onReturnLatest() { return () => {} },
            get onLoadMore() { return () => {} },
            get scrolledUp() { return () => scrolledUp },
            get onScrolledUpChange() { return () => {} },
            get autoScroll() { return autoScroll },
            get onClearHash() { return () => {} },
            get onScheduleScrollSpy() { return () => {} },
            get setScrollRef() { return () => {} },
            get isDesktop() { return () => true },
            get scrollToMessage() { return () => {} },
            get anchor() { return (id: string) => "anchor-" + id },
            get terminalHeight() { return () => 100 },
            get rollbackActive() { return false },
          } })
        }

        const i18n = setupI18n({locale: "en", messages: {en: {}}})
        render(() => <I18nProvider i18n={i18n}><DialogProvider><Suspense fallback={<p data-test-loading>Loading conversation</p>}><App /></Suspense></DialogProvider></I18nProvider>, document.querySelector("#root")!)
      `,
    ),
  ])

  server = await createServer({
    configFile: false,
    root: fixtureDirectory,
    plugins: [solidPlugin()],
    resolve: {
      alias: [
        ...aliasConfig(stubPath),
        { find: "@/utils/error", replacement: path.resolve(import.meta.dir, "../../../src/utils/error.ts") },
        { find: "@", replacement: path.resolve(import.meta.dir, "../../../src") },
      ],
    },
    server: {
      host: "127.0.0.1",
      port: 5213,
      strictPort: true,
      fs: { allow: [path.resolve(import.meta.dir, "../../..")] },
    },
  })
  await server.listen()

  const url = server.resolvedUrls?.local[0]
  if (!url) throw new Error("Expected Vite test server URL")

  browser = await chromium.launch({ headless: true })
  page = await browser.newPage({ viewport: { width: 900, height: 700 } })
  page.on("pageerror", (error) => pageErrors.push(error.message))
  await page.goto(url)
  await page.waitForFunction(() => typeof window.__setTimeline === "function")
})

afterAll(async () => {
  await page?.close()
  await browser?.close()
  await server?.close()
  if (fixtureDirectory) await rm(fixtureDirectory, { recursive: true, force: true })
})

describe("conversation row retention", () => {
  test("offers turn details only when the server exposes execution inspection", async () => {
    await page.evaluate(
      (messages) => {
        const fixture = window as unknown as { __setTimeline: (messages: unknown[]) => void }
        fixture.__setTimeline(messages)
      },
      [JSON.parse(msg("msg_capability", "user", "Task"))],
    )
    const details = page.locator('[data-component="execution-completion"] button')
    await expect(details.count()).resolves.toBe(1)
    await details.click()
    expect(await page.evaluate(() => (window as unknown as { __openedExecution: string[] }).__openedExecution)).toEqual(
      ["msg_capability"],
    )
    await page.evaluate(() =>
      (window as unknown as { __setExecutionAvailable: (available: boolean) => void }).__setExecutionAvailable(false),
    )
    await expect(details.count()).resolves.toBe(0)
    await page.evaluate(() =>
      (window as unknown as { __setExecutionAvailable: (available: boolean) => void }).__setExecutionAvailable(true),
    )
    await expect(details.count()).resolves.toBe(1)
    expect(pageErrors).toEqual([])
  })

  test("keeps the reading column free of a persistent timeline", async () => {
    await page.evaluate(() => {
      ;(window as unknown as { __setTimeline: (m: unknown[]) => void }).__setTimeline([
        { id: "usr_navigation", sessionID: "ses_1", role: "user", time: { created: 1 } },
      ])
    })
    expect(await page.getByRole("navigation", { name: "Conversation timeline" }).count()).toBe(0)
  })

  test("keeps rows mounted across message object replacement and propagates updates", async () => {
    await page.evaluate(
      (msgs) => {
        ;(window as unknown as { __setTimeline: (m: unknown[]) => void }).__setTimeline(msgs)
      },
      [JSON.parse(msg("msg_a", "user", "first")), JSON.parse(msg("msg_b", "user", "second"))] as unknown[],
    )

    expect(pageErrors).toEqual([])
    const rows = page.locator('[data-slot="session-turn-stub"]')
    await expect(rows.count()).resolves.toBe(2)
    const textA = await page.evaluate(() => {
      const row = document.querySelector('[data-message-id="msg_a"]') as HTMLElement
      return row?.querySelector("[data-root-text]")?.textContent
    })
    expect(textA).toBe("first")

    // Replace message objects with brand-new references (same ids): this is
    // the message.updated / reconcile path that used to destroy and recreate
    // every row, leaving abandoned Solid owner graphs behind.
    const mountsBefore = await page.evaluate(() =>
      (window as unknown as { __sessionTurnMounts: () => number }).__sessionTurnMounts(),
    )
    await page.evaluate(
      (msgs) => {
        ;(window as unknown as { __setTimeline: (m: unknown[]) => void }).__setTimeline(msgs)
      },
      [JSON.parse(msg("msg_a", "user", "first-updated")), JSON.parse(msg("msg_b", "user", "second"))] as unknown[],
    )

    await expect(rows.count()).resolves.toBe(2)
    const mountsAfter = await page.evaluate(() =>
      (window as unknown as { __sessionTurnMounts: () => number }).__sessionTurnMounts(),
    )
    const textUpdated = await page.evaluate(() => {
      const row = document.querySelector('[data-message-id="msg_a"]') as HTMLElement
      return row?.querySelector("[data-root-text]")?.textContent
    })

    // Same row owner stayed mounted (no new component instance) and the
    // replaced object's data propagated into the existing row.
    expect(pageErrors).toEqual([])
    expect(mountsAfter).toBe(mountsBefore)
    expect(textUpdated).toBe("first-updated")

    // Removing a message unmounts its row.
    await page.evaluate(
      (msgs) => {
        ;(window as unknown as { __setTimeline: (m: unknown[]) => void }).__setTimeline(msgs)
      },
      [JSON.parse(msg("msg_b", "user", "second"))] as unknown[],
    )
    await expect(rows.count()).resolves.toBe(1)
    expect(await page.locator('[data-message-id="msg_a"]').count()).toBe(0)
  })
  test("a huge message mounts only bounded Part rows and locates an unmounted message", async () => {
    await page.evaluate(() => {
      const fixture = window as unknown as { __setTimeline: (messages: unknown[]) => void; __enableContent: () => void }
      fixture.__setTimeline([
        { id: "huge", sessionID: "ses_1", role: "user", text: "huge", time: { created: 1 } },
        { id: "target", sessionID: "ses_1", role: "user", text: "target", time: { created: 2 } },
      ])
      fixture.__enableContent()
    })
    await page.waitForSelector("[data-display-row]")
    expect(await page.locator("[data-display-row]").count()).toBeLessThan(30)
    expect(
      await page
        .locator('[data-slot="session-turn-stub"]')
        .evaluateAll((elements) =>
          Math.max(...elements.map((element) => Number(element.getAttribute("data-part-count")))),
        ),
    ).toBeLessThanOrEqual(6)
    expect(await page.locator('[data-display-row^="target:"]').count()).toBe(0)
    expect(
      await page.evaluate(() =>
        (window as unknown as { __locate: (id: string) => Promise<boolean> }).__locate("target"),
      ),
    ).toBe(true)
    await page.waitForSelector('[data-display-row^="target:"]')
    expect(pageErrors).toEqual([])
  })
  test("a Part search target identifies the rendered row after loading its window", async () => {
    expect(
      await page.evaluate(() =>
        (window as unknown as { __locate: (id: string, partID: string) => Promise<boolean> }).__locate(
          "huge",
          "part-0800",
        ),
      ),
    ).toBe(true)
    expect(await page.locator('[data-message-id="huge"][data-part-id="part-0800"]').count()).toBe(1)
    expect(
      await page.evaluate(() =>
        (window as unknown as { __locate: (id: string, partID: string) => Promise<boolean> }).__locate(
          "target",
          "part-0000",
        ),
      ),
    ).toBe(true)
    expect(await page.locator('[data-message-id="target"][data-part-id="part-0000"]').count()).toBe(1)
  })

  test("prepending history preserves the visible content and its viewport offset", async () => {
    const target = page.locator('[data-message-id="target"][data-row-kind="body"]')
    const before = await target.boundingBox()
    await page.evaluate(() => {
      const fixture = window as unknown as { __readingHistory(): void; __setTimeline(messages: unknown[]): void }
      fixture.__readingHistory()
      fixture.__setTimeline([
        { id: "earlier", sessionID: "ses_1", role: "user", text: "earlier", time: { created: 0 } },
        { id: "huge", sessionID: "ses_1", role: "user", text: "huge", time: { created: 1 } },
        { id: "target", sessionID: "ses_1", role: "user", text: "target", time: { created: 2 } },
      ])
    })
    await page.waitForTimeout(150)
    const after = await target.boundingBox()
    expect(after).not.toBeNull()
    expect(Math.abs(after!.y - before!.y)).toBeLessThan(3)
    expect(pageErrors).toEqual([])
  })
  test("virtualized turns retain one capability-gated details action on their footer", async () => {
    await page.evaluate(() => {
      const fixture = window as unknown as { __setTimeline(messages: unknown[]): void; __enableContent(): void }
      fixture.__setTimeline([
        { id: "virtual-details", sessionID: "ses_1", role: "user", text: "Task", time: { created: 1 } },
      ])
      fixture.__enableContent()
    })
    await page.locator('[data-display-row="virtual-details:footer"]').waitFor()
    const details = page.locator('[data-component="execution-completion"] button')
    expect(await details.count()).toBe(1)
    await details.click()
    expect(
      await page.evaluate(() => (window as unknown as { __openedExecution: string[] }).__openedExecution.at(-1)),
    ).toBe("virtual-details")
    expect(await details.evaluate((element) => element === document.activeElement)).toBe(true)
    await details.press("Enter")
    expect(
      await page.evaluate(() => (window as unknown as { __openedExecution: string[] }).__openedExecution.slice(-2)),
    ).toEqual(["virtual-details", "virtual-details"])
    await page.evaluate(() =>
      (window as unknown as { __setExecutionAvailable(value: boolean): void }).__setExecutionAvailable(false),
    )
    expect(await details.count()).toBe(0)
  })

  test("delayed execution state never suspends the conversation or replaces an existing turn", async () => {
    await page.reload()
    await page.waitForFunction(() => typeof window.__setTimeline === "function")
    await page.evaluate(() => {
      window.__holdExecutions()
      window.__setTimeline([
        { id: "usr_delayed", sessionID: "ses_1", role: "user", text: "Pending task", time: { created: 1 } },
      ])
    })
    await page.waitForFunction(() => window.__pendingExecutions() === 1)
    expect(await page.locator("[data-test-loading]").count()).toBe(0)
    const row = page.locator('[data-message-id="usr_delayed"] [data-slot="session-turn-stub"]')
    expect(await row.isVisible()).toBe(true)
    const mount = await row.getAttribute("data-mount")
    await page.evaluate(() => window.__settleExecutions())
    await page.waitForFunction(
      () => document.querySelector('[data-slot="session-turn-stub"]')?.getAttribute("data-execution") === "running",
    )
    expect(await row.getAttribute("data-mount")).toBe(mount)
    await page.evaluate(() => {
      window.__holdExecutions()
      window.__setTimeline([
        { id: "usr_delayed", sessionID: "ses_1", role: "user", text: "Pending task", time: { created: 1 } },
        { id: "usr_next", sessionID: "ses_1", role: "user", text: "Next task", time: { created: 2 } },
      ])
    })
    await page.waitForFunction(() => window.__pendingExecutions() === 1)
    expect(await page.locator("[data-test-loading]").count()).toBe(0)
    expect(await row.getAttribute("data-mount")).toBe(mount)
    expect(await page.locator('[data-slot="session-turn-stub"]').count()).toBe(2)
    await page.evaluate(() => window.__settleExecutions())
    expect(pageErrors).toEqual([])
  })
})
