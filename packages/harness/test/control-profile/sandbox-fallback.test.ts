import { describe, expect, test } from "bun:test"
import { resolveEffectiveSandbox } from "../../src/control-profile/profiles"
import { ScopeContext } from "../../src/scope/context"
import { tmpdir } from "../support/fixture"
import { afterAll as afterRuntimeTests } from "bun:test"
import { testRuntime } from "../support/runtime"
const runtime = await testRuntime()

// ---------------------------------------------------------------------------
// B3 anchors: autonomous fails closed when the OS sandbox cannot be prepared
// (fallback defaults to deny), guarded keeps warn, and the operator overrides
// (sandbox.fallbackPolicy / sandbox.enabled=false) still apply.
// ---------------------------------------------------------------------------

describe("resolveEffectiveSandbox (B3)", () => {
  test("autonomous defaults to fail-closed deny fallback", () =>
    runtime.run(async () => {
      await using tmp = await tmpdir()
      await ScopeContext.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const sb = await resolveEffectiveSandbox("autonomous")
          expect(sb.mode).toBe("workspace_write")
          expect(sb.fallback).toBe("deny")
        },
      })
    }))

  test("guarded keeps the historical warn fallback", () =>
    runtime.run(async () => {
      await using tmp = await tmpdir()
      await ScopeContext.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const sb = await resolveEffectiveSandbox("guarded")
          expect(sb.mode).toBe("workspace_write")
          expect(sb.fallback).toBe("warn")
        },
      })
    }))

  test("config sandbox.fallbackPolicy override still applies to autonomous", () =>
    runtime.run(async () => {
      await using tmp = await tmpdir({ config: { sandbox: { fallbackPolicy: "allow" } } })
      await ScopeContext.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const sb = await resolveEffectiveSandbox("autonomous")
          expect(sb.mode).toBe("workspace_write")
          expect(sb.fallback).toBe("allow")
        },
      })
    }))

  test("config sandbox.enabled=false disables the autonomous sandbox", () =>
    runtime.run(async () => {
      await using tmp = await tmpdir({ config: { sandbox: { enabled: false } } })
      await ScopeContext.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const sb = await resolveEffectiveSandbox("autonomous")
          expect(sb).toEqual({ mode: "none", fallback: "allow" })
        },
      })
    }))

  test("full_access sandbox stays none/allow", () =>
    runtime.run(async () => {
      await using tmp = await tmpdir()
      await ScopeContext.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const sb = await resolveEffectiveSandbox("full_access")
          expect(sb).toEqual({ mode: "none", fallback: "allow" })
        },
      })
    }))
})

afterRuntimeTests(() => runtime.close())
