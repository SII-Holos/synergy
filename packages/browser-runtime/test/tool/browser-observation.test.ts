import { afterEach, beforeEach, expect, test } from "bun:test"
import { BrowserToolHelper } from "../../src/tools/browser-shared"
import { BrowserAnnotateTool } from "../../src/tools/browser-annotate"
import { BrowserSessionImpl } from "../../src/session"
import { BrowserStorage } from "../../src/storage"
import { BrowserEvent } from "../../src/event"
import { BrowserReadTool } from "../../src/tools/browser-read"
import { BrowserConsoleTool } from "../../src/tools/browser-console"
import { BrowserNetworkTool } from "../../src/tools/browser-network"
import { BrowserEvalTool } from "../../src/tools/browser-eval"
import { BrowserClipboardTool } from "../../src/tools/browser-clipboard"
import { BrowserDialogTool } from "../../src/tools/browser-dialog"
import { BrowserAuditTool } from "../../src/tools/browser-audit"
import { BrowserInspectTool } from "../../src/tools/browser-inspect"
import { BrowserPerformanceTool } from "../../src/tools/browser-performance"
import { BrowserSnapshotTool } from "../../src/tools/browser-snapshot"
import type { BrowserBackendCommand, BrowserBackendResult } from "@ericsanchezok/synergy-browser"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"

const original = {
  getOrCreateSession: BrowserToolHelper.getOrCreateSession,
  getPage: BrowserToolHelper.getPage,
  resolvePage: BrowserToolHelper.resolvePage,
  execute: BrowserToolHelper.execute,
  withActivity: BrowserToolHelper.withActivity,
}
const context = {
  sessionID: "ses_observation",
  messageID: "msg_observation",
  agent: "synergy",
  abort: new AbortController().signal,
  metadata() {},
  async ask() {},
}
let response: BrowserBackendResult
let commands: BrowserBackendCommand[]
beforeEach(() => {
  commands = []
  response = { type: "data", pageId: "page-test", data: { value: "observed" } }
  BrowserToolHelper.resolvePage = async () =>
    ({ id: "page-test", url: "https://example.com", title: "Example" }) as never
  BrowserToolHelper.execute = async (_ctx, command) => {
    commands.push(command)
    return response
  }
  BrowserToolHelper.withActivity = async (_ctx, _page, _kind, _tool, _label, run) => run()
})
afterEach(() => Object.assign(BrowserToolHelper, original))

test("read reports bounded content and empty pages without exposing a transport object", async () => {
  const tool = await BrowserReadTool.init()
  response = { type: "data", pageId: "page-test", data: { content: "Visible text", truncated: true } }
  const result = await tool.execute({ format: "text", maxChars: 10 }, context)
  expect(result.output).toBe("Visible text")
  expect(result.metadata.truncated).toBe(true)
  response = { type: "data", pageId: "page-test", data: {} }
  expect((await tool.execute({ format: "html", maxChars: 10 }, context)).output).toBe("(empty page)")
  response = { type: "void" }
  await expect(tool.execute({ format: "text", maxChars: 10 }, context)).rejects.toThrow("unexpected result")
})

test("console and network queries reject inconsistent filters and preserve bounded evidence", async () => {
  const consoleTool = await BrowserConsoleTool.init()
  const network = await BrowserNetworkTool.init()
  for (const params of [{ action: "get" }, { action: "clear", id: "x" }, { action: "clear", level: "error" }])
    expect(consoleTool.parameters.safeParse(params).success).toBe(false)
  for (const params of [{ action: "get" }, { action: "clear", id: "x" }, { action: "list", includeBody: true }])
    expect(network.parameters.safeParse(params).success).toBe(false)
  expect((await consoleTool.execute({ action: "list", filter: "error" }, context)).output).toContain("observed")
  expect(
    (await network.execute({ action: "get", id: "request-1", includeBody: true, maxBodyBytes: 100 }, context)).metadata
      .action,
  ).toBe("get")
  expect(commands.at(-1)).toMatchObject({ type: "network", id: "request-1", maxBodyBytes: 100 })
  response = { type: "void" }
  await expect(consoleTool.execute({ action: "clear" }, context)).rejects.toThrow("unexpected result")
  await expect(network.execute({ action: "clear" }, context)).rejects.toThrow("unexpected result")
})

test("evaluation and clipboard bound model output and reject oversized UTF-8 writes", async () => {
  const evaluate = await BrowserEvalTool.init()
  response = { type: "evaluation", pageId: "page-test", value: "abcdefghijklmnop" }
  const result = await evaluate.execute({ expression: "document.title", mode: "readonly", maxChars: 4 }, context)
  expect(result.metadata.truncated).toBe(true)
  expect(result.output).toContain("truncated")
  expect(commands.at(-1)).toMatchObject({ type: "evaluate", mode: "readonly" })
  const clipboard = await BrowserClipboardTool.init()
  expect(clipboard.parameters.safeParse({ action: "write" }).success).toBe(false)
  expect(clipboard.parameters.safeParse({ action: "read", text: "x" }).success).toBe(false)
  await expect(clipboard.execute({ action: "write", text: "界".repeat(400_000) }, context)).rejects.toThrow("1 MB")
  response = { type: "data", pageId: "page-test", data: { text: "hello" } }
  expect((await clipboard.execute({ action: "read" }, context)).metadata.byteLength).toBe(5)
  response = { type: "data", pageId: "page-test", data: {} }
  expect((await clipboard.execute({ action: "read" }, context)).output).toBe("(clipboard empty)")
  response = { type: "void" }
  await expect(evaluate.execute({ expression: "1", mode: "trusted", maxChars: 4 }, context)).rejects.toThrow(
    "unexpected result",
  )
  await expect(clipboard.execute({ action: "clear" }, context)).rejects.toThrow("unexpected result")
})

test("dialog audit and inspection retain page identity and do not accept unrelated results", async () => {
  const dialog = await BrowserDialogTool.init()
  const audit = await BrowserAuditTool.init()
  const inspect = await BrowserInspectTool.init()
  expect(dialog.parameters.safeParse({ action: "dismiss", promptText: "ignored" }).success).toBe(false)
  expect((await dialog.execute({ action: "accept", promptText: "yes" }, context)).metadata.pageId).toBe("page-test")
  expect((await audit.execute({}, context)).metadata.categories).toHaveLength(4)
  const target = { kind: "css" as const, value: "button" }
  expect((await inspect.execute({ target, computedStyles: ["color"] }, context)).metadata.target).toEqual(target)
  response = { type: "void" }
  await expect(dialog.execute({ action: "status" }, context)).rejects.toThrow("unexpected result")
  await expect(audit.execute({}, context)).rejects.toThrow("unexpected result")
  await expect(inspect.execute({ target }, context)).rejects.toThrow("unexpected result")
})

test("performance exports preserve trace data on disk while model output contains only the count", async () => {
  const performance = await BrowserPerformanceTool.init()
  expect(performance.parameters.safeParse({ action: "measure", exportPath: "trace.json" }).success).toBe(false)
  await using tmp = await tmpdir()
  await ScopeContext.provide({
    scope: await tmp.scope(),
    fn: async () => {
      response = {
        type: "data",
        pageId: "page-test",
        data: { traceEvents: [{ name: "Render" }, { name: "Layout" }], duration: 10 },
      }
      const result = await performance.execute({ action: "stopTrace", exportPath: "trace.json" }, context)
      expect(result.metadata.traceEventCount).toBe(2)
      expect(result.output).not.toContain("Render")
      expect((await Bun.file(`${tmp.path}/trace.json`).json()).traceEvents).toHaveLength(2)
      await expect(performance.execute({ action: "stopTrace", exportPath: "trace.json" }, context)).rejects.toThrow()
      response = { type: "void" }
      await expect(performance.execute({ action: "measure" }, context)).rejects.toThrow("unexpected result")
    },
  })
})

test("snapshot evidence includes snapshot identity even for an empty document", async () => {
  const snapshot = await BrowserSnapshotTool.init()
  response = { type: "snapshot", pageId: "page-test", snapshotId: "snapshot-1", elements: [], truncated: false }
  const result = await snapshot.execute({ maxNodes: 100, interactiveOnly: true }, context)
  expect(result.output).toContain("snapshotId: snapshot-1")
  expect(result.metadata.elementsCount).toBe(0)
  response = { type: "void" }
  await expect(snapshot.execute({ maxNodes: 100, interactiveOnly: false }, context)).rejects.toThrow(
    "unexpected result",
  )
})

test("annotation tools persist creation and resolution while paging only pending annotations", async () => {
  await using tmp = await tmpdir({ git: true })
  await ScopeContext.provide({
    scope: await tmp.scope(),
    fn: async () => {
      const owner = {
        mode: "session" as const,
        scopeID: ScopeContext.current.scope.id,
        directory: tmp.path,
        sessionID: context.sessionID,
      }
      const session = new BrowserSessionImpl(owner, async () => {
        throw new Error("no browser launch")
      })
      BrowserToolHelper.getOrCreateSession = async () => session
      BrowserToolHelper.getPage = async () => ({ id: "page-test", url: "https://example.com/" }) as never
      try {
        const tool = await BrowserAnnotateTool.init()
        for (const params of [
          { action: "read" },
          { action: "create" },
          { action: "list", comment: "ignored" },
          { action: "create", comment: "test", page: 1 },
          { action: "list", annotationId: "bad" },
        ])
          expect(tool.parameters.safeParse(params).success).toBe(false)
        expect((await tool.execute({ action: "list" }, context)).metadata.count).toBe(0)
        const created = await tool.execute(
          { action: "create", comment: "Improve contrast", ref: "button-1", styleFeedback: { color: "darker" } },
          context,
        )
        const annotationId = created.metadata.id!
        expect((await BrowserStorage.load(owner))?.annotations?.[0]).toMatchObject({
          id: annotationId,
          pageID: "page-test",
          resolved: false,
        })
        expect((await tool.execute({ action: "read", annotationId }, context)).output).toContain("Improve contrast")
        expect((await tool.execute({ action: "list", pageSize: 1 }, context)).output).toContain("darker")
        expect((await tool.execute({ action: "list", page: 1, pageSize: 1 }, context)).output).toBe(
          "No pending annotations.",
        )
        await tool.execute({ action: "resolve", annotationId }, context)
        expect((await BrowserStorage.load(owner))?.annotations?.[0]?.resolved).toBe(true)
        expect((await tool.execute({ action: "list" }, context)).metadata).toMatchObject({ count: 1, pending: 0 })
        expect((await tool.execute({ action: "resolve", annotationId: "missing" }, context)).title).toBe(
          "Annotation not found",
        )
        expect((await tool.execute({ action: "read", annotationId: "missing" }, context)).title).toBe(
          "Annotation not found",
        )
      } finally {
        await session.clearAnnotations()
        BrowserEvent.remove(owner)
      }
    },
  })
})
