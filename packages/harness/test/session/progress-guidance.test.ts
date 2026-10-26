import { afterAll, expect, test } from "bun:test"
import { buildGeneralPrompt } from "../../src/agent/prompt/general/builder"
import { buildCodingPrompt } from "../../src/agent/prompt/coding/builder"
import { buildLightweightPrompt } from "../../src/agent/prompt/lightweight/builder"
import { PROGRESS_UPDATES } from "../../src/agent/prompt/progress"
import { ScopeContext } from "../../src/scope/context"
import { LLM } from "../../src/session/llm"
import { tmpdir } from "../support/fixture"
import { testRuntime } from "../support/runtime"

const runtime = await testRuntime()
afterAll(() => runtime.close())

function input(prompt?: string): LLM.StreamInput {
  return {
    sessionID: "ses_progress",
    user: {
      id: "msg_progress",
      sessionID: "ses_progress",
      role: "user",
      time: { created: Date.now() },
      agent: "fixture",
      model: { providerID: "fixture", modelID: "gpt-5" },
      isRoot: true,
      rootID: "msg_progress",
      origin: { type: "user" },
    },
    model: {
      id: "gpt-5",
      providerID: "fixture",
      name: "Fixture model",
      api: { id: "gpt-5", url: "https://example.invalid", npm: "@ai-sdk/openai" },
      capabilities: {
        temperature: true,
        reasoning: false,
        attachment: false,
        toolcall: true,
        input: { text: true, audio: false, image: false, video: false, pdf: false },
        output: { text: true, audio: false, image: false, video: false, pdf: false },
        interleaved: false,
      },
      cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
      limit: { context: 100_000, output: 8_192 },
      status: "active",
      options: {},
      headers: {},
      release_date: "2026-01-01",
    },
    agent: { name: "fixture", mode: "primary", prompt, permission: [], options: {} },
    system: ["Preserve the task's authorization boundaries."],
    messages: [{ role: "user", content: "Inspect the project." }],
    tools: {},
    abort: new AbortController().signal,
  }
}

test("prepared primary prompts follow the resolved model across model switches", () =>
  runtime.run(async () => {
    await using tmp = await tmpdir()
    await ScopeContext.provide({
      scope: await tmp.scope(),
      async fn() {
        for (const build of [buildGeneralPrompt, buildCodingPrompt, buildLightweightPrompt]) {
          const request = input(build())
          for (const [apiModelID, expected] of [
            ["gpt-5", 1],
            ["deepseek-ai/DeepSeek-V4-Flash", 0],
            ["claude-sonnet-4-5", 1],
          ] as const) {
            request.model.api.id = apiModelID
            const prepared = await LLM.prepare(request)
            const system = prepared.system.join("\n\n")
            expect(system.split(PROGRESS_UPDATES).length - 1, apiModelID).toBe(expected)
            expect(system).toContain("Preserve the task's authorization boundaries.")
            const messages = LLM.promptMessages({ ...request, system: prepared.system })
            expect(JSON.stringify(messages).includes("## Progress Updates")).toBe(expected === 1)
            expect(request.agent.prompt).toBe(build())
          }
        }
      },
    })
  }))

test("fallback and custom prompts retain their content with model-selected progress guidance", () =>
  runtime.run(async () => {
    await using tmp = await tmpdir()
    await ScopeContext.provide({
      scope: await tmp.scope(),
      async fn() {
        for (const prompt of [undefined, "", "You inspect local projects."]) {
          for (const id of ["deepseek-chat", "gpt-5"]) {
            const request = input(prompt)
            request.model.id = id
            request.model.api.id = id
            const prepared = await LLM.prepare(request)
            const system = prepared.system.join("\n\n")
            expect(system.split(PROGRESS_UPDATES).length - 1).toBe(id === "deepseek-chat" ? 0 : 1)
            expect(system).toContain(prompt || "You are Synergy, an AI coding assistant.")
          }
        }
      },
    })
  }))
