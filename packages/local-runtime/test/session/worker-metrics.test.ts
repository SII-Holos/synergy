import { afterAll } from "bun:test"
import { testRuntime } from "../support/runtime"
import { expect, test } from "bun:test"
import { Scope } from "@ericsanchezok/synergy-harness/scope"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { ObservabilityConfig } from "@ericsanchezok/synergy-harness/observability/config"
import { ObservabilityContext } from "@ericsanchezok/synergy-harness/observability/context"
import { ObservabilityStore } from "@ericsanchezok/synergy-harness/observability/store"
import { RolloutContext } from "@ericsanchezok/synergy-harness/session/rollout/context"
import {
  AgentWorkerPool,
  DEFAULT_AGENT_WORKER_POOL_OPTIONS,
} from "@ericsanchezok/synergy-harness/session/agent-turn/worker-pool"

const runtime = await testRuntime()

test(
  "real worker fetch metrics retain the owning session and trace",
  runtime.bind(async () => {
    ObservabilityConfig.refresh()
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch() {
        const chunks = [
          {
            id: "response",
            choices: [{ index: 0, delta: { role: "assistant", content: "hello" }, finish_reason: null }],
          },
          {
            id: "response",
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
            usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 },
          },
        ]
        return new Response(chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n", {
          headers: { "content-type": "text/event-stream" },
        })
      },
    })
    const pool = new AgentWorkerPool({
      ...DEFAULT_AGENT_WORKER_POOL_OPTIONS,
      size: 1,
      minIdle: 1,
      idleBaselineRecycle: false,
    })
    const url = `http://127.0.0.1:${server.port}/v1`
    try {
      for (const suffix of ["first", "second"]) {
        await ScopeContext.provide({
          scope: Scope.home(),
          fn: () =>
            ObservabilityContext.withContextAsync(
              { sessionID: `ses_${suffix}`, traceId: `trace_${suffix}`, messageID: `msg_${suffix}` },
              async () => {
                const stream = await RolloutContext.provide(
                  {
                    owner: { kind: "session", scopeID: Scope.home().id, sessionID: `ses_${suffix}` },
                    runID: `msg_${suffix}`,
                    callID: `call_${suffix}`,
                  },
                  () =>
                    pool.run({
                      abort: new AbortController().signal,
                      sessionID: `ses_${suffix}`,
                      user: { id: `msg_${suffix}` },
                      agent: { name: "synergy" },
                      model: {
                        id: "review-model",
                        providerID: "review-local",
                        api: { id: "review-model", url, npm: "@ai-sdk/openai-compatible" },
                        capabilities: {
                          temperature: true,
                          reasoning: false,
                          attachment: false,
                          toolcall: true,
                          input: { text: true, audio: false, image: false, video: false, pdf: false },
                          output: { text: true, audio: false, image: false, video: false, pdf: false },
                        },
                        limit: { context: 128000, output: 4096 },
                        options: {},
                      },
                      system: [],
                      messages: [{ role: "user", content: "hello" }],
                      toolDefinitions: [],
                      prepared: {
                        system: [],
                        baseSystemLength: 0,
                        provider: {
                          options: { apiKey: "fixture-key", baseURL: url },
                          timeouts: { ttfbMs: 5000, idleMs: false, wallMs: 0 },
                        },
                        params: { options: {} },
                      },
                      archive: async () => {},
                    } as unknown as Parameters<AgentWorkerPool["run"]>[0]),
                )
                try {
                  let answer = ""
                  for await (const event of stream.fullStream) if (event.type === "text-delta") answer += event.text
                  expect(answer).toBe("hello")
                } finally {
                  await stream.dispose()
                }
              },
            ),
        })
      }
      const rows = ObservabilityStore.queryMetrics({ since: 0, names: ["llm.fetch.headers"] })
      expect(rows).toHaveLength(2)
      expect(new Set(rows.map((row) => row.pid)).size).toBe(1)
      expect(rows[0]?.pid).toBeGreaterThan(0)
      expect(rows[0]?.pid).not.toBe(process.pid)
      expect(rows.map((row) => ({ sessionID: row.session_id, traceId: row.trace_id, callID: row.call_id }))).toEqual([
        { sessionID: "ses_first", traceId: "trace_first", callID: "call_first" },
        { sessionID: "ses_second", traceId: "trace_second", callID: "call_second" },
      ])
    } finally {
      await pool.stop()
      await server.stop(true)
    }
  }),
  { timeout: 15000 },
)

afterAll(() => runtime.close())

test(
  "real network watchdogs release the worker after timeouts and cancellation",
  runtime.bind(async () => {
    const { createServer } = await import("node:http")
    const server = createServer(async (request, response) => {
      let body = ""
      for await (const chunk of request) body += chunk
      const { model } = JSON.parse(body) as { model: string }
      const timers: Array<ReturnType<typeof setTimeout>> = []
      response.on("close", () => timers.forEach(clearTimeout))
      const headers = () => {
        response.writeHead(200, { "content-type": "text/event-stream" })
        response.flushHeaders()
      }
      const text = () =>
        response.write(
          `data: ${JSON.stringify({ id: "response", choices: [{ index: 0, delta: { content: "hello" }, finish_reason: null }] })}\n\n`,
        )
      const finish = () =>
        response.end(
          `data: ${JSON.stringify({ id: "response", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 } })}\n\ndata: [DONE]\n\n`,
        )
      if (model === "headers") {
        timers.push(
          setTimeout(() => {
            headers()
            text()
            finish()
          }, 250),
        )
        return
      }
      headers()
      if (model === "body") {
        timers.push(
          setTimeout(() => {
            text()
            finish()
          }, 250),
        )
        return
      }
      text()
      if (model === "wall" || model === "cancel") {
        timers.push(setInterval(() => response.write(": keepalive\n\n"), 10))
        return
      }
      if (model === "idle" || model === "disabled") {
        timers.push(setTimeout(finish, 250))
        return
      }
      finish()
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    const address = server.address()
    if (!address || typeof address === "string") throw new Error("Missing fixture address")
    const url = `http://127.0.0.1:${address.port}/v1`
    const pool = new AgentWorkerPool({
      ...DEFAULT_AGENT_WORKER_POOL_OPTIONS,
      size: 1,
      minIdle: 1,
      idleBaselineRecycle: false,
    })
    const cases = [
      { id: "headers", timeouts: { ttfbMs: 60, idleMs: false as const, wallMs: 1000 }, kind: "ttfb" },
      { id: "body", timeouts: { ttfbMs: 60, idleMs: false as const, wallMs: 1000 }, kind: "ttfb" },
      { id: "idle", timeouts: { ttfbMs: 1000, idleMs: 60, wallMs: 1000 }, kind: "idle" },
      { id: "wall", timeouts: { ttfbMs: 1000, idleMs: 200, wallMs: 100 }, kind: "wall" },
      { id: "disabled", timeouts: { ttfbMs: 1000, idleMs: false as const, wallMs: 0 } },
      { id: "cancel", timeouts: { ttfbMs: 1000, idleMs: false as const, wallMs: 0 } },
      { id: "recovered", timeouts: { ttfbMs: 1000, idleMs: 200, wallMs: 1000 } },
    ]
    try {
      for (const item of cases) {
        await ScopeContext.provide({
          scope: Scope.home(),
          fn: () =>
            ObservabilityContext.withContextAsync(
              { traceId: `trace_${item.id}`, callID: `call_${item.id}` },
              async () => {
                const abort = new AbortController()
                const stream = await pool.run({
                  abort: abort.signal,
                  sessionID: `ses_${item.id}`,
                  user: { id: `msg_${item.id}` },
                  agent: { name: "synergy" },
                  model: {
                    id: item.id,
                    providerID: "network-fixture",
                    api: { id: item.id, url, npm: "@ai-sdk/openai-compatible" },
                    capabilities: {
                      temperature: false,
                      reasoning: false,
                      attachment: false,
                      toolcall: true,
                      input: { text: true },
                      output: { text: true },
                    },
                    limit: { context: 4096, output: 128 },
                    options: {},
                  },
                  system: [],
                  messages: [{ role: "user", content: "hello" }],
                  toolDefinitions: [],
                  prepared: {
                    system: [],
                    baseSystemLength: 0,
                    provider: { options: { apiKey: "fixture", baseURL: url }, timeouts: item.timeouts },
                    params: { options: {} },
                  },
                  archive: async () => {},
                } as unknown as Parameters<AgentWorkerPool["run"]>[0])
                let failure: unknown
                let answer = ""
                const cancelTimer =
                  item.id === "cancel"
                    ? setInterval(() => {
                        if (
                          ObservabilityStore.queryMetrics({
                            since: 0,
                            sessionID: "ses_cancel",
                            names: ["llm.fetch.first_byte"],
                          }).length
                        ) {
                          abort.abort(new DOMException("Fixture cancellation", "AbortError"))
                        }
                      }, 10)
                    : undefined
                try {
                  for await (const event of stream.fullStream) {
                    if (event.type === "error") failure = event.error
                    if (event.type === "text-delta") {
                      answer += event.text
                    }
                  }
                } catch (error) {
                  failure = error
                } finally {
                  clearInterval(cancelTimer)
                  await stream.dispose()
                }
                if (item.kind || item.id === "cancel") expect(failure ?? abort.signal.reason).toBeDefined()
                else {
                  expect(failure).toBeUndefined()
                  expect(answer).toBe("hello")
                }
                const rows = ObservabilityStore.queryMetrics({ since: 0, sessionID: `ses_${item.id}` })
                const fired = rows.filter((row) => row.name === "llm.watchdog.fired")
                expect(fired.map((row) => JSON.parse(row.labels_json).kind)).toEqual(item.kind ? [item.kind] : [])
                for (const row of rows.filter((row) => row.name.startsWith("llm."))) {
                  expect(row.trace_id).toBe(`trace_${item.id}`)
                  expect(row.call_id).toBe(`call_${item.id}`)
                  expect(JSON.parse(row.labels_json).model).toBe(item.id)
                }
                if (item.id === "body") {
                  expect(rows.some((row) => row.name === "llm.fetch.headers")).toBe(true)
                  expect(rows.some((row) => row.name === "llm.fetch.first_byte")).toBe(false)
                }
              },
            ),
        })
      }
      const rows = ObservabilityStore.queryMetrics({
        since: 0,
        names: ["llm.fetch.headers"],
        providerID: "network-fixture",
      })
      expect(new Set(rows.map((row) => row.pid)).size).toBe(1)
    } finally {
      await pool.stop()
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()))
        server.closeAllConnections()
      })
    }
  }),
  30_000,
)
