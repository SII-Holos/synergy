import { expect, test } from "bun:test"
import { tmpdir } from "../fixture/fixture"
import { ScopeContext } from "../../src/scope/context"
import { Agent } from "../../src/agent/agent"
import { AgentDelegation } from "../../src/agent/delegation"
import { PermissionNext } from "../../src/permission/next"
import { ToolExposure } from "../../src/tool/exposure"
import { ToolRegistry } from "../../src/tool/registry"

const FLASH_DEFERRED = ["task", "task_list", "task_output", "task_cancel", "dagwrite", "dagread", "dagpatch"]

function evalPerm(agent: Agent.Info | undefined, permission: string): PermissionNext.Action | undefined {
  if (!agent) return undefined
  return PermissionNext.evaluate(permission, "*", agent.permission).action
}

test("synergy-flash registers as a visible primary agent", async () => {
  await using tmp = await tmpdir()
  await ScopeContext.provide({
    scope: await tmp.scope(),
    fn: async () => {
      const agents = await Agent.list()
      const flash = agents.find((agent) => agent.name === "synergy-flash")
      expect(flash).toBeDefined()
      expect(flash?.mode).toBe("primary")
      expect(flash?.hidden).toBeUndefined()
      expect(flash?.native).toBe(true)
    },
  })
})

test("synergy-flash keeps the classic synergy permission surface", async () => {
  await using tmp = await tmpdir()
  await ScopeContext.provide({
    scope: await tmp.scope(),
    fn: async () => {
      const flash = await Agent.get("synergy-flash")
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
    },
  })
})

test("synergy-flash defers orchestration tools via deferredTools", async () => {
  await using tmp = await tmpdir()
  await ScopeContext.provide({
    scope: await tmp.scope(),
    fn: async () => {
      const flash = await Agent.get("synergy-flash")
      expect(flash?.deferredTools).toBeDefined()
      for (const id of FLASH_DEFERRED) {
        expect(flash?.deferredTools).toContain(id)
        const exposure = ToolExposure.deferredExposure(id, ToolExposure.RESIDENT, flash?.deferredTools)
        expect(exposure.mode).toBe("group")
      }
      expect(ToolExposure.deferredExposure("bash", ToolExposure.RESIDENT, flash?.deferredTools).mode).toBe("resident")
    },
  })
})

test("legacy subagents are delegatable by synergy-flash", async () => {
  await using tmp = await tmpdir()
  await ScopeContext.provide({
    scope: await tmp.scope(),
    fn: async () => {
      for (const name of ["developer", "explore", "scout", "advisor", "inspector", "scribe", "scholar"]) {
        const agent = await Agent.get(name)
        expect(agent).toBeDefined()
        expect(AgentDelegation.canDelegateTo(agent!, "synergy-flash")).toBe(true)
      }
      expect(AgentDelegation.canDelegateTo(await Agent.get("synergy-max"), "synergy-flash")).toBe(false)
    },
  })
})

test("registry folds orchestration tools only for synergy-flash", async () => {
  await using tmp = await tmpdir()
  await ScopeContext.provide({
    scope: await tmp.scope(),
    fn: async () => {
      const flash = await Agent.get("synergy-flash")
      const synergy = await Agent.get("synergy")
      expect(flash).toBeDefined()
      expect(synergy).toBeDefined()

      const flashTools = await ToolRegistry.tools("test-provider", flash)
      const flashById = new Map(flashTools.map((tool) => [tool.id, tool]))
      // task/task_list/task_output/task_cancel are Cortex-provider tools and
      // are absent from this isolated registry; the DAG trio is static builtin.
      for (const id of ["dagwrite", "dagread", "dagpatch"]) {
        expect(flashById.get(id)?.exposure).toMatchObject({ mode: "group", group: "orchestration" })
      }
      expect(flashById.get("bash")?.exposure).toEqual({ mode: "resident" })
      expect(flashById.get("skill")?.exposure).toEqual({ mode: "resident" })

      const synergyTools = await ToolRegistry.tools("test-provider", synergy)
      const synergyById = new Map(synergyTools.map((tool) => [tool.id, tool]))
      expect(synergyById.get("dagwrite")?.exposure).toEqual({ mode: "resident" })
    },
  })
})
