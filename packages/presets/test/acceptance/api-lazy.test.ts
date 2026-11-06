import { expect, test } from "bun:test"
import path from "node:path"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import { apiLazy } from "../../script/acceptance/api-lazy"
import { selectCases } from "../../script/acceptance/catalog"
import { execute, makePlan, report } from "../../script/acceptance/runner"
import { fixtureSettings } from "./support"

const labFile = process.env.SYNERGY_ACCEPTANCE_REMOTE_SETTINGS
test.skipIf(!labFile)(
  "API, MCP and a real plugin process stay independent of lazy Docker allocation",
  async () => {
    await using tmp = await tmpdir()
    using provider = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(request) {
        const body = await request.json()
        const messages = body.messages as Array<{ role: string; content: unknown }>
        const last = messages.findLastIndex(
          (message) => message.role === "user" && JSON.stringify(message.content).includes("<acceptance>"),
        )
        const raw = messages[last]?.content
        const prompt = typeof raw === "string" ? raw : JSON.stringify(raw ?? "")
        const instruction = prompt.match(/<acceptance>(.*?)<\/acceptance>/s)?.[1]
        const task = instruction ? (JSON.parse(instruction) as { tool: string; input: unknown }) : undefined
        const result = messages.slice(last + 1).find((message) => message.role === "tool")
        const content = result ? JSON.stringify(result.content) : "API acceptance"
        const tool = body.tools?.length && task && !result ? task : undefined
        const usage = { prompt_tokens: 15, completion_tokens: 8 }
        if (!body.stream)
          return Response.json({
            id: "fixture",
            model: "model",
            choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
            usage,
          })
        return new Response(
          [
            {
              id: "fixture",
              model: "model",
              choices: [
                {
                  index: 0,
                  delta: tool
                    ? {
                        role: "assistant",
                        tool_calls: [
                          {
                            index: 0,
                            id: `call_${crypto.randomUUID()}`,
                            type: "function",
                            function: { name: tool.tool, arguments: JSON.stringify(tool.input) },
                          },
                        ],
                      }
                    : { role: "assistant", content },
                  finish_reason: null,
                },
              ],
            },
            {
              id: "fixture",
              model: "model",
              choices: [{ index: 0, delta: {}, finish_reason: tool ? "tool_calls" : "stop" }],
              usage,
            },
          ]
            .map((frame) => `data: ${JSON.stringify(frame)}\n\n`)
            .join("") + "data: [DONE]\n\n",
          { headers: { "content-type": "text/event-stream" } },
        )
      },
    })
    const settings = await fixtureSettings(tmp.path, provider.url.toString())
    settings.remote = (await Bun.file(labFile!).json()).remote
    const plan = await makePlan({
      source: "a".repeat(40),
      directory: path.join(tmp.path, "run"),
      cases: selectCases("api-lazy"),
      inputs: [],
    })
    await execute(plan, { "api-lazy": apiLazy(settings) }, { source: plan.source })
    const result = await report(plan)
    if (!result.passed) {
      const file = Bun.file(path.join(plan.directory, "cases/api-lazy/1/failure.json"))
      if (await file.exists()) console.error(await file.text())
    }
    expect(result.cases).toEqual([{ id: "api-lazy", status: "passed", attempts: 1, errors: [] }])
  },
  120_000,
)
