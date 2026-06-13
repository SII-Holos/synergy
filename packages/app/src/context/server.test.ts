import { describe, expect, test } from "bun:test"
import { hostedAgentServerUrl, normalizeServerUrlForDefault } from "./server"

describe("hosted server URL normalization", () => {
  test("extracts the canonical hosted agent server URL", () => {
    expect(hostedAgentServerUrl("https://test-synergy.holosai.io/agents/agent-1/c/path")).toBe(
      "https://test-synergy.holosai.io/agents/agent-1",
    )
  })

  test("forces hosted mode back to the current agent URL", () => {
    expect(
      normalizeServerUrlForDefault(
        "https://test-synergy.holosai.io/agents/agent-1/c/path",
        "https://test-synergy.holosai.io/agents/agent-1",
      ),
    ).toBe("https://test-synergy.holosai.io/agents/agent-1")
  })

  test("keeps regular server URL behavior outside hosted mode", () => {
    expect(normalizeServerUrlForDefault("localhost:4096/", "http://localhost:4096")).toBe(
      "http://localhost:4096",
    )
  })
})
