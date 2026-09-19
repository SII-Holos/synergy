import { describe, expect, test } from "bun:test"
import type { ProviderListResponse } from "@ericsanchezok/synergy-sdk/client"
import { resolveModelReadiness } from "../../../src/components/provider/model-readiness"

type Availability = ProviderListResponse["runtimeAvailability"][string]
type AuthHealth = ProviderListResponse["authHealth"][string]

function snapshot(input: {
  connected: string[]
  availability?: Record<string, Partial<Availability>>
  authHealth?: Record<string, Partial<AuthHealth>>
}): ProviderListResponse {
  const runtimeAvailability = Object.fromEntries(
    Object.entries(input.availability ?? {}).map(([providerID, value]) => [
      providerID,
      { providerID, available: false, modelCount: 0, ...value },
    ]),
  )
  const authHealth = Object.fromEntries(
    Object.entries(input.authHealth ?? {}).map(([providerID, value]) => [
      providerID,
      { providerID, status: "connected" as const, ...value },
    ]),
  )
  return {
    all: [],
    default: {},
    connected: input.connected,
    configProviders: [],
    catalogProviders: [],
    profiles: {},
    connections: {},
    authHealth,
    runtimeAvailability,
    modelCatalog: {},
  }
}

describe("model readiness derivation", () => {
  test("ready when one connected provider exposes a usable model", () => {
    const readiness = resolveModelReadiness(
      snapshot({
        connected: ["deepseek"],
        availability: { deepseek: { available: true, modelCount: 42, reason: "connected" } },
      }),
    )
    expect(readiness).toEqual({ state: "ready" })
  })

  test("not-configured for the store's default empty shape", () => {
    const readiness = resolveModelReadiness(snapshot({ connected: [], availability: {}, authHealth: {} }))
    expect(readiness).toEqual({ state: "not-configured" })
  })

  test("needs-attention when credentials require action", () => {
    const readiness = resolveModelReadiness(
      snapshot({
        connected: ["anthropic"],
        availability: { anthropic: { available: false, reason: "authentication_required", modelCount: 12 } },
        authHealth: { anthropic: { status: "action_required", recovery: "reconnect" } },
      }),
    )
    expect(readiness).toEqual({ state: "needs-attention", providerIDs: ["anthropic"] })
  })

  test("needs-attention when a credential quota is exhausted", () => {
    const readiness = resolveModelReadiness(
      snapshot({
        connected: ["openai"],
        availability: { openai: { available: false, reason: "exhausted", modelCount: 8 } },
        authHealth: { openai: { status: "exhausted" } },
      }),
    )
    expect(readiness).toEqual({ state: "needs-attention", providerIDs: ["openai"] })
  })

  test("restricted when the only blocking reason is a disabled provider", () => {
    const readiness = resolveModelReadiness(
      snapshot({
        connected: ["groq"],
        availability: { groq: { available: false, reason: "disabled", modelCount: 20 } },
        authHealth: { groq: { status: "connected" } },
      }),
    )
    expect(readiness).toEqual({ state: "restricted", providerIDs: ["groq"] })
  })

  test("restricted when a connected provider has no selectable model", () => {
    const readiness = resolveModelReadiness(
      snapshot({
        connected: ["local"],
        availability: { local: { available: false, reason: "no_models", modelCount: 0 } },
        authHealth: { local: { status: "connected" } },
      }),
    )
    expect(readiness).toEqual({ state: "restricted", providerIDs: ["local"] })
  })

  test("restricted when the snapshot carries no availability entry for a connected provider", () => {
    const readiness = resolveModelReadiness(snapshot({ connected: ["mystery"], availability: {} }))
    expect(readiness).toEqual({ state: "restricted", providerIDs: ["mystery"] })
  })

  test("one available provider among blocked ones is ready", () => {
    const readiness = resolveModelReadiness(
      snapshot({
        connected: ["a-blocked", "deepseek", "z-fixme"],
        availability: {
          "a-blocked": { available: false, reason: "authentication_required", modelCount: 3 },
          deepseek: { available: true, reason: "connected", modelCount: 7 },
          "z-fixme": { available: false, reason: "disabled", modelCount: 1 },
        },
        authHealth: { "a-blocked": { status: "action_required" } },
      }),
    )
    expect(readiness).toEqual({ state: "ready" })
  })

  test("returns affected provider ids in deterministic order", () => {
    const readiness = resolveModelReadiness(
      snapshot({
        connected: ["zeta", "alpha", "mid"],
        availability: {
          zeta: { available: false, reason: "disabled", modelCount: 1 },
          alpha: { available: false, reason: "no_models", modelCount: 0 },
          mid: { available: false, reason: "disabled", modelCount: 4 },
        },
      }),
    )
    expect(readiness).toEqual({ state: "restricted", providerIDs: ["alpha", "mid", "zeta"] })
  })

  test("ranks needs-attention above restricted when connected providers disagree", () => {
    const readiness = resolveModelReadiness(
      snapshot({
        connected: ["disabled-one", "expired-one"],
        availability: {
          "disabled-one": { available: false, reason: "disabled", modelCount: 2 },
          "expired-one": { available: false, reason: "exhausted", modelCount: 9 },
        },
        authHealth: { "expired-one": { status: "exhausted" } },
      }),
    )
    expect(readiness).toEqual({ state: "needs-attention", providerIDs: ["expired-one"] })
  })

  test("available: false alone is not ready, and available: true alone is", () => {
    expect(
      resolveModelReadiness(snapshot({ connected: ["x"], availability: { x: { available: false, modelCount: 5 } } })),
    ).toEqual({ state: "restricted", providerIDs: ["x"] })
    expect(
      resolveModelReadiness(snapshot({ connected: ["x"], availability: { x: { available: true, modelCount: 5 } } })),
    ).toEqual({ state: "ready" })
  })
})
