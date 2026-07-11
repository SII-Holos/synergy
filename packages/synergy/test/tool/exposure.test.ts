import { describe, expect, test } from "bun:test"
import z from "zod"
import { Agent } from "../../src/agent/agent"
import { createBuiltinMaxSubagents } from "../../src/agent/builtin-max-subagents"
import { BlueprintLoopStore } from "../../src/blueprint"
import { PermissionNext } from "../../src/permission/next"
import { ScopeContext } from "../../src/scope/context"
import { Session } from "../../src/session"
import { ToolResolver } from "../../src/session/tool-resolver"
import { ExpandToolsTool } from "../../src/tool/expand-tools"
import { ToolDiscovery } from "../../src/tool/discovery"
import { ToolExposure } from "../../src/tool/exposure"
import { SearchToolsTool } from "../../src/tool/search-tools"
import { Tool } from "../../src/tool/tool"
import { ToolRegistry } from "../../src/tool/registry"
import { Log } from "../../src/util/log"
import { tool as pluginTool } from "../../../plugin/src/tool"
import { tmpdir } from "../fixture/fixture"

Log.init({ print: false })

const model = {
  id: "test-model",
  providerID: "test-provider",
  name: "Test Model",
  limit: { context: 100_000, output: 8_192 },
  cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
  api: { id: "test-model", npm: "@ai-sdk/openai" },
  capabilities: {
    toolcall: true,
    attachment: false,
    reasoning: false,
    temperature: true,
    input: { text: true, image: false, audio: false, video: false },
    output: { text: true, image: false, audio: false, video: false },
  },
  options: {},
} as any

const imageModel = {
  ...model,
  capabilities: {
    ...model.capabilities,
    input: { ...model.capabilities.input, image: true },
  },
} as any

const allowAllAgent: Agent.Info = {
  name: "synergy",
  mode: "primary",
  permission: PermissionNext.fromConfig({ "*": "allow" }),
  options: {},
}

const builtinCtx = {
  defaults: [],
  user: [],
  role: () => undefined,
  evolutionActive: false,
}

async function definitionIDs(
  session: Session.Info,
  input?: { agent?: Agent.Info; model?: typeof model; userTools?: Record<string, boolean> },
) {
  const defs = await ToolResolver.definitions({
    agent: input?.agent ?? allowAllAgent,
    model: input?.model ?? model,
    sessionID: session.id,
    session,
    userTools: input?.userTools,
    includeMCP: false,
  })
  return new Set(defs.map((def) => def.id))
}

async function definitions(session: Session.Info) {
  return ToolResolver.definitions({
    agent: allowAllAgent,
    model,
    sessionID: session.id,
    session,
    includeMCP: false,
  })
}

function toolContext(sessionID: string): Tool.Context {
  return {
    sessionID,
    messageID: "message_test",
    agent: "synergy",
    abort: new AbortController().signal,
    extra: { model },
    metadata() {},
    async ask() {},
  }
}

describe("tool exposure", () => {
  test("defaults to resident and classifies built-in groups and explicit search/internal tools", () => {
    const explicit = Tool.define(
      "explicit_search_tool",
      {
        description: "Only visible after activation.",
        parameters: z.object({}),
        async execute() {
          return { title: "explicit_search_tool", output: "ok", metadata: {} }
        },
      },
      { exposure: { mode: "search", title: "Explicit Search Tool", keywords: ["needle"] } },
    )
    const internal = Tool.define(
      "internal_helper_tool",
      {
        description: "Only visible when force-enabled by the host.",
        parameters: z.object({}),
        async execute() {
          return { title: "internal_helper_tool", output: "ok", metadata: {} }
        },
      },
      { exposure: { mode: "internal" } },
    )

    expect(ToolExposure.normalize("ordinary_tool")).toEqual({ mode: "resident" })
    expect(ToolExposure.normalize("browser_navigation")).toEqual({ mode: "group", group: "browser" })
    expect(explicit.exposure).toEqual({ mode: "search", title: "Explicit Search Tool", keywords: ["needle"] })
    expect(internal.exposure).toEqual({ mode: "internal" })
  })

  test("ToolResolver exposes exactly one image inspection tool for active model capability", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const session = await Session.create({})

        const textOnly = await definitionIDs(session)
        expect(textOnly.has("look_at")).toBe(true)
        expect(textOnly.has("view_image")).toBe(false)

        const imageCapable = await definitionIDs(session, { model: imageModel })
        expect(imageCapable.has("look_at")).toBe(false)
        expect(imageCapable.has("view_image")).toBe(true)
      },
    })
  })

  test("ToolResolver hides deferred groups until the session expands them", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const session = await Session.create({})
        let ids = await definitionIDs(session)

        expect(ids.has("search_tools")).toBe(true)
        expect(ids.has("expand_tools")).toBe(true)
        expect(ids.has("browser_navigation")).toBe(false)
        expect(ids.has("agenda_list")).toBe(false)
        expect(ids.has("session_list")).toBe(false)
        expect(ids.has("note_list")).toBe(false)
        expect(ids.has("memory_get")).toBe(false)
        expect(ids.has("email_send")).toBe(false)
        expect(ids.has("worktree_enter")).toBe(false)

        await Session.update(session.id, (draft) => {
          draft.toolState = { expandedGroups: ["browser"] }
        })

        const expanded = await Session.get(session.id)
        ids = await definitionIDs(expanded)
        expect(ids.has("browser_navigation")).toBe(true)
        expect(ids.has("browser_screenshot")).toBe(true)
        expect(ids.has("agenda_list")).toBe(false)

        expect((await Session.get(session.id)).toolState?.expandedGroups).toEqual(["browser"])
      },
    })
  })

  test("search-only tools are visible only after explicit activation", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const id = `search_only_test_${Math.random().toString(36).slice(2)}`
        await ToolRegistry.register(
          Tool.define(
            id,
            {
              description: "A test-only deferred tool.",
              parameters: z.object({}),
              async execute() {
                return { title: id, output: "ok", metadata: {} }
              },
            },
            { exposure: { mode: "search", title: "Test Deferred Tool", keywords: ["deferred-test"] } },
          ),
        )

        const session = await Session.create({})
        expect((await definitionIDs(session)).has(id)).toBe(false)

        await Session.update(session.id, (draft) => {
          draft.toolState = { activatedTools: [id] }
        })

        expect((await definitionIDs(await Session.get(session.id))).has(id)).toBe(true)
      },
    })
  })

  test("internal tools are hidden from search and visible only when force-enabled", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const id = `internal_test_${Math.random().toString(36).slice(2)}`
        await ToolRegistry.register(
          Tool.define(
            id,
            {
              description: "A test-only internal tool.",
              parameters: z.object({}),
              async execute() {
                return { title: id, output: "ok", metadata: {} }
              },
            },
            { exposure: { mode: "internal" } },
          ),
        )

        const session = await Session.create({})
        expect((await definitionIDs(session)).has(id)).toBe(false)
        expect((await definitionIDs(session, { userTools: { [id]: true } })).has(id)).toBe(true)

        const search = await SearchToolsTool.init({ agent: allowAllAgent })
        const searchResult = await search.execute({ query: id, limit: 8 }, toolContext(session.id))
        expect((searchResult.metadata.results as Array<any>).some((entry) => entry.id === id)).toBe(false)
      },
    })
  })

  test("skips plugin tools with incompatible schemas without hiding valid tools", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const suffix = Math.random().toString(36).slice(2)
        const goodId = `good_plugin_schema_${suffix}`
        const badId = `bad_plugin_schema_${suffix}`
        await ToolRegistry.register(
          Tool.define(goodId, {
            description: "A valid test plugin tool.",
            parameters: z.object({ query: z.string() }),
            async execute() {
              return { title: goodId, output: "ok", metadata: {} }
            },
          }),
        )
        await ToolRegistry.register({
          id: badId,
          source: {
            type: "plugin",
            pluginId: "focus",
            toolId: "bad_schema",
            pluginDir: "/tmp/focus",
            runtimeMode: "inProcess",
          },
          init: async () => ({
            description: "An invalid plugin tool.",
            parameters: z.object({ broken: { _def: { typeName: "ZodString" } } as any }),
            async execute() {
              return { title: badId, output: "should not run", metadata: {} }
            },
          }),
        })

        const session = await Session.create({})
        const availability = await ToolResolver.availability({
          agent: allowAllAgent,
          model,
          sessionID: session.id,
          session,
          includeMCP: false,
        })

        expect(availability.visible.some((item) => item.id === goodId)).toBe(true)
        expect(availability.visible.some((item) => item.id === badId)).toBe(false)
        const diagnostic = availability.diagnostics.get(badId)
        expect(diagnostic?.code).toBe("tool_unavailable")
        expect(diagnostic?.message).toContain("zod >=4")
        expect(diagnostic?.metadata).toMatchObject({
          pluginId: "focus",
          pluginToolId: "bad_schema",
          runtimeMode: "inProcess",
        })
      },
    })
  })

  test("search_tools is read-only and expand_tools persists session state", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const session = await Session.create({})
        const search = await SearchToolsTool.init({ agent: allowAllAgent })
        const searchResult = await search.execute({ query: "memory note", limit: 8 }, toolContext(session.id))
        const searchResults = searchResult.metadata.results as Array<any>
        const memoryResult = searchResults.find((result) => result.id === "memory")
        const noteResult = searchResults.find((result) => result.id === "note")
        expect(memoryResult).toMatchObject({ type: "group", id: "memory" })
        expect(memoryResult.matchedToolPreview).toContain("memory_search")
        expect(noteResult).toMatchObject({ type: "group", id: "note" })
        expect(searchResults.some((result) => result.type === "tool" && result.id.startsWith("memory_"))).toBe(false)
        expect(searchResult.output).not.toContain("Structured results")
        expect((await Session.get(session.id)).toolState).toBeUndefined()

        const expand = await ExpandToolsTool.init({ agent: allowAllAgent })
        const result = await expand.execute(
          { groups: ["browser"], reason: "test browser expansion" },
          toolContext(session.id),
        )
        expect(result.metadata.availableNextStep).toBe(true)
        expect(result.metadata.availableOn).toBe("next_model_request")
        expect(result.metadata.availableRequestedTools).toContain("browser_navigation")
        expect(result.metadata.newlyVisibleTools).toContain("browser_navigation")
        expect(result.metadata.newlyVisibleTools).not.toContain("search_tools")
        expect(result.metadata.visibleTools).toBeUndefined()
        expect(result.output).toContain("You can call these tools directly:")
        expect(result.output).toContain("browser_navigation")
        expect(result.output).not.toContain("availableNextStep")
        expect(result.output).not.toContain("availableOn")
        expect(result.output).not.toContain("activatedTools: (none)")
        expect(result.output).not.toContain("visibleToolCount")
        expect(result.output).not.toContain("Structured result")
        expect((await Session.get(session.id)).toolState?.expandedGroups).toEqual(["browser"])
      },
    })
  })

  test("permissions and user tool settings still hide expanded tools", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const session = await Session.create({})
        await Session.update(session.id, (draft) => {
          draft.toolState = { expandedGroups: ["browser"] }
        })
        const expanded = await Session.get(session.id)
        const denyNavigate: Agent.Info = {
          ...allowAllAgent,
          permission: PermissionNext.fromConfig({ "*": "allow", browser_navigation: "deny" }),
        }

        expect((await definitionIDs(expanded, { agent: denyNavigate })).has("browser_navigation")).toBe(false)
        expect(
          (await definitionIDs(expanded, { userTools: { browser_navigation: false } })).has("browser_navigation"),
        ).toBe(false)
        expect((await definitionIDs(expanded, { agent: denyNavigate })).has("browser_screenshot")).toBe(true)
      },
    })
  })

  test("Plan keeps bash visible and forces the note group without exposing other deferred groups", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const session = await Session.create({})
        await Session.update(session.id, (draft) => {
          draft.workflow = { kind: "plan" }
        })

        const ids = await definitionIDs(await Session.get(session.id))
        expect(ids.has("bash")).toBe(true)
        expect(ids.has("edit")).toBe(false)
        expect(ids.has("search_tools")).toBe(true)
        expect(ids.has("expand_tools")).toBe(true)
        expect(ids.has("note_read")).toBe(true)
        expect(ids.has("note_write")).toBe(true)
        expect(ids.has("memory_get")).toBe(false)
        expect(ids.has("agenda_list")).toBe(false)
      },
    })
  })

  test("Plan does not override explicit permission denial for bash", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const session = await Session.create({})
        await Session.update(session.id, (draft) => {
          draft.workflow = { kind: "plan" }
        })
        const denyBash: Agent.Info = {
          ...allowAllAgent,
          permission: PermissionNext.fromConfig({ "*": "allow", bash: "deny" }),
        }

        const availability = await ToolResolver.availability({
          agent: denyBash,
          model,
          sessionID: session.id,
          session: await Session.get(session.id),
          includeMCP: false,
        })

        expect(availability.visible.some((def) => def.id === "bash")).toBe(false)
        expect(availability.diagnostics.get("bash")?.code).toBe("permission_denied")
      },
    })
  })

  test("LightLoop primary and recorded reviewer sessions expose the correct review tools", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const parent = await Session.create({})
        await Session.update(parent.id, (draft) => {
          draft.workflow = { kind: "lightloop", taskDescription: "Finish the feature" }
        })
        const primarySession = await Session.get(parent.id)

        let availability = await ToolResolver.availability({
          agent: allowAllAgent,
          model,
          sessionID: primarySession.id,
          session: primarySession,
          includeMCP: false,
        })
        expect(availability.visible.some((def) => def.id === "loop_stop")).toBe(true)
        expect(availability.visible.some((def) => def.id === "light_loop_approve")).toBe(false)
        expect(availability.visible.some((def) => def.id === "light_loop_reject")).toBe(false)
        expect(availability.diagnostics.get("light_loop_approve")?.code).toBe("permission_denied")
        expect(availability.diagnostics.get("light_loop_reject")?.code).toBe("permission_denied")

        const child = await Session.create({
          parentID: parent.id,
          cortex: {
            parentSessionID: parent.id,
            parentMessageID: "msg_parent",
            description: "Review LightLoop",
            agent: "lightloop-reviewer",
            executionRole: "delegated_subagent",
            startedAt: Date.now(),
            status: "running",
          },
        })
        await Session.update(parent.id, (draft) => {
          if (draft.workflow?.kind !== "lightloop") throw new Error("expected lightloop")
          draft.workflow.stopRequest = {
            summary: "done",
            requestedAt: Date.now(),
            requesterSessionID: parent.id,
            requesterMessageID: "msg_parent",
            reviewSessionID: child.id,
            reviewTaskID: "ctx_review",
          }
        })

        const reviewerAgent = {
          ...allowAllAgent,
          name: "lightloop-reviewer",
          mode: "subagent" as const,
        }
        const reviewerSession = await Session.get(child.id)
        availability = await ToolResolver.availability({
          agent: reviewerAgent,
          model,
          sessionID: reviewerSession.id,
          session: reviewerSession,
          includeMCP: false,
        })
        expect(availability.visible.some((def) => def.id === "light_loop_approve")).toBe(true)
        expect(availability.visible.some((def) => def.id === "light_loop_reject")).toBe(true)
        expect(availability.visible.some((def) => def.id === "loop_stop")).toBe(false)

        await Session.update(child.id, (draft) => {
          if (!draft.cortex) throw new Error("expected cortex child")
          draft.cortex.agent = "implementation-engineer"
        })
        availability = await ToolResolver.availability({
          agent: reviewerAgent,
          model,
          sessionID: child.id,
          session: await Session.get(child.id),
          includeMCP: false,
        })
        expect(availability.visible.some((def) => def.id === "light_loop_approve")).toBe(false)
        expect(availability.visible.some((def) => def.id === "light_loop_reject")).toBe(false)
      },
    })
  })

  test("BlueprintLoop execution and recorded reviewer sessions expose symmetric control tools", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const execution = await Session.create({})
        const loop = await BlueprintLoopStore.create({
          noteID: "note_blueprint",
          title: "Test Blueprint",
          sessionID: execution.id,
          auditAgent: "security-reviewer",
        })
        await BlueprintLoopStore.updateStatus(ScopeContext.current.scope.id, loop.id, { status: "running" })
        await Session.update(execution.id, (draft) => {
          draft.blueprint = { loopID: loop.id, loopRole: "execution" }
        })

        let availability = await ToolResolver.availability({
          agent: allowAllAgent,
          model,
          sessionID: execution.id,
          session: await Session.get(execution.id),
          includeMCP: false,
        })
        expect(availability.visible.some((def) => def.id === "blueprint_loop_stop")).toBe(true)
        expect(availability.visible.some((def) => def.id === "blueprint_loop_approve")).toBe(false)
        expect(availability.visible.some((def) => def.id === "blueprint_loop_reject")).toBe(false)

        const reviewer = await Session.create({
          parentID: execution.id,
          cortex: {
            parentSessionID: execution.id,
            parentMessageID: "msg_parent",
            description: "Audit BlueprintLoop",
            agent: "security-reviewer",
            executionRole: "delegated_subagent",
            startedAt: Date.now(),
            status: "running",
          },
        })
        await Session.update(reviewer.id, (draft) => {
          draft.blueprint = { loopID: loop.id, loopRole: "audit" }
        })
        await BlueprintLoopStore.updateStatus(ScopeContext.current.scope.id, loop.id, {
          status: "auditing",
          auditSessionID: reviewer.id,
          auditTaskID: "ctx_review",
        })

        const reviewerAgent = createBuiltinMaxSubagents(builtinCtx)["security-reviewer"]
        if (!reviewerAgent) throw new Error("missing security-reviewer")
        availability = await ToolResolver.availability({
          agent: reviewerAgent,
          model,
          sessionID: reviewer.id,
          session: await Session.get(reviewer.id),
          includeMCP: false,
        })
        expect(availability.visible.some((def) => def.id === "blueprint_loop_stop")).toBe(false)
        expect(availability.visible.some((def) => def.id === "blueprint_loop_approve")).toBe(true)
        expect(availability.visible.some((def) => def.id === "blueprint_loop_reject")).toBe(true)

        const unrelatedReviewer = await Session.create({
          parentID: execution.id,
          cortex: {
            parentSessionID: execution.id,
            parentMessageID: "msg_parent",
            description: "Unrecorded Blueprint audit",
            agent: "security-reviewer",
            executionRole: "delegated_subagent",
            startedAt: Date.now(),
            status: "running",
          },
        })
        await Session.update(unrelatedReviewer.id, (draft) => {
          draft.blueprint = { loopID: loop.id, loopRole: "audit" }
        })
        availability = await ToolResolver.availability({
          agent: reviewerAgent,
          model,
          sessionID: unrelatedReviewer.id,
          session: await Session.get(unrelatedReviewer.id),
          includeMCP: false,
        })
        expect(availability.visible.some((def) => def.id === "blueprint_loop_approve")).toBe(false)
        expect(availability.visible.some((def) => def.id === "blueprint_loop_reject")).toBe(false)
      },
    })
  })

  test("LightLoop review tools stay diagnostically denied outside the recorded reviewer session", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const parent = await Session.create({})
        await Session.update(parent.id, (draft) => {
          draft.workflow = {
            kind: "lightloop",
            taskDescription: "Finish the feature",
            stopRequest: {
              summary: "done",
              requestedAt: Date.now(),
              requesterSessionID: parent.id,
              requesterMessageID: "msg_parent",
              reviewSessionID: "ses_other_reviewer",
              reviewTaskID: "ctx_review",
            },
          }
        })
        const child = await Session.create({
          parentID: parent.id,
          cortex: {
            parentSessionID: parent.id,
            parentMessageID: "msg_parent",
            description: "Review LightLoop",
            agent: "lightloop-reviewer",
            executionRole: "delegated_subagent",
            startedAt: Date.now(),
            status: "running",
          },
        })
        const reviewerAgent = {
          ...allowAllAgent,
          name: "lightloop-reviewer",
          mode: "subagent" as const,
        }

        const availability = await ToolResolver.availability({
          agent: reviewerAgent,
          model,
          sessionID: child.id,
          session: await Session.get(child.id),
          includeMCP: false,
        })
        expect(availability.visible.some((def) => def.id === "light_loop_approve")).toBe(false)
        expect(availability.visible.some((def) => def.id === "light_loop_reject")).toBe(false)
        expect(availability.diagnostics.get("light_loop_approve")?.code).toBe("permission_denied")
        expect(availability.diagnostics.get("light_loop_reject")?.code).toBe("permission_denied")
      },
    })
  })

  test("recursive coordinator agents resolve task tools while ordinary subagents do not", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const session = await Session.create({})
        const agents = createBuiltinMaxSubagents(builtinCtx)
        const recursiveTools = ["task", "task_list", "task_output", "task_cancel", "dagwrite", "dagread", "dagpatch"]

        for (const name of ["supervisor", "lightloop-reviewer"]) {
          const agent = agents[name]
          if (!agent) throw new Error(`missing ${name}`)
          const availability = await ToolResolver.availability({
            agent,
            model,
            sessionID: session.id,
            session,
            includeMCP: false,
          })
          const visible = new Set(availability.visible.map((def) => def.id))
          for (const tool of recursiveTools) {
            expect(visible.has(tool), `${name}:${tool}`).toBe(true)
          }
          const task = availability.visible.find((def) => def.id === "task")
          expect(task?.description).toContain("implementation-engineer")
        }

        const ordinary = agents["implementation-engineer"]
        if (!ordinary) throw new Error("missing implementation-engineer")
        const availability = await ToolResolver.availability({
          agent: ordinary,
          model,
          sessionID: session.id,
          session,
          includeMCP: false,
        })
        const visible = new Set(availability.visible.map((def) => def.id))
        for (const tool of recursiveTools) {
          expect(visible.has(tool), `implementation-engineer:${tool}`).toBe(false)
          expect(availability.diagnostics.get(tool)?.code).toBe("permission_denied")
        }
      },
    })
  })

  test("Plan resolve keeps hidden tools inactive while preserving semantic diagnostic wrappers", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const session = await Session.create({})
        await Session.update(session.id, (draft) => {
          draft.workflow = { kind: "plan" }
        })
        const executions = new Map<string, Promise<any>>()
        const processor = {
          message: { id: "message_test" },
          partFromToolCall: () => undefined,
          beginExecution: (id: string) => {
            let outcome: any
            let resolvePromise!: (value: any) => void
            const promise = new Promise<any>((resolve) => {
              resolvePromise = resolve
            })
            executions.set(id, promise)
            return {
              callID: id,
              promise,
              resolve(value: any) {
                if (outcome) return
                outcome = value
                resolvePromise(value)
              },
              complete(input: unknown, result: any) {
                this.resolve({ status: "completed", input, result })
              },
              fail(input: unknown, error: string, metadata?: Record<string, any>) {
                this.resolve({ status: "error", input, error, metadata })
              },
              get outcome() {
                return outcome
              },
              get status() {
                return outcome ? "resolved" : "pending"
              },
            }
          },
        } as any

        const resolved = await ToolResolver.resolveWithAvailability({
          agent: allowAllAgent,
          model,
          sessionID: session.id,
          processor,
          session: await Session.get(session.id),
          includeMCP: false,
        })

        expect(resolved.activeToolIDs).toContain("bash")
        expect(resolved.activeToolIDs).not.toContain("edit")
        expect(resolved.tools.edit).toBeDefined()

        await expect(
          (resolved.tools.edit as any).execute({ filePath: "x" }, { toolCallId: "call_edit" }),
        ).rejects.toThrow("Plan")
        const outcome = await executions.get("call_edit")
        expect(outcome.status).toBe("error")
        expect(outcome.metadata.toolDiagnostic.code).toBe("plan_mode_blocked")
      },
    })
  })

  test("default tool budget is lower than expanded built-in groups", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const session = await Session.create({})
        const base = await definitions(session)
        await Session.update(session.id, (draft) => {
          draft.toolState = { expandedGroups: ToolExposure.BUILTIN_GROUPS.map((group) => group.id) }
        })
        const expanded = await definitions(await Session.get(session.id))

        const baseChars = base.reduce(
          (sum, def) => sum + def.description.length + JSON.stringify(def.inputSchema).length,
          0,
        )
        const expandedChars = expanded.reduce(
          (sum, def) => sum + def.description.length + JSON.stringify(def.inputSchema).length,
          0,
        )

        expect(base.length).toBeLessThan(expanded.length - 20)
        expect(expandedChars - baseChars).toBeGreaterThan(10_000)
      },
    })
  })

  test("MCP deferral threshold uses the total visible MCP tool count", () => {
    expect(ToolExposure.mcpExposure(ToolExposure.MCP_DEFER_THRESHOLD - 1, "github")).toEqual({ mode: "resident" })
    expect(ToolExposure.mcpExposure(ToolExposure.MCP_DEFER_THRESHOLD, "github")).toMatchObject({
      mode: "group",
      group: "mcp:github",
    })
    expect(ToolExposure.mcpToolID("github server", "list/repos")).toBe("mcp__github_server__list_repos")
  })

  test("plugin tools can declare exposure and default to resident compatibility", () => {
    const deferred = pluginTool({
      description: "Deferred plugin tool",
      exposure: { mode: "search", title: "Deferred Plugin", keywords: ["plugin"] },
      args: {},
      async execute() {
        return "ok"
      },
    })
    const compatible = pluginTool({
      description: "Compatible plugin tool",
      args: {},
      async execute() {
        return "ok"
      },
    })
    expect(deferred.exposure).toEqual({ mode: "search", title: "Deferred Plugin", keywords: ["plugin"] })
    expect(compatible.exposure).toBeUndefined()
  })

  test("ToolDiscovery marks grouped tool results with expandable groups", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const session = await Session.create({})
        const catalog = await ToolDiscovery.collect({
          providerID: model.providerID,
          agent: allowAllAgent,
          session,
          includeMCP: false,
        })
        const browserTool = ToolDiscovery.nonResidentEntries(catalog).find((entry) => entry.id === "browser_screenshot")

        expect(browserTool?.type).toBe("tool")
        expect(browserTool?.group).toBe("browser")
        expect(browserTool?.active).toBe(false)
      },
    })
  })
})
