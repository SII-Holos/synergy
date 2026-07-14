import { describe, expect, test } from "bun:test"
import path from "node:path"
import { ScopeListTool } from "../../src/tool/scope-list"
import { SessionControlTool } from "../../src/tool/session-control"
import { Session } from "../../src/session"
import { ScopeContext } from "../../src/scope/context"
import { Scope } from "../../src/scope"
import { tmpdir } from "../fixture/fixture"

const ctx = {
  sessionID: "ses_source_scope_list",
  messageID: "msg_source_scope_list",
  callID: "call_source_scope_list",
  agent: "synergy",
  abort: AbortSignal.any([]),
  metadata: () => {},
  ask: async () => {},
}

function listInput(overrides: Record<string, unknown> = {}) {
  return {
    includeHome: true,
    limit: 50,
    offset: 0,
    ...overrides,
  }
}

function createInput(overrides: Record<string, unknown>) {
  return {
    baseRef: "current" as const,
    cleanup: "keep" as const,
    force: false,
    ...overrides,
  }
}

describe("tool.scope_list", () => {
  test("lists home and the current project scope with machine-readable metadata", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()

    await ScopeContext.provide({
      scope,
      fn: async () => {
        const tool = await ScopeListTool.init()
        // Default page size is enough once current/home are pinned to the front.
        const result = await tool.execute(listInput() as any, ctx)

        expect(result.metadata.total).toBeGreaterThanOrEqual(2)
        expect(result.metadata.currentScopeID).toBe(scope.id)
        expect(result.output).toContain(`[${scope.id}]`)
        expect(result.output).toContain("[current]")
        expect(result.output).toContain("[home]")

        const scopes = result.metadata.scopes as Array<{
          id: string
          type: "home" | "project"
          directory: string
          current: boolean
        }>
        expect(scopes[0]?.current).toBe(true)
        expect(scopes[0]?.id).toBe(scope.id)
        expect(scopes.some((entry) => entry.id === "home" && entry.type === "home")).toBe(true)

        const current = scopes.find((entry) => entry.id === scope.id)
        expect(current).toBeTruthy()
        expect(current?.type).toBe("project")
        expect(current?.current).toBe(true)
        expect(path.resolve(current?.directory ?? "")).toBe(path.resolve(tmp.path))

        // Home remains discoverable even when filtered by query.
        const homeOnly = await tool.execute(listInput({ query: "home", includeHome: true }) as any, ctx)
        expect(homeOnly.metadata.scopes.some((entry: { id: string }) => entry.id === "home")).toBe(true)
      },
    })
  })

  test("filters scopes by query against name/path/id", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    await Scope.updatePersisted({ scopeID: scope.id, name: "Scope List Alpha" })

    await ScopeContext.provide({
      scope,
      fn: async () => {
        const tool = await ScopeListTool.init()

        const byName = await tool.execute(listInput({ query: "Scope List Alpha" }) as any, ctx)
        expect(byName.metadata.total).toBe(1)
        expect(byName.metadata.scopes[0].id).toBe(scope.id)

        const byPath = await tool.execute(listInput({ query: path.basename(tmp.path) }) as any, ctx)
        expect(byPath.metadata.scopes.some((entry: { id: string }) => entry.id === scope.id)).toBe(true)

        const byId = await tool.execute(listInput({ query: scope.id.slice(0, 8) }) as any, ctx)
        expect(byId.metadata.scopes.some((entry: { id: string }) => entry.id === scope.id)).toBe(true)

        const miss = await tool.execute(listInput({ query: "definitely-not-a-scope-xyz" }) as any, ctx)
        expect(miss.metadata.total).toBe(0)
        expect(miss.output).toContain("No scopes matched")
      },
    })
  })

  test("can omit home and paginate results", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()

    await ScopeContext.provide({
      scope,
      fn: async () => {
        const tool = await ScopeListTool.init()
        const withoutHome = await tool.execute(listInput({ includeHome: false }) as any, ctx)
        expect(
          (withoutHome.metadata.scopes as Array<{ type: string }>).every((entry) => entry.type === "project"),
        ).toBe(true)
        expect(withoutHome.output).not.toContain("[home]")

        const page = await tool.execute(listInput({ limit: 1, offset: 0 }) as any, ctx)
        expect(page.metadata.count).toBe(1)
        expect(page.metadata.total).toBeGreaterThanOrEqual(2)
        // Current scope is sorted first, so the first page should be the active project.
        expect(page.metadata.scopes[0].id).toBe(scope.id)
        expect(page.metadata.scopes[0].current).toBe(true)
        expect(page.output).toContain("showing 1-1")
      },
    })
  })

  test("returned scope id can create a session via session_control", async () => {
    await using projectA = await tmpdir({ git: true })
    await using projectB = await tmpdir({ git: true })
    const scopeA = await projectA.scope()
    const scopeB = await projectB.scope()

    await ScopeContext.provide({
      scope: scopeA,
      fn: async () => {
        const listTool = await ScopeListTool.init()
        const listed = await listTool.execute(listInput({ query: path.basename(projectB.path) }) as any, ctx)
        const target = (listed.metadata.scopes as Array<{ id: string }>).find((entry) => entry.id === scopeB.id)
        expect(target?.id).toBe(scopeB.id)

        const control = await SessionControlTool.init()
        const created = await control.execute(
          createInput({
            action: "create",
            title: "Cross-scope from scope_list",
            scopeID: target!.id,
          }) as any,
          ctx,
        )

        const sessionID = created.metadata.session.id as string
        const session = await Session.get(sessionID)
        expect(session.scope.id).toBe(scopeB.id)
        expect(created.metadata.session.scopeID).toBe(scopeB.id)

        await Session.remove(sessionID)
      },
    })
  })
})
