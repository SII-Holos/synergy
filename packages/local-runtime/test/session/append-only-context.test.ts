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
  "final provider requests retain context across tool steps, changed state and a new invocation",
  () =>
    runtime.run(async () => {
      const requests: { messages: unknown[]; tools: unknown[] }[] = []
      const first = Promise.withResolvers<void>()
      const release = Promise.withResolvers<void>()
      let filePath = ""
      const server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        async fetch(request) {
          const body = (await request.json()) as { messages: unknown[]; tools: unknown[] }
          const index = body.tools?.length ? requests.push(body) - 1 : 3
          if (index === 0) {
            first.resolve()
            await release.promise
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
          return new Response(
            [
              { id: `response_${index}`, choices: [{ index: 0, delta, finish_reason: null }] },
              {
                id: `response_${index}`,
                choices: [{ index: 0, delta: {}, finish_reason: tool ? "tool_calls" : "stop" }],
                usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 },
              },
            ]
              .map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`)
              .join("") + "data: [DONE]\n\n",
            { headers: { "content-type": "text/event-stream" } },
          )
        },
      })
      try {
        await using tmp = await tmpdir({
          git: true,
          config: {
            model: "prefix/model",
            compaction: { auto: false },
            provider: {
              prefix: {
                npm: "@ai-sdk/openai-compatible",
                env: [],
                options: { apiKey: "fixture", baseURL: `http://127.0.0.1:${server.port}/v1` },
                models: { model: { name: "Prefix", tool_call: true, limit: { context: 128000, output: 4096 } } },
              },
            },
            agent: { "prefix-agent": { mode: "primary", model: "prefix/model" } },
          },
        })
        filePath = tmp.path + "/fixture.txt"
        await Bun.write(filePath, "stable tool output")
        await ScopeContext.provide({
          scope: await tmp.scope(),
          fn: async () => {
            const session = await Session.create({ title: "Original title", controlProfile: "full_access" })
            const root = await createUserMessage({
              sessionID: session.id,
              agent: "prefix-agent",
              metadata: { promptContext: { version: 999 } },
              parts: [{ type: "text", text: "Read the fixture twice, then finish." }],
            })
            expect(root.info.metadata?.promptContext).toBeUndefined()
            const loop = SessionInvoke.loop.force(session.id)
            try {
              await first.promise
              await Session.update(session.id, (draft) => {
                draft.title = "Changed title"
              })
              release.resolve()
              await loop
              expect(requests).toHaveLength(3)
              for (let index = 1; index < requests.length; index++) {
                expect(requests[index].messages.slice(0, requests[index - 1].messages.length)).toEqual(
                  requests[index - 1].messages,
                )
                expect(requests[index].tools).toEqual(requests[0].tools)
              }
              expect(JSON.stringify(requests[0].messages)).toContain("Original title")
              expect(JSON.stringify(requests[1].messages)).toContain("Changed title")
              const messages = await Session.messages({ sessionID: session.id })
              const contexts = messages.filter(
                (m) => m.info.role === "user" && m.info.origin?.detail === "context_update",
              )
              expect(contexts).toHaveLength(2)
              expect(contexts.every((m) => m.info.visible === false && m.info.includeInContext === true)).toBe(true)
              expect(messages.flatMap((m) => m.parts).filter((p) => p.type === "tool")).toHaveLength(2)
              await createUserMessage({
                sessionID: session.id,
                agent: "prefix-agent",
                parts: [{ type: "text", text: "Continue from the saved conversation." }],
              })
              await SessionInvoke.loop.force(session.id)
              expect(requests).toHaveLength(4)
              expect(requests[3].messages.slice(0, requests[2].messages.length)).toEqual(requests[2].messages)
            } finally {
              release.resolve()
              await loop
            }
          },
        })
      } finally {
        release.resolve()
        await server.stop(true)
      }
    }),
  { timeout: 60000 },
)
