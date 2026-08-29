import { describe, expect, test } from "bun:test"
import "../../src/product-registration"
import { SessionToolContext } from "../../src/session/tool-context"
import { ToolMcpSource } from "../../src/tool/mcp-source"
import { ToolRegistry } from "../../src/tool/registry"

/**
 * P9 tool execution context contract (S8): after the product manifest loads,
 * the L1 session tool resolver's product dependencies are mounted through
 * registries — the plugin source (gate data + tool hooks + degradation), the
 * blueprint access adapter, and the MCP tool source — and the surface tool
 * domains register their tools through providers instead of the static
 * builtin list.
 */
describe("SessionToolContext registration", () => {
  test("product registration mounts the plugin tool-context source", () => {
    expect(SessionToolContext.plugin()).toBeDefined()
  })

  test("product registration mounts the blueprint access adapter", () => {
    expect(SessionToolContext.blueprint()).toBeDefined()
  })

  test("product registration mounts the MCP tool source", () => {
    expect(ToolMcpSource.get()).toBeDefined()
  })

  test("unregistered blueprint access degrades to denied, not an error", async () => {
    const access = SessionToolContext.blueprint()
    if (!access) return
    const session = {
      id: "ses_test",
      blueprint: { loopRole: "execution", loopID: "bll_test" },
      scope: { id: "scp_test" },
    } as never
    await expect(access.canStopLoop(session)).resolves.toBe(false)
  })

  test("surface tool domains register providers drained by ToolRegistry", async () => {
    const providers = ToolRegistry.toolProviderIDs()
    expect(providers).toContain("boss")
    expect(providers).toContain("lattice")
    expect(providers).toContain("blueprint")
    expect(providers).toContain("lightloop")
  })
})
