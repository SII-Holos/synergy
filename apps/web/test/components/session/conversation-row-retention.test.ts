import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { fixturePort } from "@ericsanchezok/synergy-testing/fixture"
import { mkdtemp, rm } from "node:fs/promises"
import path from "node:path"
import { loadavg } from "node:os"
import type { Socket } from "node:net"
import { chromium, type Browser, type Page } from "playwright"
import { createServer, type ViteDevServer } from "vite"
import solidPlugin from "vite-plugin-solid"

let browser: Browser
let page: Page
let server: ViteDevServer
let fixtureDirectory: string
const pageErrors: string[] = []
const diagnostics: string[] = []
const requests = new Set<string>()
const sockets = new Set<Socket>()
const diagnosticStart = performance.now()
let navigation = 0
const bootMarkers = new Set<string>()
function diagnose(stage: string, detail: unknown = {}) {
  const entry = JSON.stringify({
    stage,
    navigation,
    milliseconds: Math.round(performance.now() - diagnosticStart),
    detail,
  })
  diagnostics.push(entry)
  if (process.env.SYNERGY_CONVERSATION_FIXTURE_DIAGNOSTICS === "1") console.info(`[conversation-fixture] ${entry}`)
}
async function fixtureStep<T>(stage: string, action: () => Promise<T>): Promise<T> {
  diagnose(`${stage}:start`)
  try {
    const result = await action()
    diagnose(`${stage}:end`)
    return result
  } catch (error) {
    diagnose(`${stage}:error`, {
      error: String(error),
      pendingRequests: [...requests],
      pageErrors,
      bootMarkers: [...bootMarkers],
    })
    console.error(`[conversation-fixture] evidence\n${diagnostics.join("\n")}`)
    throw error
  } finally {
    diagnose(`${stage}:finished`)
  }
}
async function reloadFixture(owner: "timeline" | "execution") {
  navigation += 1
  bootMarkers.clear()
  diagnose("reload:begin", { owner })
  await fixtureStep("reload:dispose-and-settle", () => disposeFixture())
  await fixtureStep("reload:navigate", () => page.reload())
  await fixtureStep(`reload:${owner}-ready`, () =>
    page.waitForFunction(
      (owner) =>
        owner === "timeline" ? typeof window.__setTimeline === "function" : typeof window.__executionOwner === "object",
      owner,
    ),
  )
}
async function disposeFixture() {
  if (!page || page.isClosed()) return
  const state = await page.evaluate(async () => {
    const before = window.__pendingExecutions?.() ?? 0
    window.__executionOwner?.dispose?.()
    window.__settleExecutions?.()
    await Promise.resolve()
    return { before, after: window.__pendingExecutions?.() ?? 0 }
  })
  diagnose("render-and-pending:disposed", state)
  if (state.after) throw new Error(`Conversation fixture retained ${state.after} pending execution requests`)
}

type ExecutionCall = {
  rootIDs: string[]
  server: string
  scope: string | null
  session: string
  aborted: boolean
  delivered: boolean
}
type ExecutionTransportOptions = { deliverAfterAbort?: boolean }
type ExecutionOwnerFixture = {
  hold(options?: ExecutionTransportOptions): void
  calls(): ExecutionCall[]
  settle(index: number, status?: string, fail?: boolean): void
  event(rootID: unknown, sessionID?: string, type?: string): void
  identity(server: string, scope: string, session: string): void
  reconnect(): void
  revision(): void
  admission(ready: boolean, hasSession?: boolean): void
  handoff(optimisticID: string, canonicalID: string): void
  hydrate(): void
  hasHandoff(): boolean
  dispose(): void
}
declare global {
  interface Window {
    __setTimeline: (messages: unknown[]) => void
    __enableContent(): void
    __virtualExecutionWork: {
      reset(): void
      counts(): { processRootReads: number; projectionRootReads: number }
    }
    __executionOwner: ExecutionOwnerFixture
    __holdExecutions: (options?: ExecutionTransportOptions) => void
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
    "@lingui/core",
    "@lingui/solid",
    "@/context/session-transition",
  ]
  return stubbed.map((find) => ({ find, replacement: stubPath }))
}

beforeAll(async () => {
  diagnose("setup:host", { loadAverage: loadavg(), pid: process.pid })
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
      '<style>html,body,#root{height:700px;margin:0}.h-full{height:100%}.overflow-y-auto{overflow-y:auto}[data-slot="session-turn-stub"]{min-height:80px}</style><div id="root"></div><script>console.info("[conversation-boot] document")</script><script type="module" src="/main.tsx"></script>',
    ),
    Bun.write(
      stubPath,
      `
        import { createMemo, createSignal } from "solid-js"
        import { ExecutionCompletion } from ${JSON.stringify(`/@fs/${completionPath}`)}
        import { createPartArrivalState } from ${JSON.stringify(`/@fs/${arrivalPath}`)}
        import { createSessionTransitionState } from ${JSON.stringify(`/@fs/${transitionPath}`)}
        export { draftTransitionKey } from ${JSON.stringify(`/@fs/${transitionPath}`)}
        import { draftTransitionKey } from ${JSON.stringify(`/@fs/${transitionPath}`)}
        import { createStore } from "solid-js/store"
        import { createSynergyClient } from ${JSON.stringify(`/@fs/${path.resolve(import.meta.dir, "../../../../../packages/sdk/js/src/client.ts")}`)}

        export { resolveActivityDisclosure } from ${JSON.stringify(`/@fs/${processPath}`)}
        console.info("[conversation-boot] stubs")
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
        export const setupI18n = () => ({_: descriptor => descriptor.message ?? descriptor.id})
        export const I18nProvider = props => props.children
        export const useLingui = () => ({_: descriptor => descriptor.message ?? descriptor.id})
        const [server, setServer] = createSignal("http://fixture")
        const [scope, setScope] = createSignal("scope")
        const [session, setSession] = createSignal("ses_1")
        const [recovery, setRecovery] = createSignal(1)
        const [revision, setRevision] = createSignal(0)
        const [ready, setReady] = createSignal(true)
        const [hasSession, setHasSession] = createSignal(true)
        const [messages, setMessages] = createSignal([])
        export const fixtureMessages = messages
        const virtualExecutionWork = {processRootReads: 0, projectionRootReads: 0}
        window.__virtualExecutionWork = {
          reset: () => { virtualExecutionWork.processRootReads = 0; virtualExecutionWork.projectionRootReads = 0 },
          counts: () => ({...virtualExecutionWork}),
        }
        export const readProjectionPage = id => {
          if (id === "r32") virtualExecutionWork.projectionRootReads++
          return {hasMore: false}
        }
        export const setFixtureMessages = setMessages
        export const fixtureSession = session
        const listeners = new Map()
        const calls = []
        let holdExecutions = false
        let deliverAfterAbort = false
        const pendingExecutions = new Map()
        const client = createMemo(() => createSynergyClient({
          baseUrl: server(), scopeID: scope(),
          fetch: async request => {
            const url = new URL(request.url)
            const { rootIDs } = await request.json()
            const index = calls.length
            const call = {rootIDs, server: url.origin, scope: request.headers.get("x-synergy-scope-id"), session: url.pathname.split("/")[2], aborted: request.signal.aborted, delivered: false}
            calls.push(call)
            if (!holdExecutions) {
              request.signal.throwIfAborted()
              call.delivered = true
              return Response.json([])
            }
            const allowLateDelivery = deliverAfterAbort
            return new Promise<Response>((resolve, reject) => {
              const release = () => {
                pendingExecutions.delete(index)
                request.signal.removeEventListener("abort", abort)
              }
              const abort = () => {
                call.aborted = true
                if (allowLateDelivery) return
                release()
                reject(request.signal.reason ?? new DOMException("The operation was aborted", "AbortError"))
              }
              const deliver = response => {
                release()
                call.delivered = true
                resolve(response)
              }
              pendingExecutions.set(index, deliver)
              request.signal.addEventListener("abort", abort, {once: true})
              if (request.signal.aborted) abort()
            })
          },
        }))
        window.__holdExecutions = (options = {}) => {
          holdExecutions = true
          deliverAfterAbort = options.deliverAfterAbort === true
        }
        window.__pendingExecutions = () => pendingExecutions.size
        const settle = (index, status = "running", fail = false) => {
          const resolve = pendingExecutions.get(index)
          resolve?.(fail ? Response.json({message: "Unavailable"}, {status: 503}) : Response.json(calls[index].rootIDs.map(rootID => ({rootID, status, startedAt: 1, stoppedAt: []}))))
        }
        window.__settleExecutions = () => {
          holdExecutions = false
          for (const index of [...pendingExecutions.keys()]) settle(index)
        }
        const [content, setContent] = createStore({partSummary: {}, part: {}, partVersion: {}})
        window.__executionOwner = {
          hold: window.__holdExecutions, calls: () => calls, settle,
          event: (rootID, sessionID = session(), type = "session.execution.updated") => {
            for (const listener of listeners.get(type) ?? []) listener({type, properties: {sessionID, rootID}})
          },
          identity: (url, key, id) => { setServer(url); setScope(key); setSession(id) },
          reconnect: () => setRecovery(value => value + 1),
          revision: () => setRevision(value => value + 1),
          admission: (isReady, exists = true) => { setReady(isReady); setHasSession(exists) },
          handoff: (optimisticID, canonicalID) => {
            const message = {id: optimisticID, sessionID: session(), role: "user", rootID: optimisticID, isRoot: true, time: {created: 1}, text: "First send"}
            const part = {id: "captured-part", messageID: optimisticID, sessionID: session(), type: "text", text: "First send"}
            const lease = transitions.prepareDraft(draftTransitionKey(server(), scope()))
            lease.submit({text: "First send", messageID: optimisticID, prompt: [], message, parts: [part]})
            lease.handoff(session(), {phase: "loading", title: "Waiting"})
            transitions.messageIdentity.handoff([server(), scope(), session()], optimisticID, canonicalID)
            transitions.handoffMessage(session(), canonicalID)
            transitions.set(session(), {phase: "loading", title: "Waiting"}, undefined, {messageID: canonicalID, success: {phase: "success", title: "Ready"}})
            setMessages([{...message, id: canonicalID, rootID: canonicalID}])
          },
          hydrate: () => {
            const id = transitions.get(session()).handoff.messageID
            setContent("partSummary", id, [{id: "captured-part", content: {version: "current"}}])
            setContent("part", id, [{id: "captured-part", type: "text", text: "First send"}])
            setContent("partVersion", "captured-part", "current")
          },
          hasHandoff: () => !!transitions.get(session())?.handoff,
        }
        export const useSDK = () => ({
          get url() { return server() }, get scopeKey() { return scope() }, get client() { return client() }, connected: () => true,
          event: {on: (type, listener) => {
            if (!listeners.has(type)) listeners.set(type, new Set())
            listeners.get(type).add(listener)
            return () => listeners.get(type).delete(listener)
          }},
        })
        export const useSessionDataView = () => () => ({statusFor: () => ({type: revision() % 2 ? "busy" : "idle"}), sessionFor: () => hasSession() ? {id: session()} : undefined, messagesFor: messages})
        export const useSync = () => ({data: content})
        export const useSessionPreparation = () => ({ready})
        const partArrival = createPartArrivalState()
        export const useGlobalSync = () => ({partArrival, peekScopeState: () => undefined, reconnectVersion: recovery, ready: true, scopeRecoveryPending: () => false})
        export const SessionSubmissionStatus = () => null
        const transitions = createSessionTransitionState()
        export const useSessionTransition = () => transitions
        export const submissionForRoot = (_, rootID) => {
          if (rootID === "r32") virtualExecutionWork.processRootReads++
          return undefined
        }
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
        import { fixtureSession, fixtureMessages, setFixtureMessages, readProjectionPage } from "./stubs"
        console.info("[conversation-boot] main")

        type AnyMsg = { id: string; role: "user" | "assistant"; text?: string }

        function App() {
          const timeline = fixtureMessages
          const [contentEnabled, setContentEnabled] = createSignal(false)
          let scrolledUp = false
          ;(window as any).__readingHistory = () => { scrolledUp = true }
          ;(window as any).__enableContent = () => setContentEnabled(true)
          let locate: ((id: string, behavior: ScrollBehavior, partID?: string) => Promise<boolean>) | undefined
          ;(window as any).__locate = (id: string, partID?: string) => locate?.(id, "auto", partID)
          ;(window as any).__setTimeline = setFixtureMessages
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
              page: readProjectionPage,load: async () => {},retain: () => ({ready:Promise.resolve(),release() {}}),
            } : undefined },
            registerMessageLocator: fn => { locate=fn; return () => { if(locate===fn) locate=undefined } },
            onFirstTurnMounted() {},
            canRewind: () => true,
            get sessionID() { return fixtureSession() },
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
        console.info("[conversation-boot] render:start")
        const dispose = render(() => <I18nProvider i18n={i18n}><DialogProvider><Suspense fallback={<p data-test-loading>Loading conversation</p>}><App /></Suspense></DialogProvider></I18nProvider>, document.querySelector("#root")!)
        window.__executionOwner.dispose = dispose
        console.info("[conversation-boot] render:end")
      `,
    ),
  ])

  server = await createServer({
    configFile: false,
    root: fixtureDirectory,
    cacheDir: path.join(fixtureDirectory, ".vite"),
    optimizeDeps: {
      include: ["solid-js", "solid-js/web", "solid-js/store", "zod", "fuzzysort", "lucide-solid"],
      noDiscovery: true,
    },
    plugins: [solidPlugin()],
    resolve: {
      alias: [
        ...aliasConfig(stubPath),
        {
          find: /^@ericsanchezok\/synergy-plugin\/icons$/,
          replacement: path.resolve(import.meta.dir, "../../../../../packages/plugin/src/icons.ts"),
        },
        {
          find: /^virtua\/solid$/,
          replacement: path.resolve(import.meta.dir, "../../../node_modules/virtua/lib/solid/index.mjs"),
        },
        {
          find: /^lucide-solid$/,
          replacement: path.resolve(
            import.meta.dir,
            "../../../../../packages/ui/node_modules/lucide-solid/dist/esm/lucide-solid.js",
          ),
        },
        { find: "@/utils/error", replacement: path.resolve(import.meta.dir, "../../../src/utils/error.ts") },
        { find: "@", replacement: path.resolve(import.meta.dir, "../../../src") },
      ],
    },
    server: {
      host: "127.0.0.1",
      port: await fixturePort(),
      strictPort: true,
      // Files are immutable after setup; this fixture does not exercise HMR or native file watching.
      watch: null,
      fs: { allow: [path.resolve(import.meta.dir, "../../../../.."), fixtureDirectory] },
    },
  })
  server.httpServer?.on("connection", (socket) => {
    sockets.add(socket)
    socket.once("close", () => sockets.delete(socket))
  })
  await fixtureStep("setup:vite-listen", () => server.listen())
  await fixtureStep("setup:vite-warmup", () => server.warmupRequest("/main.tsx"))

  const url = server.resolvedUrls?.local[0]
  if (!url) throw new Error("Expected Vite test server URL")

  browser = await fixtureStep("setup:browser-launch", () => chromium.launch({ headless: true }))
  browser.on("disconnected", () => diagnose("browser:disconnected"))
  page = await fixtureStep("setup:page-create", () => browser.newPage({ viewport: { width: 900, height: 700 } }))
  page.on("pageerror", (error) => {
    pageErrors.push(error.message)
    diagnose("page:error", error.message)
  })
  page.on("console", (message) => {
    if (message.text().startsWith("[conversation-boot]")) bootMarkers.add(message.text())
    diagnose(`page:console:${message.type()}`, { text: message.text(), location: message.location() })
  })
  page.on("request", (request) => requests.add(request.url()))
  page.on("requestfinished", (request) => requests.delete(request.url()))
  page.on("requestfailed", (request) => {
    requests.delete(request.url())
    diagnose("request:failed", { url: request.url(), failure: request.failure() })
  })
  page.on("response", (response) => {
    if (response.status() >= 400) diagnose("request:response", { url: response.url(), status: response.status() })
  })
  page.on("framenavigated", (frame) => {
    if (frame === page.mainFrame()) diagnose("page:navigated", frame.url())
  })
  page.on("crash", () => diagnose("page:crash"))
  page.on("close", () => diagnose("page:closed"))
  await fixtureStep("setup:page-goto", () => page.goto(url, { timeout: 60000 }))
  await fixtureStep("setup:timeline-ready", () =>
    page.waitForFunction(() => typeof window.__setTimeline === "function", undefined, { timeout: 15000 }),
  )
}, 90000)

afterAll(async () => {
  const errors: unknown[] = []
  const cleanup = async (stage: string, action: () => Promise<void>) => {
    try {
      await fixtureStep(`cleanup:${stage}`, action)
    } catch (error) {
      errors.push(error)
    }
  }
  await cleanup("render-and-pending", () => disposeFixture())
  await cleanup("page", async () => {
    await page?.close()
  })
  await cleanup("browser", async () => {
    await browser?.close()
  })
  await cleanup("server", async () => {
    if (!server) return
    server.httpServer?.once("close", () => diagnose("cleanup:server:http:end"))
    diagnose("cleanup:server:http:start", {
      pendingRequests: [...requests],
      sockets: [...sockets].map((socket) => ({
        destroyed: socket.destroyed,
        writable: socket.writable,
        readable: socket.readable,
      })),
      clients: server.ws.clients.size,
    })
    await server.close()
  })
  await cleanup("files", async () => {
    if (fixtureDirectory) await rm(fixtureDirectory, { recursive: true, force: true })
  })
  diagnose("cleanup:complete", { errors: errors.map(String), pendingRequests: [...requests] })
  if (errors.length) throw new AggregateError(errors, "Conversation fixture cleanup failed")
}, 30000)

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
    await reloadFixture("timeline")
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

const executionCalls = () => page.evaluate(() => window.__executionOwner.calls())
const executionFrames = () =>
  page.evaluate(
    () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
  )
const waitExecutionCalls = (count: number) =>
  page.waitForFunction((count) => window.__executionOwner.calls().length === count, count)
const executionStatus = (rootID: string) =>
  page.locator(`[data-slot="session-turn-stub"][data-message-id="${rootID}"]`).getAttribute("data-execution")
const waitExecutionStatus = (rootID: string, status: string) =>
  page.waitForFunction(
    ({ rootID, status }) =>
      document
        .querySelector(`[data-slot="session-turn-stub"][data-message-id="${rootID}"]`)
        ?.getAttribute("data-execution") === status,
    { rootID, status },
  )
async function startExecutionOwner(options: ExecutionTransportOptions = {}) {
  await reloadFixture("execution")
  await page.evaluate((options) => {
    window.__executionOwner.hold(options)
    window.__setTimeline(
      Array.from({ length: 70 }, (_, index) => ({
        id: `r${index}`,
        sessionID: "ses_1",
        role: "user",
        time: { created: index },
      })),
    )
  }, options)
  await waitExecutionCalls(1)
}

describe("conversation execution request owner", () => {
  test.each(["success", "failure"] as const)(
    "commits a 64-root %s response in one real virtual projection",
    async (outcome) => {
      await fixtureStep(`virtual-response:${outcome}`, async () => {
        await startExecutionOwner()
        await page.evaluate(() => window.__enableContent())
        await page.waitForSelector("[data-display-row]")
        await page.evaluate(() => (window as unknown as { __locate(id: string): Promise<boolean> }).__locate("r69"))
        await page.waitForSelector('[data-display-row="r69:footer"]')
        await executionFrames()
        // An unmounted middle root isolates whole-window work from row-local rendering.
        expect(await page.locator('[data-display-row][data-message-id="r32"]').count()).toBe(0)
        if (outcome === "failure") {
          await page.evaluate(() => window.__executionOwner.settle(0, "running"))
          await executionFrames()
          await page.evaluate(() => window.__executionOwner.reconnect())
          await waitExecutionCalls(2)
        }
        const index = outcome === "failure" ? 1 : 0
        expect((await executionCalls())[index].rootIDs).toHaveLength(64)
        await page.evaluate(
          ({ index, outcome }) => {
            window.__virtualExecutionWork.reset()
            window.__executionOwner.settle(index, "running", outcome === "failure")
          },
          { index, outcome },
        )
        await executionFrames()
        const counts = await page.evaluate(() => window.__virtualExecutionWork.counts())
        diagnose("virtual-response:work", { outcome, roots: 64, ...counts })
        expect(counts).toEqual({ processRootReads: 1, projectionRootReads: 1 })
        const rows = page.locator('[data-slot="session-turn-stub"][data-message-id="r69"]')
        expect(await rows.count()).toBeGreaterThan(0)
        expect(
          await rows.evaluateAll(
            (elements, outcome) =>
              elements.every(
                (element) => element.getAttribute("data-execution") === (outcome === "failure" ? null : "running"),
              ),
            outcome,
          ),
        ).toBe(true)
        expect(await page.evaluate(() => window.__pendingExecutions())).toBe(0)
        expect((await executionCalls()).length).toBe(index + 1)
        expect(pageErrors).toEqual([])
      })
    },
  )

  test("loads 64 roots once, batches dirty roots and ignores malformed or outside identities", async () => {
    await startExecutionOwner()
    expect((await executionCalls())[0].rootIDs).toEqual(Array.from({ length: 64 }, (_, index) => `r${index + 6}`))
    await page.evaluate(() => window.__executionOwner.settle(0, "completed"))
    await waitExecutionStatus("r69", "completed")
    await page.evaluate(() => {
      for (const rootID of [undefined, null, {}, [], "", "r0", "outside"]) window.__executionOwner.event(rootID)
      window.__executionOwner.event("r8", "another-session")
    })
    await executionFrames()
    expect((await executionCalls()).length).toBe(1)
    await page.evaluate(() => {
      window.__executionOwner.event("r8")
      window.__executionOwner.event("r8")
      window.__executionOwner.event("r9")
    })
    await waitExecutionCalls(2)
    expect((await executionCalls())[1].rootIDs).toEqual(["r8", "r9"])
    await page.evaluate(() => window.__executionOwner.settle(1, "running"))
    await waitExecutionStatus("r8", "running")
    expect(await executionStatus("r7")).toBe("completed")
    expect(await executionStatus("r69")).toBe("completed")
    expect(pageErrors).toEqual([])
  })

  test("queues in-flight dirties without aborting and rejects only superseded roots", async () => {
    await startExecutionOwner()
    await page.evaluate(() => {
      window.__executionOwner.event("r8")
      window.__executionOwner.event("r8")
    })
    await executionFrames()
    expect((await executionCalls()).length).toBe(1)
    expect((await executionCalls())[0].aborted).toBe(false)
    await page.evaluate(() => window.__executionOwner.settle(0, "completed"))
    await waitExecutionCalls(2)
    expect((await executionCalls())[1].rootIDs).toEqual(["r8"])
    expect(await executionStatus("r8")).toBeNull()
    expect(await executionStatus("r9")).toBe("completed")
    await page.evaluate(() => {
      window.__executionOwner.event("r8")
      window.__executionOwner.event("r9")
      window.__executionOwner.settle(1, "stopped")
    })
    await waitExecutionCalls(3)
    expect((await executionCalls())[1].aborted).toBe(false)
    expect((await executionCalls())[2].rootIDs).toEqual(["r8", "r9"])
    expect(await executionStatus("r8")).toBeNull()
    await page.evaluate(() => window.__executionOwner.settle(2, "running"))
    await waitExecutionStatus("r8", "running")
  })

  test("fetches only added roots, prunes evictions and fences re-added roots", async () => {
    await startExecutionOwner()
    await page.evaluate(() => {
      window.__setTimeline(
        Array.from({ length: 71 }, (_, index) => ({ id: `r${index}`, role: "user", time: { created: index } })),
      )
      window.__executionOwner.event("r6")
      window.__setTimeline(
        Array.from({ length: 64 }, (_, index) => ({
          id: index === 63 ? "r6" : `r${index + 8}`,
          role: "user",
          time: { created: index },
        })),
      )
    })
    await executionFrames()
    expect((await executionCalls()).length).toBe(1)
    await page.evaluate(() => window.__executionOwner.settle(0, "completed"))
    await waitExecutionCalls(2)
    expect((await executionCalls())[1].rootIDs).toEqual(["r70", "r6"])
    expect(await executionStatus("r6")).toBeNull()
    expect(await executionStatus("r8")).toBe("completed")
    await page.evaluate(() => window.__executionOwner.settle(1, "running"))
    await waitExecutionStatus("r6", "running")
    await page.evaluate(() => {
      window.__setTimeline(
        Array.from({ length: 63 }, (_, index) => ({
          id: index === 62 ? "r6" : `r${index + 9}`,
          role: "user",
          time: { created: index },
        })),
      )
      window.__setTimeline(
        Array.from({ length: 64 }, (_, index) => ({
          id: index === 63 ? "r6" : `r${index + 8}`,
          role: "user",
          time: { created: index },
        })),
      )
    })
    await waitExecutionCalls(3)
    expect((await executionCalls())[2].rootIDs).toEqual(["r8"])
    expect(await executionStatus("r8")).toBeNull()
    expect(await executionStatus("r70")).toBe("running")
    await page.evaluate(() => window.__executionOwner.settle(2, "completed"))
    await waitExecutionStatus("r8", "completed")
  })

  test("identity epochs reject A to B to A and abort disposed request owners", async () => {
    await startExecutionOwner({ deliverAfterAbort: true })
    await page.evaluate(() => window.__executionOwner.identity("http://second", "scope-b", "ses_b"))
    await waitExecutionCalls(2)
    await page.evaluate(() => window.__executionOwner.identity("http://fixture", "scope", "ses_1"))
    await waitExecutionCalls(3)
    const calls = await executionCalls()
    expect(calls.map((call) => call.aborted)).toEqual([true, true, false])
    expect(calls[1]).toMatchObject({ server: "http://second", scope: "scope-b", session: "ses_b" })
    await page.evaluate(() => {
      window.__executionOwner.settle(0, "stopped")
      window.__executionOwner.settle(1, "failed")
    })
    await executionFrames()
    expect(await executionStatus("r69")).toBeNull()
    expect((await executionCalls()).slice(0, 2).map((call) => call.delivered)).toEqual([true, true])
    await page.evaluate(() => window.__executionOwner.settle(2, "running"))
    await waitExecutionStatus("r69", "running")
    expect((await executionCalls()).length).toBe(3)
    await page.evaluate(() => window.__executionOwner.event("r69"))
    await waitExecutionCalls(4)
    await page.evaluate(() => {
      window.__executionOwner.event("r69")
      window.__executionOwner.dispose()
      window.__executionOwner.settle(3, "completed")
    })
    await executionFrames()
    expect((await executionCalls()).length).toBe(4)
    expect((await executionCalls())[3].aborted).toBe(true)
    expect((await executionCalls())[3].delivered).toBe(true)
  })

  test("ordinary cancellation drains aborted transport before identity replacement and disposal", async () => {
    await startExecutionOwner()
    await page.evaluate(() => window.__executionOwner.identity("http://second", "scope-b", "ses_b"))
    await waitExecutionCalls(2)
    expect(await page.evaluate(() => window.__pendingExecutions())).toBe(1)
    expect((await executionCalls())[0]).toMatchObject({ aborted: true, delivered: false })
    await page.evaluate(() => window.__executionOwner.settle(0, "stopped"))
    await executionFrames()
    expect((await executionCalls())[0].delivered).toBe(false)
    expect(await executionStatus("r69")).toBeNull()
    await page.evaluate(() => window.__executionOwner.settle(1, "running"))
    await waitExecutionStatus("r69", "running")
    await page.evaluate(() => window.__executionOwner.event("r69"))
    await waitExecutionCalls(3)
    await page.evaluate(() => window.__executionOwner.dispose())
    await executionFrames()
    expect(await page.evaluate(() => window.__pendingExecutions())).toBe(0)
    expect((await executionCalls())[2]).toMatchObject({ aborted: true, delivered: false })
    expect((await executionCalls()).length).toBe(3)
    expect(pageErrors).toEqual([])
  })

  test("permission and actual reconnect generation conservatively refresh the full window", async () => {
    await startExecutionOwner()
    await page.evaluate(() => window.__executionOwner.settle(0, "completed"))
    await executionFrames()
    await page.evaluate(() => {
      window.__executionOwner.event(undefined, "ses_1", "permission.asked")
      window.__executionOwner.event(undefined, "ses_1", "permission.replied")
    })
    await waitExecutionCalls(2)
    expect((await executionCalls())[1].rootIDs.length).toBe(64)
    await page.evaluate(() => window.__executionOwner.reconnect())
    await executionFrames()
    expect((await executionCalls()).length).toBe(2)
    expect((await executionCalls())[1].aborted).toBe(false)
    await page.evaluate(() => window.__executionOwner.settle(1, "failed"))
    await waitExecutionCalls(3)
    expect((await executionCalls())[2].rootIDs.length).toBe(64)
    expect(await executionStatus("r8")).toBe("completed")
    await page.evaluate(() => window.__executionOwner.settle(2, "running"))
    await waitExecutionStatus("r8", "running")
  })

  test("failures settle without self retry and lifecycle revision repairs only the latest root", async () => {
    await startExecutionOwner()
    await page.evaluate(() => window.__executionOwner.settle(0, "running", true))
    await executionFrames()
    expect((await executionCalls()).length).toBe(1)
    expect(await executionStatus("r69")).toBeNull()
    await page.evaluate(() => window.__executionOwner.event("r8"))
    await waitExecutionCalls(2)
    expect((await executionCalls())[1].rootIDs).toEqual(["r8"])
    await page.evaluate(() => window.__executionOwner.settle(1, "completed"))
    await waitExecutionStatus("r8", "completed")
    await page.evaluate(() => window.__executionOwner.revision())
    await waitExecutionCalls(3)
    expect((await executionCalls())[2].rootIDs).toEqual(["r69"])
    await page.evaluate(() => window.__executionOwner.settle(2, "running", true))
    await executionFrames()
    expect((await executionCalls()).length).toBe(3)
    expect(await executionStatus("r8")).toBe("completed")
    await page.evaluate(() => window.__executionOwner.event("r9"))
    await waitExecutionCalls(4)
    await page.evaluate(() => {
      window.__executionOwner.event("r9")
      window.__executionOwner.settle(3, "running", true)
    })
    await waitExecutionCalls(5)
    expect((await executionCalls())[4].rootIDs).toEqual(["r9"])
    await page.evaluate(() => window.__executionOwner.settle(4, "running"))
    await waitExecutionStatus("r9", "running")
    await executionFrames()
    expect((await executionCalls()).length).toBe(5)
    expect(pageErrors).toEqual([])
  })

  test("readiness close and reopen aborts, fences and rebaselines the loaded window", async () => {
    await startExecutionOwner({ deliverAfterAbort: true })
    await page.evaluate(() => window.__executionOwner.admission(false))
    await executionFrames()
    expect((await executionCalls())[0].aborted).toBe(true)
    await page.evaluate(() => {
      window.__executionOwner.event("r8")
      window.__executionOwner.event(undefined, "ses_1", "permission.asked")
      window.__executionOwner.reconnect()
    })
    await executionFrames()
    expect((await executionCalls()).length).toBe(1)
    await page.evaluate(() => window.__executionOwner.admission(true, false))
    await executionFrames()
    expect((await executionCalls()).length).toBe(1)
    await page.evaluate(() => window.__executionOwner.admission(true))
    await waitExecutionCalls(2)
    expect((await executionCalls())[1].rootIDs.length).toBe(64)
    await page.evaluate(() => window.__executionOwner.settle(0, "stopped"))
    await executionFrames()
    expect(await executionStatus("r69")).toBeNull()
    expect((await executionCalls())[0].delivered).toBe(true)
    await page.evaluate(() => window.__executionOwner.settle(1, "running"))
    await waitExecutionStatus("r69", "running")
    await page.evaluate(() => window.__executionOwner.admission(true, false))
    await executionFrames()
    expect(await executionStatus("r69")).toBeNull()
    await page.evaluate(() => window.__executionOwner.admission(true))
    await waitExecutionCalls(3)
    expect((await executionCalls())[2].rootIDs.length).toBe(64)
    await page.evaluate(() => window.__executionOwner.settle(2, "completed"))
    await waitExecutionStatus("r69", "completed")
  })

  test("first-send alias retains its row while canonical execution and bodies complete handoff", async () => {
    await reloadFixture("execution")
    await page.evaluate(() => {
      window.__executionOwner.hold()
      window.__executionOwner.admission(false)
      window.__setTimeline([{ id: "optimistic-root", sessionID: "ses_1", role: "user", time: { created: 1 } }])
    })
    const row = page.locator('[data-slot="session-turn-stub"][data-message-id="optimistic-root"]')
    const mount = await row.getAttribute("data-mount")
    await page.evaluate(() => {
      window.__executionOwner.handoff("optimistic-root", "canonical-root")
      window.__executionOwner.admission(true)
    })
    await waitExecutionCalls(1)
    expect((await executionCalls())[0].rootIDs).toEqual(["canonical-root"])
    expect(await page.evaluate(() => window.__executionOwner.hasHandoff())).toBe(true)
    await page.evaluate(() => window.__executionOwner.settle(0, "running"))
    await executionFrames()
    expect(await executionStatus("optimistic-root")).toBe("running")
    expect(await page.evaluate(() => window.__executionOwner.hasHandoff())).toBe(true)
    await page.evaluate(() => window.__executionOwner.hydrate())
    await page.waitForFunction(() => !window.__executionOwner.hasHandoff())
    expect(await row.getAttribute("data-mount")).toBe(mount)
    await page.evaluate(() => {
      window.__executionOwner.event("optimistic-root")
      window.__executionOwner.event("canonical-root")
    })
    await waitExecutionCalls(2)
    expect((await executionCalls())[1].rootIDs).toEqual(["canonical-root"])
    await page.evaluate(() => window.__executionOwner.settle(1, "completed"))
    await waitExecutionStatus("optimistic-root", "completed")
    expect(await row.getAttribute("data-mount")).toBe(mount)
    expect(pageErrors).toEqual([])
  })
})
