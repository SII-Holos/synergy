import { describe, expect, test } from "bun:test"
import { createBuiltinMaxSubagents } from "../../src/agent/builtin-max-subagents"
import { PermissionNext } from "../../src/permission/next"

const ctx = {
  defaults: [],
  user: [],
  role: () => undefined,
  evolutionActive: false,
}

function action(agent: ReturnType<typeof createBuiltinMaxSubagents>[string], permission: string) {
  return PermissionNext.evaluate(permission, "*", agent.permission).action
}

describe("synergy-max subagents", () => {
  const agents = createBuiltinMaxSubagents(ctx)

  test("does not expose workflow-designer", () => {
    expect(agents["workflow-designer"]).toBeUndefined()
  })

  test("all max subagents receive the base utility and research tool bundle", () => {
    for (const agent of Object.values(agents)) {
      for (const permission of [
        "bash",
        "process",
        "skill",
        "websearch",
        "webfetch",
        "look_at",
        "glob",
        "arxiv_search",
      ]) {
        expect(action(agent, permission)).toBe("allow")
      }
      expect(action(agent, "arxiv_download")).toBe("ask")
      expect(action(agent, "mcp__any_server__any_tool")).toBe("allow")
    }
  })

  test("anchored write agents use only the anchored file harness", () => {
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
      expect(action(agent, "parse_code")).toBe("allow")
      expect(action(agent, "revise_file")).toBe("ask")
      expect(action(agent, "save_file")).toBe("ask")
      expect(action(agent, "read")).toBe("deny")
      expect(action(agent, "grep")).toBe("deny")
      expect(action(agent, "ast_grep")).toBe("deny")
      expect(action(agent, "edit")).toBe("deny")
      expect(action(agent, "write")).toBe("deny")
    }
  })

  test("classic read agents use only the classic read harness and cannot write files", () => {
    const classicReaders = [
      "intent-analyst",
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
      expect(action(agent, "ast_grep")).toBe("allow")
      expect(action(agent, "view_file")).toBe("deny")
      expect(action(agent, "scan_files")).toBe("deny")
      expect(action(agent, "parse_code")).toBe("deny")
      expect(action(agent, "revise_file")).toBe("deny")
      expect(action(agent, "save_file")).toBe("deny")
      expect(action(agent, "edit")).toBe("deny")
      expect(action(agent, "write")).toBe("deny")
    }
  })
})
