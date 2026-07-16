import { describe, expect, test } from "bun:test"
import type { ProviderAuthHealth } from "@ericsanchezok/synergy-sdk/client"
import { selectAppAttention } from "./app-attention"

function msg(d: { message?: string }): string {
  return d.message ?? ""
}

const hiddenUpdate = {
  visible: false,
  title: { id: "test.productUpdate.hidden.title", message: "Product update available" },
  detail: { id: "test.productUpdate.hidden.detail", message: "A new version is ready to install." },
  actionLabel: null,
  action: null,
  progress: null,
  tone: "neutral" as const,
  busy: false,
}

function auth(providerID: string): ProviderAuthHealth {
  return { providerID, status: "action_required", recovery: "reconnect" }
}

describe("app attention selector", () => {
  test("an active updater stays above provider authentication", () => {
    const notice = selectAppAttention({
      productUpdate: {
        ...hiddenUpdate,
        visible: true,
        title: { id: "test.productUpdate.active.title", message: "Downloading Synergy" },
        tone: "active",
        progress: 40,
      },
      authHealth: { anthropic: auth("anthropic") },
      providerNames: { anthropic: "Anthropic" },
    })
    expect(notice?.source).toBe("product-update")
    expect(notice?.priority).toBe(400)
  })

  test("authentication is above update failures and ready updates", () => {
    for (const tone of ["error", "ready"] as const) {
      const notice = selectAppAttention({
        productUpdate: {
          ...hiddenUpdate,
          visible: true,
          title: { id: "test.productUpdate.ready.title", message: "Update" },
          tone,
          action: "check",
        },
        authHealth: { "openai-codex": auth("openai-codex") },
        providerNames: { "openai-codex": "OpenAI Codex" },
      })
      expect(notice?.source).toBe("provider-auth")
    }
  })

  test("multiple providers aggregate into one stable notice", () => {
    const notice = selectAppAttention({
      productUpdate: hiddenUpdate,
      authHealth: { github: auth("github"), anthropic: auth("anthropic"), "openai-codex": auth("openai-codex") },
      providerNames: {},
    })
    expect(msg(notice!.title)).toBe("3 providers need attention")
    expect(notice?.action).toEqual({ type: "open-settings", section: "providers" })
  })

  test("a single provider focuses its recovery target and GitHub routes to GitHub settings", () => {
    const codex = selectAppAttention({
      productUpdate: hiddenUpdate,
      authHealth: { "openai-codex": auth("openai-codex") },
      providerNames: { "openai-codex": "OpenAI Codex" },
    })
    expect(codex?.action).toEqual({
      type: "open-settings",
      section: "providers",
      providerID: "openai-codex",
    })

    const github = selectAppAttention({
      productUpdate: hiddenUpdate,
      authHealth: { github: auth("github") },
      providerNames: { github: "GitHub" },
    })
    expect(github?.action).toEqual({ type: "open-settings", section: "github" })
  })
})
