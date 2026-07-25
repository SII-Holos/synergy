import { describe, expect, test } from "bun:test"
import {
  resolveProviderAuthMethods,
  runProviderDeviceCallback,
} from "../../../src/components/provider/provider-connection-model"

describe("provider connection model", () => {
  test("preserves both GitHub Copilot authentication methods", () => {
    const methods = resolveProviderAuthMethods({
      registry: {
        "github-copilot": [
          { type: "oauth", label: "Login with GitHub Copilot" },
          { type: "api", label: "GitHub token" },
        ],
      },
      providerID: "github-copilot",
      fallbackLabel: "API key",
    })

    expect(methods).toEqual([
      { type: "oauth", label: "Login with GitHub Copilot" },
      { type: "api", label: "GitHub token" },
    ])
  })

  test("reports device callback failures instead of leaving the waiting state active", async () => {
    let completed = false
    let failed = false

    await runProviderDeviceCallback({
      callback: () => Promise.reject(new Error("callback failed")),
      complete: async () => {
        completed = true
      },
      active: () => true,
      onError: () => {
        failed = true
      },
      onComplete: () => {
        completed = true
      },
    })

    expect(failed).toBe(true)
    expect(completed).toBe(false)
  })

  test("does not update an authentication flow after it is unmounted", async () => {
    let failed = false
    let completed = false

    await runProviderDeviceCallback({
      callback: () => Promise.reject(new Error("aborted")),
      complete: async () => {
        completed = true
      },
      active: () => false,
      onError: () => {
        failed = true
      },
      onComplete: () => {
        completed = true
      },
    })

    expect(failed).toBe(false)
    expect(completed).toBe(false)
  })
})
