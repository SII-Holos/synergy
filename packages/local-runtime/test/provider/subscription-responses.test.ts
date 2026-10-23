import { afterAll, expect, test } from "bun:test"
import { ProviderProfile } from "@ericsanchezok/synergy-harness/provider/profile"
import { registerBuiltinProviderProfiles } from "@ericsanchezok/synergy-harness/test/internal/provider/builtin"
import { loadBundledProvider } from "../../src/provider/sdk-registry"
import { testRuntime } from "../support/runtime"
import z from "zod"

const runtime = await testRuntime({ register: registerBuiltinProviderProfiles })
const efforts = ["low", "medium", "high", "xhigh"] as const
const requestBody = z.object({
  input: z.array(z.unknown()),
  reasoning: z.object({ effort: z.string() }),
})

test("Grok's production profile sends Responses with documented reasoning efforts", () =>
  runtime.run(async () => {
    const profile = ProviderProfile.get("grok")!
    expect(profile.modelFactory).toBe("openaiResponses")
    const factory = await loadBundledProvider(profile.aiSdkPackage!)
    expect(factory).toBeDefined()
    const requests: Array<{ pathname: string; body: z.infer<typeof requestBody> }> = []
    const sdk = factory!({
      apiKey: "test-key",
      baseURL: "https://provider.invalid/v1",
      fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = input instanceof Request ? input : new Request(input, init)
        requests.push({ pathname: new URL(request.url).pathname, body: requestBody.parse(await request.json()) })
        throw new Error("request captured")
      },
    })
    const model = ProviderProfile.defaultModelFactory(profile.modelFactory, { sdk, modelID: "grok-4.7" })

    for (const reasoningEffort of efforts) {
      await expect(
        model.doStream({
          prompt: [{ role: "user", content: [{ type: "text", text: "ping" }] }],
          providerOptions: { xai: { reasoningEffort } },
        }),
      ).rejects.toThrow("request captured")
    }
    expect(profile.apiMode).toBe("responses")
    expect(requests.map((request) => request.pathname)).toEqual(efforts.map(() => "/v1/responses"))
    expect(requests.map((request) => request.body.reasoning.effort)).toEqual([...efforts])
    expect(requests.every((request) => request.body.input.length === 1)).toBe(true)
  }))

test.each([
  { providerID: "grok", modelID: "grok-4.7", namespace: "xai" },
  { providerID: "openai-codex", modelID: "gpt-5.4-mini", namespace: "openai" },
])(
  "$providerID's production Responses factory serializes tools and their results",
  ({ providerID, modelID, namespace }) =>
    runtime.run(async () => {
      const profile = ProviderProfile.get(providerID)!
      expect(profile.modelFactory).toBe("openaiResponses")
      const factory = await loadBundledProvider(profile.aiSdkPackage!)
      expect(factory).toBeDefined()
      const bodies: unknown[] = []
      const sdk = factory!({
        apiKey: "test-key",
        baseURL: "https://provider.invalid/v1",
        fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
          const request = input instanceof Request ? input : new Request(input, init)
          expect(new URL(request.url).pathname).toBe("/v1/responses")
          bodies.push(await request.json())
          throw new Error("request captured")
        },
      })
      const model = ProviderProfile.defaultModelFactory(profile.modelFactory, { sdk, modelID })
      await expect(
        model.doStream({
          prompt: [
            { role: "user", content: [{ type: "text", text: "Echo hello" }] },
            {
              role: "assistant",
              content: [{ type: "tool-call", toolCallId: "call-test", toolName: "echo", input: { value: "hello" } }],
            },
            {
              role: "tool",
              content: [
                {
                  type: "tool-result",
                  toolCallId: "call-test",
                  toolName: "echo",
                  output: { type: "text", value: "hello" },
                },
              ],
            },
          ],
          tools: [
            {
              type: "function",
              name: "echo",
              inputSchema: {
                type: "object",
                properties: { value: { type: "string" } },
                required: ["value"],
                additionalProperties: false,
              },
            },
          ],
          providerOptions: { [namespace]: { reasoningEffort: "medium" } },
        }),
      ).rejects.toThrow("request captured")
      expect(bodies).toHaveLength(1)
      const body = z
        .object({
          input: z.array(z.unknown()),
          tools: z.array(z.unknown()),
          reasoning: z.object({ effort: z.string() }),
          stream: z.boolean(),
        })
        .parse(bodies[0])
      expect(body.stream).toBe(true)
      expect(body.reasoning.effort).toBe("medium")
      expect(body.tools).toContainEqual(expect.objectContaining({ type: "function", name: "echo" }))
      expect(body.input).toContainEqual(
        expect.objectContaining({ type: "function_call", call_id: "call-test", name: "echo" }),
      )
      expect(body.input).toContainEqual(
        expect.objectContaining({ type: "function_call_output", call_id: "call-test", output: "hello" }),
      )
    }),
)

afterAll(() => runtime.close())
