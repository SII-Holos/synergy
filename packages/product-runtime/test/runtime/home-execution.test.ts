import { expect, test } from "bun:test"
import { ProductRuntimeHandle } from "../../src/server/runtime-handle"
import { openLocalRuntime } from "@ericsanchezok/synergy-runtime-local"
import { runtimeHome } from "@ericsanchezok/synergy-harness/test/support/runtime-home"
import { Scope } from "@ericsanchezok/synergy-harness/scope"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { SessionInvoke } from "@ericsanchezok/synergy-harness/session/invoke"
import { Asset } from "@ericsanchezok/synergy-harness/asset/asset"
import { NoteStore, NoteMarkdown } from "@ericsanchezok/synergy-note"
import { LibraryDB } from "@ericsanchezok/synergy-library/database"

test("Home tasks run in independent core and full workers, and full task data survives restart", async () => {
  await using coreHome = await runtimeHome()
  await using fullHome = await runtimeHome()
  const sessions = new Map<string, string>()
  const requests: Array<{ owner: string; tools: string[] }> = []
  let fetched = 0
  using provider = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      if (new URL(request.url).pathname === "/document") {
        fetched++
        return new Response("A Home task fetched this document without a workspace.", {
          headers: { "content-type": "text/plain" },
        })
      }
      const owner = request.headers.get("authorization")?.replace("Bearer ", "") ?? ""
      const body = (await request.json()) as {
        stream?: boolean
        messages: Array<{ role: string }>
        tools?: Array<{ function: { name: string } }>
      }
      requests.push({ owner, tools: body.tools?.map((tool) => tool.function.name) ?? [] })
      const done = !body.stream || body.messages.some((message) => message.role === "tool")
      const name = owner === "full" ? "note_write" : "webfetch"
      const args =
        owner === "full"
          ? { mode: "create", title: "Home result", content: "Saved by the full worker", scope: "current" }
          : { url: new URL("/document", request.url).toString(), format: "text" }
      const message = done
        ? { role: "assistant", content: `${owner} completed` }
        : {
            role: "assistant",
            tool_calls: [
              { index: 0, id: "home_tool", type: "function", function: { name, arguments: JSON.stringify(args) } },
            ],
          }
      const usage = { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 }
      if (!body.stream)
        return Response.json({
          id: "fixture",
          object: "chat.completion",
          created: 0,
          model: "model",
          choices: [{ index: 0, message, finish_reason: "stop" }],
          usage,
        })
      const frames = [
        { choices: [{ index: 0, delta: message, finish_reason: null }] },
        { choices: [{ index: 0, delta: {}, finish_reason: done ? "stop" : "tool_calls" }], usage },
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
  const host = (fixture: typeof coreHome, owner: string) => ({
    ...fixture.host,
    env: {
      ...fixture.host.env,
      SYNERGY_CONFIG_CONTENT: JSON.stringify({
        model: "fixture/model",
        controlProfile: "full_access",
        execution: { agentWorkers: 1, agentWorkerMinIdle: 0 },
        ...(owner === "full"
          ? { library: { memory: { enabled: false }, experience: { retrieve: false, encode: false }, autonomy: false } }
          : {}),
        provider: {
          fixture: {
            name: "Fixture",
            npm: "@ai-sdk/openai-compatible",
            env: [],
            models: { model: { name: "Fixture", tool_call: true, limit: { context: 128000, output: 4096 } } },
            options: { apiKey: owner, baseURL: provider.url.toString() },
          },
        },
      }),
    },
  })
  await using core = await openLocalRuntime({ host: host(coreHome, "core"), mode: "oneshot" })
  await using full = await ProductRuntimeHandle.openTask({ host: host(fullHome, "full"), mode: "oneshot" })
  const inHome = <T>(runtime: typeof core, body: () => T) =>
    runtime.run(() => ScopeContext.provide({ scope: Scope.home(), fn: body }))
  const run = async (runtime: typeof core, owner: string) =>
    inHome(runtime, async () => {
      const session = await Session.create({ title: `${owner} Home task` })
      sessions.set(owner, session.id)
      const result = await SessionInvoke.invoke({
        sessionID: session.id,
        parts: [{ type: "text", text: "Use the available tool, then finish." }],
      })
      expect(result.parts).toContainEqual(expect.objectContaining({ type: "text", text: `${owner} completed` }))
      const messages = await Session.messages({ sessionID: session.id })
      const tool = messages.flatMap((message) => message.parts).find((part) => part.type === "tool")
      expect(tool?.type === "tool" ? tool.state.status : undefined).toBe("completed")
      expect((await Session.get(session.id)).workspace).toBeNull()
      if (owner === "core") {
        expect(tool?.type === "tool" && tool.state.status === "completed" ? tool.state.output : "").toContain(
          "A Home task fetched this document without a workspace.",
        )
      }
      return tool?.type === "tool" && tool.state.status === "completed" ? tool.state.metadata : undefined
    })
  const [, metadata] = await Promise.all([run(core, "core"), run(full, "full")])
  expect(fetched).toBe(1)
  const noteID = String(metadata?.id)
  const assetID = await full.run(() => Asset.write(Buffer.from("Home artifact"), "text/plain", "result.txt"))
  full.run(() =>
    LibraryDB.Memory.insert(
      {
        id: "home-memory",
        title: "Home memory",
        content: "Remember Home",
        category: "general",
        recallMode: "contextual",
      },
      { id: "vector", model: "fixture", vector: [1, 0] },
    ),
  )
  expect(requests.every((request) => ["core", "full"].includes(request.owner))).toBe(true)
  expect(requests.every((request) => !request.tools.includes("read") && !request.tools.includes("bash"))).toBe(true)
  expect(
    requests.filter((request) => request.owner === "core").every((request) => !request.tools.includes("note_write")),
  ).toBe(true)
  expect(requests.some((request) => request.owner === "full" && request.tools.includes("note_write"))).toBe(true)
  await core.close()
  expect(NoteMarkdown.toMarkdown((await inHome(full, () => NoteStore.get("home", noteID))).content)).toContain(
    "Saved by the full worker",
  )
  await full.close()
  await using restored = await ProductRuntimeHandle.openTask({ host: host(fullHome, "full"), mode: "oneshot" })
  expect((await inHome(restored, () => Session.get(sessions.get("full")!))).workspace).toBeNull()
  expect((await inHome(restored, () => NoteStore.get("home", noteID))).title).toBe("Home result")
  expect(await restored.run(async () => (await Asset.read(assetID))?.text())).toBe("Home artifact")
  expect(restored.run(() => LibraryDB.Memory.get("home-memory")?.content)).toBe("Remember Home")
  const result = await inHome(restored, () =>
    SessionInvoke.invoke({
      sessionID: sessions.get("full")!,
      parts: [{ type: "text", text: "Confirm the previous result." }],
    }),
  )
  expect(result.parts).toContainEqual(expect.objectContaining({ type: "text", text: "full completed" }))
}, 60_000)
