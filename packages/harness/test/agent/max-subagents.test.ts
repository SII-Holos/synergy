import { describe, expect, test } from "bun:test"
import { createBuiltinMaxSubagents } from "../../src/agent/builtin-max-subagents"
import { createBuiltinLegacySubagents } from "../../src/agent/builtin-legacy-subagents"
import { PermissionNext } from "../../src/permission/next"
import { afterAll as afterRuntimeTests } from "bun:test"
import { testRuntime } from "../support/runtime"
const runtime = await testRuntime()

const ctx = {
  defaults: [],
  user: [],
  role: () => undefined,
}

const nativeToolProcedure =
  /\b(?:view_file|scan_files|revise_file|resolve_conflicts|save_file|session_send|session_control|todowrite|todoread|ast_grep|webfetch|yieldSeconds)\b|read\(filePath|strength:\s*["']|\bgh (?:repo clone|search)\b|\btool descriptions?\b|\bcurrent (?:tool )?catalog\b/i

function action(agent: ReturnType<typeof createBuiltinMaxSubagents>[string], permission: string) {
  return PermissionNext.evaluate(permission, "*", agent.permission).action
}

describe("coding subagents", () => {
  const agents = runtime.run(() => createBuiltinMaxSubagents(ctx))

  test("specialist prompts retain role and handoff without native tool procedures", () =>
    runtime.run(() => {
      for (const [name, agent] of Object.entries(agents)) {
        expect(agent.prompt, name).toMatch(/# Identity\b/)
        expect(agent.prompt, name).toMatch(/# Mission\b/)
        expect(agent.prompt, name).toMatch(/# Report\b/)
        expect(agent.prompt, name).not.toMatch(nativeToolProcedure)
      }
    }))

  test("does not expose workflow-designer", () =>
    runtime.run(() => {
      expect(agents["workflow-designer"]).toBeUndefined()
    }))

  test("all max subagents receive the base utility tool bundle", () =>
    runtime.run(() => {
      for (const agent of Object.values(agents)) {
        for (const permission of ["bash", "process", "skill", "webfetch", "glob", "list"]) {
          expect(action(agent, permission)).toBe("allow")
        }
        expect(action(agent, "look_at")).toBe("deny")
      }
    }))

  test("deferred permissions stay within the owning subagent profiles", () =>
    runtime.run(() => {
      const readOnly = agents["code-cartographer"]
      expect(action(readOnly, "note_read")).toBe("deny")
      expect(action(readOnly, "note_write")).toBe("deny")
      expect(action(readOnly, "note_edit")).toBe("deny")
      expect(action(readOnly, "memory_get")).toBe("deny")
      expect(action(readOnly, "session_read")).toBe("deny")
      expect(action(readOnly, "mcp__any_server__any_tool")).toBe("deny")

      const historian = agents["session-historian"]
      expect(action(historian, "session_list")).toBe("allow")
      expect(action(historian, "session_read")).toBe("allow")
      expect(action(historian, "session_search")).toBe("allow")
      expect(action(historian, "session_send")).toBe("deny")

      for (const name of ["docs-researcher", "research-scout", "literature-searcher", "literature-analyst"]) {
        expect(action(agents[name], "mcp__any_server__any_tool"), name).toBe("deny")
      }
    }))

  test("max subagents retain discovery without granting absent Browser tools", () =>
    runtime.run(() => {
      for (const [name, agent] of Object.entries(agents)) {
        for (const permission of [
          "search_tools",
          "expand_tools",
          "browser_navigation",
          "browser_action",
          "browser_upload",
        ]) {
          expect(action(agent, permission), `${name}:${permission}`).toBe(
            permission.startsWith("browser_") ? "deny" : "allow",
          )
        }
      }
    }))

  test("anchored write agents use only the anchored file harness", () =>
    runtime.run(() => {
      const anchoredWriters = [
        "implementation-engineer",
        "refactoring-engineer",
        "integration-engineer",
        "documentation-engineer",
        "test-strategist",
        "fixture-builder",
        "property-test-engineer",
        "type-test-engineer",
      ]

      for (const name of anchoredWriters) {
        const agent = agents[name]
        expect(agent, name).toBeDefined()
        expect(action(agent, "view_file")).toBe("allow")
        expect(action(agent, "scan_files")).toBe("allow")
        expect(action(agent, "parse_code")).toBe("deny")
        expect(action(agent, "revise_file")).toBe("ask")
        expect(action(agent, "resolve_conflicts")).toBe("ask")
        expect(action(agent, "save_file")).toBe("ask")
        expect(action(agent, "read")).toBe("deny")
        expect(action(agent, "grep")).toBe("deny")
        expect(action(agent, "ast_grep")).toBe("deny")
        expect(action(agent, "edit")).toBe("deny")
        expect(action(agent, "write")).toBe("deny")
      }
    }))

  test("classic read agents use only the classic read harness and cannot write files", () =>
    runtime.run(() => {
      const classicReaders = [
        "requirements-engineer",
        "code-cartographer",
        "dependency-tracer",
        "solution-architect",
        "api-contract-designer",
        "migration-architect",
        "quality-gatekeeper",
        "python-quality-engineer",
        "rust-quality-engineer",
        "typescript-quality-engineer",
        "maintainability-reviewer",
        "security-reviewer",
        "performance-reviewer",
        "api-compatibility-reviewer",
        "documentation-reviewer",
        "docs-researcher",
        "research-scout",
        "research-methodologist",
      ]

      for (const name of classicReaders) {
        const agent = agents[name]
        expect(agent, name).toBeDefined()
        expect(action(agent, "read")).toBe("allow")
        expect(action(agent, "grep")).toBe("allow")
        expect(action(agent, "ast_grep")).toBe("deny")
        expect(action(agent, "view_file")).toBe("deny")
        expect(action(agent, "scan_files")).toBe("deny")
        expect(action(agent, "parse_code")).toBe("deny")
        expect(action(agent, "revise_file")).toBe("deny")
        expect(action(agent, "resolve_conflicts")).toBe("deny")
        expect(action(agent, "save_file")).toBe("deny")
        expect(action(agent, "edit")).toBe("deny")
        expect(action(agent, "write")).toBe("deny")
      }
    }))

  test("recursive reviewers are absent and ordinary subagents cannot coordinate recursively", () =>
    runtime.run(() => {
      const coordinatorTools = ["task", "task_list", "task_output", "task_cancel", "dagwrite", "dagread", "dagpatch"]

      for (const name of ["supervisor", "lightloop-reviewer"]) {
        expect(agents[name], name).toBeUndefined()
      }

      const ordinary = agents["implementation-engineer"]
      expect(ordinary).toBeDefined()
      for (const permission of coordinatorTools) {
        expect(action(ordinary, permission), `implementation-engineer:${permission}`).toBe("deny")
      }
    }))
})

describe("synergy subagents", () => {
  const agents = runtime.run(() => createBuiltinLegacySubagents(ctx))

  test("classic prompts retain their responsibilities without native tool procedures", () =>
    runtime.run(() => {
      for (const [name, agent] of Object.entries(agents)) {
        expect(agent.prompt, name).toMatch(/\bYou are\b/)
        expect(agent.prompt, name).toMatch(/\b(?:report|output|response|answer|deliver)\b/i)
        expect(agent.prompt, name).not.toMatch(nativeToolProcedure)
      }
    }))

  test("classic subagents retain discovery without granting absent Browser tools", () =>
    runtime.run(() => {
      for (const [name, agent] of Object.entries(agents)) {
        for (const permission of [
          "search_tools",
          "expand_tools",
          "browser_navigation",
          "browser_action",
          "browser_upload",
        ]) {
          expect(action(agent, permission), `${name}:${permission}`).toBe(
            permission.startsWith("browser_") ? "deny" : "allow",
          )
        }
      }
    }))
})

afterRuntimeTests(() => runtime.close())
