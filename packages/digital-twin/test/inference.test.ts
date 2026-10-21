import { afterAll, expect, spyOn, test } from "bun:test"
import { testRuntime } from "@ericsanchezok/synergy-harness/test/support/runtime"
import { Scope } from "@ericsanchezok/synergy-harness/scope"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { AgentCall } from "@ericsanchezok/synergy-harness/agent/call"
import type { Provider } from "@ericsanchezok/synergy-harness/provider/provider"
import { infer } from "../src/inference"

const runtime = await testRuntime()
afterAll(() => runtime.close())

test("the output contract names exact supplied evidence IDs and rejects invented targets", () =>
  runtime.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      fn: async () => {
        const model = {
          providerID: "fixture",
          id: "selected",
          limit: { context: 100_000, output: 8192 },
        } as Provider.Model
        let targets = ["API"]
        const calls: AgentCall.TextInput[] = []
        const sampling = spyOn(AgentCall, "text").mockImplementation(async (input) => {
          calls.push(input)
          return {
            text: "",
            model,
            toolCalls: [
              {
                name: "predict_next_input",
                input: {
                  candidate: "再检查一下 API 的边界",
                  abstention: null,
                  grounding: ["current"],
                  targets,
                },
              },
            ],
          }
        })
        try {
          const input = {
            current: [{ role: "assistant" as const, content: "API 已实现" }],
            evidence: [],
            statistics: [],
            model,
            metadata: {},
          }
          expect((await infer(input)).prediction.candidate).toContain("API")
          expect(calls[0]?.outputTool?.schema).toMatchObject({
            properties: { grounding: { items: { type: "string", enum: ["current"] } } },
          })
          expect(calls[0]?.maxOutputTokens).toBe(model.limit.output)
          targets = ["an-unrelated-repository"]
          await expect(infer(input)).rejects.toThrow("ungrounded")
        } finally {
          sampling.mockRestore()
        }
      },
    }),
  ))
