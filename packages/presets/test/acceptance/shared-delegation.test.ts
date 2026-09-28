import { expect, test } from "bun:test"
import path from "node:path"
import fs from "node:fs/promises"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import { sharedDelegation } from "../../script/acceptance/shared-delegation"
import { selectCases } from "../../script/acceptance/catalog"
import { execute, makePlan, report } from "../../script/acceptance/runner"
import { fixtureSettings } from "./support"

test("shared child writers preserve external edits across cancellation and rebinding, then isolate worktrees", async () => {
  await using tmp = await tmpdir()
  using provider = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      const body = await request.json()
      const messages = body.messages as Array<{
        role: string
        content: string | Array<{ type: string; text?: string }>
      }>
      const text = (message: (typeof messages)[number]) =>
        typeof message.content === "string"
          ? message.content
          : (message.content?.map((part) => part.text ?? "").join("\n") ?? "")
      const last = messages.findLastIndex(
        (message) =>
          message.role === "user" && (text(message).includes("<siblings>") || text(message).includes("<command>")),
      )
      const prompt = last < 0 ? "" : text(messages[last]!)
      const results = messages.slice(last + 1).filter((message) => message.role === "tool")
      const parent = body.tools?.some((tool: { function: { name: string } }) => tool.function.name === "task")
      const command = prompt.match(/<command>(.*?)<\/command>/s)?.[1]
      const calls =
        !results.length && body.tools?.length
          ? parent && prompt.includes("<siblings>")
            ? ["keep", "cancel"].map((name) => ({
                name: "task",
                arguments: JSON.stringify({
                  description: `sibling-${name}`,
                  subagent_type: "implementation-engineer",
                  background: false,
                  output: { mode: "final_response" },
                  prompt: `Run exactly once: <command>cat record.txt > ${name}.txt; cat record.txt</command> Return the observed identifier.`,
                }),
              }))
            : command
              ? [
                  {
                    name: "bash",
                    arguments: JSON.stringify({ command, description: "Write isolated acceptance output" }),
                  },
                ]
              : []
          : []
      const content = results.length ? results.map(text).join("\n") : "Shared acceptance"
      const usage = { prompt_tokens: 20, completion_tokens: 10 }
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
  const settings = await fixtureSettings(tmp.path, provider.url.toString())
  const plan = await makePlan({
    source: "a".repeat(40),
    directory: path.join(tmp.path, "run"),
    cases: selectCases("shared-delegation"),
    inputs: [],
  })
  await execute(plan, { "shared-delegation": sharedDelegation(settings) }, { source: plan.source })
  const result = await report(plan)
  if (!result.passed) {
    if (process.env.SYNERGY_ACCEPTANCE_DIAGNOSTICS)
      await fs.cp(
        plan.directory,
        path.join(process.env.SYNERGY_ACCEPTANCE_DIAGNOSTICS, `shared-${crypto.randomUUID()}`),
        { recursive: true },
      )
    const failure = Bun.file(path.join(plan.directory, "cases/shared-delegation/1/failure.json"))
    if (await failure.exists()) console.error(await failure.text())
  }
  expect(result.cases).toEqual([{ id: "shared-delegation", status: "passed", attempts: 1, errors: [] }])
  const physical = await Bun.file(path.join(plan.directory, "cases/shared-delegation/1/physical.json")).json()
  expect(physical.worktrees).toHaveLength(2)
  expect(new Set(physical.worktrees.map((entry: { path: string }) => entry.path)).size).toBe(2)
  expect(physical.cancelledEffects).toBe(0)
}, 180000)
