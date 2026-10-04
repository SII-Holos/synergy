import { expect, test } from "bun:test"
import path from "node:path"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import { modelStream } from "../../script/acceptance/model-stream"
import { selectCases } from "../../script/acceptance/catalog"
import { execute, makePlan, report } from "../../script/acceptance/runner"
import { fixtureSettings } from "./support"

for (const fault of ["disconnect", "timeout"] as const)
  test(`model stream ${fault} preserves input and partial evidence without repeating completed Bash effects`, async () => {
    await using tmp = await tmpdir()
    const calls: unknown[] = []
    using provider = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(request) {
        const body = await request.json()
        const messages = body.messages as Array<{ role: string; content: unknown }>
        const lastUser = messages.findLastIndex(
          (message) =>
            message.role === "user" &&
            /Transport phase=|Continue the same session/.test(JSON.stringify(message.content)),
        )
        const raw = messages[lastUser]?.content
        const prompt = typeof raw === "string" ? raw : JSON.stringify(raw ?? "")
        const command = prompt.match(/<command>(.*?)<\/command>/s)?.[1]
        const result = messages.slice(lastUser + 1).find((message) => message.role === "tool")
        const content = result ? JSON.stringify(result.content) : "Stream acceptance"
        const tools = body.tools?.length && command && !result
        calls.push({
          prompt: prompt.slice(-1500),
          command,
          result: Boolean(result),
          tools: body.tools?.length,
          stream: body.stream,
        })
        const usage = { prompt_tokens: 12, completion_tokens: 8 }
        if (!body.stream)
          return Response.json({
            id: "fixture",
            model: "model",
            choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
            usage,
          })
        const frames = [
          {
            id: "fixture",
            model: "model",
            choices: [
              {
                index: 0,
                delta: tools
                  ? {
                      role: "assistant",
                      tool_calls: [
                        {
                          index: 0,
                          id: `call_${crypto.randomUUID()}`,
                          type: "function",
                          function: {
                            name: "bash",
                            arguments: JSON.stringify({ command, workBrief: "Acceptance command" }),
                          },
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
            choices: [{ index: 0, delta: {}, finish_reason: tools ? "tool_calls" : "stop" }],
            usage,
          },
        ]
        return new Response(frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join("") + "data: [DONE]\n\n", {
          headers: { "content-type": "text/event-stream" },
        })
      },
    })
    const settings = await fixtureSettings(tmp.path, provider.url.toString())
    const cases = selectCases(fault === "timeout" ? "fault-model-timeout" : "fault-model-stream")
    const id = cases[0]!.id
    const plan = await makePlan({ source: "a".repeat(40), directory: path.join(tmp.path, "run"), cases, inputs: [] })
    await execute(
      plan,
      { [id]: modelStream(settings, { fault, ttfbSeconds: 2, idleSeconds: 0.25 }) },
      { source: plan.source },
    )
    const result = await report(plan)
    if (!result.passed) {
      console.error(calls)
      const file = Bun.file(path.join(plan.directory, `cases/${id}/1/failure.json`))
      if (await file.exists()) console.error(await file.text())
    }
    expect(result.cases).toEqual([{ id, status: "passed", attempts: 1, errors: [] }])
    expect(result.usage.requests).toBeGreaterThanOrEqual(6)
    const physical = await Bun.file(path.join(plan.directory, `cases/${id}/1/effects.txt`)).text()
    expect(physical).toBe("once\n")
  }, 90_000)
