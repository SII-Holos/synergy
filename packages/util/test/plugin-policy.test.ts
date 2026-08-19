import { describe, expect, test } from "bun:test"
import {
  DEFAULT_PLUGIN_RUNTIME_LIMITS,
  decideTrust,
  defaultPluginTrustDecision,
  isTrustedPluginSource,
  resolvePluginPolicyDecision,
  resolveRuntimeLimits,
  resolveRuntimeMode,
  trustReason,
  trustSummary,
  validateRuntimePolicy,
} from "../src/plugin-policy"

describe("resolveRuntimeMode", () => {
  test("keeps built-ins in-process and external plugins out of process", () => {
    expect(resolveRuntimeMode({ source: "builtin" })).toBe("inProcess")
    expect(resolveRuntimeMode({ source: "official" })).toBe("process")
    expect(resolveRuntimeMode({ source: "local" })).toBe("process")
    expect(resolveRuntimeMode({ source: "npm" })).toBe("process")
    expect(resolveRuntimeMode({ source: "git" })).toBe("process")
    expect(resolveRuntimeMode({ source: "url" })).toBe("process")
  })
})

describe("resolveRuntimeLimits", () => {
  test("starts from the defaults", () => {
    expect(resolveRuntimeLimits()).toEqual(DEFAULT_PLUGIN_RUNTIME_LIMITS)
  })

  test("applies numeric positive overrides in order", () => {
    const limits = resolveRuntimeLimits({ maxMemoryMb: 256, startupTimeoutMs: 9_000 }, { maxMemoryMb: 128 })
    expect(limits.maxMemoryMb).toBe(128)
    expect(limits.startupTimeoutMs).toBe(9_000)
    expect(limits.toolInvocationTimeoutMs).toBe(DEFAULT_PLUGIN_RUNTIME_LIMITS.toolInvocationTimeoutMs)
  })

  test("ignores undefined, non-numeric, non-finite, and nonpositive overrides", () => {
    const limits = resolveRuntimeLimits(
      undefined,
      { maxMemoryMb: 0, heartbeatIntervalMs: -5, toolInvocationTimeoutMs: Number.NaN },
      { startupTimeoutMs: Number.POSITIVE_INFINITY },
    )
    expect(limits).toEqual(DEFAULT_PLUGIN_RUNTIME_LIMITS)
  })

  test("rounds fractional limits", () => {
    expect(resolveRuntimeLimits({ maxMemoryMb: 256.7 }).maxMemoryMb).toBe(257)
  })
})

describe("isTrustedPluginSource", () => {
  test("trusts builtin, official, and local sources only", () => {
    expect(isTrustedPluginSource("builtin")).toBe(true)
    expect(isTrustedPluginSource("official")).toBe(true)
    expect(isTrustedPluginSource("local")).toBe(true)
    expect(isTrustedPluginSource("npm")).toBe(false)
    expect(isTrustedPluginSource("git")).toBe(false)
    expect(isTrustedPluginSource("url")).toBe(false)
  })
})

describe("decideTrust", () => {
  test("promotes explicitly trusted or builtin plugins to the trusted-import tier", () => {
    expect(decideTrust({ source: "npm", userTrusted: true, verifiedIntegrity: false, devMode: false }).tier).toBe(
      "trusted-import",
    )
    expect(decideTrust({ source: "builtin", userTrusted: false, verifiedIntegrity: false, devMode: false }).tier).toBe(
      "trusted-import",
    )
  })

  test("keeps untrusted external plugins declarative", () => {
    expect(decideTrust({ source: "npm", userTrusted: false, verifiedIntegrity: true, devMode: true })).toEqual({
      source: "npm",
      userTrusted: false,
      verifiedIntegrity: true,
      tier: "declarative",
      reason: "plugin contributes declarations only until trusted",
    })
  })

  test("records the user-trusted reason", () => {
    const decision = decideTrust({ source: "local", userTrusted: true, verifiedIntegrity: false, devMode: false })
    expect(decision.reason).toBe("plugin UI was explicitly trusted")
  })
})

describe("defaultPluginTrustDecision", () => {
  test("trusts trusted sources by default", () => {
    expect(defaultPluginTrustDecision({ source: "official" }).tier).toBe("trusted-import")
    expect(defaultPluginTrustDecision({ source: "npm" }).tier).toBe("declarative")
  })

  test("passes explicit fields through", () => {
    expect(
      defaultPluginTrustDecision({ source: "npm", userTrusted: true, verifiedIntegrity: true, devMode: true }),
    ).toEqual({
      source: "npm",
      userTrusted: true,
      verifiedIntegrity: true,
      tier: "trusted-import",
      reason: "plugin UI was explicitly trusted",
    })
  })
})

describe("resolvePluginPolicyDecision", () => {
  test("combines capabilities, trust, and runtime mode", () => {
    const decision = resolvePluginPolicyDecision({
      manifest: { capabilities: [{ id: "fs.read" }, { id: "net.request" }] },
      source: "npm",
      userTrusted: true,
    })
    expect(decision).toEqual({
      source: "npm",
      capabilities: ["fs.read", "net.request"],
      trust: {
        source: "npm",
        userTrusted: true,
        verifiedIntegrity: false,
        tier: "trusted-import",
        reason: "plugin UI was explicitly trusted",
      },
      runtimeMode: "process",
    })
  })

  test("handles manifests without capabilities", () => {
    const decision = resolvePluginPolicyDecision({ manifest: {}, source: "builtin" })
    expect(decision.capabilities).toEqual([])
    expect(decision.runtimeMode).toBe("inProcess")
  })
})

describe("trust helpers and policy checks", () => {
  test("summarize trust decisions", () => {
    const decision = defaultPluginTrustDecision({ source: "npm" })
    expect(trustReason(decision)).toBe("plugin contributes declarations only until trusted")
    expect(trustSummary(decision)).toBe("declarative: plugin contributes declarations only until trusted")
  })

  test("validateRuntimePolicy reports a passing check", () => {
    expect(validateRuntimePolicy()).toEqual([
      { type: "pass", message: "External plugins use the process runtime; built-ins may use the inProcess runtime." },
    ])
  })
})
