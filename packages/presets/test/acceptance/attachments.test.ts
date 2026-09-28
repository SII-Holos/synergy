import { expect, test } from "bun:test"
import path from "node:path"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import { attachments } from "../../script/acceptance/attachments"
import { selectCases } from "../../script/acceptance/catalog"
import { execute, makePlan, report } from "../../script/acceptance/runner"

test("attachment acceptance drives actual isolated Runtime queues and validates transmitted content", async () => {
  await using tmp = await tmpdir()
  using upstream = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const input = await request.json()
      const text = JSON.stringify(input.messages)
      const markers = [...text.matchAll(/(?:Primary|Supplementary) record: ([a-f0-9]{32})/g)].map((match) => match[1])
      const content = markers.length ? [...new Set(markers)].join(" ") : "Attachment acceptance"
      if (!input.stream)
        return Response.json({
          id: "fixture",
          object: "chat.completion",
          created: 0,
          model: "model",
          choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
          usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
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
            usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
          },
        ]
          .map((frame) => `data: ${JSON.stringify(frame)}\n\n`)
          .join("") + "data: [DONE]\n\n",
        { headers: { "content-type": "text/event-stream" } },
      )
    },
  })
  const key = path.join(tmp.path, "fixture-key")
  await Bun.write(key, "fixture")
  const driver = attachments({
    providerID: "fixture",
    modelID: "model",
    upstream: upstream.url.toString(),
    apiKeyFile: key,
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
          models: { model: { name: "Fixture", tool_call: true, limit: { context: 128000, output: 2048 } } },
        },
      },
    },
  })
  const cases = selectCases("attachments-home,attachments-project,attachments-workspace")
  const plan = await makePlan({ source: "a".repeat(40), directory: path.join(tmp.path, "run"), cases, inputs: [] })
  await execute(plan, Object.fromEntries(cases.map((scenario) => [scenario.id, driver])), { source: plan.source })
  const outcome = await report(plan)
  if (!outcome.passed)
    for (const scenario of cases) {
      const failure = Bun.file(path.join(plan.directory, "cases", scenario.id, "1/failure.json"))
      if (await failure.exists()) console.error(await failure.text())
    }
  expect(outcome.cases).toEqual(
    cases.map((scenario) => ({ id: scenario.id, status: "passed", attempts: 1, errors: [] })),
  )
  expect(outcome.usage.requests).toBeGreaterThanOrEqual(6)
}, 180_000)
