import { test, expect } from "bun:test"
import path from "path"
import { tmpdir } from "../fixture/fixture"
import { Instance } from "../../src/scope/instance"
import { Agent } from "../../src/agent/agent"
import { PermissionNext } from "../../src/permission/next"
import { Config } from "../../src/config/config"
import { RuntimeReload } from "../../src/runtime/reload"

// Helper to evaluate permission for a tool with wildcard pattern
function evalPerm(agent: Agent.Info | undefined, permission: string): PermissionNext.Action | undefined {
  if (!agent) return undefined
  return PermissionNext.evaluate(permission, "*", agent.permission).action
}

test("returns default native agents when no config", async () => {
  await using tmp = await tmpdir()
  await Instance.provide({
    scope: await tmp.scope(),
    fn: async () => {
      const agents = await Agent.list()
      const names = agents.map((a) => a.name)
      expect(names).toContain("master")
      expect(names).toContain("scribe")
      expect(names).toContain("explore")
      expect(names).toContain("compaction")
      expect(names).toContain("title")
      expect(names).toContain("summary")
      expect(names).toContain("multimodal-looker")
      expect(names).toContain("scout")
      expect(names).toContain("advisor")
      expect(names).toContain("scholar")
    },
  })
})

test("master agent has correct default properties", async () => {
  await using tmp = await tmpdir()
  await Instance.provide({
    scope: await tmp.scope(),
    fn: async () => {
      const master = await Agent.get("master")
      expect(master).toBeDefined()
      expect(master?.mode).toBe("all")
      expect(master?.native).toBe(true)
      expect(evalPerm(master, "edit")).toBe("ask")
      expect(evalPerm(master, "bash")).toBe("allow")
    },
  })
})

test("explore agent allows edit and write but denies todowrite", async () => {
  await using tmp = await tmpdir()
  await Instance.provide({
    scope: await tmp.scope(),
    fn: async () => {
      const explore = await Agent.get("explore")
      expect(explore).toBeDefined()
      expect(explore?.mode).toBe("subagent")
      expect(evalPerm(explore, "edit")).toBe("allow")
      expect(evalPerm(explore, "write")).toBe("allow")
      expect(evalPerm(explore, "todoread")).toBe("deny")
      expect(evalPerm(explore, "todowrite")).toBe("deny")
    },
  })
})

test("scholar agent has correct permissions", async () => {
  await using tmp = await tmpdir()
  await Instance.provide({
    scope: await tmp.scope(),
    fn: async () => {
      const scholar = await Agent.get("scholar")
      expect(scholar).toBeDefined()
      expect(scholar?.mode).toBe("all")
      expect(scholar?.native).toBe(true)
      // Scholar allows arxiv tools
      expect(PermissionNext.evaluate("arxiv_search", "*", scholar!.permission).action).toBe("allow")
      expect(PermissionNext.evaluate("arxiv_download", "*", scholar!.permission).action).toBe("allow")
    },
  })
})

test("compaction agent denies all permissions", async () => {
  await using tmp = await tmpdir()
  await Instance.provide({
    scope: await tmp.scope(),
    fn: async () => {
      const compaction = await Agent.get("compaction")
      expect(compaction).toBeDefined()
      expect(compaction?.hidden).toBe(true)
      expect(evalPerm(compaction, "bash")).toBe("deny")
      expect(evalPerm(compaction, "edit")).toBe("deny")
      expect(evalPerm(compaction, "read")).toBe("deny")
    },
  })
})

test("custom agent from config creates new agent", async () => {
  await using tmp = await tmpdir({
    config: {
      agent: {
        my_custom_agent: {
          model: "openai/gpt-4",
          description: "My custom agent",
          temperature: 0.5,
          top_p: 0.9,
        },
      },
    },
  })
  await Instance.provide({
    scope: await tmp.scope(),
    fn: async () => {
      const custom = await Agent.get("my_custom_agent")
      expect(custom).toBeDefined()
      expect(custom?.model?.providerID).toBe("openai")
      expect(custom?.model?.modelID).toBe("gpt-4")
      expect(custom?.description).toBe("My custom agent")
      expect(custom?.temperature).toBe(0.5)
      expect(custom?.topP).toBe(0.9)
      expect(custom?.native).toBe(false)
      expect(custom?.mode).toBe("all")
    },
  })
})

test("custom agent config overrides native agent properties", async () => {
  await using tmp = await tmpdir({
    config: {
      agent: {
        master: {
          model: "anthropic/claude-3",
          description: "Custom build agent",
          temperature: 0.7,
          color: "#FF0000",
        },
      },
    },
  })
  await Instance.provide({
    scope: await tmp.scope(),
    fn: async () => {
      const master = await Agent.get("master")
      expect(master).toBeDefined()
      expect(master?.model?.providerID).toBe("anthropic")
      expect(master?.model?.modelID).toBe("claude-3")
      expect(master?.description).toBe("Custom build agent")
      expect(master?.temperature).toBe(0.7)
      expect(master?.color).toBe("#FF0000")
      expect(master?.native).toBe(true)
    },
  })
})

test("agent disable removes agent from list", async () => {
  await using tmp = await tmpdir({
    config: {
      agent: {
        explore: { disable: true },
      },
    },
  })
  await Instance.provide({
    scope: await tmp.scope(),
    fn: async () => {
      const explore = await Agent.get("explore")
      expect(explore).toBeUndefined()
      const agents = await Agent.list()
      const names = agents.map((a) => a.name)
      expect(names).not.toContain("explore")
    },
  })
})

test("agent permission config merges with defaults", async () => {
  await using tmp = await tmpdir({
    config: {
      agent: {
        master: {
          permission: {
            bash: {
              "rm -rf *": "deny",
            },
          },
        },
      },
    },
  })
  await Instance.provide({
    scope: await tmp.scope(),
    fn: async () => {
      const master = await Agent.get("master")
      expect(master).toBeDefined()
      // Specific pattern is denied
      expect(PermissionNext.evaluate("bash", "rm -rf *", master!.permission).action).toBe("deny")
      // Edit remains ask by default
      expect(evalPerm(master, "edit")).toBe("ask")
    },
  })
})

test("global permission config applies to all agents", async () => {
  await using tmp = await tmpdir({
    config: {
      permission: {
        bash: "deny",
      },
    },
  })
  await Instance.provide({
    scope: await tmp.scope(),
    fn: async () => {
      const master = await Agent.get("master")
      expect(master).toBeDefined()
      expect(evalPerm(master, "bash")).toBe("deny")
    },
  })
})

test("agent steps/maxSteps config sets steps property", async () => {
  await using tmp = await tmpdir({
    config: {
      agent: {
        master: { steps: 50 },
        scribe: { maxSteps: 100 },
      },
    },
  })
  await Instance.provide({
    scope: await tmp.scope(),
    fn: async () => {
      const master = await Agent.get("master")
      const scribe = await Agent.get("scribe")
      expect(master?.steps).toBe(50)
      expect(scribe?.steps).toBe(100)
    },
  })
})

test("agent mode can be overridden", async () => {
  await using tmp = await tmpdir({
    config: {
      agent: {
        explore: { mode: "primary" },
      },
    },
  })
  await Instance.provide({
    scope: await tmp.scope(),
    fn: async () => {
      const explore = await Agent.get("explore")
      expect(explore?.mode).toBe("primary")
    },
  })
})

test("agent name can be overridden", async () => {
  await using tmp = await tmpdir({
    config: {
      agent: {
        master: { name: "Builder" },
      },
    },
  })
  await Instance.provide({
    scope: await tmp.scope(),
    fn: async () => {
      const master = await Agent.get("master")
      expect(master?.name).toBe("Builder")
    },
  })
})

test("agent prompt can be set from config", async () => {
  await using tmp = await tmpdir({
    config: {
      agent: {
        master: { prompt: "Custom system prompt" },
      },
    },
  })
  await Instance.provide({
    scope: await tmp.scope(),
    fn: async () => {
      const master = await Agent.get("master")
      expect(master?.prompt).toBe("Custom system prompt")
    },
  })
})

test("unknown agent properties are placed into options", async () => {
  await using tmp = await tmpdir({
    config: {
      agent: {
        master: {
          random_property: "hello",
          another_random: 123,
        },
      },
    },
  })
  await Instance.provide({
    scope: await tmp.scope(),
    fn: async () => {
      const master = await Agent.get("master")
      expect(master?.options.random_property).toBe("hello")
      expect(master?.options.another_random).toBe(123)
    },
  })
})

test("agent options merge correctly", async () => {
  await using tmp = await tmpdir({
    config: {
      agent: {
        master: {
          options: {
            custom_option: true,
            another_option: "value",
          },
        },
      },
    },
  })
  await Instance.provide({
    scope: await tmp.scope(),
    fn: async () => {
      const master = await Agent.get("master")
      expect(master?.options.custom_option).toBe(true)
      expect(master?.options.another_option).toBe("value")
    },
  })
})

test("multiple custom agents can be defined", async () => {
  await using tmp = await tmpdir({
    config: {
      agent: {
        agent_a: {
          description: "Agent A",
          mode: "subagent",
        },
        agent_b: {
          description: "Agent B",
          mode: "primary",
        },
      },
    },
  })
  await Instance.provide({
    scope: await tmp.scope(),
    fn: async () => {
      const agentA = await Agent.get("agent_a")
      const agentB = await Agent.get("agent_b")
      expect(agentA?.description).toBe("Agent A")
      expect(agentA?.mode).toBe("subagent")
      expect(agentB?.description).toBe("Agent B")
      expect(agentB?.mode).toBe("primary")
    },
  })
})

test("Agent.get returns undefined for non-existent agent", async () => {
  await using tmp = await tmpdir()
  await Instance.provide({
    scope: await tmp.scope(),
    fn: async () => {
      const nonExistent = await Agent.get("does_not_exist")
      expect(nonExistent).toBeUndefined()
    },
  })
})

test("explore agent model follows mid_model after config reload", async () => {
  await using tmp = await tmpdir({
    config: {
      model: "openai/gpt-4.1",
      mid_model: "openai/gpt-4.1",
    },
  })
  await Instance.provide({
    scope: await tmp.scope(),
    fn: async () => {
      const before = await Agent.get("explore")
      expect(before?.model).toEqual({ providerID: "openai", modelID: "gpt-4.1" })

      await Bun.write(
        path.join(tmp.path, "synergy.json"),
        JSON.stringify({
          $schema: "file:///test/config.schema.json",
          model: "openai/gpt-4.1",
          mid_model: "openai/gpt-5-mini",
        }),
      )

      await RuntimeReload.reload({ targets: ["config"], scope: "project", reason: "test" })

      const after = await Agent.get("explore")
      expect(after?.model).toEqual({ providerID: "openai", modelID: "gpt-5-mini" })
    },
  })
})

test("default permission includes doom_loop allow and external_directory ask", async () => {
  await using tmp = await tmpdir()
  await Instance.provide({
    scope: await tmp.scope(),
    fn: async () => {
      const master = await Agent.get("master")
      expect(evalPerm(master, "doom_loop")).toBe("allow")
      expect(evalPerm(master, "external_directory")).toBe("ask")
    },
  })
})

test("openclaw external agent is registered without model switching claims", async () => {
  if (!Bun.which("openclaw")) {
    console.log("Skipping: openclaw binary not available")
    return
  }
  await using tmp = await tmpdir()
  await Instance.provide({
    scope: await tmp.scope(),
    fn: async () => {
      const openclaw = await Agent.get("openclaw")
      expect(openclaw?.external?.adapter).toBe("openclaw")
      expect(openclaw?.external?.config?.modelSwitch).toBeUndefined()
    },
  })
})

test("webfetch is allowed by default", async () => {
  await using tmp = await tmpdir()
  await Instance.provide({
    scope: await tmp.scope(),
    fn: async () => {
      const master = await Agent.get("master")
      expect(evalPerm(master, "webfetch")).toBe("allow")
    },
  })
})

test("legacy tools config converts to permissions", async () => {
  await using tmp = await tmpdir({
    config: {
      agent: {
        master: {
          tools: {
            bash: false,
            read: false,
          },
        },
      },
    },
  })
  await Instance.provide({
    scope: await tmp.scope(),
    fn: async () => {
      const master = await Agent.get("master")
      expect(evalPerm(master, "bash")).toBe("deny")
      expect(evalPerm(master, "read")).toBe("deny")
    },
  })
})

test("legacy tools config maps write/edit/patch/multiedit to edit permission", async () => {
  await using tmp = await tmpdir({
    config: {
      agent: {
        master: {
          tools: {
            write: false,
          },
        },
      },
    },
  })
  await Instance.provide({
    scope: await tmp.scope(),
    fn: async () => {
      const master = await Agent.get("master")
      expect(evalPerm(master, "edit")).toBe("deny")
    },
  })
})

test("Truncate.DIR is allowed even when user denies external_directory globally", async () => {
  const { Truncate } = await import("../../src/tool/truncation")
  await using tmp = await tmpdir({
    config: {
      permission: {
        external_directory: "deny",
      },
    },
  })
  await Instance.provide({
    scope: await tmp.scope(),
    fn: async () => {
      const master = await Agent.get("master")
      expect(PermissionNext.evaluate("external_directory", Truncate.DIR, master!.permission).action).toBe("allow")
      expect(PermissionNext.evaluate("external_directory", "/some/other/path", master!.permission).action).toBe("deny")
    },
  })
})

test("Truncate.DIR is allowed even when user denies external_directory per-agent", async () => {
  const { Truncate } = await import("../../src/tool/truncation")
  await using tmp = await tmpdir({
    config: {
      agent: {
        master: {
          permission: {
            external_directory: "deny",
          },
        },
      },
    },
  })
  await Instance.provide({
    scope: await tmp.scope(),
    fn: async () => {
      const master = await Agent.get("master")
      expect(PermissionNext.evaluate("external_directory", Truncate.DIR, master!.permission).action).toBe("allow")
      expect(PermissionNext.evaluate("external_directory", "/some/other/path", master!.permission).action).toBe("deny")
    },
  })
})

test("explicit Truncate.DIR deny is respected", async () => {
  const { Truncate } = await import("../../src/tool/truncation")
  await using tmp = await tmpdir({
    config: {
      permission: {
        external_directory: {
          "*": "deny",
          [Truncate.DIR]: "deny",
        },
      },
    },
  })
  await Instance.provide({
    scope: await tmp.scope(),
    fn: async () => {
      const master = await Agent.get("master")
      expect(PermissionNext.evaluate("external_directory", Truncate.DIR, master!.permission).action).toBe("deny")
    },
  })
})

// Skill permission tests

test("scribe agent has selective skill permissions", async () => {
  await using tmp = await tmpdir()
  await Instance.provide({
    scope: await tmp.scope(),
    fn: async () => {
      const scribe = await Agent.get("scribe")
      expect(scribe).toBeDefined()
      // Scribe allows agent-browser but denies git-guide, frontend-design, skill-creator
      expect(PermissionNext.evaluate("skill", "agent-browser", scribe!.permission).action).toBe("allow")
      expect(PermissionNext.evaluate("skill", "git-guide", scribe!.permission).action).toBe("deny")
      expect(PermissionNext.evaluate("skill", "frontend-design", scribe!.permission).action).toBe("deny")
      expect(PermissionNext.evaluate("skill", "skill-creator", scribe!.permission).action).toBe("deny")
    },
  })
})

test("explore agent has selective skill permissions", async () => {
  await using tmp = await tmpdir()
  await Instance.provide({
    scope: await tmp.scope(),
    fn: async () => {
      const explore = await Agent.get("explore")
      expect(explore).toBeDefined()
      // Explore allows agent-browser but denies git-guide, skill-creator, frontend-design
      expect(PermissionNext.evaluate("skill", "agent-browser", explore!.permission).action).toBe("allow")
      expect(PermissionNext.evaluate("skill", "git-guide", explore!.permission).action).toBe("deny")
      expect(PermissionNext.evaluate("skill", "skill-creator", explore!.permission).action).toBe("deny")
      expect(PermissionNext.evaluate("skill", "frontend-design", explore!.permission).action).toBe("deny")
    },
  })
})

test("multimodal-looker agent denies all skills", async () => {
  await using tmp = await tmpdir()
  await Instance.provide({
    scope: await tmp.scope(),
    fn: async () => {
      const looker = await Agent.get("multimodal-looker")
      expect(looker).toBeDefined()
      expect(PermissionNext.evaluate("skill", "*", looker!.permission).action).toBe("deny")
      expect(PermissionNext.evaluate("skill", "git-guide", looker!.permission).action).toBe("deny")
      expect(PermissionNext.evaluate("skill", "skill-creator", looker!.permission).action).toBe("deny")
    },
  })
})

test("scout agent has selective skill permissions", async () => {
  await using tmp = await tmpdir()
  await Instance.provide({
    scope: await tmp.scope(),
    fn: async () => {
      const scout = await Agent.get("scout")
      expect(scout).toBeDefined()
      // Scout allows agent-browser and git-guide, denies frontend-design and skill-creator
      expect(PermissionNext.evaluate("skill", "agent-browser", scout!.permission).action).toBe("allow")
      expect(PermissionNext.evaluate("skill", "git-guide", scout!.permission).action).toBe("allow")
      expect(PermissionNext.evaluate("skill", "frontend-design", scout!.permission).action).toBe("deny")
      expect(PermissionNext.evaluate("skill", "skill-creator", scout!.permission).action).toBe("deny")
    },
  })
})

test("master agent allows all skills by default", async () => {
  await using tmp = await tmpdir()
  await Instance.provide({
    scope: await tmp.scope(),
    fn: async () => {
      const master = await Agent.get("master")
      expect(master).toBeDefined()
      expect(PermissionNext.evaluate("skill", "git-guide", master!.permission).action).toBe("allow")
      expect(PermissionNext.evaluate("skill", "skill-creator", master!.permission).action).toBe("allow")
      expect(PermissionNext.evaluate("skill", "frontend-design", master!.permission).action).toBe("allow")
      expect(PermissionNext.evaluate("skill", "agent-browser", master!.permission).action).toBe("allow")
    },
  })
})

test("Agent.defaultAgent() returns synergy by default", async () => {
  await using tmp = await tmpdir()
  await Instance.provide({
    scope: await tmp.scope(),
    fn: async () => {
      const defaultAgent = await Agent.defaultAgent()
      expect(defaultAgent).toBe("synergy")
    },
  })
})

test("Agent.defaultAgent() with default_agent config returns configured agent", async () => {
  await using tmp = await tmpdir({
    config: {
      default_agent: "master",
    },
  })
  await Instance.provide({
    scope: await tmp.scope(),
    fn: async () => {
      const defaultAgent = await Agent.defaultAgent()
      expect(defaultAgent).toBe("master")
    },
  })
})

test("Agent.defaultAgent() with custom default_agent returns configured custom agent", async () => {
  await using tmp = await tmpdir({
    config: {
      default_agent: "custom_agent",
      agent: {
        custom_agent: {
          description: "A custom default agent",
        },
      },
    },
  })
  await Instance.provide({
    scope: await tmp.scope(),
    fn: async () => {
      const defaultAgent = await Agent.defaultAgent()
      expect(defaultAgent).toBe("custom_agent")
    },
  })
})

test("Agent.list() sorts configured default_agent first", async () => {
  await using tmp = await tmpdir({
    config: {
      default_agent: "scribe",
    },
  })
  await Instance.provide({
    scope: await tmp.scope(),
    fn: async () => {
      const agents = await Agent.list()
      const firstAgent = agents[0]
      expect(firstAgent.name).toBe("scribe")
    },
  })
})

test("Agent.list() sorts synergy first when no default_agent configured", async () => {
  await using tmp = await tmpdir()
  await Instance.provide({
    scope: await tmp.scope(),
    fn: async () => {
      const agents = await Agent.list()
      const firstAgent = agents[0]
      expect(firstAgent.name).toBe("synergy")
    },
  })
})
