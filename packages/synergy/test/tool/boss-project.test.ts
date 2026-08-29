import { describe, expect, test } from "bun:test"
import path from "path"
import { existsSync, mkdirSync } from "fs"
import { Identifier } from "../../src/id/id"
import { Scope } from "../../src/scope"
import { ScopeContext } from "../../src/scope/context"
import { Session } from "../../src/session"
import { SessionWorkflowService } from "../../src/session/workflow"
import { BossService } from "../../src/boss/boss"
import { BossProjectTool, DEFAULT_PROJECT_BOSS_INSTRUCTIONS } from "../../src/boss/tools/boss-project"
import { ToolRegistry } from "../../src/tool/registry"
// Product domains register tool providers via the L4 manifest
import "../../src/product-registration"
import type { Tool } from "../../src/tool/tool"
import { tmpdir } from "../fixture/fixture"

async function withScope<T>(fn: () => Promise<T>): Promise<T> {
  await using tmp = await tmpdir({ git: true })
  const scope = (await Scope.fromDirectory(tmp.path)).scope
  return ScopeContext.provide({ scope, fn })
}

function ctx(sessionID: string): Tool.Context {
  return {
    sessionID,
    messageID: Identifier.ascending("message"),
    callID: "call-boss-project-test",
    agent: "synergy-max",
    abort: AbortSignal.any([]),
    metadata: () => {},
    ask: async () => {},
  }
}

async function bossSession(): Promise<Session.Info> {
  const session = await Session.create({})
  await SessionWorkflowService.enableBoss(session.id)
  return session
}

describe("boss_project tool", () => {
  test("registers in the tool registry", async () => {
    await withScope(async () => {
      expect(await ToolRegistry.find("boss_project")).toBeDefined()
    })
  })

  test("creates a directory, binds a project scope, and creates a project boss session", async () => {
    await withScope(async () => {
      const boss = await bossSession()
      const projectDir = path.join(
        process.env.SYNERGY_TEST_ROOT!,
        "boss-project-" + Math.random().toString(36).slice(2),
      )
      const tool = await BossProjectTool.init()
      const result = await tool.execute({ directory: projectDir }, ctx(boss.id))

      expect(existsSync(projectDir)).toBe(true)
      expect(result.metadata).toMatchObject({ directory: projectDir })
      const sessionID = result.metadata.sessionID as string
      const scopeID = result.metadata.scopeID as string
      const projectSession = await Session.get(sessionID)

      expect(projectSession.workflow).toMatchObject({ kind: "boss", role: "boss" })
      const workflowInstructions = (projectSession.workflow as { instructions?: string }).instructions ?? ""
      expect(workflowInstructions).toContain(DEFAULT_PROJECT_BOSS_INSTRUCTIONS)
      expect(workflowInstructions).toContain(boss.id)
      expect(projectSession.interaction).toMatchObject({ mode: "interactive", source: "boss" })
      expect((projectSession.scope as Scope).id).toBe(scopeID)
      expect(scopeID).not.toBe("home")

      const scope = await Scope.fromID(scopeID)
      expect(scope?.type).toBe("project")
      expect((scope as Scope.Project).directory).toBe(projectDir)
    })
  })

  test("is idempotent: reusing an existing directory reuses the existing scope and creates a distinct session", async () => {
    await withScope(async () => {
      const boss = await bossSession()
      const projectDir = path.join(
        process.env.SYNERGY_TEST_ROOT!,
        "boss-project-" + Math.random().toString(36).slice(2),
      )
      mkdirSync(projectDir, { recursive: true })
      const { scope } = await Scope.fromDirectory(projectDir, { persist: true })
      expect(scope.type).toBe("project")

      const tool = await BossProjectTool.init()
      const result = await tool.execute({ directory: projectDir }, ctx(boss.id))
      const sessionID = result.metadata.sessionID as string
      const scopeID = result.metadata.scopeID as string
      expect(scopeID).toBe(scope.id)
      const projectSession = await Session.get(sessionID)
      expect(projectSession.workflow?.kind === "boss" && projectSession.workflow.role).toBe("boss")
      expect((projectSession.scope as Scope).id).toBe(scopeID)
    })
  })

  test("rejects non-boss callers", async () => {
    await withScope(async () => {
      const plain = await Session.create({})
      const tool = await BossProjectTool.init()
      const projectDir = path.join(
        process.env.SYNERGY_TEST_ROOT!,
        "boss-project-" + Math.random().toString(36).slice(2),
      )
      await expect(tool.execute({ directory: projectDir }, ctx(plain.id))).rejects.toThrow(
        "only boss-role sessions may create project bosses",
      )
    })
  })

  test("rejects worker-role callers (only the boss may create project bosses)", async () => {
    await withScope(async () => {
      const boss = await bossSession()
      const worker = await BossService.spawn(boss.id, { role: "code" })
      const tool = await BossProjectTool.init()
      const projectDir = path.join(
        process.env.SYNERGY_TEST_ROOT!,
        "boss-project-" + Math.random().toString(36).slice(2),
      )
      await expect(tool.execute({ directory: projectDir }, ctx(worker.id))).rejects.toThrow(
        "only boss-role sessions may create project bosses",
      )
    })
  })

  test("allows directories inside the home directory (runtime colleague projects)", async () => {
    await withScope(async () => {
      const boss = await bossSession()
      const tool = await BossProjectTool.init()
      const homeDir = process.env.SYNERGY_TEST_HOME!
      const nestedDir = path.join(homeDir, "boss-nested-" + Math.random().toString(36).slice(2))
      const result = await tool.execute({ directory: nestedDir }, ctx(boss.id))

      expect(result.metadata).toMatchObject({ directory: nestedDir })
      const scopeID = result.metadata.scopeID as string
      expect(scopeID).not.toBe("home")
      const scope = await Scope.fromID(scopeID)
      expect(scope?.type).toBe("project")
      expect((scope as Scope.Project).directory).toBe(nestedDir)
    })
  })

  test("honors custom title, agent, and instructions", async () => {
    await withScope(async () => {
      const boss = await bossSession()
      const projectDir = path.join(
        process.env.SYNERGY_TEST_ROOT!,
        "boss-project-" + Math.random().toString(36).slice(2),
      )
      const tool = await BossProjectTool.init()
      const customInstructions = "只关注 API 层。"
      const result = await tool.execute(
        { directory: projectDir, title: "My API Project", agent: "synergy", instructions: customInstructions },
        ctx(boss.id),
      )
      const session = await Session.get(result.metadata.sessionID as string)
      expect(session.title).toBe("My API Project")
      expect(session.agentOverride).toBe("synergy")
      const workflowInstructions = (session.workflow as { instructions?: string }).instructions ?? ""
      expect(workflowInstructions).toContain(customInstructions)
      expect(workflowInstructions).toContain(boss.id)
    })
  })
})
