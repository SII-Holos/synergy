import { afterAll as afterRuntimeTests } from "bun:test"
import { testRuntime } from "../support/runtime"
const runtime = await testRuntime()
import { Provider } from "../../src/provider/provider"
import { afterEach, expect, mock, spyOn, test } from "bun:test"
import { z } from "zod"
import { Identifier } from "../../src/id/id"
import { ScopeContext } from "../../src/scope/context"
import { Session } from "../../src/session"
import { createUserMessage } from "../../src/session/input"
import { AgentTurn } from "../../src/session/agent-turn"
import { MessageV2 } from "../../src/session/message-v2"
import { SessionProcessor } from "../../src/session/processor"
import { SessionRetry } from "../../src/session/retry"
import { RolloutCall } from "../../src/session/rollout/call"
import { RolloutLedger } from "../../src/session/rollout/ledger"
import { RolloutArtifact } from "../../src/session/rollout/artifact"
import { ToolScheduler } from "../../src/session/tool-scheduler"
import { ObservabilityMetrics } from "../../src/observability/metrics"
import { tmpdir } from "../support/fixture"

afterEach(
  runtime.bind(async () => {
    mock.restore()
    await ToolScheduler.stop()
    ToolScheduler.configure()
  }),
)

function testModel(): Provider.Model {
  return {
    id: "test-model",
    providerID: "test",
    api: { id: "test-model", url: "https://example.invalid", npm: "@ai-sdk/openai-compatible" },
    name: "Test Model",
    capabilities: {
      temperature: false,
      reasoning: false,
      attachment: false,
      toolcall: true,
      input: { text: true, audio: false, image: false, video: false, pdf: false },
      output: { text: true, audio: false, image: false, video: false, pdf: false },
      interleaved: false,
    },
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    limit: { context: 128_000, output: 4_096 },
    status: "active",
    options: {},
    headers: {},
    release_date: "2026-01-01",
    family: "test",
  }
}

const testUsage = { inputTokens: 1, outputTokens: 0, totalTokens: 1 }

async function run(
  mode:
    | "stream"
    | "dispatch"
    | "exhausted"
    | "reused"
    | "cancel"
    | "tls"
    | "empty"
    | "empty-then-text"
    | "reasoning-only"
    | "tools"
    | "tools-stop"
    | "length",
) {
  await using tmp = await tmpdir({ git: true })
  return ScopeContext.provide({
    scope: await tmp.scope(),
    fn: async () => {
      const session = await Session.create({})
      const user = await createUserMessage({
        sessionID: session.id,
        model: { providerID: "test", modelID: "test-model" },
        parts: [{ type: "text", text: "run a tool" }],
      })
      const assistant: MessageV2.Assistant = {
        id: Identifier.ascending("message"),
        sessionID: session.id,
        role: "assistant",
        time: { created: Date.now() },
        parentID: user.info.id,
        rootID: user.info.id,
        modelID: "test-model",
        providerID: "test",
        mode: "test",
        agent: "synergy",
        path: { cwd: ScopeContext.current.directory, root: ScopeContext.current.directory },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      }
      await Session.updateMessage(assistant)
      const abort = new AbortController()
      const processor = SessionProcessor.create({
        assistantMessage: assistant,
        sessionID: session.id,
        model: testModel(),
        abort: abort.signal,
      })
      let calls = 0
      let effects = 0
      let disposed = 0
      spyOn(SessionRetry, "delay").mockReturnValue(0)
      if (mode === "cancel")
        spyOn(SessionRetry, "sleep").mockImplementation(async () => {
          abort.abort()
          throw abort.signal.reason
        })
      const owner = { kind: "session" as const, scopeID: ScopeContext.current.scope.id, sessionID: session.id }
      spyOn(AgentTurn, "stream").mockImplementation(async () => {
        const attempt = ++calls
        return RolloutCall.stream(
          {
            owner,
            runID: user.info.id,
            purpose: "test",
            request: {},
            model: { providerID: "test", modelID: "test-model", sdk: "test", pricing: null },
          },
          async () => ({
            fullStream: (async function* () {
              if (mode === "empty" || mode === "empty-then-text" || mode === "reasoning-only" || mode === "length") {
                yield { type: "start-step" as const }
                if (mode === "empty-then-text") {
                  yield { type: "text-start" as const, id: "text" }
                  if (attempt > 1) yield { type: "text-delta" as const, id: "text", text: "recovered answer" }
                  yield { type: "text-end" as const, id: "text" }
                }
                if (mode === "reasoning-only") {
                  yield { type: "reasoning-start" as const, id: "reasoning" }
                  yield { type: "reasoning-delta" as const, id: "reasoning", text: "internal deliberation" }
                  yield { type: "reasoning-end" as const, id: "reasoning" }
                }
                yield {
                  type: "finish-step" as const,
                  finishReason: mode === "length" ? "length" : "stop",
                  usage: testUsage,
                }
                yield { type: "finish" as const }
                return
              }
              if (mode === "tools" || mode === "tools-stop") {
                yield { type: "start-step" as const }
                yield {
                  type: "tool-call" as const,
                  toolCallId: `call-${attempt}`,
                  toolName: "probe",
                  input: { attempt },
                }
                yield {
                  type: "finish-step" as const,
                  finishReason: mode === "tools-stop" ? "stop" : "tool-calls",
                  usage: testUsage,
                }
                yield { type: "finish" as const }
                return
              }
              const failed =
                ((mode === "stream" || mode === "reused" || mode === "cancel") && attempt === 1) ||
                mode === "exhausted" ||
                mode === "tls"
              yield { type: "text-start" as const, id: "text" }
              yield {
                type: "text-delta" as const,
                id: "text",
                text: failed ? "discard this partial answer" : "valid answer",
              }
              yield { type: "reasoning-start" as const, id: "reasoning" }
              yield {
                type: "reasoning-delta" as const,
                id: "reasoning",
                text: failed ? "discard this reasoning" : "valid reasoning",
              }
              if (!failed) {
                yield { type: "text-end" as const, id: "text" }
                yield { type: "reasoning-end" as const, id: "reasoning" }
              }
              yield {
                type: "tool-call" as const,
                toolCallId: mode === "reused" ? "same-call" : `call-${attempt}`,
                toolName: "probe",
                input: { attempt },
              }
              if (failed) {
                yield {
                  type: "error" as const,
                  error:
                    mode === "tls"
                      ? new Error("unknown certificate verification error")
                      : Object.assign(new TypeError("getaddrinfo ETIMEOUT example.invalid"), { code: "ETIMEOUT" }),
                }
              }
            })(),
            usage: Promise.resolve(undefined),
            async dispose() {
              disposed++
            },
          }),
        )
      })
      if (mode === "dispatch") {
        const dispatch = ToolScheduler.dispatch
        let failed = false
        spyOn(ToolScheduler, "dispatch").mockImplementation(async (input) => {
          const result = await dispatch(input)
          if (!failed) {
            failed = true
            throw Object.assign(new Error("post-dispatch failure"), { code: "ECONNRESET" })
          }
          return result
        })
      }
      await processor.process({
        user: user.info,
        sessionID: session.id,
        model: testModel(),
        agent: { name: "synergy", mode: "primary", permission: [], options: {}, native: true },
        system: [],
        messages: [{ role: "user", content: "run a tool" }],
        abort: abort.signal,
        toolDefinitions: [],
        executionTools: {
          probe: {
            inputSchema: z.object({}),
            async execute(input: unknown, options) {
              effects++
              const output = { output: "done", title: "probe", metadata: {} }
              processor.beginExecution(options.toolCallId).complete(input, output)
              return output
            },
          },
        },
        executorKinds: { probe: "control_plane" },
      })
      const recordedCalls = await RolloutLedger.calls(owner, user.info.id)
      const artifacts = await Promise.all(
        recordedCalls.map(async (call) => {
          const chunks: Uint8Array[] = []
          if (call.response) for await (const chunk of RolloutArtifact.read(owner, call.response.id)) chunks.push(chunk)
          return Buffer.concat(chunks).toString()
        }),
      )
      return {
        recordedCalls,
        artifacts,
        calls,
        effects,
        disposed,
        message: await MessageV2.get({ sessionID: session.id, messageID: assistant.id }),
      }
    },
  })
}

test(
  "a failed provider stream cannot execute its proposed tool, and recovery executes once",
  runtime.bind(async () => {
    const result = await run("stream")
    expect(result.calls).toBe(2)
    expect(result.effects).toBe(1)
    expect(result.disposed).toBe(2)
    expect(
      result.message.parts
        .filter((part) => part.type === "tool")
        .map((part) => part.state.status)
        .sort(),
    ).toEqual(["completed"])
  }),
)

test(
  "a failure after tool dispatch never replays the model or side effect",
  runtime.bind(async () => {
    const result = await run("dispatch")
    expect(result.calls).toBe(1)
    expect(result.effects).toBe(1)
    expect(result.message.info).toMatchObject({ finish: "error" })
  }),
)

test(
  "provider retries stop at the attempt budget and persist a terminal failure",
  runtime.bind(async () => {
    const result = await run("exhausted")
    expect(result.calls).toBe(1 + SessionRetry.RETRY_MAX_ATTEMPTS)
    expect(result.effects).toBe(0)
    expect(result.disposed).toBe(result.calls)
    expect(result.message.info).toMatchObject({ finish: "error", error: { name: "APIError" } })
  }),
)

test(
  "retry removes incomplete content from persisted history and the next model context",
  runtime.bind(async () => {
    const result = await run("stream")
    expect(result.message.parts.filter((part) => part.type === "text").map((part) => part.text)).toEqual([
      "valid answer",
    ])
    expect(result.message.parts.filter((part) => part.type === "reasoning").map((part) => part.text)).toEqual([
      "valid reasoning",
    ])
    expect(JSON.stringify(MessageV2.projectModelMessages([result.message]).messages)).not.toContain("discard this")
  }),
)

test(
  "provider call IDs reused on retry execute the recovered input once",
  runtime.bind(async () => {
    const result = await run("reused")
    expect(result.calls).toBe(2)
    expect(result.effects).toBe(1)
    const tools = result.message.parts.filter((part) => part.type === "tool")
    expect(tools).toHaveLength(1)
    expect(tools[0]?.state).toMatchObject({ status: "completed", input: { attempt: 2 } })
  }),
)

test(
  "withdrawn retry output remains in the authoritative call records",
  runtime.bind(async () => {
    const result = await run("stream")
    expect(result.recordedCalls.map((call) => call.status)).toEqual(["failed", "completed"])
    expect(result.artifacts[0]).toContain("discard this partial answer")
    expect(result.artifacts[1]).toContain("valid answer")
    if (result.message.info.role !== "assistant") throw new Error("Expected an assistant message")
    expect(result.message.info.accounting).toMatchObject({
      kind: "rollout",
      callIDs: result.recordedCalls.map((call) => call.id),
    })
  }),
)

test(
  "cancelling before retry keeps the final partial output and starts no new attempt",
  runtime.bind(async () => {
    const result = await run("cancel")
    expect(result.calls).toBe(1)
    expect(result.effects).toBe(0)
    expect(result.message.info).toMatchObject({ finish: "error", error: { name: "MessageAbortedError" } })
    expect(result.message.parts.filter((part) => part.type === "text").map((part) => part.text)).toEqual([
      "discard this partial answer",
    ])
  }),
)

// The reported incident: a Cortex run failed on Bun's unmapped BoringSSL fallback string
// (unknown certificate verification error) and was treated as terminal after one attempt.
test(
  "an unmapped certificate verification failure retries within a bounded budget and persists evidence",
  runtime.bind(async () => {
    const result = await run("tls")
    expect(result.calls).toBe(1 + SessionRetry.RETRY_TLS_VERIFICATION_MAX_ATTEMPTS)
    expect(result.calls).toBe(7)
    expect(result.effects).toBe(0)
    expect(result.message.info).toMatchObject({
      finish: "error",
      error: {
        name: "APIError",
        data: {
          isRetryable: true,
          metadata: {
            networkKind: "indeterminate",
            category: "tls-verification",
            endpointHost: "example.invalid",
          },
        },
      },
    })
  }),
)

test(
  "keeps the full budget for a classified transport failure",
  runtime.bind(async () => {
    const result = await run("exhausted")
    expect(result.calls).toBe(1 + SessionRetry.RETRY_MAX_ATTEMPTS)
    expect(result.calls).toBeGreaterThan(1 + SessionRetry.RETRY_TLS_VERIFICATION_MAX_ATTEMPTS)
  }),
)

// Provider-level baseURL is the standard proxy configuration (postmortem 0017):
// the persisted endpoint host must come from the merged connection identity,
// not the model catalog URL.
test(
  "derives endpointHost from provider-level baseURL when the provider is proxied",
  runtime.bind(async () => {
    const getProvider = spyOn(Provider, "getProvider").mockResolvedValue({
      options: { baseURL: "https://gateway.example.test" },
    } as never)
    try {
      const result = await run("tls")
      expect(result.message.info).toMatchObject({
        finish: "error",
        error: {
          data: {
            metadata: {
              endpointHost: "gateway.example.test",
            },
          },
        },
      })
    } finally {
      getProvider.mockRestore()
    }
  }),
)

// The reported incident: a provider completed a turn with `finishReason: "stop"`
// but streamed no text and called no tool, so the turn succeeded invisibly.
test(
  "a response that completes with no text and no tool calls retries as empty_response",
  runtime.bind(async () => {
    const result = await run("empty")
    expect(result.calls).toBe(1 + SessionRetry.RETRY_MAX_ATTEMPTS)
    expect(result.message.info).toMatchObject({
      finish: "error",
      error: {
        name: "APIError",
        data: { isRetryable: true, metadata: { code: "empty_response" } },
      },
    })
  }),
)

test(
  "an exhausted empty response persists only the terminal error",
  runtime.bind(async () => {
    const result = await run("empty")
    expect(result.message.parts.filter((part) => part.type === "text")).toHaveLength(0)
    expect(result.message.parts.filter((part) => part.type === "tool")).toHaveLength(0)
    if (result.message.info.role !== "assistant") throw new Error("Expected an assistant message")
    expect(result.message.info.finish).toBe("error")
    expect(result.message.info.error?.name).toBe("APIError")
  }),
)

test(
  "a pure tool step is not treated as an empty response",
  runtime.bind(async () => {
    const result = await run("tools")
    expect(result.calls).toBe(1)
    expect(result.effects).toBe(1)
    if (result.message.info.role !== "assistant") throw new Error("Expected an assistant message")
    expect(result.message.info.finish).toBe("tool-calls")
    expect(result.message.info.error).toBeUndefined()
  }),
)

test(
  "an empty response retries and keeps the recovered answer",
  runtime.bind(async () => {
    const result = await run("empty-then-text")
    expect(result.calls).toBe(2)
    expect(result.message.parts.filter((part) => part.type === "text").map((part) => part.text)).toEqual([
      "recovered answer",
    ])
    if (result.message.info.role !== "assistant") throw new Error("Expected an assistant message")
    expect(result.message.info.finish).toBe("stop")
    expect(result.message.info.error).toBeUndefined()
  }),
)

test(
  "a tool call reported with finishReason stop is not treated as an empty response",
  runtime.bind(async () => {
    const result = await run("tools-stop")
    expect(result.calls).toBe(1)
    expect(result.effects).toBe(1)
    if (result.message.info.role !== "assistant") throw new Error("Expected an assistant message")
    expect(result.message.info.finish).toBe("stop")
    expect(result.message.info.error).toBeUndefined()
  }),
)

test(
  "a step that produces only reasoning is treated as an empty response",
  runtime.bind(async () => {
    const result = await run("reasoning-only")
    expect(result.calls).toBe(1 + SessionRetry.RETRY_MAX_ATTEMPTS)
    if (result.message.info.role !== "assistant") throw new Error("Expected an assistant message")
    expect(result.message.info.error).toMatchObject({
      name: "APIError",
      data: { isRetryable: true, metadata: { code: "empty_response" } },
    })
  }),
)

test(
  "a length-limited step is not treated as an empty response",
  runtime.bind(async () => {
    const result = await run("length")
    expect(result.calls).toBe(1)
    if (result.message.info.role !== "assistant") throw new Error("Expected an assistant message")
    expect(result.message.info.finish).toBe("length")
    expect(result.message.info.error).toBeUndefined()
  }),
)

test(
  "records the cached-input token metric alongside the other step tokens",
  runtime.bind(async () => {
    using metrics = spyOn(ObservabilityMetrics, "record")
    const result = await run("tools")
    expect(result.calls).toBe(1)

    const rows = (
      metrics as unknown as {
        mock: { calls: Array<Array<{ name?: string; value?: number; unit?: string }>> }
      }
    ).mock.calls.map((call) => call[0])

    const cached = rows.filter((row) => row.name === "llm.tokens.cached_input")
    expect(cached).toHaveLength(1)
    expect(cached[0].unit).toBe("tokens")
    expect(typeof cached[0].value).toBe("number")
    // Recorded at the same finish-step boundary as the input and output counters,
    // so a cold prefill is distinguishable from a genuine stall.
    expect(rows.filter((row) => row.name === "llm.tokens.input")).toHaveLength(1)
    expect(rows.filter((row) => row.name === "llm.tokens.output")).toHaveLength(1)
  }),
)

afterRuntimeTests(() => runtime.close())
