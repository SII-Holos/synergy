import { describe, expect, test } from "bun:test"
import path from "path"
import { afterAll as afterRuntimeTests } from "bun:test"
import { testRuntime } from "../support/runtime"
const runtime = await testRuntime()

const { GlobalBus } = await import("@ericsanchezok/synergy-harness/bus/global")
const { Scope } = await import("@ericsanchezok/synergy-harness/scope")
const { ScopeContext } = await import("@ericsanchezok/synergy-harness/scope/context")
const { Server } = await import("../../src/server/server")
const { Session } = await import("@ericsanchezok/synergy-harness/session")
const { MessageV2 } = await import("@ericsanchezok/synergy-harness/session/message-v2")
const { Log } = await import("@ericsanchezok/synergy-harness/util/log")

const projectRoot = path.join(__dirname, "../..")
runtime.run(() => Log.init({ print: false }))

describe("session summarize route", () => {
  test("publishes a canonical compaction boundary root for event-driven sync", () =>
    runtime.run(async () => {
      const scope = (await Scope.fromDirectory(projectRoot)).scope

      await ScopeContext.provide({
        scope,
        fn: async () => {
          const session = await Session.create({ title: "Compaction event test" })
          const messages: any[] = []
          const handler = (event: { scopeID: string | null; payload: any }) => {
            if (event.scopeID !== scope.id) return
            if (event.payload?.type !== "message.updated") return
            messages.push(event.payload.properties.info)
          }

          GlobalBus().on("event", handler)
          try {
            const app = Server.App()
            const response = await app.request(`/session/${session.id}/summarize`, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "x-synergy-directory": scope.local!.directory,
              },
              body: JSON.stringify({
                providerID: "test-provider",
                modelID: "test-model",
              }),
            })

            // The test intentionally uses a fake provider/model. The loop may
            // fail after the boundary is written, but event-driven sync relies
            // on the boundary's earlier message.updated payload.
            expect([200, 400, 500]).toContain(response.status)

            const boundary = messages.find(
              (message) =>
                message.sessionID === session.id &&
                message.role === "user" &&
                message.metadata?.compactionBoundary === true,
            )

            expect(boundary).toBeDefined()
            expect(boundary).toMatchObject({
              isRoot: true,
              rootID: boundary.id,
              visible: true,
            })
          } finally {
            GlobalBus().off("event", handler)
            await Session.remove(session.id)
          }
        },
      })
    }))
})

test("repeated empty summarize requests settle without manufacturing history and retain later user input", async () => {
  const summaries: string[] = []
  using provider = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const input = (await request.json()) as { messages: unknown[]; stream?: boolean }
      const prompt = JSON.stringify(input.messages)
      if (prompt.includes("Write the compaction continuation summary now.")) summaries.push(prompt)
      const usage = { prompt_tokens: 100, completion_tokens: 2, total_tokens: 102 }
      if (!input.stream)
        return Response.json({
          id: "fixture",
          object: "chat.completion",
          created: 0,
          model: "model",
          choices: [{ index: 0, message: { role: "assistant", content: "None." }, finish_reason: "stop" }],
          usage,
        })
      return new Response(
        [
          {
            id: "fixture",
            object: "chat.completion.chunk",
            created: 0,
            model: "model",
            choices: [{ index: 0, delta: { role: "assistant", content: "None." }, finish_reason: null }],
          },
          {
            id: "fixture",
            object: "chat.completion.chunk",
            created: 0,
            model: "model",
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
            usage,
          },
        ]
          .map((frame) => `data: ${JSON.stringify(frame)}\n\n`)
          .join("") + "data: [DONE]\n\n",
        {
          headers: { "content-type": "text/event-stream" },
        },
      )
    },
  })
  await using instance = await testRuntime({
    SYNERGY_CONFIG_CONTENT: JSON.stringify({
      model: "fixture/model",
      default_agent: "fixture",
      compaction: { auto: true, prune: false, codexRemote: false },
      agent: { fixture: { mode: "all", prompt: "Preserve the task's evidence.", permission: { "*": "allow" } } },
      provider: {
        fixture: {
          npm: "@ai-sdk/openai-compatible",
          options: { baseURL: provider.url.toString(), apiKey: "synthetic-key" },
          models: { model: { name: "Fixture", tool_call: true, limit: { context: 65_536, output: 8_192 } } },
        },
      },
    }),
  })
  await instance.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      async fn() {
        const session = await Session.create({ workspace: null, title: "Repeated empty compaction" })
        const app = Server.App()
        const summarize = () =>
          app.request(`/session/${session.id}/summarize?scopeID=home`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ providerID: "fixture", modelID: "model", auto: false }),
          })
        const read = async () => {
          const response = await app.request(`/session/${session.id}/message?scopeID=home&raw=true`)
          expect(response.status).toBe(200)
          return MessageV2.WithParts.array().parse(await response.json())
        }
        try {
          expect((await summarize()).status).toBe(200)
          const first = await read()
          expect((await summarize()).status).toBe(200)
          const repeated = await read()
          expect(summaries).toHaveLength(0)
          expect(repeated).toHaveLength(4)
          expect(repeated.slice(0, 2)).toEqual(first)
          for (const message of repeated) {
            if (message.info.role === "user") {
              expect(message.info).toMatchObject({ includeInContext: false, metadata: { compactionBoundary: true } })
              expect(message.parts.some((part) => part.type === "text" && part.text === "What did we do so far?")).toBe(
                true,
              )
              expect(message.info.metadata?.compactionNoopRequests).toEqual(
                message.parts.filter((part) => part.type === "compaction").map((part) => part.id),
              )
            } else {
              expect(message.info).toMatchObject({
                finish: "stop",
                includeInContext: false,
                metadata: { compactionAttempt: { state: "empty", reason: "no-history" } },
              })
              expect(message.info.summary).toBeUndefined()
              expect(message.info.compaction).toBeUndefined()
            }
          }
          const text = `real-user-evidence ${"retain observed constraints ".repeat(100)}`
          const added = await app.request(`/session/${session.id}/message?scopeID=home`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              agent: "fixture",
              model: { providerID: "fixture", modelID: "model" },
              noReply: true,
              parts: [{ type: "text", text }],
            }),
          })
          expect(added.status).toBe(200)
          expect((await summarize()).status).toBe(200)
          expect(summaries).toHaveLength(1)
          expect(summaries[0]).toContain(text)
          const retained = await read()
          const human = retained.find((message) =>
            message.parts.some((part) => part.type === "text" && part.text === text),
          )!
          expect(human.info.includeInContext).not.toBe(false)
          expect(human.info.metadata?.compactionBoundary).not.toBe(true)
          expect(retained.some((message) => message.info.role === "assistant" && message.info.summary)).toBe(true)
        } finally {
          await Session.remove(session.id)
        }
      },
    }),
  )
}, 20_000)

afterRuntimeTests(() => runtime.close())
