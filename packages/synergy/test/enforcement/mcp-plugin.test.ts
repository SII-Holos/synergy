import { describe, expect, test } from "bun:test"
const { EnforcementGate } = await import("../../src/enforcement/gate")

// ---------------------------------------------------------------------------
// enforcement/mcp-plugin.test.ts
//
// Tests for the EnforcementGate MCP and plugin opaque strategy — unknown
// external tools must trigger ask/deny and never be auto-approved in
// unattended mode.
//
// These tests encode the MCP/plugin external I/O boundary contract.
// ---------------------------------------------------------------------------

// ------------------------------------------------------------------
// 1. Unknown MCP tools
// ------------------------------------------------------------------
describe("EnforcementGate MCP opaque strategy", () => {
  test("unknown MCP tool defaults to ask", async () => {
    const gate = await EnforcementGate.create({
      activeWorkspace: "/Users/test/synergy-control-profile",
      workspaceType: "worktree",
      profileId: "guarded",
    })

    const envelope = gate.evaluate("mcp__unknown_server__unknown_tool", {
      serverName: "unknown_server",
      toolName: "unknown_tool",
    })

    // Unknown MCP tools must default to "ask", not "allow"
    expect(envelope.decision).toBe("ask")
  })

  test("unknown MCP tool produces mcp_invoke capability with nonBypassable", async () => {
    const gate = await EnforcementGate.create({
      activeWorkspace: "/Users/test/synergy-control-profile",
      workspaceType: "worktree",
    })

    const result = gate.classify("mcp__github__list_repos", {})

    const mcpCap = result.capabilities.find((c: any) => c.class === "mcp_invoke")!
    expect(mcpCap).toBeDefined()
    // MCP invoke is an externalIO operation — always nonBypassable
    expect(mcpCap.nonBypassable).toBe(true)
  })

  test("MCP tool with unknown server name is classified as opaque", async () => {
    const gate = await EnforcementGate.create({
      activeWorkspace: "/Users/test/synergy-control-profile",
      workspaceType: "worktree",
    })

    const result = gate.classify("mcp__completely_fake_server__do_something", {})

    const mcpCap = result.capabilities.find((c: any) => c.class === "mcp_invoke")!
    expect(mcpCap).toBeDefined()
    expect(mcpCap.opaque).toBe(true)
  })

  test("unattended mode does not auto-approve unknown MCP tool", async () => {
    const gate = await EnforcementGate.create({
      activeWorkspace: "/Users/test/synergy-control-profile",
      workspaceType: "worktree",
      profileId: "guarded",
      interactionMode: "unattended",
    })

    const envelope = gate.evaluate("mcp__any_service__do_work", {
      serverName: "any_service",
      toolName: "do_work",
    })

    // Unattended mode must NOT auto-approve MCP opaque externalIO
    expect(envelope.decision).toBe("ask")
  })

  test("guarded profile asks for MCP tool invocations", async () => {
    const gate = await EnforcementGate.create({
      activeWorkspace: "/Users/test/synergy-control-profile",
      workspaceType: "worktree",
      profileId: "guarded",
    })

    const envelope = gate.evaluate("mcp__github__list_repos", {
      serverName: "github",
      toolName: "list_repos",
    })

    expect(envelope.decision).toBe("ask")
  })
})

// ------------------------------------------------------------------
// 2. Unknown plugin tools
// ------------------------------------------------------------------
describe("EnforcementGate plugin opaque strategy", () => {
  test("unknown plugin tool defaults to ask", async () => {
    const gate = await EnforcementGate.create({
      activeWorkspace: "/Users/test/synergy-control-profile",
      workspaceType: "worktree",
      profileId: "guarded",
    })

    const envelope = gate.evaluate("plugin__unknown_plugin__unknown_action", {
      pluginName: "unknown_plugin",
      actionName: "unknown_action",
    })

    // Unknown plugin tools must default to "ask", not "allow"
    expect(envelope.decision).toBe("ask")
  })

  test("unknown plugin tool produces plugin_invoke capability with nonBypassable", async () => {
    const gate = await EnforcementGate.create({
      activeWorkspace: "/Users/test/synergy-control-profile",
      workspaceType: "worktree",
    })

    const result = gate.classify("plugin__my_plugin__do_export", {})

    const pluginCap = result.capabilities.find((c: any) => c.class === "plugin_invoke")!
    expect(pluginCap).toBeDefined()
    // Plugin invoke is an externalIO operation — always nonBypassable
    expect(pluginCap.nonBypassable).toBe(true)
  })

  test("plugin tool with unknown plugin name is classified as opaque", async () => {
    const gate = await EnforcementGate.create({
      activeWorkspace: "/Users/test/synergy-control-profile",
      workspaceType: "worktree",
    })

    const result = gate.classify("plugin__no_such_plugin__run_task", {})

    const pluginCap = result.capabilities.find((c: any) => c.class === "plugin_invoke")!
    expect(pluginCap).toBeDefined()
    expect(pluginCap.opaque).toBe(true)
  })

  test("unattended mode does not auto-approve unknown plugin tool", async () => {
    const gate = await EnforcementGate.create({
      activeWorkspace: "/Users/test/synergy-control-profile",
      workspaceType: "worktree",
      profileId: "guarded",
      interactionMode: "unattended",
    })

    const envelope = gate.evaluate("plugin__remote_plugin__fetch", {
      pluginName: "remote_plugin",
      actionName: "fetch",
    })

    // Unattended mode must NOT auto-approve plugin opaque externalIO
    expect(envelope.decision).toBe("ask")
  })

  test("known plugin tools decompose manifest capabilities into gate capabilities", async () => {
    const gate = await EnforcementGate.create({
      activeWorkspace: "/Users/test/synergy-control-profile",
      workspaceType: "worktree",
      pluginToolCapabilities: {
        plugin__data_export__publish: {
          capabilities: ["plugin_invoke", "filesystem:read", "filesystem:write", "network", "shell"],
          risk: "high",
        },
      },
    })

    const result = gate.classify("plugin__data_export__publish", {})
    const classes = result.capabilities.map((cap: any) => cap.class)

    expect(classes).toContain("plugin_invoke")
    expect(classes).toContain("plugin_file_read")
    expect(classes).toContain("plugin_file_write")
    expect(classes).toContain("plugin_network")
    expect(classes).toContain("plugin_shell")
    expect(result.capabilities.find((cap: any) => cap.class === "plugin_invoke")?.opaque).toBe(false)
  })

  test("plugin approval records are keyed by canonical plugin id and mark unapproved sub-capabilities", async () => {
    const gate = await EnforcementGate.create({
      activeWorkspace: "/Users/test/synergy-control-profile",
      workspaceType: "worktree",
      pluginToolCapabilities: {
        plugin__data_export__publish: {
          capabilities: ["plugin_invoke", "filesystem:read", "filesystem:write", "network"],
          risk: "high",
        },
      },
      pluginApprovals: {
        data_export: {
          pluginId: "data_export",
          source: "npm",
          version: "1.0.0",
          manifestHash: "manifest",
          permissionsHash: "permissions",
          approvedAt: 1700000000000,
          approvedBy: "user",
          trustTier: "sandbox",
          approvedCapabilities: ["plugin_invoke", "filesystem:read"],
          approvedNetworkDomains: [],
          approvedUISurfaces: [],
          risk: "high",
        },
      },
    })

    const result = gate.classify("plugin__data_export__publish", {})

    expect(result.capabilities.find((cap: any) => cap.class === "plugin_file_read")?.approved).toBe(true)
    expect(result.capabilities.find((cap: any) => cap.class === "plugin_file_write")?.approved).toBe(false)
    expect(result.capabilities.find((cap: any) => cap.class === "plugin_file_write")?.reason).toBe("unapproved")
    expect(result.capabilities.find((cap: any) => cap.class === "plugin_network")?.approved).toBe(false)
  })
})

// ------------------------------------------------------------------
// 3. Known vs unknown MCP/plugin distinction
// ------------------------------------------------------------------
describe("EnforcementGate known vs unknown MCP/plugin", () => {
  test("known MCP tool from registered server can be allowed by profile", async () => {
    const gate = await EnforcementGate.create({
      activeWorkspace: "/Users/test/synergy-control-profile",
      workspaceType: "worktree",
      profileId: "guarded",
      registeredMcpTools: new Set(["mcp__github__list_repos"]),
    })

    const envelope = gate.evaluate("mcp__github__list_repos", {
      serverName: "github",
      toolName: "list_repos",
    })

    // Known MCP tools can be evaluated by profile rules — the profile may
    // still ask, but at least it gets classified as known (non-opaque)
    expect(envelope.opaque).toBe(false)
  })

  test("known plugin tool from registered plugin can be allowed by profile", async () => {
    const gate = await EnforcementGate.create({
      activeWorkspace: "/Users/test/synergy-control-profile",
      workspaceType: "worktree",
      profileId: "guarded",
      registeredPluginTools: new Set(["plugin__s3__upload"]),
    })

    const envelope = gate.evaluate("plugin__s3__upload", {
      pluginName: "s3",
      actionName: "upload",
    })

    // Known plugin tools get non-opaque treatment
    expect(envelope.opaque).toBe(false)
  })

  test("known MCP tool still asks under guarded profile", async () => {
    const gate = await EnforcementGate.create({
      activeWorkspace: "/Users/test/synergy-control-profile",
      workspaceType: "worktree",
      registeredMcpTools: new Set(["mcp__github__list_repos"]),
    })

    const envelope = gate.evaluate("mcp__github__list_repos", {
      serverName: "github",
      toolName: "list_repos",
    })

    expect(envelope.decision).toBe("ask")
  })
})

// ------------------------------------------------------------------
// 4. ExternalIO capability class consistency
// ------------------------------------------------------------------
describe("EnforcementGate externalIO capability classification", () => {
  test("all MCP and plugin invocations are classified as externalIO", async () => {
    const gate = await EnforcementGate.create({
      activeWorkspace: "/Users/test/synergy-control-profile",
      workspaceType: "worktree",
    })

    const tools = ["mcp__github__list_repos", "mcp__slack__send_message", "plugin__s3__upload", "plugin__email__send"]

    for (const toolName of tools) {
      const result = gate.classify(toolName, {})
      const externalIO = result.capabilities.some((c: any) => c.class === "mcp_invoke" || c.class === "plugin_invoke")
      expect(externalIO).toBe(true)
    }
  })

  test("externalIO capabilities are always nonBypassable", async () => {
    const gate = await EnforcementGate.create({
      activeWorkspace: "/Users/test/synergy-control-profile",
      workspaceType: "worktree",
    })

    const result = gate.classify("mcp__any_service__any_tool", {})

    for (const cap of result.capabilities) {
      if (cap.class === "mcp_invoke" || cap.class === "plugin_invoke") {
        expect(cap.nonBypassable).toBe(true)
      }
    }
  })
})
