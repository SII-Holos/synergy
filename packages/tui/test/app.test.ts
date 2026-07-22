import { describe, expect, test } from "bun:test"
import type {
  EventReplayResult,
  EventStreamPayload,
  Message,
  Part,
  PermissionRequest,
  QuestionAnswer,
  QuestionRequest,
  ScopeBootstrapResponse,
  Session,
  SessionInputResult,
  SessionMessagePage,
} from "@ericsanchezok/synergy-sdk/client"
import { SelectRenderable, TextareaRenderable } from "@opentui/core"
import { createTestRenderer } from "@opentui/core/testing"
import { createTuiApp } from "../src/app"
import { createTuiController, type RuntimeAdapter } from "../src/controller"

function session(id: string, updated: number, title = id): Session {
  return {
    id,
    scope: { type: "project", id: "scope-tui", directory: "/workspace" },
    title,
    version: "1",
    time: { created: updated, updated },
  }
}

function userMessage(id: string, sessionID: string, created: number): Message {
  return {
    id,
    sessionID,
    role: "user",
    time: { created },
    agent: "synergy",
    model: { providerID: "test", modelID: "test" },
  }
}

function textPart(id: string, sessionID: string, messageID: string, text: string): Part {
  return { id, sessionID, messageID, type: "text", text }
}

function page(sessionID: string, text = `hello from ${sessionID}`): SessionMessagePage {
  const info = userMessage(`message-${sessionID}`, sessionID, 1)
  return {
    items: [{ info, parts: [textPart(`part-${sessionID}`, sessionID, info.id, text)] }],
    referencedRoots: [],
    nextCursor: null,
    hasMore: false,
    total: 1,
  }
}

function bootstrap(sessions: Session[], commands: ScopeBootstrapResponse["command"] = []): ScopeBootstrapResponse {
  return {
    scopeID: "scope-tui",
    provider: {
      all: [],
      connected: [],
      default: {},
      configProviders: [],
      catalogProviders: [],
      profiles: {},
      authHealth: {},
      runtimeAvailability: {},
      modelCatalog: {},
    },
    agent: [],
    config: {},
    command: commands,
    sessions: { data: sessions, total: sessions.length, offset: 0, limit: 50 },
    cortex: [],
  }
}

class OpenStream implements AsyncIterable<EventStreamPayload> {
  private waiter: ((value: IteratorResult<EventStreamPayload>) => void) | undefined

  close() {
    this.waiter?.({ value: undefined, done: true })
    this.waiter = undefined
  }

  [Symbol.asyncIterator](): AsyncIterator<EventStreamPayload> {
    return {
      next: () => new Promise((resolve) => (this.waiter = resolve)),
    }
  }
}

class UiAdapter implements RuntimeAdapter {
  readonly calls: string[] = []
  readonly stream = new OpenStream()
  interactions = { permissions: [] as PermissionRequest[], questions: [] as QuestionRequest[] }

  constructor(
    readonly snapshot: ScopeBootstrapResponse,
    readonly pages: Record<string, SessionMessagePage> = {},
  ) {}

  async health() {
    return { healthy: true as const, version: "1", modelReady: true }
  }
  async bootstrap() {
    return { data: this.snapshot, epoch: "epoch-tui", seq: 7 }
  }
  async listInteractions() {
    return this.interactions
  }
  async subscribe() {
    return this.stream
  }
  async replay(): Promise<EventReplayResult> {
    return { status: "ok", epoch: "epoch-tui", seq: 7, events: [] }
  }
  async messagePage(sessionID: string) {
    this.calls.push(`messages:${sessionID}`)
    return this.pages[sessionID] ?? page(sessionID)
  }
  async sessionResources(sessionID: string) {
    return {
      todos: [{ id: `todo-${sessionID}`, content: "Ship TUI", status: "pending", priority: "high" }],
      dag: [{ id: `dag-${sessionID}`, content: "Build interface", status: "running", deps: [] }],
    }
  }
  async getSession(sessionID: string) {
    return session(sessionID, 1)
  }
  async createSession(title?: string) {
    this.calls.push(`create:${title ?? ""}`)
    return session("created", 10, title ?? "New session")
  }
  async updateSession(sessionID: string, patch: { title?: string; pinned?: number; archived?: number }) {
    this.calls.push(`update:${sessionID}:${patch.pinned ?? ""}`)
    return { ...session(sessionID, 10), pinned: patch.pinned }
  }
  async deleteSession(sessionID: string) {
    this.calls.push(`delete:${sessionID}`)
  }
  async sendInput(sessionID: string, text: string): Promise<SessionInputResult> {
    this.calls.push(`input:${sessionID}:${text}`)
    return { status: "started", messageID: "input-message" }
  }
  async sendCommand(sessionID: string, command: string, args?: string) {
    this.calls.push(`command:${sessionID}:${command}:${args ?? ""}`)
  }
  async abortSession(sessionID: string) {
    this.calls.push(`abort:${sessionID}`)
  }
  async replyPermission(requestID: string, reply: "once" | "session" | "always" | "reject") {
    this.calls.push(`permission:${requestID}:${reply}`)
  }
  async replyQuestion(requestID: string, answers: QuestionAnswer[]) {
    this.calls.push(`question:${requestID}:${answers.flat().join(",")}`)
  }
  async rejectQuestion(requestID: string) {
    this.calls.push(`reject-question:${requestID}`)
  }
}

async function createHarness(adapter: UiAdapter, width = 110, height = 32, onQuit?: () => void) {
  const testRenderer = await createTestRenderer({ width, height, kittyKeyboard: true })
  const controller = createTuiController(adapter)
  const app = await createTuiApp(controller, { renderer: testRenderer.renderer, onQuit })
  await app.start()
  await testRenderer.flush()
  return { app, controller, adapter, ...testRenderer }
}

async function settle() {
  await Promise.resolve()
  await Promise.resolve()
  await Bun.sleep(0)
}

describe("Synergy TUI app", () => {
  test("renders sessions, messages, resources, and live status", async () => {
    const adapter = new UiAdapter(bootstrap([session("s1", 1, "First session"), session("s2", 2, "第二个会话")]), {
      s2: page("s2", "Hello **Synergy** 你好 👋🏽"),
    })
    const harness = await createHarness(adapter)
    const frame = harness.captureCharFrame()

    expect(frame).toContain("SYNERGY TUI")
    expect(frame).toContain("第二个会话")
    expect(frame).toContain("Hello Synergy 你好 👋🏽")
    expect(frame).toContain("Ship TUI")
    expect(frame).toContain("live · idle · seq 7")
    harness.app.stop()
  })

  test("keeps sanitized-empty session and command labels visible", async () => {
    const adapter = new UiAdapter(
      bootstrap(
        [session("s1", 1, "\u001b[31m\u001b[0m")],
        [
          {
            name: "\u001b[31m\u001b[0m",
            description: "\u001b[31m\u001b[0m",
            hints: [],
            kind: "prompt",
            promptVisible: true,
          },
        ],
      ),
    )
    const harness = await createHarness(adapter)

    expect(harness.captureCharFrame()).toContain("Untitled session")
    harness.mockInput.pressKey("k", { ctrl: true })
    await harness.flush()
    const frame = harness.captureCharFrame()
    expect(frame).toContain("/unnamed-command")
    expect(frame).toContain("Synergy command")
    harness.app.stop()
  })

  test("sends multiline composer input and restores input history", async () => {
    const adapter = new UiAdapter(bootstrap([session("s1", 1)]))
    const harness = await createHarness(adapter)
    const composer = harness.renderer.root.findDescendantById("tui-composer")
    expect(composer).toBeInstanceOf(TextareaRenderable)
    if (!(composer instanceof TextareaRenderable)) throw new Error("composer not found")

    await harness.mockInput.typeText("first line")
    harness.mockInput.pressEnter({ shift: true })
    await harness.mockInput.typeText("second line")
    harness.mockInput.pressEnter()
    await settle()
    expect(adapter.calls).toContain("input:s1:first line\nsecond line")
    expect(composer.plainText).toBe("")

    harness.mockInput.pressArrow("up")
    expect(composer.plainText).toBe("first line\nsecond line")
    harness.mockInput.pressArrow("down")
    expect(composer.plainText).toBe("")
    harness.app.stop()
  })

  test("switches sessions from the sidebar and adapts to compact width", async () => {
    const adapter = new UiAdapter(bootstrap([session("s1", 1, "First"), session("s2", 2, "Second")]))
    const harness = await createHarness(adapter)
    const sessions = harness.renderer.root.findDescendantById("tui-sessions")
    expect(sessions).toBeInstanceOf(SelectRenderable)
    if (!(sessions instanceof SelectRenderable)) throw new Error("session select not found")

    harness.mockInput.pressTab()
    harness.mockInput.pressArrow("down")
    harness.mockInput.pressEnter()
    await settle()
    await harness.flush()
    expect(harness.controller.getState().activeSessionID).toBe("s1")
    expect(adapter.calls).toContain("messages:s1")

    harness.resize(70, 24)
    await harness.flush()
    expect(harness.captureCharFrame()).not.toContain("SESSIONS")
    harness.mockInput.pressTab()
    await harness.flush()
    expect(harness.captureCharFrame()).toContain("SESSIONS")

    harness.mockInput.pressEnter()
    await settle()
    expect(harness.controller.getState().activeSessionID).toBe("s2")
    expect(adapter.calls).toContain("messages:s2")
    harness.app.stop()
  })

  test("uses the command palette without dispatching an unreviewed command", async () => {
    const adapter = new UiAdapter(
      bootstrap(
        [session("s1", 1)],
        [{ name: "review", description: "Review changes", hints: [], kind: "prompt", promptVisible: true }],
      ),
    )
    const harness = await createHarness(adapter)

    harness.mockInput.pressKey("k", { ctrl: true })
    await harness.flush()
    expect(harness.captureCharFrame()).toContain("COMMAND PALETTE")
    expect(adapter.calls.some((call) => call.startsWith("command:"))).toBe(false)

    harness.mockInput.pressEnter()
    await harness.mockInput.typeText("--all")
    harness.mockInput.pressEnter()
    await settle()
    expect(adapter.calls).toContain("command:s1:review:--all")
    harness.app.stop()
  })

  test("handles permission and question modals in priority order", async () => {
    const adapter = new UiAdapter(bootstrap([session("s1", 1)]))
    adapter.interactions = {
      permissions: [
        { id: "permission-1", sessionID: "s1", permission: "shell", patterns: ["git status"], metadata: {} },
      ],
      questions: [
        {
          id: "question-1",
          sessionID: "s1",
          questions: [
            {
              header: "Mode",
              question: "Choose execution mode",
              options: [
                { label: "Safe", description: "Use guarded execution" },
                { label: "Fast", description: "Use autonomous execution" },
              ],
            },
          ],
        },
      ],
    }
    const harness = await createHarness(adapter)
    expect(harness.captureCharFrame()).toContain("PERMISSION · shell")

    harness.mockInput.pressEnter()
    await settle()
    await harness.flush()
    expect(adapter.calls).toContain("permission:permission-1:once")
    expect(harness.captureCharFrame()).toContain("QUESTION 1/1 · Mode")

    harness.mockInput.pressEnter()
    await settle()
    expect(adapter.calls).toContain("question:question-1:Safe")
    harness.app.stop()
  })

  test("rejects dismissed permission and question interactions on the server", async () => {
    const permissionAdapter = new UiAdapter(bootstrap([session("s1", 1)]))
    permissionAdapter.interactions.permissions = [
      { id: "permission-1", sessionID: "s1", permission: "shell", patterns: ["git status"], metadata: {} },
    ]
    const permissionHarness = await createHarness(permissionAdapter)
    permissionHarness.mockInput.pressEscape()
    await settle()
    expect(permissionAdapter.calls).toContain("permission:permission-1:reject")
    permissionHarness.app.stop()

    const questionAdapter = new UiAdapter(bootstrap([session("s1", 1)]))
    questionAdapter.interactions.questions = [
      {
        id: "question-1",
        sessionID: "s1",
        questions: [
          {
            header: "Mode",
            question: "Choose execution mode",
            options: [{ label: "Safe", description: "Use guarded execution" }],
          },
        ],
      },
    ]
    const questionHarness = await createHarness(questionAdapter)
    questionHarness.mockInput.pressEscape()
    await settle()
    expect(questionAdapter.calls).toContain("reject-question:question-1")
    questionHarness.app.stop()
  })

  test("treats a missing active session status as idle when quitting", async () => {
    const adapter = new UiAdapter(bootstrap([session("s1", 1)]))
    let quitCount = 0
    const harness = await createHarness(adapter, 110, 32, () => quitCount++)

    harness.mockInput.pressKey("c", { ctrl: true })
    await settle()

    expect(quitCount).toBe(1)
    expect(adapter.calls).not.toContain("abort:s1")
  })
})
