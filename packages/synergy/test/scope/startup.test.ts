import { describe, expect, test } from "bun:test"
import "../../src/product-registration"
import { ScopeStartup } from "../../src/scope/startup"
import { registerPluginStartup } from "../../src/plugin/startup"
import { registerLatticeStartup } from "../../src/lattice/startup"
import { registerLspStartup } from "../../src/lsp/startup"
import { registerProjectStartup } from "../../src/project/startup"
import { registerCommandStartup } from "../../src/command/startup"

/**
 * H5 startup contribution contract (S9): after the product manifest loads,
 * every historical scope-startup step is registered as a contribution, and
 * the deterministic topological plan reproduces the historical startup
 * order exactly. Order-sensitive chain (blueprint): session-recovery →
 * lattice-runtime → activity-summary → resume-pending.
 */
describe("ScopeStartup registration", () => {
  test("product registration mounts all domain startup contributions", () => {
    const names = ScopeStartup.registered().map((step) => step.name)
    expect(names).toContain("plugin-activate")
    expect(names).toContain("plugin-init")
    expect(names).toContain("lattice-runtime")
    expect(names).toContain("lsp-init")
    expect(names).toContain("vcs-init")
    expect(names).toContain("command-watcher")
  })

  test("topological plan reproduces the historical startup order", () => {
    const plan = ScopeStartup.plan()
    const indexOf = (name: string) => {
      const index = plan.indexOf(name)
      expect(index).toBeGreaterThanOrEqual(0)
      return index
    }

    expect(indexOf("plugin-activate")).toBeLessThan(indexOf("starting-listeners"))
    expect(indexOf("starting-listeners")).toBeLessThan(indexOf("plugin-init"))
    expect(indexOf("plugin-init")).toBeLessThan(indexOf("session-recovery"))
    expect(indexOf("session-recovery")).toBeLessThan(indexOf("lattice-runtime"))
    expect(indexOf("lattice-runtime")).toBeLessThan(indexOf("activity-summary"))
    expect(indexOf("activity-summary")).toBeLessThan(indexOf("resume-pending"))
    expect(indexOf("resume-pending")).toBeLessThan(indexOf("format"))
    expect(indexOf("format")).toBeLessThan(indexOf("lsp-init"))
    expect(indexOf("lsp-init")).toBeLessThan(indexOf("file-watcher"))
    expect(indexOf("file-watcher")).toBeLessThan(indexOf("vcs-init"))
    expect(indexOf("vcs-init")).toBeLessThan(indexOf("command-watcher"))
  })

  test("reset() keeps contributions recoverable: re-registration restores the full set", () => {
    // Pins the invariant the restore-dance in the test above relies on:
    // register dedupes by name against the live contributions array (no
    // module-level latched flags), so reset() followed by re-registering
    // the domain modules always restores the complete startup set.
    const before = ScopeStartup.registered()
      .map((step) => step.name)
      .sort()
    ScopeStartup.reset()
    expect(ScopeStartup.registered()).toEqual([])
    registerPluginStartup()
    registerLatticeStartup()
    registerLspStartup()
    registerProjectStartup()
    registerCommandStartup()
    const after = ScopeStartup.registered()
      .map((step) => step.name)
      .sort()
    expect(after).toEqual(before)
  })

  test("mis-registered ordering references fail loudly", () => {
    ScopeStartup.reset()
    try {
      ScopeStartup.register({
        name: "test-step",
        phase: "core",
        after: ["nonexistent-anchor"],
        init: () => {},
      })
      expect(() => ScopeStartup.plan()).toThrow("references unknown step")
    } finally {
      ScopeStartup.reset()
      // restore the product registrations for other tests in this process
      registerPluginStartup()
      registerLatticeStartup()
      registerLspStartup()
      registerProjectStartup()
      registerCommandStartup()
    }
  })
})
