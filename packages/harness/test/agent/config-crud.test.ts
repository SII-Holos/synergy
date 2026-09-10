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
          scope: "global",
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
        for (const bad of ["not-a-model-ref", "openai/", "/gpt-5", "/"]) {
          await expect(
            AgentConfig.create({ name: "bad-model", prompt: "x", model: bad, scope: "project" }),
          ).rejects.toThrow(/model.*provider\/model/i)
        }
      },
    })
  })

  test("creates parent directories for nested agent names", async () => {
    await using tmp = await tmpdir()
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        await AgentConfig.create({
          name: "team/reviewer",
          prompt: "nested reviewer",
          scope: "project",
        })

        const file = path.join(tmp.path, ".synergy", "agent", "team", "reviewer.md")
        expect(
          await fs.access(file).then(
            () => true,
            () => false,
          ),
        ).toBe(true)
        expect(await Agent.get("team/reviewer")).toBeDefined()
      },
    })
  })

  test("aborted signal rejects before any write lands", async () => {
    await using tmp = await tmpdir()
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const controller = new AbortController()
        controller.abort()
        await expect(
          AgentConfig.create({
            name: "cancelled-agent",
            prompt: "never lands",
            scope: "project",
            signal: controller.signal,
          }),
        ).rejects.toThrow(/cancelled/i)

        expect(await Agent.get("cancelled-agent")).toBeUndefined()
        const file = path.join(tmp.path, ".synergy", "agent", "cancelled-agent.md")
        await expect(fs.access(file)).rejects.toThrow()
      },
    })
  })
})

describe("AgentConfig ownership resolution", () => {
  test("resolves markdown owners by frontmatter name, not filename", async () => {
    await using tmp = await tmpdir()
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        // legacy.md carries a frontmatter name override, like the loader permits
        await fs.mkdir(path.join(tmp.path, ".synergy", "agent"), { recursive: true })
        await Bun.write(
          path.join(tmp.path, ".synergy", "agent", "legacy.md"),
          "---\nname: reviewer\ndescription: frontmatter owner\n---\nPrompt body",
        )
        await Agent.reload()
        expect(await Agent.get("reviewer")).toBeDefined()

        const updated = await AgentConfig.update({ name: "reviewer", patch: { description: "updated" } })
        expect(updated.source).toBe("markdown")
        expect(updated.file).toContain("legacy.md")

        const agent = await Agent.get("reviewer")
        expect(agent?.description).toBe("updated")

        // delete removes the actual owning file
        await AgentConfig.remove({ name: "reviewer", strategy: "delete" })
        await expect(fs.access(path.join(tmp.path, ".synergy", "agent", "legacy.md"))).rejects.toThrow()
        expect(await Agent.get("reviewer")).toBeUndefined()
      },
    })
  })
})

describe("AgentConfig graph validation", () => {
  test("rejects removing a delegation group another agent's visibleTo depends on", async () => {
    await using tmp = await tmpdir()
    const scope = await tmp.scope()
    await ScopeContext.provide({
      scope,
      fn: async () => {
        await AgentConfig.create({
          name: "group-owner",
          prompt: "owner",
          delegationGroups: ["reviewers"],
          scope: "project",
        })
        await AgentConfig.create({
          name: "group-member",
          prompt: "member",
          visibleTo: ["reviewers"],
          scope: "project",
        })

        await expect(AgentConfig.update({ name: "group-owner", patch: { delegationGroups: [] } })).rejects.toThrow(
          /group-member.*unreachable/i,
        )

        // disabling the group owner equally breaks the member's only identity
        await expect(AgentConfig.remove({ name: "group-owner" })).rejects.toThrow(/group-member.*unreachable/i)

        // clearing the dependent visibleTo first unblocks the write
        await AgentConfig.update({ name: "group-member", patch: { visibleTo: [] } })
        await expect(AgentConfig.remove({ name: "group-owner" })).resolves.toBeDefined()
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
        await AgentConfig.update({ name: "reviewer", patch: { description: "after" } })

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
        await AgentConfig.update({ name: "explore", patch: { model: "openai/gpt-test" } })

        const domain = await Config.domainGet("agents")
        expect(domain.agent?.["explore"]).toMatchObject({ model: "openai/gpt-test" })

        const agent = await Agent.get("explore")
        expect(agent?.model).toMatchObject({ providerID: "openai", modelID: "gpt-test" })
      },
    })
  })

  test("null clears an explicit model so modelRole takes effect", async () => {
    await using tmp = await tmpdir()
    const scope = await tmp.scope()
    await ScopeContext.provide({
      scope,
      fn: async () => {
        await AgentConfig.create({
          name: "role-switcher",
          prompt: "switch",
          model: "openai/explicit-model",
          modelRole: "mid",
          scope: "project",
        })
        expect((await Agent.get("role-switcher"))?.modelSource).toBe("explicit")

        await AgentConfig.update({ name: "role-switcher", patch: { model: null } })

        const agent = await Agent.get("role-switcher")
        expect(agent?.model).toBeUndefined()
        expect(agent?.modelRole).toBe("mid")
        expect(agent?.modelSource).toBe("role")
      },
    })
  })

  test("re-enabling a disabled markdown agent leaves no residual overlay", async () => {
    await using tmp = await tmpdir()
    const scope = await tmp.scope()
    await ScopeContext.provide({
      scope,
      fn: async () => {
        await AgentConfig.create({ name: "cycle-agent", prompt: "cycle", scope: "project" })
        await AgentConfig.remove({ name: "cycle-agent", strategy: "disable" })
        expect(await Agent.get("cycle-agent")).toBeUndefined()

        await AgentConfig.update({ name: "cycle-agent", patch: { disable: false } })
        expect(await Agent.get("cycle-agent")).toBeDefined()

        const domain = await Config.domainGet("agents")
        expect(domain.agent?.["cycle-agent"]).toBeUndefined()

        // deleting after the disable/re-enable cycle removes the file outright
        await AgentConfig.remove({ name: "cycle-agent", strategy: "delete" })
        const file = path.join(tmp.path, ".synergy", "agent", "cycle-agent.md")
        await expect(fs.access(file)).rejects.toThrow()
        expect(await Agent.get("cycle-agent")).toBeUndefined()
      },
    })
  })
})

describe("AgentConfig scoped disable", () => {
  test("disabling a project markdown agent writes the flag to the project layer", async () => {
    await using tmp = await tmpdir()
    const scope = await tmp.scope()
    await ScopeContext.provide({
      scope,
      fn: async () => {
        await AgentConfig.create({ name: "project-agent", prompt: "project", scope: "project" })
        expect(await Agent.get("project-agent")).toBeDefined()

        await AgentConfig.remove({ name: "project-agent", strategy: "disable" })

        const projectDomain = await Config.domainGet("agents", path.join(tmp.path, ".synergy"))
        expect(projectDomain.agent?.["project-agent"]).toMatchObject({ disable: true })

        const globalDomain = await Config.domainGet("agents")
        expect(globalDomain.agent?.["project-agent"]).toBeUndefined()
      },
    })
  })

  test("deleting a markdown agent clears the owning layer jsonc overlay", async () => {
    await using tmp = await tmpdir()
    const scope = await tmp.scope()
    await ScopeContext.provide({
      scope,
      fn: async () => {
        await AgentConfig.create({ name: "overlay-agent", prompt: "base", scope: "project" })
        await AgentConfig.remove({ name: "overlay-agent", strategy: "disable" })
        await AgentConfig.update({ name: "overlay-agent", patch: { disable: false, model: "openai/x" } })
        const projectRoot = path.join(tmp.path, ".synergy")
        expect(await Config.domainGet("agents", projectRoot)).toMatchObject({
          agent: { "overlay-agent": { model: "openai/x" } },
        })

        await AgentConfig.remove({ name: "overlay-agent", strategy: "delete" })

        expect(await Agent.get("overlay-agent")).toBeUndefined()
        expect((await Config.domainGet("agents", projectRoot)).agent?.["overlay-agent"]).toBeUndefined()
        const file = path.join(projectRoot, "agent", "overlay-agent.md")
        await expect(fs.access(file)).rejects.toThrow()
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
        await AgentConfig.remove({ name: "explore", strategy: "disable" })

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

        await AgentConfig.remove({ name: "temp-agent", strategy: "delete" })

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
        await AgentConfig.create({ name: "jsonc-agent", description: "entry", storage: "jsonc", scope: "global" })
        expect((await Config.domainGet("agents")).agent?.["jsonc-agent"]).toBeDefined()

        await AgentConfig.remove({ name: "jsonc-agent", strategy: "delete" })

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

  test("falls back to another available primary when synergy itself is disabled", async () => {
    await using tmp = await tmpdir({
      config: {
        agent: { synergy: { disable: true } },
      },
    })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const resolved = await Agent.defaultAgent()
        expect(resolved).not.toBe("synergy")
        expect(await Agent.get(resolved)).toBeDefined()
        expect((await Agent.get(resolved))?.mode).not.toBe("subagent")
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

describe("AgentConfig write boundaries", () => {
  test("JSONC creation and disable stay in the project layer", async () => {
    await using tmp = await tmpdir()
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        await AgentConfig.create({ name: "scoped-json", storage: "jsonc", scope: "project", description: "local" })
        const root = path.join(tmp.path, ".synergy")
        expect((await Config.domainGet("agents", root)).agent?.["scoped-json"]?.description).toBe("local")
        expect((await Config.domainGet("agents")).agent?.["scoped-json"]).toBeUndefined()
        await AgentConfig.remove({ name: "scoped-json" })
        expect((await Config.domainGet("agents", root)).agent?.["scoped-json"]?.disable).toBe(true)
        expect((await Config.domainGet("agents")).agent?.["scoped-json"]).toBeUndefined()
      },
    })
  })

  test("null clears a markdown prompt", async () => {
    await using tmp = await tmpdir()
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        await AgentConfig.create({ name: "clear-prompt", prompt: "old prompt" })
        await AgentConfig.update({ name: "clear-prompt", patch: { prompt: null } })
        expect((await Agent.get("clear-prompt"))?.prompt ?? "").toBe("")
      },
    })
  })

  test("built-in overrides and re-enabling use the same model validation", async () => {
    await using tmp = await tmpdir()
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        await expect(AgentConfig.update({ name: "explore", patch: { model: "broken" } })).rejects.toThrow(
          /provider\/model/,
        )
        await AgentConfig.create({ name: "disabled-json", storage: "jsonc", scope: "global" })
        await AgentConfig.remove({ name: "disabled-json" })
        await expect(
          AgentConfig.update({ name: "disabled-json", patch: { disable: false, model: "broken" } }),
        ).rejects.toThrow(/provider\/model/)
      },
    })
  })

  test("concurrent JSONC updates preserve both patches", async () => {
    await using tmp = await tmpdir()
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        await AgentConfig.create({ name: "concurrent-json", storage: "jsonc", scope: "global", description: "before" })
        await Promise.all([
          AgentConfig.update({ name: "concurrent-json", patch: { description: "after" } }),
          AgentConfig.update({ name: "concurrent-json", patch: { model: "openai/test" } }),
        ])
        expect((await Config.domainGet("agents")).agent?.["concurrent-json"]).toMatchObject({
          description: "after",
          model: "openai/test",
        })
      },
    })
  })

  test("update disable reports success and validates dependent visibility", async () => {
    await using tmp = await tmpdir()
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        await AgentConfig.create({ name: "disable-update", prompt: "owner", delegationGroups: ["unique-review-group"] })
        await AgentConfig.create({ name: "dependent-update", prompt: "member", visibleTo: ["unique-review-group"] })
        await expect(AgentConfig.update({ name: "disable-update", patch: { disable: true } })).rejects.toThrow(
          /unreachable/,
        )
        await expect(AgentConfig.update({ name: "disable-update", patch: { delegationGroups: null } })).rejects.toThrow(
          /unreachable/,
        )
        await AgentConfig.update({ name: "dependent-update", patch: { visibleTo: [] } })
        await expect(AgentConfig.update({ name: "disable-update", patch: { disable: true } })).resolves.toBeDefined()
        expect(await Agent.get("disable-update")).toBeUndefined()
      },
    })
  })

  test("deleting project markdown preserves an independent global definition", async () => {
    await using tmp = await tmpdir()
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        await AgentConfig.create({ name: "layered-agent", prompt: "project" })
        await Config.domainUpdate("agents", { agent: { "layered-agent": { description: "global definition" } } })
        await Agent.reload()
        await AgentConfig.remove({ name: "layered-agent", strategy: "delete" })
        expect((await Config.domainGet("agents")).agent?.["layered-agent"]?.description).toBe("global definition")
      },
    })
  })

  test("defaultAgent fails explicitly when no visible primary exists", async () => {
    await using tmp = await tmpdir()
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const primary = (await Agent.list()).filter((agent) => agent.mode !== "subagent" && !agent.hidden)
        await Config.domainUpdate("agents", {
          agent: Object.fromEntries(primary.map((agent) => [agent.name, { hidden: true }])),
        })
        await Agent.reload()
        await expect(Agent.defaultAgent()).rejects.toThrow(/visible primary/)
      },
    })
  })
})

test("clearing the last custom JSONC field keeps the agent definition", async () => {
  await using tmp = await tmpdir()
  await ScopeContext.provide({
    scope: await tmp.scope(),
    fn: async () => {
      await AgentConfig.create({ name: "minimal-json", storage: "jsonc", description: "only field" })
      await AgentConfig.update({ name: "minimal-json", patch: { description: null } })
      expect(await Agent.get("minimal-json")).toBeDefined()
      await AgentConfig.remove({ name: "minimal-json" })
      await AgentConfig.update({ name: "minimal-json", patch: { disable: false } })
      expect(await Agent.get("minimal-json")).toBeDefined()
    },
  })
})
