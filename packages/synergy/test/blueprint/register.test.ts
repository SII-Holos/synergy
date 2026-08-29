import { describe, expect, test } from "bun:test"
// The L4 manifest registers every built-in product domain
import "../../src/product-registration"
import { ContinuationKernel } from "../../src/session/continuation-kernel"
import { WorkflowPromptRegistry } from "../../src/session/workflow-prompt-registry"
import { ToolRegistry } from "../../src/tool/registry"

/**
 * Blueprint domain registration canary: after the L4 product manifest loads,
 * the continuation policy, the prompt contribution (control sources + plugin
 * timer reattach), and the domain tool provider are all registered. This is
 * the wiring contract every real entry point (CLI and server) shares.
 */
describe("blueprint domain registration (L4 manifest canary)", () => {
  test("continuation policy is registered under the blueprint provider", () => {
    expect(ContinuationKernel.registeredPolicyIDs()).toContain("blueprint_loop")
  })

  test("prompt contribution carries the control sources and the timer reattach hook", () => {
    const contribution = WorkflowPromptRegistry.get("blueprint")
    expect(contribution).toBeDefined()
    expect([...(contribution?.controlSources ?? [])].sort()).toEqual([
      "blueprint_loop_continuation",
      "blueprint_loop_rejected",
      "blueprint_loop_start",
    ])
    expect(typeof contribution?.reattachPluginTimers).toBe("function")
  })

  test("domain tools are registered under the blueprint provider", () => {
    expect(ToolRegistry.toolProviderIDs()).toContain("blueprint")
  })
})
