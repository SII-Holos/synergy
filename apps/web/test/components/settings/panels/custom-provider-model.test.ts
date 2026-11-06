import { expect, test } from "bun:test"
import { customProviderInput, newCustomModel } from "../../../../src/components/settings/panels/custom-provider-model"

test("custom API input requires an explicit endpoint, protocol and model capacities", () => {
  const model = newCustomModel()
  expect(
    customProviderInput({
      providerID: "my-gateway",
      name: "Gateway",
      endpoint: "",
      protocol: "openai-completions",
      models: [model],
    }).issue,
  ).toBe("endpoint")
  expect(
    customProviderInput({
      providerID: "my-gateway",
      name: "Gateway",
      endpoint: "https://example.com/v1",
      protocol: "openai-completions",
      models: [{ ...model, id: "custom-model" }],
    }).issue,
  ).toBe("capacity")
})

test("custom API input preserves protocol and per-model capabilities without a brand profile", () => {
  const result = customProviderInput({
    providerID: "my-gateway",
    name: "Team gateway",
    endpoint: "https://example.com/v1",
    protocol: "anthropic-messages",
    models: [
      {
        ...newCustomModel(),
        id: "model-a",
        name: "Model A",
        context: "200000",
        output: "64000",
        image: true,
        reasoning: true,
      },
    ],
  })
  expect(result.input).toEqual({
    id: "my-gateway",
    name: "Team gateway",
    endpoint: "https://example.com/v1",
    protocol: "anthropic-messages",
    models: [
      { id: "model-a", name: "Model A", context: 200000, output: 64000, toolCall: true, image: true, reasoning: true },
    ],
  })
})

test("invalid identities, non-HTTP endpoints and duplicate models are rejected before writes", () => {
  const model = { ...newCustomModel(), id: "model-a", context: "100000", output: "16000" }
  const draft = {
    providerID: "my-gateway",
    name: "Gateway",
    endpoint: "https://example.com/v1",
    protocol: "openai-responses" as const,
    models: [model],
  }
  expect(customProviderInput({ ...draft, providerID: "bad/id" }).issue).toBe("id")
  expect(customProviderInput({ ...draft, endpoint: "file:///models" }).issue).toBe("endpoint")
  expect(customProviderInput({ ...draft, models: [model, { ...model, key: "another" }] }).issue).toBe("duplicate")
  expect(customProviderInput({ ...draft, models: [] }).issue).toBe("model")
})
