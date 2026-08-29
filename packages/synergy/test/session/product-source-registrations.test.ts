import { describe, expect, test } from "bun:test"
import { AgentExternalSource } from "../../src/agent/external-source"
import { AgentPluginSource } from "../../src/agent/plugin-source"
import { registerAgentPluginSource } from "../../src/plugin/agent-source"
import { registerAgentExternalSource } from "../../src/external-agent/agent-source"
import { registerNoteVirtualFileSource } from "../../src/note/virtual-file-source"
import { registerPermissionPluginSource } from "../../src/plugin/permission-source"
import { registerProviderPluginAuth } from "../../src/plugin/provider-auth-source"
import { registerScopeLibraryStore } from "../../src/library/scope-migration-store"
import { registerToolPluginSource } from "../../src/plugin/tool-source"
import { registerLspToolSource } from "../../src/lsp/tool-source"
import { registerWorkspaceFileSymbolSource } from "../../src/lsp/workspace-symbol-source"
import { registerLspConfigCatalog } from "../../src/lsp/config-catalog"
import { registerToolLinkTargetSource } from "../../src/synergy-link/tool-target-source"
import { ToolLspSource } from "../../src/tool/lsp-source"
import { ToolNoteSource } from "../../src/tool/note-source"
import { ToolPluginSource } from "../../src/tool/plugin-source"
import { ToolLinkTargetSource } from "../../src/tool/link-target-source"
import { ConfigLspCatalog } from "../../src/config/lsp-catalog"
import { PermissionPluginSource } from "../../src/permission/plugin-source"
import { ProviderPluginAuth } from "../../src/provider/plugin-auth-source"
import { ScopeLibraryStore } from "../../src/scope/library-store"
import { WorkspaceFileSymbolSource } from "../../src/workspace-file/symbol-source"

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
