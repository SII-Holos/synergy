import { expect, test } from "bun:test"
import path from "node:path"
import { runtimeHome } from "@ericsanchezok/synergy-harness/test/support/runtime-home"
import { Scope } from "@ericsanchezok/synergy-harness/scope"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { SessionInvoke } from "@ericsanchezok/synergy-harness/session/invoke"
import { openLocalRuntime } from "../src"

for (const workspace of ["project", "none"] as const)
  test(`a real agent worker completes and persists a task with ${workspace} workspace`, async () => {
    await using fixture = await runtimeHome()
    const file = path.join(fixture.host.home, "evidence.txt")
    await Bun.write(file, "isolated evidence")
    let sessionID = ""
    const authorizations: Array<string | null> = []
    using provider = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        authorizations.push(request.headers.get("authorization"))
        const body = (await request.json()) as {
          stream?: boolean
          messages: Array<{ role: string }>
          tools?: Array<{ function: { name: string } }>
        }
        if (!body.stream)
          return Response.json({
            id: "fixture",
            object: "chat.completion",
            created: 0,
            model: "model",
            choices: [{ index: 0, message: { role: "assistant", content: "Done" }, finish_reason: "stop" }],
            usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
          })
        if (workspace === "none") expect(body.tools?.some((tool) => tool.function.name === "read")).toBe(false)
        const tool = !body.messages.some((message) => message.role === "tool")
        const delta = tool
          ? {
              role: "assistant",
              tool_calls: [
                {
                  index: 0,
                  id: "read_evidence",
                  type: "function",
                  function:
                    workspace === "project"
                      ? { name: "read", arguments: JSON.stringify({ filePath: file }) }
                      : {
                          name: "session_read",
                          arguments: JSON.stringify({ target: sessionID, limit: 20, offset: 0 }),
                        },
                },
              ],
            }
          : { role: "assistant", content: "Read isolated evidence" }
        const frames = [
          { choices: [{ index: 0, delta, finish_reason: null }] },
          {
            choices: [{ index: 0, delta: {}, finish_reason: tool ? "tool_calls" : "stop" }],
            usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 },
          },
        ]
        return new Response(
          frames
            .map(
              (frame) =>
                `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 0, model: "model", ...frame })}\n\n`,
            )
            .join("") + "data: [DONE]\n\n",
          { headers: { "content-type": "text/event-stream" } },
        )
      },
    })
    const host = {
      ...fixture.host,
      env: {
        ...fixture.host.env,
        SYNERGY_CONFIG_CONTENT: JSON.stringify({
          model: "fixture/model",
          controlProfile: "full_access",
          execution: { agentWorkers: 1, agentWorkerMinIdle: 0 },
          provider: {
            fixture: {
              name: "Fixture",
              npm: "@ai-sdk/openai-compatible",
              env: [],
              models: { model: { name: "Fixture", tool_call: true, limit: { context: 128000, output: 4096 } } },
              options: { apiKey: "isolated-token", baseURL: provider.url.toString() },
            },
          },
        }),
      },
    }
    await using runtime = await openLocalRuntime({ host, mode: "oneshot" })
    await runtime.run(async () =>
      ScopeContext.provide({
        scope: workspace === "project" ? (await Scope.fromDirectory(fixture.host.home)).scope : Scope.home(),
        fn: async () => {
          const session = await Session.create({ title: "Worker round trip" })
          sessionID = session.id
          const response = await SessionInvoke.invoke({
            sessionID: session.id,
            parts: [{ type: "text", text: "Read the evidence" }],
          })
          expect(response.parts.some((part) => part.type === "text" && part.text === "Read isolated evidence")).toBe(
            true,
          )
          const messages = await Session.messages({ sessionID: session.id })
          const toolPart = messages
            .flatMap((message) => message.parts)
            .find((part) => part.type === "tool" && part.tool === (workspace === "project" ? "read" : "session_read"))
          expect(toolPart?.type === "tool" ? toolPart.state : undefined).toMatchObject({ status: "completed" })
          expect((await Session.get(session.id)).workspace).toEqual(workspace === "project" ? session.workspace : null)
        },
      }),
    )
    expect(authorizations.length).toBeGreaterThan(0)
    expect(authorizations.every((value) => value === "Bearer isolated-token")).toBe(true)
  }, 30_000)
