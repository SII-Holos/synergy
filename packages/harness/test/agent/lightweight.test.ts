import { PrimaryAgentIdentity } from "../../src/agent/primary-identity"
import { expect, test } from "bun:test"
import { tmpdir } from "../support/fixture"
import { ScopeContext } from "../../src/scope/context"
import { Agent } from "../../src/agent/agent"
import { AgentDelegation } from "../../src/agent/delegation"
import { PermissionNext } from "../../src/permission/next"
import { afterAll as afterRuntimeTests } from "bun:test"
import { testRuntime } from "../support/runtime"
const runtime = await testRuntime()

function evalPerm(agent: Agent.Info | undefined, permission: string): PermissionNext.Action | undefined {
  if (!agent) return undefined
  return PermissionNext.evaluate(permission, "*", agent.permission).action
}

test("lightweight primary keeps the classic execution surface with file_search as the only search tool", () =>
  runtime.run(async () => {
    await using tmp = await tmpdir()
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const flash = await Agent.get(PrimaryAgentIdentity.names.lightweight)
        expect(flash).toBeDefined()
        expect(evalPerm(flash, "bash")).toBe("allow")
        expect(evalPerm(flash, "read")).toBe("allow")
        expect(evalPerm(flash, "edit")).toBe("ask")
        expect(evalPerm(flash, "todowrite")).toBe("deny")
        expect(evalPerm(flash, "view_file")).toBe("deny")
        expect(evalPerm(flash, "task")).toBe("allow")
        expect(evalPerm(flash, "dagwrite")).toBe("allow")
        expect(evalPerm(flash, "memory_write")).toBe("allow")
        expect(evalPerm(flash, "memory_edit")).toBe("allow")
        expect(evalPerm(flash, "question")).toBe("allow")
        expect(evalPerm(flash, "expand_tools")).toBe("allow")
        expect(evalPerm(flash, "file_search")).not.toBe("deny")
        expect(evalPerm(flash, "glob")).toBe("deny")
        expect(evalPerm(flash, "grep")).toBe("deny")
        expect(evalPerm(flash, "ast_grep")).toBe("deny")
      },
    })
  }))

test("legacy subagents are delegatable by the lightweight primary", () =>
  runtime.run(async () => {
    await using tmp = await tmpdir()
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        for (const name of ["developer", "explore", "scout", "advisor", "inspector", "scribe", "scholar"]) {
          const agent = await Agent.get(name)
          expect(agent).toBeDefined()
          expect(AgentDelegation.canDelegateTo(agent!, PrimaryAgentIdentity.names.lightweight)).toBe(true)
        }
        expect(
          AgentDelegation.canDelegateTo(
            await Agent.get(PrimaryAgentIdentity.names.coding),
            PrimaryAgentIdentity.names.lightweight,
          ),
        ).toBe(false)
      },
    })
  }))

afterRuntimeTests(() => runtime.close())
