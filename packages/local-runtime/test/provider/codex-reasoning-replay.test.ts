import { expect, test } from "bun:test"
import { createOpenAI } from "@ai-sdk/openai"
import { MessageV2 } from "@ericsanchezok/synergy-harness/session/message-v2"
import { afterAll as afterRuntimeTests } from "bun:test"
import { testRuntime } from "../support/runtime"

const runtime = await testRuntime()

const history = [
  {
    info: {
      id: "user-1",
      sessionID: "session-1",
      role: "user",
      time: { created: 0 },
      agent: "user",
      model: { providerID: "openai-codex", modelID: "gpt-5" },
      tools: {},
      mode: "",
    },
    parts: [{ id: "part-user", sessionID: "session-1", messageID: "user-1", type: "text", text: "continue" }],
  },
  {
    info: {
      id: "assistant-1",
      sessionID: "session-1",
      role: "assistant",
      time: { created: 1 },
      parentID: "user-1",
      providerID: "openai-codex",
      modelID: "gpt-5",
      profileID: "openai-codex",
      apiModelID: "gpt-5",
      mode: "",
      agent: "agent",
      path: { cwd: "/", root: "/" },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    },
    parts: [
      {
        id: "part-first",
        sessionID: "session-1",
        messageID: "assistant-1",
        type: "reasoning",
        text: "first summary",
        time: { start: 0 },
        metadata: { openai: { itemId: "rs_1" } },
      },
      {
        id: "part-last",
        sessionID: "session-1",
        messageID: "assistant-1",
        type: "reasoning",
        text: "last summary",
        time: { start: 0 },
        metadata: { openai: { itemId: "rs_1", reasoningEncryptedContent: "opaque" } },
      },
      {
        id: "part-old",
        sessionID: "session-1",
        messageID: "assistant-1",
        type: "reasoning",
        text: "legacy summary",
        time: { start: 0 },
        metadata: { openai: { itemId: "rs_old" } },
      },
      {
        id: "part-call",
        sessionID: "session-1",
        messageID: "assistant-1",
        type: "tool",
        callID: "call_1",
        tool: "lookup",
        state: { status: "completed", input: {}, output: "ok", title: "lookup", time: { start: 0, end: 1 } },
      },
    ],
  },
] as unknown as MessageV2.WithParts[]

test("same-model Codex replay reaches the SDK wire as encrypted reasoning before tool continuation", () =>
  runtime.run(async () => {
    let requestBody: { store?: boolean; input?: Array<Record<string, unknown>> } | undefined
    const openai = createOpenAI({
      apiKey: "test",
      baseURL: "https://example.invalid",
      fetch: (async (_input, init) => {
        requestBody = JSON.parse(String(init?.body))
        return new Response(JSON.stringify({ error: { message: "fixture stop", type: "invalid_request_error" } }), {
          status: 400,
          headers: { "content-type": "application/json" },
        })
      }) as typeof fetch,
    })
    const prompt = MessageV2.toModelMessage(history, {
      model: { providerID: "openai-codex", modelID: "gpt-5", profileID: "openai-codex", apiModelID: "gpt-5" },
    })
    try {
      await openai.responses("gpt-5").doGenerate({
        prompt: prompt as unknown as Parameters<ReturnType<typeof openai.responses>["doGenerate"]>[0]["prompt"],
        providerOptions: { openai: { store: false } },
      })
    } catch {}
    expect(requestBody).toBeDefined()
    expect(requestBody?.store).toBe(false)
    expect(requestBody?.input).toContainEqual({
      type: "reasoning",
      id: "rs_1",
      encrypted_content: "opaque",
      summary: [
        { type: "summary_text", text: "first summary" },
        { type: "summary_text", text: "last summary" },
      ],
    })
    expect(requestBody?.input?.some((item) => item.type === "reasoning" && item.id === "rs_old")).toBe(false)
    expect(requestBody?.input?.some((item) => item.type === "function_call" && item.call_id === "call_1")).toBe(true)
  }))

afterRuntimeTests(() => runtime.close())
