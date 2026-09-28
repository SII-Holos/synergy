import path from "node:path"
import type { Settings } from "../../script/acceptance/settings"

export function fixtureProvider(answer: (input: Record<string, unknown>) => string | Promise<string>) {
  return Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const input = (await request.json()) as Record<string, unknown>
      const content = await answer(input)
      const usage = { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 }
      if (!input.stream)
        return Response.json({
          id: "fixture",
          object: "chat.completion",
          created: 0,
          model: "model",
          choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
          usage,
        })
      return new Response(
        [
          {
            id: "fixture",
            object: "chat.completion.chunk",
            created: 0,
            model: "model",
            choices: [{ index: 0, delta: { role: "assistant", content }, finish_reason: null }],
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
        { headers: { "content-type": "text/event-stream" } },
      )
    },
  })
}

export async function fixtureSettings(directory: string, upstream: string): Promise<Settings> {
  const apiKeyFile = path.join(directory, "fixture-key")
  await Bun.write(apiKeyFile, "fixture")
  return {
    providerID: "fixture",
    modelID: "model",
    upstream,
    apiKeyFile,
    modelCatalog: process.env.MODELS_DEV_API_JSON!,
    deadlineMs: 60_000,
    config: {
      model: "fixture/model",
      nano_model: "fixture/model",
      mini_model: "fixture/model",
      vision_model: "fixture/model",
      controlProfile: "full_access",
      execution: { agentWorkers: 1, agentWorkerMinIdle: 0 },
      library: { memory: { enabled: false }, experience: { retrieve: false, encode: false }, autonomy: false },
      provider: {
        fixture: {
          npm: "@ai-sdk/openai-compatible",
          env: [],
          models: {
            model: {
              name: "Fixture",
              tool_call: true,
              attachment: true,
              modalities: { input: ["text", "image"], output: ["text"] },
              limit: { context: 128000, output: 2048 },
            },
          },
        },
      },
    },
  }
}
