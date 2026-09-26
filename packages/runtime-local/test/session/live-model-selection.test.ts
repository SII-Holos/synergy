import { afterAll, expect, test } from "bun:test"
import { testRuntime } from "../support/runtime"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { createUserMessage } from "@ericsanchezok/synergy-harness/session/input"
import { SessionInvoke } from "@ericsanchezok/synergy-harness/session/invoke"
import { Log } from "@ericsanchezok/synergy-harness/util/log"

const runtime = await testRuntime()
afterAll(() => runtime.close())
runtime.run(() => Log.init({ print: false }))

test(
  "live model and effort changes reach the next real request without replaying tools",
  () =>
    runtime.run(async () => {
      const received = [Promise.withResolvers<void>(), Promise.withResolvers<void>()]
      const release = [Promise.withResolvers<void>(), Promise.withResolvers<void>()]
      const requests: Record<string, unknown>[] = []
      let filePath = ""
      const server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        async fetch(request) {
          const body = (await request.json()) as Record<string, unknown>
          const index = requests.push(body) - 1
          if (index < 2) {
            received[index].resolve()
            await release[index].promise
          }
          const tool = index < 2
          const delta = tool
            ? {
                role: "assistant",
                tool_calls: [
                  {
                    index: 0,
                    id: `call_${index}`,
                    type: "function",
                    function: { name: "read", arguments: JSON.stringify({ filePath }) },
                  },
                ],
              }
            : { role: "assistant", content: "Done" }
          const chunks = [
            { id: `response_${index}`, choices: [{ index: 0, delta, finish_reason: null }] },
            {
              id: `response_${index}`,
              choices: [{ index: 0, delta: {}, finish_reason: tool ? "tool_calls" : "stop" }],
              usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
            },
          ]
          return new Response(
            chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n",
            {
              headers: { "content-type": "text/event-stream" },
            },
          )
        },
      })
      try {
        await using tmp = await tmpdir({
          git: true,
          config: {
            model: "selection/a",
            compaction: { auto: false },
            provider: {
              selection: {
                npm: "@ai-sdk/openai-compatible",
                env: [],
                options: { apiKey: "fixture", baseURL: `http://127.0.0.1:${server.port}/v1` },
                models: {
                  a: {
                    name: "A",
                    tool_call: true,
                    limit: { context: 128000, output: 4096 },
                    variants: { high: { reasoningEffort: "high" } },
                  },
                  b: {
                    name: "B",
                    tool_call: true,
                    limit: { context: 64000, output: 2048 },
                    variants: { low: { reasoningEffort: "low" } },
                  },
                },
              },
            },
            agent: { "selection-agent": { mode: "primary", model: "selection/a" } },
          },
        })
        filePath = tmp.path + "/fixture.txt"
        await Bun.write(filePath, "selection fixture")
        await ScopeContext.provide({
          scope: await tmp.scope(),
          fn: async () => {
            const session = await Session.create({
              title: "Model selection integration",
              controlProfile: "full_access",
            })
            const a = { providerID: "selection", modelID: "a" }
            const b = { providerID: "selection", modelID: "b" }
            await Session.setModelSelection(session.id, { model: a, thinking: { mode: "variant", variant: "high" } })
            await createUserMessage({
              sessionID: session.id,
              agent: "selection-agent",
              parts: [{ type: "text", text: "Read the fixture twice, then finish." }],
            })
            const loop = SessionInvoke.loop.force(session.id)
            try {
              await received[0].promise
              await Session.setModelSelection(session.id, { model: b, thinking: { mode: "variant", variant: "low" } })
              release[0].resolve()
              await received[1].promise
              await Session.setModelSelection(session.id, { model: a })
              release[1].resolve()
              await loop
              expect(requests.map((request) => [request.model, request.reasoning_effort])).toEqual([
                ["a", "high"],
                ["b", "low"],
                ["a", "high"],
              ])
              const messages = await Session.messages({ sessionID: session.id })
              const tools = messages.flatMap((message) => message.parts).filter((part) => part.type === "tool")
              expect(tools).toHaveLength(2)
              expect(tools.map((part) => part.state.status)).toEqual(["completed", "completed"])
              expect(
                messages
                  .filter((message) => message.info.role === "assistant")
                  .map((message) =>
                    message.info.role === "assistant" ? message.info.modelSelection?.model.modelID : undefined,
                  ),
              ).toEqual(["a", "b", "a"])
              expect((await Session.get(session.id)).modelSelection?.pendingReason).toBeUndefined()
            } finally {
              release.forEach((gate) => gate.resolve())
            }
          },
        })
      } finally {
        release.forEach((gate) => gate.resolve())
        await server.stop(true)
      }
    }),
  { timeout: 60000 },
)
