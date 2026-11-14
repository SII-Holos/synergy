import { expect, test } from "bun:test"
import { OrganizationResourceProtocol as Resource } from "../src/index"

const input = {
  name: "Model",
  scope: { kind: "organization" },
  configuration: {
    protocol: "openai-compatible",
    endpoint: "http://localhost:8080/v1",
    model: { id: "local/model", name: "Local model", limit: { context: 8192, output: 1024 } },
  },
  credential: { kind: "bearer", value: "fixture-secret" },
}

test("resource configuration is explicit and rejects unsupported protocols and credential-bearing URLs", () => {
  expect(Resource.Create.parse(input).configuration.protocol).toBe("openai-compatible")
  for (const endpoint of [
    "file:///tmp/model",
    "ftp://model.example",
    "https://user:secret@model.example",
    "https://model.example/?key=secret",
    "https://model.example/#secret",
  ]) {
    expect(
      Resource.Create.safeParse({ ...input, configuration: { ...input.configuration, endpoint } }).success,
    ).toBeFalse()
  }
  for (const changed of [
    { ...input, orgID: "forged" },
    { ...input, resourceID: "forged" },
    { ...input, configuration: { ...input.configuration, protocol: "unimplemented" } },
    { ...input, configuration: { ...input.configuration, headers: { Authorization: "injected" } } },
    {
      ...input,
      configuration: {
        ...input.configuration,
        model: { ...input.configuration.model, options: { apiKey: "injected" } },
      },
    },
    { ...input, credential: { kind: "bearer", value: "secret\r\ninjected: header" } },
    { ...input, credential: { kind: "header", name: "HOST", value: "other.example" } },
  ])
    expect(Resource.Create.safeParse(changed).success).toBeFalse()
  expect(Resource.Change.safeParse({ expectedRevision: 1, scope: { kind: "organization" } }).success).toBeFalse()
  expect(Resource.Change.safeParse({ expectedRevision: 1 }).success).toBeFalse()
  expect(Resource.GrantChange.safeParse({ expectedRevision: -1, enabled: true }).success).toBeFalse()
})

test("public resource definitions exclude endpoints, credentials and arbitrary runtime options", () => {
  const parsed = Resource.Create.parse(input)
  expect(Resource.Definition.safeParse(parsed.configuration).success).toBeFalse()
  if (!("endpoint" in parsed.configuration)) throw new Error("Expected the explicit endpoint fixture")
  const { endpoint: _, ...definition } = parsed.configuration
  expect(Resource.Definition.safeParse(definition).success).toBeTrue()
  expect(Resource.CredentialInfo.safeParse(parsed.credential).success).toBeFalse()
  if ("model" in definition)
    expect(definition.model.capabilities).toMatchObject({
      input: ["text"],
      output: ["text"],
      tools: true,
      reasoning: false,
    })
})
