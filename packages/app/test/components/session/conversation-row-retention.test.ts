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
    "@/context/session-optimistic-message",
    "./session-timeline",
    "./session-transition-card",
  ]
  return stubbed.map((find) => ({ find, replacement: stubPath }))
}

beforeAll(async () => {
  fixtureDirectory = await mkdtemp(path.join(import.meta.dir, ".conversation-row-fixture-"))
  const conversationPath = path.resolve(import.meta.dir, "../../../src/components/session/conversation.tsx")
  const stubPath = path.join(fixtureDirectory, "stubs.tsx")

  await Promise.all([
    Bun.write(
      path.join(fixtureDirectory, "index.html"),
      '<div id="root"></div><script type="module" src="/main.tsx"></script>',
    ),
    Bun.write(
      stubPath,
      `
        import { createMemo, createSignal } from "solid-js"

        let mountCount = 0
        ;(window as any).__sessionTurnMounts = () => mountCount

        export function SessionTurn(props: any) {
          const [mounted] = createSignal(++mountCount)
          const root = createMemo(() => props.rootMessage)
          return (
            <div data-slot="session-turn-stub" data-message-id={props.messageID} data-mount={mounted()}>
              {root()?.text ?? ""}
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
        export const SessionTimeline = () => null
        export const SessionTransitionCard = () => null
        export const messageAllowsCanonicalActions = () => false
      `,
    ),
    Bun.write(
      path.join(fixtureDirectory, "main.tsx"),
      `
        import { createComponent, createSignal } from "solid-js"
        import { render } from "solid-js/web"
        import { SessionConversation } from ${JSON.stringify(`/@fs/${conversationPath}`)}

        type AnyMsg = { id: string; role: "user" | "assistant"; text?: string }

        function App() {
          const [timeline, setTimeline] = createSignal<AnyMsg[]>([])
          ;(window as any).__setTimeline = (msgs: AnyMsg[]) => setTimeline(msgs)
          const autoScroll = {
            contentRef: undefined,
            forceScrollToBottom: () => {},
            handleInteraction: () => {},
            handleScroll: () => {},
            scrollRef: undefined,
          }
          const turnProjection = () => ({
            turnMessagesFor: (m: AnyMsg) => [m],
            compactionParentIDs: () => [],
          })
          return createComponent(SessionConversation, {
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
            get scrolledUp() { return () => false },
            get onScrolledUpChange() { return () => {} },
            get autoScroll() { return autoScroll },
            get onClearHash() { return () => {} },
            get onScheduleScrollSpy() { return () => {} },
            get setScrollRef() { return () => {} },
            get isDesktop() { return () => false },
            get scrollToMessage() { return () => {} },
            get anchor() { return (id: string) => "anchor-" + id },
            get terminalHeight() { return () => 100 },
            get rollbackActive() { return false },
          })
        }

        render(() => createComponent(App), document.querySelector("#root")!)
      `,
    ),
  ])

  server = await createServer({
    configFile: false,
    root: fixtureDirectory,
    plugins: [solidPlugin()],
    resolve: { alias: aliasConfig(stubPath) },
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
  await page.goto(url)
})

afterAll(async () => {
  await page?.close()
  await browser?.close()
  await server?.close()
  if (fixtureDirectory) await rm(fixtureDirectory, { recursive: true, force: true })
})

describe("conversation row retention", () => {
  test("keeps rows mounted across message object replacement and propagates updates", async () => {
    await page.evaluate(
      (msgs) => {
        ;(window as unknown as { __setTimeline: (m: unknown[]) => void }).__setTimeline(msgs)
      },
      [JSON.parse(msg("msg_a", "user", "first")), JSON.parse(msg("msg_b", "user", "second"))] as unknown[],
    )

    const rows = page.locator('[data-slot="session-turn-stub"]')
    await expect(rows.count()).resolves.toBe(2)
    const textA = await page.evaluate(() => {
      const row = document.querySelector('[data-message-id="msg_a"]') as HTMLElement
      return row?.textContent
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
      return row?.textContent
    })

    // Same row owner stayed mounted (no new component instance) and the
    // replaced object's data propagated into the existing row.
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
})
