import { describe, expect, test } from "bun:test"
import { AgentExternalSource } from "@ericsanchezok/synergy-harness/agent/external-source"
import { AgentPluginSource } from "@ericsanchezok/synergy-harness/agent/plugin-source"
import { registerAgentPluginSource } from "@ericsanchezok/synergy-plugin-host/plugin/agent-source"
import { registerAgentExternalSource } from "@ericsanchezok/synergy-agent-integrations/external-agent/agent-source"
import { registerNoteVirtualFileSource } from "@ericsanchezok/synergy-note/virtual-file-source"
import { registerPermissionPluginSource } from "@ericsanchezok/synergy-plugin-host/plugin/permission-source"
import { registerProviderPluginAuth } from "@ericsanchezok/synergy-plugin-host/plugin/provider-auth-source"
import { registerScopeLibraryStore } from "@ericsanchezok/synergy-library/scope-migration-store"
import { registerToolPluginSource } from "@ericsanchezok/synergy-plugin-host/plugin/tool-source"
import { registerLspToolSource } from "@ericsanchezok/synergy-agent-integrations/lsp/tool-source"
import { registerWorkspaceFileSymbolSource } from "@ericsanchezok/synergy-agent-integrations/lsp/workspace-symbol-source"
import { registerLspConfigCatalog } from "@ericsanchezok/synergy-agent-integrations/lsp/config-catalog"
import { registerToolLinkTargetSource } from "@ericsanchezok/synergy-agent-integrations/synergy-link/tool-target-source"
import { ToolLspSource } from "@ericsanchezok/synergy-harness/tool/lsp-source"
import { ToolNoteSource } from "@ericsanchezok/synergy-harness/tool/note-source"
import { ToolPluginSource } from "@ericsanchezok/synergy-harness/tool/plugin-source"
import { ToolLinkTargetSource } from "@ericsanchezok/synergy-harness/tool/link-target-source"
import { ConfigLspCatalog } from "@ericsanchezok/synergy-harness/config/lsp-catalog"
import { PermissionPluginSource } from "@ericsanchezok/synergy-harness/permission/plugin-source"
import { ProviderPluginAuth } from "@ericsanchezok/synergy-harness/provider/plugin-auth-source"
import { ScopeLibraryStore } from "@ericsanchezok/synergy-harness/scope/library-store"
import { WorkspaceFileSymbolSource } from "@ericsanchezok/synergy-runtime-local/workspace-file/symbol-source"

/**
 * S9d port contract: every register function exported for the L4 product
 * manifest mounts its L1 port. The parent session wires these into
 * src/product-registration.ts after both S9 workstreams land.
 */
describe("S9d source registrations", () => {
  test("agent plugin source registers and resolves through the port", () => {
    registerAgentPluginSource()
    expect(AgentPluginSource.get()).toBeDefined()
  })

  test("agent external source registers adapter loading and discovery", () => {
    registerAgentExternalSource()
    expect(AgentExternalSource.get()).toBeDefined()
  })

  test("note virtual-file source registers note markdown reads", () => {
    registerNoteVirtualFileSource()
    const source = ToolNoteSource.get()
    expect(source).toBeDefined()
    expect(source!.noteExtension).toBe(".md")
  })

  test("permission plugin source registers the ask-hook trigger", () => {
    registerPermissionPluginSource()
    expect(PermissionPluginSource.get()).toBeDefined()
  })

  test("provider plugin auth source registers hooks and profiles", () => {
    registerProviderPluginAuth()
    expect(ProviderPluginAuth.get()).toBeDefined()
  })

  test("scope library store registers experience scope accessors", () => {
    registerScopeLibraryStore()
    expect(ScopeLibraryStore.get()).toBeDefined()
  })

  test("tool plugin source registers tool entries and setting conditions", () => {
    registerToolPluginSource()
    expect(ToolPluginSource.get()).toBeDefined()
  })

  test("lsp tool source registers diagnostics access", () => {
    registerLspToolSource()
    const source = ToolLspSource.get()
    expect(source).toBeDefined()
    expect(typeof source!.diagnostics).toBe("function")
  })

  test("workspace-file symbol source registers client availability", () => {
    registerWorkspaceFileSymbolSource()
    expect(WorkspaceFileSymbolSource.get()).toBeDefined()
  })

  test("lsp config catalog registers builtin server ids", () => {
    registerLspConfigCatalog()
    expect(ConfigLspCatalog.isKnownServer("typescript")).toBe(true)
  })

  test("tool link target source registers target resolution", () => {
    registerToolLinkTargetSource()
    expect(ToolLinkTargetSource.get()).toBeDefined()
  })
})
