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
  "replays interleaved reasoning_content on the wire after a tool call",
  () =>
    runtime.run(async () => {
      const requests: Array<{ messages?: Array<Record<string, unknown>>; tools?: unknown[] }> = []
      let filePath = ""
      const server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        async fetch(request) {
          const body = (await request.json()) as (typeof requests)[number]
          if (!body.tools?.length) {
            return Response.json({
              id: "title",
              choices: [{ index: 0, message: { role: "assistant", content: "Title" }, finish_reason: "stop" }],
            })
          }
          const index = requests.push(body) - 1
          const delta =
            index === 0
              ? {
                  role: "assistant",
                  reasoning_content: "Read the fixture before answering.",
                  tool_calls: [
                    {
                      index: 0,
                      id: "call_read",
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
              choices: [{ index: 0, delta: {}, finish_reason: index === 0 ? "tool_calls" : "stop" }],
              usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
            },
          ]
          return new Response(
            chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n",
            { headers: { "content-type": "text/event-stream" } },
          )
        },
      })
      try {
        await using tmp = await tmpdir({
          git: true,
          config: {
            model: "thinking/model",
            compaction: { auto: false },
            provider: {
              thinking: {
                npm: "@ai-sdk/openai-compatible",
                env: [],
                options: { apiKey: "fixture", baseURL: `http://127.0.0.1:${server.port}/v1` },
                models: {
                  model: {
                    name: "Thinking",
                    tool_call: true,
                    reasoning: true,
                    interleaved: { field: "reasoning_content" },
                    limit: { context: 128000, output: 4096 },
                  },
                },
              },
            },
            agent: { "thinking-agent": { mode: "primary", model: "thinking/model" } },
          },
        })
        filePath = tmp.path + "/fixture.txt"
        await Bun.write(filePath, "reasoning fixture")
        await ScopeContext.provide({
          scope: await tmp.scope(),
          fn: async () => {
            const session = await Session.create({ title: "Reasoning replay", controlProfile: "full_access" })
            await createUserMessage({
              sessionID: session.id,
              agent: "thinking-agent",
              summary: { title: "Reasoning replay" },
              parts: [{ type: "text", text: "Read the fixture, then finish." }],
            })
            await SessionInvoke.loop.force(session.id)
            expect(requests).toHaveLength(2)
            const replayed = requests[1].messages?.find(
              (message) => message.role === "assistant" && Array.isArray(message.tool_calls),
            )
            expect(replayed?.reasoning_content).toBe("Read the fixture before answering.")
          },
        })
      } finally {
        await server.stop(true)
      }
    }),
  { timeout: 60000 },
)
