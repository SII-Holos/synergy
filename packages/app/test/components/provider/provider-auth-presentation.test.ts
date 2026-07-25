import { describe, expect, test } from "bun:test"
import { setupI18n, type MessageDescriptor } from "@lingui/core"
import { disconnectProviderConfirm } from "../../../src/components/dialog/confirm-copy"
import {
  providerCanDisconnect,
  providerNeedsAction,
  providerRecoveryCopy,
  providerStatusLabel,
  providerUsageStatusLabel,
} from "../../../src/components/provider/provider-auth-presentation"

const i18n = setupI18n({ locale: "en" })

function render(descriptor: MessageDescriptor): string {
  return i18n._(descriptor)
}

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
    expect(render(providerStatusLabel({ providerID: "a", status: "exhausted" }))).toBe("Temporarily unavailable")
  })

  test("recovery copy distinguishes environment, API-key, and OAuth actions", () => {
    const githubCopy = providerRecoveryCopy(
      "GitHub",
      { providerID: "github", status: "action_required", recovery: "update_environment" },
      ["GH_TOKEN", "GITHUB_TOKEN"],
    )
    expect(render(githubCopy)).toContain("GH_TOKEN or GITHUB_TOKEN")
    const openRouterCopy = providerRecoveryCopy("OpenRouter", {
      providerID: "openrouter",
      status: "action_required",
      authKind: "api_key",
    })
    expect(render(openRouterCopy)).toContain("Replace")
    const codexCopy = providerRecoveryCopy("OpenAI Codex", { providerID: "openai-codex", status: "action_required" })
    expect(render(codexCopy)).toContain("Reconnect")
  })

  test("disconnect is limited to rejected Synergy-managed credentials", () => {
    expect(
      providerCanDisconnect({
        providerID: "openrouter",
        status: "action_required",
        canDisconnect: true,
      }),
    ).toBe(true)
    expect(
      providerCanDisconnect({
        providerID: "openrouter",
        status: "connected",
        canDisconnect: true,
      }),
    ).toBe(false)
    expect(
      providerCanDisconnect({
        providerID: "openrouter",
        status: "action_required",
        canDisconnect: false,
      }),
    ).toBe(false)
  })

  test("disconnect confirmation explains preserved provider configuration", () => {
    const copy = disconnectProviderConfirm("OpenRouter")
    expect(render(copy.title)).toBe("Disconnect provider?")
    expect(render(copy.description)).toContain("OpenRouter")
    expect(render(copy.description)).toContain("provider and model configuration")
    expect(render(copy.confirmLabel)).toBe("Disconnect")
    expect(copy.tone).toBe("warning")
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
    expect(render(providerUsageStatusLabel(undefined, snapshot("error", true)))).toBe("Sign-in required")
    expect(render(providerUsageStatusLabel({ providerID: "a", status: "exhausted" }, snapshot("error")))).toBe(
      "Temporarily unavailable",
    )
    expect(render(providerUsageStatusLabel({ providerID: "a", status: "connected" }, snapshot("error")))).toBe("Retry")
  })
})
