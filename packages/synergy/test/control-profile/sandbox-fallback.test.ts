import { describe, expect, test } from "bun:test"
import { resolveEffectiveSandbox } from "../../src/control-profile/profiles"
import { ScopeContext } from "../../src/scope/context"
import { tmpdir } from "../fixture/fixture"

// ---------------------------------------------------------------------------
// B3 anchors: autonomous fails closed when the OS sandbox cannot be prepared
// (fallback defaults to deny), guarded keeps warn, and the operator overrides
// (sandbox.fallbackPolicy / sandbox.enabled=false) still apply.
// ---------------------------------------------------------------------------

describe("resolveEffectiveSandbox (B3)", () => {
  test("autonomous defaults to fail-closed deny fallback", async () => {
    await using tmp = await tmpdir()
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const sb = await resolveEffectiveSandbox("autonomous")
        expect(sb.mode).toBe("workspace_write")
        expect(sb.fallback).toBe("deny")
      },
    })
  })

  test("guarded keeps the historical warn fallback", async () => {
    await using tmp = await tmpdir()
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const sb = await resolveEffectiveSandbox("guarded")
        expect(sb.mode).toBe("workspace_write")
        expect(sb.fallback).toBe("warn")
      },
    })
  })

  test("config sandbox.fallbackPolicy override still applies to autonomous", async () => {
    await using tmp = await tmpdir({ config: { sandbox: { fallbackPolicy: "allow" } } })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const sb = await resolveEffectiveSandbox("autonomous")
        expect(sb.mode).toBe("workspace_write")
        expect(sb.fallback).toBe("allow")
      },
    })
  })

  test("config sandbox.enabled=false disables the autonomous sandbox", async () => {
    await using tmp = await tmpdir({ config: { sandbox: { enabled: false } } })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const sb = await resolveEffectiveSandbox("autonomous")
        expect(sb).toEqual({ mode: "none", fallback: "allow" })
      },
    })
  })

  test("full_access sandbox stays none/allow", async () => {
    await using tmp = await tmpdir()
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const sb = await resolveEffectiveSandbox("full_access")
        expect(sb).toEqual({ mode: "none", fallback: "allow" })
      },
    })
  })
})
