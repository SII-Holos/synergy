import { describe, expect, test } from "bun:test"
import { validateRuntimePolicy } from "../../src/plugin/runtime-policy"
import type { PluginManifest } from "@ericsanchezok/synergy-plugin"

function makeManifest(overrides: Partial<PluginManifest> = {}): PluginManifest {
  const base: PluginManifest = {
    name: "test-plugin",
    version: "1.0.0",
    description: "A test plugin",
  } as PluginManifest
  return { ...base, ...overrides } as PluginManifest
}

describe("validateRuntimePolicy", () => {
  // ── Runtime resolver consistency ──

  test("third-party npm plugin requesting in-process warns that runtime resolves to process", () => {
    const manifest = makeManifest({
      runtime: { mode: "in-process" },
    })
    const results = validateRuntimePolicy({
      manifest,
      source: "npm",
      trustTier: "sandbox",
      risk: "low",
    })
    const errors = results.filter((r) => r.type === "error")
    const warnings = results.filter((r) => r.type === "warn")
    expect(errors.length).toBe(0)
    expect(
      warnings.some((warning) => warning.message.includes('"in-process"') && warning.message.includes('"process"')),
    ).toBe(true)
  })

  test("third-party git plugin defaulting to process does not fail validation", () => {
    const manifest = makeManifest({})
    const results = validateRuntimePolicy({
      manifest,
      source: "git",
      trustTier: "sandbox",
      risk: "low",
    })
    const errors = results.filter((r) => r.type === "error")
    expect(errors.length).toBe(0)
  })

  test("third-party url plugin requesting in-process warns that runtime resolves to process", () => {
    const manifest = makeManifest({
      runtime: { mode: "in-process" },
    })
    const results = validateRuntimePolicy({
      manifest,
      source: "url",
      trustTier: "sandbox",
      risk: "low",
    })
    const errors = results.filter((r) => r.type === "error")
    const warnings = results.filter((r) => r.type === "warn")
    expect(errors.length).toBe(0)
    expect(
      warnings.some((warning) => warning.message.includes('"in-process"') && warning.message.includes('"process"')),
    ).toBe(true)
  })

  test("local plugin requesting in-process is allowed (no error)", () => {
    const manifest = makeManifest({
      runtime: { mode: "in-process" },
    })
    const results = validateRuntimePolicy({
      manifest,
      source: "local",
      trustTier: "trusted-import",
      risk: "low",
    })
    const errors = results.filter((r) => r.type === "error")
    const thirdPartyErrors = errors.filter((e) => e.message.toLowerCase().includes("third-party"))
    expect(thirdPartyErrors.length).toBe(0)
  })

  test("builtin plugin requesting in-process is allowed (no error)", () => {
    const manifest = makeManifest({
      runtime: { mode: "in-process" },
    })
    const results = validateRuntimePolicy({
      manifest,
      source: "builtin",
      trustTier: "trusted-import",
      risk: "low",
    })
    const errors = results.filter((r) => r.type === "error")
    const thirdPartyErrors = errors.filter((e) => e.message.toLowerCase().includes("third-party"))
    expect(thirdPartyErrors.length).toBe(0)
  })

  // ── High risk resolves through the same policy ──

  test("high-risk plugin in-process mode warns that runtime resolves to process", () => {
    const manifest = makeManifest({
      runtime: { mode: "in-process" },
    })
    const results = validateRuntimePolicy({
      manifest,
      source: "local",
      trustTier: "trusted-import",
      risk: "high",
    })
    const errors = results.filter((r) => r.type === "error")
    const warnings = results.filter((r) => r.type === "warn")
    expect(errors.length).toBe(0)
    expect(
      warnings.some((warning) => warning.message.includes('"in-process"') && warning.message.includes('"process"')),
    ).toBe(true)
  })

  test("high-risk plugin in worker mode is allowed (no in-process error)", () => {
    const manifest = makeManifest({
      runtime: { mode: "worker" },
    })
    const results = validateRuntimePolicy({
      manifest,
      source: "local",
      trustTier: "trusted-import",
      risk: "high",
    })
    const errors = results.filter((r) => r.type === "error")
    const inProcessErrors = errors.filter(
      (e) => e.message.toLowerCase().includes("high-risk") && e.message.toLowerCase().includes("in-process"),
    )
    expect(inProcessErrors.length).toBe(0)
  })

  test("high-risk plugin in process mode (isolated) is allowed (no error)", () => {
    const manifest = makeManifest({
      runtime: { mode: "process" },
    })
    const results = validateRuntimePolicy({
      manifest,
      source: "local",
      trustTier: "trusted-import",
      risk: "high",
    })
    const errors = results.filter((r) => r.type === "error")
    const inProcessErrors = errors.filter(
      (e) => e.message.toLowerCase().includes("high-risk") && e.message.toLowerCase().includes("in-process"),
    )
    expect(inProcessErrors.length).toBe(0)
  })

  // ── Rule 3: sandbox+trusted-import mismatch → warning ──

  test("sandbox trust tier with non-sandbox mode request produces warning", () => {
    const manifest = makeManifest({
      runtime: { mode: "worker" },
    })
    const results = validateRuntimePolicy({
      manifest,
      source: "npm",
      trustTier: "sandbox",
      risk: "medium",
    })
    const warnings = results.filter((r) => r.type === "warn")
    expect(warnings.length).toBeGreaterThan(0)
    expect(warnings.some((warning) => warning.message.toLowerCase().includes("sandbox"))).toBe(true)
  })

  test("sandbox trust tier with process mode request produces warning", () => {
    const manifest = makeManifest({
      runtime: { mode: "process" },
    })
    const results = validateRuntimePolicy({
      manifest,
      source: "npm",
      trustTier: "sandbox",
      risk: "medium",
    })
    const warnings = results.filter((r) => r.type === "warn")
    expect(warnings.length).toBeGreaterThan(0)
    expect(warnings[0].message.toLowerCase()).toContain("sandbox")
  })

  test("trusted-import trust tier with sandbox request produces warning", () => {
    const manifest = makeManifest({
      trust: { requestedTier: "sandbox" },
      runtime: { mode: "in-process" },
    })
    const results = validateRuntimePolicy({
      manifest,
      source: "local",
      trustTier: "trusted-import",
      risk: "low",
    })
    const warnings = results.filter((r) => r.type === "warn")
    expect(warnings.length).toBeGreaterThan(0)
    expect(warnings[0].message.toLowerCase()).toContain("trusted-import")
  })

  test("matching sandbox trust tier and sandbox mode produces no mismatch warning", () => {
    const manifest = makeManifest({
      trust: { requestedTier: "sandbox" },
    })
    const results = validateRuntimePolicy({
      manifest,
      source: "npm",
      trustTier: "sandbox",
      risk: "low",
    })
    const warnings = results.filter((r) => r.type === "warn")
    const mismatchWarnings = warnings.filter(
      (w) => w.message.toLowerCase().includes("mismatch") || w.message.toLowerCase().includes("sandbox"),
    )
    expect(mismatchWarnings.length).toBe(0)
  })

  // ── Rule 4: worker mode unsupported APIs → warning ──

  test("worker mode with shell capability produces warning", () => {
    const manifest = makeManifest({
      runtime: { mode: "worker" },
      permissions: {
        tools: { shell: true, filesystem: "none", network: false, mcp: "none" },
      },
      contributes: {
        tools: [
          {
            name: "run",
            description: "Run shell commands",
            capabilities: { shell: true },
          },
        ],
      },
    })
    const results = validateRuntimePolicy({
      manifest,
      source: "local",
      trustTier: "trusted-import",
      risk: "high",
    })
    const warnings = results.filter((r) => r.type === "warn")
    expect(warnings.length).toBeGreaterThan(0)
    expect(warnings[0].message.toLowerCase()).toContain("worker")
  })

  test("worker mode with file_write capability produces warning", () => {
    const manifest = makeManifest({
      runtime: { mode: "worker" },
      permissions: {
        tools: { shell: false, filesystem: "write", network: false, mcp: "none" },
      },
    })
    const results = validateRuntimePolicy({
      manifest,
      source: "local",
      trustTier: "trusted-import",
      risk: "high",
    })
    const warnings = results.filter((r) => r.type === "warn")
    expect(warnings.length).toBeGreaterThan(0)
    expect(warnings[0].message.toLowerCase()).toContain("worker")
  })

  test("worker mode with low-risk capabilities only produces no warning", () => {
    const manifest = makeManifest({
      runtime: { mode: "worker" },
      permissions: {
        tools: { shell: false, filesystem: "read", network: false, mcp: "none" },
      },
    })
    const results = validateRuntimePolicy({
      manifest,
      source: "local",
      trustTier: "trusted-import",
      risk: "medium",
      userTrusted: true,
    })
    const warnings = results.filter((r) => r.type === "warn")
    const workerWarnings = warnings.filter((w) => w.message.toLowerCase().includes("worker"))
    expect(workerWarnings.length).toBe(0)
  })

  // ── Rule 5: process mode missing resources → warning ──

  test("process mode without resource limits produces warning", () => {
    const manifest = makeManifest({
      runtime: { mode: "process" },
    })
    const results = validateRuntimePolicy({
      manifest,
      source: "local",
      trustTier: "trusted-import",
      risk: "medium",
    })
    const warnings = results.filter((r) => r.type === "warn")
    expect(warnings.length).toBeGreaterThan(0)
    expect(warnings[0].message.toLowerCase()).toContain("resource")
  })

  test("process mode with memoryMb specified produces no resource warning", () => {
    const manifest = makeManifest({
      runtime: {
        mode: "process",
        resources: {
          memoryMb: 128,
        },
      },
    })
    const results = validateRuntimePolicy({
      manifest,
      source: "local",
      trustTier: "trusted-import",
      risk: "medium",
    })
    const warnings = results.filter((r) => r.type === "warn")
    const resourceWarnings = warnings.filter((w) => w.message.toLowerCase().includes("resource"))
    expect(resourceWarnings.length).toBe(0)
  })

  test("in-process mode without resources produces no resource warning", () => {
    const manifest = makeManifest({
      runtime: { mode: "in-process" },
    })
    const results = validateRuntimePolicy({
      manifest,
      source: "local",
      trustTier: "trusted-import",
      risk: "low",
    })
    const warnings = results.filter((r) => r.type === "warn")
    const resourceWarnings = warnings.filter((w) => w.message.toLowerCase().includes("resource"))
    expect(resourceWarnings.length).toBe(0)
  })
})
