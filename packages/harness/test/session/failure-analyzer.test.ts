import { expect, test } from "bun:test"
import { Identifier } from "../../src/id/id"
import { Scope } from "../../src/scope"
import { ScopeContext } from "../../src/scope/context"
import { Session } from "../../src/session"
import { LoopJob } from "../../src/session/loop-job"
import { MessageV2 } from "../../src/session/message-v2"
import { registerFailureAnalyzer, SearchFailureAnalyzer, SearchGuard } from "../../src/tool/search-guard"
import { testRuntime } from "../support/runtime"

const agent = "failure-fixture"
const tool = "custom_search"
const reflectionMarker = "[Custom failure reflection]"
const earlyStopMarker = "[Custom early stop]"

async function withContext(fn: (ctx: LoopJob.Context) => Promise<void>, userAgent = agent) {
  await using runtime = await testRuntime({
    register() {
      registerFailureAnalyzer({
        ...SearchFailureAnalyzer,
        category: "custom-search",
        tools: new Set([tool]),
        agentFilter: [agent],
        reflectionMarker,
        earlyStopMarker,
      })
    },
  })
  await runtime.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      fn: async () => {
        const session = await Session.create({ workspace: null })
        const user: MessageV2.User = {
          id: Identifier.ascending("message"),
          sessionID: session.id,
          role: "user",
          isRoot: true,
          agent: userAgent,
          model: { providerID: "fixture", modelID: "fixture" },
          time: { created: Date.now() },
        }
        await Session.updateMessage(user)
        await fn({
          session,
          sessionID: session.id,
          step: 0,
          messages: await Session.messages({ sessionID: session.id }),
          lastUser: user,
          lastUserParts: [],
          abort: new AbortController().signal,
        })
      },
    }),
  )
}

async function appendTool(
  ctx: LoopJob.Context,
  status: "completed" | "error" | "success",
  options: { tool?: string; agent?: string } = {},
) {
  const assistant: MessageV2.Assistant = {
    id: Identifier.ascending("message"),
    sessionID: ctx.sessionID,
    rootID: ctx.lastUser.id,
    parentID: ctx.lastUser.id,
    role: "assistant",
    agent: options.agent ?? agent,
    mode: options.agent ?? agent,
    path: { cwd: null, root: null },
    providerID: "fixture",
    modelID: "fixture",
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: Date.now(), completed: Date.now() },
  }
  await Session.updateMessage(assistant)
  const part: MessageV2.ToolPart = {
    id: Identifier.ascending("part"),
    sessionID: ctx.sessionID,
    messageID: assistant.id,
    type: "tool",
    tool: options.tool ?? tool,
    callID: crypto.randomUUID(),
    state:
      status === "error"
        ? {
            status,
            input: { query: assistant.id },
            error: "Custom request timed out",
            time: { start: 1, end: 2 },
          }
        : {
            status: "completed",
            input: { query: assistant.id },
            output: status === "success" ? "One result" : "Zero hits",
            title: "Search",
            metadata: status === "success" ? {} : { searchFailureType: "no_results" },
            time: { start: 1, end: 2 },
          },
  }
  await Session.updatePart(part)
  ctx.messages = await Session.messages({ sessionID: ctx.sessionID })
  ctx.lastUserParts = ctx.messages.find((message) => message.info.id === ctx.lastUser.id)!.parts
  ctx.step++
  return part
}

async function injectFailure(ctx: LoopJob.Context, marker: string, failure: string) {
  const signals = await LoopJob.detectSignals(ctx)
  expect(signals).toContain("tool_failure_pattern")
  const jobs = LoopJob.collect("pre", ctx, signals).filter((job) => job.type === "tool_failure_pattern_injector")
  expect(jobs).toHaveLength(1)
  await LoopJob.execute(jobs, ctx)
  const parts = await MessageV2.parts({ sessionID: ctx.sessionID, messageID: ctx.lastUser.id })
  const intervention = parts.find(
    (part): part is MessageV2.TextPart => part.type === "text" && part.synthetic === true && part.text.includes(marker),
  )
  expect(intervention?.text).toContain(tool)
  expect(intervention?.text).toContain(failure)
  expect(await LoopJob.detectSignals(ctx)).not.toContain("tool_failure_pattern")
}

for (const status of ["completed", "error"] as const) {
  test(`declared custom tools trigger reflection and early stop: ${status}`, () =>
    withContext(async (ctx) => {
      const first = await appendTool(ctx, status)
      expect(SearchGuard.buildRecord(first)).toBeUndefined()
      expect(await LoopJob.detectSignals(ctx)).not.toContain("tool_failure_pattern")

      await appendTool(ctx, status)
      const failure = status === "completed" ? "no_results" : "timeout"
      await injectFailure(ctx, reflectionMarker, failure)

      await appendTool(ctx, status)
      expect(await LoopJob.detectSignals(ctx)).not.toContain("tool_failure_pattern")
      await appendTool(ctx, status)
      await injectFailure(ctx, earlyStopMarker, failure)
    }))
}

test("undeclared tools do not count toward a custom analyzer threshold", () =>
  withContext(async (ctx) => {
    await appendTool(ctx, "completed")
    await appendTool(ctx, "completed", { tool: "other_search" })
    await appendTool(ctx, "error", { tool: "webfetch" })
    expect(await LoopJob.detectSignals(ctx)).not.toContain("tool_failure_pattern")

    await appendTool(ctx, "error")
    await injectFailure(ctx, reflectionMarker, "no_results")
  }))

test("successful custom tools reset the consecutive failure threshold", () =>
  withContext(async (ctx) => {
    await appendTool(ctx, "completed")
    await appendTool(ctx, "success")
    await appendTool(ctx, "completed")
    expect(await LoopJob.detectSignals(ctx)).not.toContain("tool_failure_pattern")

    await appendTool(ctx, "completed")
    await injectFailure(ctx, reflectionMarker, "no_results")
  }))

test("the analyzer agent filter accepts a matching assistant and rejects unrelated agents", () =>
  withContext(async (ctx) => {
    await appendTool(ctx, "error", { agent: "other-fixture" })
    await appendTool(ctx, "error", { agent: "other-fixture" })
    expect(await LoopJob.detectSignals(ctx)).not.toContain("tool_failure_pattern")

    await appendTool(ctx, "error")
    await injectFailure(ctx, reflectionMarker, "timeout")
  }, "other-fixture"))
