import { describe, expect, test } from "bun:test"
import { ScopeStartup } from "@ericsanchezok/synergy-harness/scope/startup"
import { afterAll as afterRuntimeTests } from "bun:test"
import { testRuntime } from "../support/runtime"
const runtime = await testRuntime()

/**
 * H5 startup contribution contract (S9): after the product manifest loads,
 * every historical scope-startup step is registered as a contribution, and
 * the deterministic topological plan reproduces the historical startup
 * order exactly. Order-sensitive chain (blueprint): session-recovery →
 * lattice-runtime → resume-pending.
 */
describe("ScopeStartup registration", () => {
  test("product registration mounts all domain startup contributions", () =>
    runtime.run(() => {
      const names = ScopeStartup.registered().map((step) => step.name)
      expect(names).toContain("plugin-activate")
      expect(names).toContain("plugin-init")
      expect(names).toContain("lattice-runtime")
      expect(names).toContain("lsp-init")
      expect(names).toContain("vcs-init")
      expect(names).toContain("command-watcher")
    }))

  test("topological plan reproduces the historical startup order", () =>
    runtime.run(() => {
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
      expect(indexOf("lattice-runtime")).toBeLessThan(indexOf("resume-pending"))
      expect(plan).not.toContain("activity-summary")
      expect(indexOf("resume-pending")).toBeLessThan(indexOf("format"))
      expect(indexOf("format")).toBeLessThan(indexOf("lsp-init"))
      expect(indexOf("lsp-init")).toBeLessThan(indexOf("file-watcher"))
      expect(indexOf("file-watcher")).toBeLessThan(indexOf("vcs-init"))
      expect(indexOf("vcs-init")).toBeLessThan(indexOf("command-watcher"))
    }))

  test("a ready Runtime keeps its startup composition immutable", () =>
    runtime.run(() => {
      const before = ScopeStartup.plan()
      expect(() => ScopeStartup.reset()).toThrow("before opening")
      expect(() => ScopeStartup.register({ name: "late-step", phase: "core", init() {} })).toThrow("before opening")
      expect(ScopeStartup.plan()).toEqual(before)
    }))
})

afterRuntimeTests(() => runtime.close())
