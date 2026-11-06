import { afterAll, expect, spyOn, test } from "bun:test"
import { testRuntime } from "@ericsanchezok/synergy-harness/test/support/runtime"
import { Scope } from "@ericsanchezok/synergy-harness/scope"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { AgentCall } from "@ericsanchezok/synergy-harness/agent/call"
import type { Provider } from "@ericsanchezok/synergy-harness/provider/provider"
import { infer } from "../src/inference"
import type { ModelMessage } from "ai"
import { contextMessages } from "../src/context"
import { SecretVault } from "@ericsanchezok/synergy-harness/secrets/vault"
import { SecretMask } from "@ericsanchezok/synergy-harness/secrets/mask"

const runtime = await testRuntime()
afterAll(() => runtime.close())

test("legacy OAuth context is captured before native prediction or evaluation requests", () =>
  runtime.run(async () => {
    const credential = `fixture-${crypto.randomUUID()}`
    const known = `registered-${crypto.randomUUID()}`
    await SecretVault.register(known, { kind: "user" })
    const content = `http://localhost:1455/auth/callback?code=${credential}&state=ordinary-state`
    const current: ModelMessage[] = [
      {
        role: "assistant",
        content: [
          { type: "tool-call", toolName: "inspect", toolCallId: "legacy", input: { authorizationCode: credential } },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolName: "inspect",
            toolCallId: "legacy",
            output: { type: "json", value: { [credential]: known } },
          },
        ],
      },
      { role: "user", content },
      { role: "assistant", content: known },
    ]
    const messages = await contextMessages(current, { reference: content })
    expect(JSON.stringify(messages)).not.toContain(credential)
    expect(JSON.stringify(messages)).not.toContain(known)
    expect(JSON.stringify(messages)).toContain("⟦sec:")
    expect(current[2]?.content).toBe(content)
  }))

test("sensitive originals cannot enter selected historical evidence", () =>
  runtime.run(async () => {
    const model = { providerID: "fixture", id: "selected", limit: { context: 32_000, output: 8_000 } } as Provider.Model
    const credential = `fixture-${crypto.randomUUID()}`
    const text = `http://localhost:1455/auth/callback?code=${credential}`
    const maskRevision = await SecretMask.revision()
    let received: AgentCall.TextInput | undefined
    const sampling = spyOn(AgentCall, "text").mockImplementation(async (input) => {
      received = input
      return {
        text: "",
        model,
        toolCalls: [
          {
            name: "predict_next_input",
            input: {
              candidate: "继续",
              grounding: ["current"],
              targets: [],
            },
          },
        ],
      }
    })
    try {
      const result = await infer({
        current: [{ role: "assistant", content: "完成了" }],
        evidence: [
          { id: "bare", kind: "voice", text: credential, family: "older", score: 2, references: [] },
          { id: "legacy", kind: "voice", text, family: "old", score: 1, references: [] },
        ],
        statistics: [],
        model,
        metadata: {},
      })
      expect(result.selected).toEqual([])
      expect(JSON.stringify(received?.messages)).not.toContain(credential)
      await expect(
        infer({
          current: [{ role: "assistant", content: "完成了" }],
          evidence: [],
          statistics: [],
          maskRevision,
          model,
          metadata: {},
        }),
      ).rejects.toThrow("protected content index changed")
      expect(sampling).toHaveBeenCalledTimes(1)
    } finally {
      sampling.mockRestore()
    }
  }))

test("native media and tool history reach inference without encoded bytes becoming prompt text", () =>
  runtime.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      fn: async () => {
        const model = {
          providerID: "fixture",
          id: "selected",
          limit: { context: 32_000, output: 8_000 },
        } as Provider.Model
        const image = `data:image/png;base64,${"A".repeat(1_400_000)}`
        const file = new Uint8Array([1, 2, 3])
        const current: ModelMessage[] = [
          {
            role: "user",
            content: [
              { type: "text", text: "检查 API" },
              { type: "image", image },
              { type: "file", data: file, mediaType: "application/pdf", filename: "spec.pdf" },
            ],
          },
          {
            role: "assistant",
            content: [
              {
                type: "reasoning",
                text: "",
                providerOptions: {
                  openai: { itemId: "opaque", reasoningEncryptedContent: "secret-state".repeat(100_000) },
                },
              },
              { type: "tool-call", toolCallId: "call", toolName: "read", input: { path: "spec.md" } },
            ],
          },
          {
            role: "tool",
            content: [
              {
                type: "tool-result",
                toolCallId: "call",
                toolName: "read",
                output: { type: "text", value: "API uses one execution boundary" },
              },
            ],
          },
          { role: "assistant", content: "API 已检查，边界一致。" },
        ]
        let received: AgentCall.TextInput | undefined
        const sampling = spyOn(AgentCall, "text").mockImplementation(async (input) => {
          received = input
          return {
            text: "",
            model,
            toolCalls: [
              {
                name: "predict_next_input",
                input: { candidate: "再检查一下 API", grounding: ["current"], targets: ["API"] },
              },
            ],
          }
        })
        try {
          await infer({ current, evidence: [], statistics: [], model, metadata: {} })
          expect(received?.messages).toHaveLength(5)
          expect(received?.messages[0]?.content).toMatchObject([
            { type: "text", text: "检查 API" },
            { type: "image", image },
            { type: "file", data: file },
          ])
          expect(received?.messages[1]?.content).toEqual([
            { type: "tool-call", toolCallId: "call", toolName: "read", input: { path: "spec.md" } },
          ])
          expect(received?.messages[2]).toEqual(current[2])
          expect(JSON.stringify(received?.messages.at(-1))).not.toContain("base64")
          expect(JSON.stringify(received?.messages)).not.toContain("reasoningEncryptedContent")
          expect(current[1]?.content).toHaveLength(2)
        } finally {
          sampling.mockRestore()
        }
      },
    }),
  ))

test("credential changes during inference invalidate the result even when the candidate is ordinary text", () =>
  runtime.run(async () => {
    const model = { providerID: "fixture", id: "selected", limit: { context: 32_000, output: 8_000 } } as Provider.Model
    const text = `fixture-${crypto.randomUUID()}`
    using sampling = spyOn(AgentCall, "text").mockImplementation(async () => {
      await SecretVault.register(text, { kind: "user" })
      return {
        text: "",
        model,
        toolCalls: [
          {
            name: "predict_next_input",
            input: { candidate: "再检查一下", grounding: ["current"], targets: [] },
          },
        ],
      }
    })
    await expect(
      infer({
        current: [{ role: "assistant", content: "完成了" }],
        evidence: [{ id: "original", kind: "voice", text, family: "old", score: 1, references: [] }],
        statistics: [],
        model,
        metadata: {},
      }),
    ).rejects.toThrow("protected content index changed")
    expect(sampling).toHaveBeenCalledTimes(1)
  }))

test("the output contract names exact supplied evidence IDs and rejects invented targets", () =>
  runtime.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      fn: async () => {
        const model = {
          providerID: "fixture",
          id: "selected",
          limit: { context: 1_000_000, output: 131_072 },
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
          const count = calls.length
          await expect(
            infer({
              ...input,
              current: [{ role: "user", content: "meaningful text ".repeat(20_000) }],
              model: { ...model, limit: { context: 8_000, output: 2_000 } },
            }),
          ).rejects.toThrow("exceeds the selected model capacity")
          expect(calls).toHaveLength(count)
          expect(calls[0]?.outputTool?.schema).toMatchObject({
            properties: { grounding: { items: { type: "string", enum: ["current"] } } },
          })
          expect(calls[0]?.maxOutputTokens).toBe(model.limit.output)
          expect(
            (await infer({ ...input, model: { ...model, limit: { context: 100_000, output: 100_000 } } })).prediction
              .candidate,
          ).toContain("API")
          for (const target of ["C:\\repo\\a.ts", '"draft"']) {
            targets = [target]
            expect(
              (await infer({ ...input, current: [{ role: "assistant", content: `API updated at ${target}` }] }))
                .prediction.candidate,
            ).toContain("API")
          }
          targets = ["an-unrelated-repository"]
          await expect(infer(input)).rejects.toThrow("ungrounded")
        } finally {
          sampling.mockRestore()
        }
      },
    }),
  ))
