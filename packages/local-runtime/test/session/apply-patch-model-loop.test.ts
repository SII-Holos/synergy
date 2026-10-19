import { expect, test } from "bun:test"
import path from "node:path"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { SessionInvoke } from "@ericsanchezok/synergy-harness/session/invoke"
import type { MessageV2 } from "@ericsanchezok/synergy-harness/session/message-v2"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import { Log } from "@ericsanchezok/synergy-harness/util/log"
import { testRuntime } from "../support/runtime"

type ProviderMessage = {
  role: string
  tool_call_id?: string
  content?: string | Array<{ type: string; text?: string }>
}

type ProviderRequest = {
  model: string
  stream?: boolean
  messages: ProviderMessage[]
  tools?: Array<{ function: { name: string; parameters: { type?: string; required?: string[] } } }>
}

type FixtureModel = {
  id: string
  name: string
  tool_call: boolean
  limit: { context: number; output: number }
}

function text(message: ProviderMessage) {
  return typeof message.content === "string"
    ? message.content
    : (message.content?.map((part) => part.text ?? "").join("\n") ?? "")
}

function completion(message: Record<string, unknown>, stream: boolean, finishReason: string) {
  const usage = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
  const envelope = { id: crypto.randomUUID(), created: 0, model: "model" }
  if (!stream)
    return Response.json({
      ...envelope,
      object: "chat.completion",
      choices: [{ index: 0, message, finish_reason: finishReason }],
      usage,
    })
  return new Response(
    [
      { choices: [{ index: 0, delta: message, finish_reason: null }] },
      { choices: [{ index: 0, delta: {}, finish_reason: finishReason }], usage },
    ]
      .map((frame) => `data: ${JSON.stringify({ ...envelope, object: "chat.completion.chunk", ...frame })}\n\n`)
      .join("") + "data: [DONE]\n\n",
    { headers: { "content-type": "text/event-stream" } },
  )
}

test("a model moves an observed TSX file, receives a backwards-hunk error, rereads and repairs it", async () => {
  await using tmp = await tmpdir({ git: true })
  const sourcePath = path.join(tmp.path, "source.tsx")
  const destinationPath = path.join(tmp.path, "dest.tsx")
  const source = [
    "export const first = {",
    '    value: "first",',
    "}",
    "",
    "export const last = {",
    '    value: "last",',
    "}",
    "",
    "export const View = () => <span>{first.value}:{last.value}</span>",
    "",
  ].join("\r\n")
  const destination = "export const Existing = () => <p>existing destination</p>\n"
  const moved = source.replace('value: "first"', 'value: "moved"')
  const repaired = moved.replace('value: "moved"', 'value: "first done"').replace('value: "last"', 'value: "last done"')
  await Promise.all([Bun.write(sourcePath, source), Bun.write(destinationPath, destination)])
  const steps = [
    { id: "read_source", name: "read", input: { filePath: sourcePath } },
    { id: "read_existing_destination", name: "read", input: { filePath: destinationPath } },
    {
      id: "move_source",
      name: "apply_patch",
      input: {
        patch: `*** Begin Patch
*** Update File: source.tsx
*** Move to: dest.tsx
@@
-  value: "first",
+    value: "moved",
*** End Patch`,
      },
    },
    {
      id: "reject_backwards",
      name: "apply_patch",
      input: {
        patch: `*** Begin Patch
*** Update File: dest.tsx
@@
-    value: "last",
+    value: "last done",
@@
-    value: "moved",
+    value: "first done",
*** End Patch`,
      },
    },
    { id: "read_after_rejection", name: "read", input: { filePath: destinationPath } },
    {
      id: "repair_in_source_order",
      name: "apply_patch",
      input: {
        patch: `*** Begin Patch
*** Update File: dest.tsx
@@
-    value: "moved",
+    value: "first done",
@@
-    value: "last",
+    value: "last done",
*** End Patch`,
      },
    },
  ]
  const advertised: FixtureModel = {
    id: "model",
    name: "Patch loop fixture",
    tool_call: true,
    limit: { context: 32768, output: 2048 },
  }
  const requests: ProviderRequest[] = []
  const failures: string[] = []
  const reply = "Moved the file and repaired both values after rereading the rejected patch target."
  using provider = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      try {
        const pathname = new URL(request.url).pathname
        if (pathname === "/v1/models") return Response.json({ object: "list", data: [advertised] })
        if (pathname !== "/v1/chat/completions") throw new Error(`Unexpected fixture route: ${pathname}`)
        const body = (await request.json()) as ProviderRequest
        if (!body.tools?.some((tool) => tool.function.name === "apply_patch"))
          return completion({ role: "assistant", content: "Fixture auxiliary response" }, !!body.stream, "stop")
        const index = requests.push(body) - 1
        expect(index).toBeLessThanOrEqual(steps.length)
        expect(body.model).toBe(advertised.id)
        expect(body.tools.map((tool) => tool.function.parameters.type)).toEqual(body.tools.map(() => "object"))
        const delivered = body.messages.filter((message) => message.role === "tool")
        expect(delivered.map((message) => message.tool_call_id)).toEqual(steps.slice(0, index).map((step) => step.id))
        const previous = delivered.at(-1)
        if (index === 1) expect(previous && text(previous)).toContain('value: "first"')
        if (index === 2) expect(previous && text(previous)).toContain("existing destination")
        if (index === 3 || index === 6) expect(previous && text(previous)).toContain("Patch applied.")
        if (index === 4) expect(previous && text(previous)).toMatch(/hunk 2[\s\S]*out-of-order/i)
        if (index === 5) {
          expect(previous && text(previous)).toContain('value: "moved"')
          expect(previous && text(previous)).toContain('value: "last"')
        }
        if (index >= 3) {
          expect(await Bun.file(sourcePath).exists()).toBe(false)
          expect(await Bun.file(destinationPath).bytes()).toEqual(
            new TextEncoder().encode(index === 6 ? repaired : moved),
          )
        }
        const step = steps[index]
        if (!step) return completion({ role: "assistant", content: reply }, !!body.stream, "stop")
        return completion(
          {
            role: "assistant",
            tool_calls: [
              {
                index: 0,
                id: step.id,
                type: "function",
                function: { name: step.name, arguments: JSON.stringify(step.input) },
              },
            ],
          },
          !!body.stream,
          "tool_calls",
        )
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        failures.push(message)
        return Response.json({ error: { message, type: "fixture_protocol_error" } }, { status: 400 })
      }
    },
  })
  const catalog = (await (await fetch(new URL("v1/models", provider.url))).json()) as { data: FixtureModel[] }
  expect(catalog.data).toEqual([advertised])
  const model = catalog.data[0]!
  await using runtime = await testRuntime({
    env: {
      SYNERGY_CONFIG_CONTENT: JSON.stringify({
        fileToolGroup: "patch",
        controlProfile: "full_access",
        model: `fixture/${model.id}`,
        mini_model: `fixture/${model.id}`,
        nano_model: `fixture/${model.id}`,
        compaction: { auto: false },
        provider: {
          fixture: {
            npm: "@ai-sdk/openai-compatible",
            env: [],
            options: { apiKey: "fixture", baseURL: new URL("v1", provider.url).toString() },
            models: { [model.id]: { name: model.name, tool_call: model.tool_call, limit: model.limit } },
          },
        },
        agent: { "patch-fixture": { mode: "primary", model: `fixture/${model.id}` } },
      }),
    },
  })
  await runtime.run(async () => {
    Log.init({ print: false })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const session = await Session.create({ title: "Patch model loop", controlProfile: "full_access" })
        const result = await SessionInvoke.invoke({
          sessionID: session.id,
          agent: "patch-fixture",
          model: { providerID: "fixture", modelID: model.id },
          tools: { "*": false, read: true, apply_patch: true },
          parts: [
            {
              type: "text",
              text: "Read source.tsx and the existing dest.tsx, update the first value and move to dest.tsx, then update both values. Read again and correct any rejected hunk before finishing.",
            },
          ],
        })
        expect(failures).toEqual([])
        expect(requests).toHaveLength(7)
        expect(requests.every((request) => request.stream)).toBe(true)
        expect(
          requests[0].tools?.find((tool) => tool.function.name === "apply_patch")?.function.parameters,
        ).toMatchObject({
          type: "object",
          required: expect.arrayContaining(["patch"]),
        })
        const messages = await Session.messages({ sessionID: session.id })
        const tools = messages
          .flatMap((message) => message.parts)
          .filter((part): part is MessageV2.ToolPart => part.type === "tool")
        expect(tools.map((part) => part.callID)).toEqual(steps.map((step) => step.id))
        expect(new Set(tools.map((part) => part.callID)).size).toBe(steps.length)
        expect(tools.map((part) => part.tool)).toEqual(steps.map((step) => step.name))
        expect(tools.map((part) => part.state.input)).toEqual(steps.map((step) => step.input))
        expect(tools.map((part) => part.state.status)).toEqual([
          "completed",
          "completed",
          "completed",
          "error",
          "completed",
          "completed",
        ])
        const move = tools[2].state
        const rejection = tools[3].state
        const repair = tools[5].state
        if (move.status !== "completed" || rejection.status !== "error" || repair.status !== "completed")
          throw new Error("Expected a completed move, rejected backwards patch and completed repair")
        const moveFiles = [
          expect.objectContaining({
            file: "source.tsx",
            beforeBytes: new TextEncoder().encode(source).length,
            afterBytes: 0,
          }),
          expect.objectContaining({
            file: "dest.tsx",
            beforeBytes: new TextEncoder().encode(destination).length,
            afterBytes: new TextEncoder().encode(moved).length,
          }),
        ]
        expect(move.metadata.files).toHaveLength(2)
        expect(move.metadata.sections[0].files).toHaveLength(2)
        expect(move.metadata).toMatchObject({
          outcome: "applied",
          files: expect.arrayContaining(moveFiles),
          sections: [
            {
              source: "source.tsx",
              destination: "dest.tsx",
              state: "committed",
              phase: "complete",
              operations: [
                { phase: "write", path: "dest.tsx", state: "committed" },
                { phase: "delete", path: "source.tsx", state: "committed" },
              ],
              files: expect.arrayContaining(moveFiles),
            },
          ],
        })
        expect(rejection.error).toMatch(/hunk 2[\s\S]*out-of-order/i)
        expect(rejection.metadata?.files).toEqual([])
        expect(rejection.metadata?.sections[0].files).toEqual([])
        expect(rejection.metadata).toMatchObject({
          outcome: "rejected",
          error: expect.stringMatching(/hunk 2[\s\S]*out-of-order/i),
          files: [],
          sections: [{ source: "dest.tsx", phase: "prepared", state: "not_started", operations: [], files: [] }],
        })
        expect(repair.metadata).toMatchObject({
          outcome: "applied",
          files: [
            {
              file: "dest.tsx",
              beforeBytes: new TextEncoder().encode(moved).length,
              afterBytes: new TextEncoder().encode(repaired).length,
            },
          ],
          sections: [{ source: "dest.tsx", state: "committed", phase: "complete" }],
        })
        expect(await Bun.file(sourcePath).exists()).toBe(false)
        expect(await Bun.file(destinationPath).bytes()).toEqual(new TextEncoder().encode(repaired))
        expect(result.info.role).toBe("assistant")
        if (result.info.role !== "assistant") throw new Error("The turn returned no assistant reply")
        expect(result.info.error).toBeUndefined()
        expect(result.info.time.completed).toBeDefined()
        expect(result.parts).toContainEqual(expect.objectContaining({ type: "text", text: reply }))
      },
    })
  })
}, 60_000)
