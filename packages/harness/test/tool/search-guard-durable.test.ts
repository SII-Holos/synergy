import { expect, spyOn, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { Identifier } from "../../src/id/id"
import { MessageV2 } from "../../src/session/message-v2"
import { Session } from "../../src/session"
import { Scope } from "../../src/scope"
import { ScopeContext } from "../../src/scope/context"
import { Storage } from "../../src/storage/storage"
import { SearchGuard } from "../../src/tool/search-guard"
import { testRuntime } from "../support/runtime"
import { storageTestBackends } from "../support/storage-backends"

const tools = new Set(["websearch", "webfetch"])

async function root(sessionID: string, isRoot = true) {
  return Session.updateMessage({
    id: Identifier.ascending("message"),
    sessionID,
    role: "user",
    isRoot,
    agent: "synergy",
    model: { providerID: "fixture", modelID: "fixture" },
    time: { created: Date.now() },
  })
}

async function attempt(sessionID: string, rootID: string, query: string, status: "completed" | "error" = "completed") {
  const message = await Session.updateMessage({
    id: Identifier.ascending("message"),
    sessionID,
    role: "assistant",
    rootID,
    parentID: rootID,
    agent: "synergy",
    mode: "synergy",
    path: { cwd: null, root: null },
    providerID: "fixture",
    modelID: "fixture",
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: Date.now(), completed: Date.now() },
  })
  const part = await Session.updatePart({
    id: Identifier.ascending("part"),
    sessionID,
    messageID: message.id,
    type: "tool",
    callID: crypto.randomUUID(),
    tool: "websearch",
    state:
      status === "completed"
        ? {
            status,
            input: { query },
            output: "No results",
            title: "Search",
            metadata: { searchFailureType: "no_results" },
            time: { start: 1, end: 2, compacted: 3 },
          }
        : { status, input: { query }, error: "Request timed out", time: { start: 1, end: 2 } },
  })
  return { message, part }
}

test("search signatures preserve filter changes and canonicalize set filters", () => {
  const input = { query: "agent memory", categories: ["cs.AI", "cs.LG"], authors: ["B", "A"] }
  expect(SearchGuard.signature("websearch", input)).toBeDefined()
  expect(SearchGuard.signature("websearch", input)).toBe(
    SearchGuard.signature("websearch", {
      ...input,
      categories: ["cs.LG", "cs.AI"],
      authors: ["A", "B"],
    }),
  )
  expect(SearchGuard.signature("websearch", { ...input, startDate: "2026-01-01" })).not.toBe(
    SearchGuard.signature("websearch", input),
  )
  expect(SearchGuard.classifyHttpStatus(408)).toBe("timeout")
  expect(SearchGuard.signature("webfetch", { url: "https://example.com/Case" })).not.toBe(
    SearchGuard.signature("webfetch", { url: "https://example.com/case" }),
  )
})

for (const backend of storageTestBackends()) {
  const open = (options: { home?: string; namespace?: string } = {}) =>
    testRuntime({ ...options, postgres: backend === "postgres" ? process.env.SYNERGY_TEST_POSTGRES_URL! : undefined })
  test(`${backend}: durable admission retains completed and errored attempts across Runtime reopen`, async () => {
    const namespace = crypto.randomUUID()
    const home = await fs.mkdtemp(path.join(process.env.SYNERGY_TEST_ROOT!, "search-reopen-"))
    try {
      let scopeID = ""
      let sessionID = ""
      let rootMessageID = ""
      {
        await using runtime = await open({ home, namespace })
        await runtime.run(() =>
          ScopeContext.provide({
            scope: Scope.home(),
            fn: async () => {
              scopeID = ScopeContext.current.scope.id
              const session = await Session.create({ workspace: null })
              sessionID = session.id
              rootMessageID = (await root(sessionID)).id
              const first = await attempt(sessionID, rootMessageID, "completed query")
              await Session.updatePart({
                ...MessageV2.ToolPart.parse(first.part),
                id: Identifier.ascending("part"),
                callID: crypto.randomUUID(),
                state: {
                  status: "completed",
                  input: { query: "same assistant second query" },
                  output: "Result",
                  title: "Search",
                  metadata: {},
                  time: { start: 1, end: 2 },
                },
              })
              await attempt(sessionID, rootMessageID, "errored query", "error")
            },
          }),
        )
      }
      await using runtime = await open({ home, namespace })
      await runtime.run(async () => {
        const records = await SearchGuard.recordsForRootDurable({
          scopeID,
          sessionID,
          rootMessageID,
          searchTools: tools,
        })
        expect(records.map((record) => record.query)).toEqual([
          "completed query",
          "same assistant second query",
          "errored query",
        ])
        for (const query of ["completed query", "errored query"]) {
          expect(SearchGuard.checkDuplicate(records, "websearch", { query })?.output).toContain("this root task")
        }
      })
    } finally {
      await fs.rm(home, { recursive: true, force: true })
    }
  })

  test(`${backend}: durable admission preserves steers and never crosses a newer root`, async () => {
    await using runtime = await open()
    await runtime.run(() =>
      ScopeContext.provide({
        scope: Scope.home(),
        fn: async () => {
          const session = await Session.create({ workspace: null })
          const old = await root(session.id)
          await attempt(session.id, old.id, "old")
          const current = await root(session.id)
          await attempt(session.id, current.id, "current")
          await root(session.id, false)
          await attempt(session.id, current.id, "after steer", "error")
          const input = {
            scopeID: ScopeContext.current.scope.id,
            sessionID: session.id,
            rootMessageID: current.id,
            searchTools: tools,
          }
          expect((await SearchGuard.recordsForRootDurable(input)).map((record) => record.query)).toEqual([
            "current",
            "after steer",
          ])
          expect(await SearchGuard.recordsForRootDurable({ ...input, rootMessageID: old.id })).toEqual([])
          await root(session.id)
          expect(await SearchGuard.recordsForRootDurable(input)).toEqual([])
        },
      }),
    )
  })

  test(`${backend}: durable admission propagates part storage failures`, async () => {
    await using runtime = await open()
    await runtime.run(() =>
      ScopeContext.provide({
        scope: Scope.home(),
        fn: async () => {
          const session = await Session.create({ workspace: null })
          const user = await root(session.id)
          const { message } = await attempt(session.id, user.id, "same")
          const failure = new Error("fixture parts unavailable")
          const read = MessageV2.parts
          using _fault = spyOn(MessageV2, "parts").mockImplementation(
            Object.assign(
              (input: Parameters<typeof read>[0]) => {
                if (input.messageID === message.id) throw failure
                return read(input)
              },
              { force: read.force, schema: read.schema },
            ),
          )
          await expect(
            SearchGuard.recordsForRootDurable({
              scopeID: ScopeContext.current.scope.id,
              sessionID: session.id,
              rootMessageID: user.id,
              searchTools: tools,
            }),
          ).rejects.toBe(failure)
        },
      }),
    )
  })

  test(`${backend}: newest-first history preserves record failures instead of silently skipping evidence`, async () => {
    await using runtime = await open()
    await runtime.run(() =>
      ScopeContext.provide({
        scope: Scope.home(),
        fn: async () => {
          const session = await Session.create({ workspace: null })
          const user = await root(session.id)
          const { message } = await attempt(session.id, user.id, "same")
          const failure = new Error("fixture record unavailable")
          const read = Storage.read
          let faults = 0
          using _fault = spyOn(Storage, "read").mockImplementation(async (key, options) => {
            if (key.at(-2) === message.id) {
              faults++
              throw failure
            }
            return read(key, options)
          })
          const collect = async () => {
            const infos: MessageV2.Info[] = []
            for await (const info of MessageV2.readNewestInfos({
              scopeID: Identifier.asScopeID(ScopeContext.current.scope.id),
              sessionID: Identifier.asSessionID(session.id),
            }))
              infos.push(info)
            return infos
          }
          const observed = await collect().catch((error) => error)
          expect(faults).toBe(1)
          expect(observed).toBe(failure)
        },
      }),
    )
  })

  test(`${backend}: tool admission derives its root from persisted authority`, async () => {
    await using runtime = await open()
    await runtime.run(() =>
      ScopeContext.provide({
        scope: Scope.home(),
        fn: async () => {
          const session = await Session.create({ workspace: null })
          const old = await root(session.id)
          await attempt(session.id, old.id, "old")
          const current = await root(session.id)
          const { message } = await attempt(session.id, current.id, "current")
          const context = {
            sessionID: session.id,
            messageID: message.id,
            abort: new AbortController().signal,
            extra: { userMessageID: old.id },
          }
          expect(
            await SearchGuard.checkDuplicateForContext(context, "websearch", { query: "current" }, tools),
          ).toBeDefined()
          expect(
            await SearchGuard.checkDuplicateForContext(context, "websearch", { query: "old" }, tools),
          ).toBeUndefined()
          await expect(
            SearchGuard.checkDuplicateForContext(
              { ...context, messageID: Identifier.ascending("message") },
              "websearch",
              { query: "current" },
              tools,
            ),
          ).rejects.toThrow()
          const controller = new AbortController()
          const reason = new Error("Search caller cancelled")
          controller.abort(reason)
          await expect(
            SearchGuard.checkDuplicateForContext(
              { ...context, abort: controller.signal },
              "websearch",
              { query: "current" },
              tools,
            ),
          ).rejects.toBe(reason)
        },
      }),
    )
  })
}
