import { afterAll, expect, test } from "bun:test"
import { ProviderProfile } from "@ericsanchezok/synergy-harness/provider/profile"
import { registerBuiltinProviderProfiles } from "@ericsanchezok/synergy-harness/test/internal/provider/builtin"
import { loadBundledProvider } from "../../src/provider/sdk-registry"
import { testRuntime } from "../support/runtime"
import { z } from "zod"
import { Provider } from "@ericsanchezok/synergy-harness/provider/provider"
import { ProviderTransform } from "@ericsanchezok/synergy-harness/provider/transform"

const runtime = await testRuntime({ register: registerBuiltinProviderProfiles })
const efforts = ["low", "medium", "high", "xhigh"] as const
const requestBody = z.object({
  input: z.array(z.unknown()),
  reasoning: z.object({ effort: z.string() }),
  store: z.boolean().optional(),
})

test.each([false, true])("Grok Responses disable remote storage for auxiliary=%s", (small) =>
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

    const catalogModel = Provider.Model.parse({
      id: "grok-4.7",
      providerID: "subscription-connection",
      name: "Grok",
      api: { id: "grok-4.7", url: "https://provider.invalid/v1", npm: profile.aiSdkPackage },
      capabilities: {
        temperature: true,
        reasoning: true,
        attachment: false,
        toolcall: true,
        input: { text: true, audio: false, image: false, video: false, pdf: false },
        output: { text: true, audio: false, image: false, video: false, pdf: false },
        interleaved: false,
      },
      cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
      limit: { context: 128_000, output: 8_192 },
      status: "active",
      options: {},
      headers: {},
      release_date: "2026-01-01",
      variants: {},
    })
    const defaults = small
      ? ProviderTransform.smallOptions(catalogModel, profile.id)
      : ProviderTransform.options(catalogModel, "fixture", undefined, profile.id)
    for (const reasoningEffort of efforts) {
      await expect(
        model.doStream({
          prompt: [{ role: "user", content: [{ type: "text", text: "ping" }] }],
          providerOptions: ProviderTransform.providerOptions(catalogModel, { ...defaults, reasoningEffort }),
        }),
      ).rejects.toThrow("request captured")
    }
    expect(profile.apiMode).toBe("responses")
    expect(requests.map((request) => request.pathname)).toEqual(efforts.map(() => "/v1/responses"))
    expect(requests.map((request) => request.body.reasoning.effort)).toEqual([...efforts])
    expect(requests.every((request) => request.body.input.length === 1)).toBe(true)
    expect(requests.map((request) => request.body.store)).toEqual(efforts.map(() => false))
  }),
)

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
