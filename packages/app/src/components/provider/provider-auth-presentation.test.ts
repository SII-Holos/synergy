import { describe, expect, test } from "bun:test"
import {
  providerNeedsAction,
  providerRecoveryCopy,
  providerStatusLabel,
  providerUsageStatusLabel,
} from "./provider-auth-presentation"

describe("provider auth presentation", () => {
  test("durable action-required and immediate usage rejection share one decision", () => {
    expect(providerNeedsAction({ providerID: "a", status: "action_required" })).toBe(true)
    expect(
      providerNeedsAction(undefined, {
        providerID: "a",
        status: "error",
        fetchedAt: new Date(0).toISOString(),
        windows: [],
        details: [],
        reloginRequired: true,
      }),
    ).toBe(true)
  })

  test("exhaustion never turns a stale usage hint into a login prompt", () => {
    expect(
      providerNeedsAction(
        { providerID: "a", status: "exhausted" },
        {
          providerID: "a",
          status: "error",
          fetchedAt: new Date(0).toISOString(),
          windows: [],
          details: [],
          reloginRequired: true,
        },
      ),
    ).toBe(false)
    expect(providerStatusLabel({ providerID: "a", status: "exhausted" })).toBe("Temporarily unavailable")
  })

  test("recovery copy distinguishes environment, API-key, and OAuth actions", () => {
    expect(
      providerRecoveryCopy(
        "GitHub",
        { providerID: "github", status: "action_required", recovery: "update_environment" },
        ["GH_TOKEN", "GITHUB_TOKEN"],
      ),
    ).toContain("GH_TOKEN or GITHUB_TOKEN")
    expect(
      providerRecoveryCopy("OpenRouter", {
        providerID: "openrouter",
        status: "action_required",
        authKind: "api_key",
      }),
    ).toContain("Replace")
    expect(providerRecoveryCopy("OpenAI Codex", { providerID: "openai-codex", status: "action_required" })).toContain(
      "Reconnect",
    )
  })

  test("usage badges distinguish rejection, exhaustion, and transient failure", () => {
    const snapshot = (status: "available" | "unavailable" | "error", reloginRequired = false) => ({
      providerID: "a",
      status,
      fetchedAt: new Date(0).toISOString(),
      windows: [],
      details: [],
      reloginRequired,
    })
    expect(providerUsageStatusLabel(undefined, snapshot("error", true))).toBe("Sign-in required")
    expect(providerUsageStatusLabel({ providerID: "a", status: "exhausted" }, snapshot("error"))).toBe(
      "Temporarily unavailable",
    )
    expect(providerUsageStatusLabel({ providerID: "a", status: "connected" }, snapshot("error"))).toBe("Retry")
  })
})
