import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import { resourceCycles } from "../../script/acceptance/resource-cycles"
import { selectCases } from "../../script/acceptance/catalog"
import { execute, makePlan, report } from "../../script/acceptance/runner"
import { fixtureSettings } from "./support"

const labFile = process.env.SYNERGY_ACCEPTANCE_REMOTE_SETTINGS

test.skipIf(!labFile)(
  "two real compaction boundaries survive three controller and compute cycles while another Runtime works",
  async () => {
    await using tmp = await tmpdir()
    using provider = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(request) {
        const body = await request.json()
        const messages = body.messages as Array<{ role: string; content: string | Array<{ text?: string }> }>
        const text = (message: (typeof messages)[number]) =>
          typeof message.content === "string"
            ? message.content
            : message.content.map((part) => part.text ?? "").join("\n")
        const user = messages.findLastIndex(
          (message) => message.role === "user" && !text(message).startsWith("<runtime-context>"),
        )
        const prompt = user < 0 ? "" : text(messages[user]!)
        const results = messages.slice(user + 1).filter((message) => message.role === "tool")
        const commands = [...prompt.matchAll(/<command>(.*?)<\/command>/gs)].map((match) => match[1]!)
        const tools = (body.tools ?? []).map((tool: { function: { name: string } }) => tool.function.name)
        const calls: Array<{ name: string; arguments: string }> = []
        if (results.length < commands.length && tools.includes("bash"))
          calls.push({
            name: "bash",
            arguments: JSON.stringify({ command: commands[results.length], workBrief: "Read actual long history" }),
          })
        if (results.length === commands.length && tools.includes("task") && prompt.includes("<delegate>"))
          calls.push({
            name: "task",
            arguments: JSON.stringify({
              taskTitle: "cycle-child",
              subagent_type: "implementation-engineer",
              output: { mode: "final_response" },
              taskInstructions: "Run exactly once: <command>cat record.txt</command> Return the observed identifier.",
            }),
          })
        const markers = [...new Set(JSON.stringify(body.messages).match(/\b[a-f0-9]{32}\b/g) ?? [])]
        const content =
          "### Key context\nObserved identifiers: " +
          markers.join(" ") +
          "\nCompleted the recorded work. Wait for the next request without repeating side effects."
        const usage = {
          prompt_tokens: Math.ceil(JSON.stringify(body.messages).length / 4),
          completion_tokens: Math.ceil(content.length / 4),
        }
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
                delta: calls.length
                  ? {
                      role: "assistant",
                      tool_calls: calls.map((fn, index) => ({
                        index,
                        id: `call_${crypto.randomUUID()}`,
                        type: "function",
                        function: fn,
                      })),
                    }
                  : { role: "assistant", content },
                finish_reason: null,
              },
            ],
          },
          {
            id: "fixture",
            model: "model",
            choices: [{ index: 0, delta: {}, finish_reason: calls.length ? "tool_calls" : "stop" }],
            usage,
          },
        ]
        return new Response(frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join("") + "data: [DONE]\n\n", {
          headers: { "content-type": "text/event-stream" },
        })
      },
    })
    const settings = {
      ...(await fixtureSettings(tmp.path, provider.url.toString())),
      remote: (await Bun.file(labFile!).json()).remote,
    }
    const plan = await makePlan({
      source: "a".repeat(40),
      directory: path.join(tmp.path, "run"),
      cases: selectCases("resource-cycles"),
      inputs: [],
    })
    await execute(plan, { "resource-cycles": resourceCycles(settings) }, { source: plan.source })
    const outcome = await report(plan)
    if (!outcome.passed) {
      if (process.env.SYNERGY_ACCEPTANCE_DIAGNOSTICS)
        await fs.cp(
          plan.directory,
          path.join(process.env.SYNERGY_ACCEPTANCE_DIAGNOSTICS, `cycles-${crypto.randomUUID()}`),
          { recursive: true },
        )
      const file = Bun.file(path.join(plan.directory, "cases/resource-cycles/1/failure.json"))
      if (await file.exists()) console.error(await file.text())
    }
    expect(outcome.cases).toEqual([{ id: "resource-cycles", status: "passed", attempts: 1, errors: [] }])
    const physical = await Bun.file(path.join(plan.directory, "cases/resource-cycles/1/physical.json")).json()
    expect(new Set(physical.samples.map((sample: { container: string }) => sample.container)).size).toBe(4)
    expect(physical.samples.every((sample: { effects: string }) => sample.effects === "once\n")).toBe(true)
    expect(physical.heartbeatProgress).toHaveLength(3)
  },
  240_000,
)
