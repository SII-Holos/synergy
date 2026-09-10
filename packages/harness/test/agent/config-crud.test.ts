import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import path from "path"
import fs from "fs/promises"
import { AgentConfig } from "../../src/agent/config-crud"
import { Agent } from "../../src/agent/agent"
import { Config } from "../../src/config/config"
import { ScopeContext } from "../../src/scope/context"
import { tmpdir } from "../support/fixture"

let originalAgentsConfig: Awaited<ReturnType<typeof Config.domainGet>> | undefined

beforeEach(async () => {
  originalAgentsConfig = await Config.domainGet("agents")
})

afterEach(async () => {
  if (originalAgentsConfig) {
    await Config.domainUpdate("agents", originalAgentsConfig, { mode: "replace-domain" })
    originalAgentsConfig = undefined
  }
  await Agent.reload()
})

describe("AgentConfig.create", () => {
  test("creates a markdown agent file in project scope and the agent resolves after reload", async () => {
    await using tmp = await tmpdir()
    const scope = await tmp.scope()
    await ScopeContext.provide({
      scope,
      fn: async () => {
        await AgentConfig.create({
          name: "reviewer",
          description: "Security-focused code reviewer for pull requests.",
          mode: "subagent",
          prompt: "You are a security-focused code reviewer.",
          scope: "project",
        })

        const file = path.join(tmp.path, ".synergy", "agent", "reviewer.md")
        const content = await fs.readFile(file, "utf8")
        expect(content).toContain("security-focused code reviewer")

        const agent = await Agent.get("reviewer")
        expect(agent).toBeDefined()
        expect(agent?.description).toBe("Security-focused code reviewer for pull requests.")
        expect(agent?.mode).toBe("subagent")
        expect(agent?.prompt).toBe("You are a security-focused code reviewer.")
      },
    })
  })

  test("creates a jsonc entry for override-style definitions without a prompt", async () => {
    await using tmp = await tmpdir()
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        await AgentConfig.create({
          name: "explore-override",
          description: "Override entry for explore model.",
          storage: "jsonc",
        })

        const domain = await Config.domainGet("agents")
        expect(domain.agent?.["explore-override"]).toMatchObject({ description: "Override entry for explore model." })
      },
    })
  })

  test("rejects a name that conflicts with an existing agent unless overwrite is set", async () => {
    await using tmp = await tmpdir()
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        await expect(AgentConfig.create({ name: "synergy", prompt: "duplicate", scope: "project" })).rejects.toThrow(
          /already exists/i,
        )

        await expect(
          AgentConfig.create({ name: "explore", model: "openai/gpt-test", scope: "project" }),
        ).rejects.toThrow(/already exists/i)
      },
    })
  })

  test("rejects invalid visibleTo references with an actionable error", async () => {
    await using tmp = await tmpdir()
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        await expect(
          AgentConfig.create({
            name: "guarded-helper",
            prompt: "helper",
            visibleTo: ["nonexistent-caller"],
            scope: "project",
          }),
        ).rejects.toThrow(/visibleTo.*no agent or delegation group.*nonexistent-caller/i)
      },
    })
  })

  test("accepts visibleTo entries that match a delegation group declared by another agent", async () => {
    await using tmp = await tmpdir()
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        await AgentConfig.create({
          name: "group-owner",
          prompt: "owner",
          delegationGroups: ["reviewers"],
          scope: "project",
        })
        await expect(
          AgentConfig.create({
            name: "group-member",
            prompt: "member",
            visibleTo: ["reviewers"],
            scope: "project",
          }),
        ).resolves.toBeDefined()
      },
    })
  })

  test("rejects an invalid model reference format", async () => {
    await using tmp = await tmpdir()
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        await expect(
          AgentConfig.create({ name: "bad-model", prompt: "x", model: "not-a-model-ref", scope: "project" }),
        ).rejects.toThrow(/model.*provider\/model/i)
      },
    })
  })
})

describe("AgentConfig.update", () => {
  test("updates the markdown file in place preserving unspecified fields", async () => {
    await using tmp = await tmpdir()
    const scope = await tmp.scope()
    await ScopeContext.provide({
      scope,
      fn: async () => {
        await AgentConfig.create({
          name: "reviewer",
          description: "before",
          mode: "subagent",
          prompt: "original prompt",
          scope: "project",
        })
        await AgentConfig.update("reviewer", { description: "after" })

        const agent = await Agent.get("reviewer")
        expect(agent?.description).toBe("after")
        expect(agent?.prompt).toBe("original prompt")
        expect(agent?.mode).toBe("subagent")
      },
    })
  })

  test("updating a builtin agent writes a jsonc override entry", async () => {
    await using tmp = await tmpdir()
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        await AgentConfig.update("explore", { model: "openai/gpt-test" })

        const domain = await Config.domainGet("agents")
        expect(domain.agent?.["explore"]).toMatchObject({ model: "openai/gpt-test" })

        const agent = await Agent.get("explore")
        expect(agent?.model).toMatchObject({ providerID: "openai", modelID: "gpt-test" })
      },
    })
  })
})

describe("AgentConfig.setDefault", () => {
  test("sets default_agent for a valid visible primary agent", async () => {
    await using tmp = await tmpdir()
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        await AgentConfig.create({
          name: "my-primary",
          description: "custom primary",
          mode: "primary",
          prompt: "primary prompt",
          scope: "project",
        })
        await AgentConfig.setDefault("my-primary")

        expect((await Config.current()).default_agent).toBe("my-primary")
        expect(await Agent.defaultAgent()).toBe("my-primary")
      },
    })
  })

  test("rejects setting default_agent to a subagent-only agent", async () => {
    await using tmp = await tmpdir()
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        await expect(AgentConfig.setDefault("developer")).rejects.toThrow(/primary/i)
      },
    })
  })

  test("rejects setting default_agent to a hidden agent", async () => {
    await using tmp = await tmpdir()
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        await expect(AgentConfig.setDefault("boss-synergy")).rejects.toThrow(/hidden/i)
      },
    })
  })

  test("rejects setting default_agent to an unknown agent", async () => {
    await using tmp = await tmpdir()
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        await expect(AgentConfig.setDefault("ghost-agent")).rejects.toThrow(/not found|does not exist/i)
      },
    })
  })
})

describe("AgentConfig.remove", () => {
  test("disable strategy writes disable:true and the agent disappears", async () => {
    await using tmp = await tmpdir()
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        await AgentConfig.remove("explore", { strategy: "disable" })

        const domain = await Config.domainGet("agents")
        expect(domain.agent?.["explore"]).toMatchObject({ disable: true })
        expect(await Agent.get("explore")).toBeUndefined()
      },
    })
  })

  test("delete strategy removes the markdown file that owns the agent", async () => {
    await using tmp = await tmpdir()
    const scope = await tmp.scope()
    await ScopeContext.provide({
      scope,
      fn: async () => {
        await AgentConfig.create({
          name: "temp-agent",
          prompt: "temporary",
          scope: "project",
        })
        expect(await Agent.get("temp-agent")).toBeDefined()

        await AgentConfig.remove("temp-agent", { strategy: "delete" })

        const file = path.join(tmp.path, ".synergy", "agent", "temp-agent.md")
        await expect(fs.access(file)).rejects.toThrow()
        expect(await Agent.get("temp-agent")).toBeUndefined()
      },
    })
  })

  test("delete strategy removes a jsonc-only entry", async () => {
    await using tmp = await tmpdir()
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        await AgentConfig.create({ name: "jsonc-agent", description: "entry", storage: "jsonc" })
        expect((await Config.domainGet("agents")).agent?.["jsonc-agent"]).toBeDefined()

        await AgentConfig.remove("jsonc-agent", { strategy: "delete" })

        expect((await Config.domainGet("agents")).agent?.["jsonc-agent"]).toBeUndefined()
      },
    })
  })
})

describe("Agent.defaultAgent fallback", () => {
  test("falls back to synergy with a warning when default_agent points to a nonexistent agent", async () => {
    await using tmp = await tmpdir({ config: { default_agent: "ghost-agent" } })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        expect(await Agent.defaultAgent()).toBe("synergy")
      },
    })
  })

  test("falls back to synergy when default_agent points to a subagent-only agent", async () => {
    await using tmp = await tmpdir({ config: { default_agent: "developer" } })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        expect(await Agent.defaultAgent()).toBe("synergy")
      },
    })
  })

  test("falls back to synergy when default_agent points to a hidden agent", async () => {
    await using tmp = await tmpdir({ config: { default_agent: "boss-synergy" } })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        expect(await Agent.defaultAgent()).toBe("synergy")
      },
    })
  })

  test("returns a configured custom primary agent as default", async () => {
    await using tmp = await tmpdir({
      config: {
        default_agent: "custom_agent",
        agent: { custom_agent: { description: "A custom default agent" } },
      },
    })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        expect(await Agent.defaultAgent()).toBe("custom_agent")
      },
    })
  })
})
