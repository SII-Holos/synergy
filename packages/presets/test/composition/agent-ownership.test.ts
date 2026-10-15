import { expect, test } from "bun:test"
import { Agent } from "@ericsanchezok/synergy-harness/agent/agent"
import { AgentDelegation } from "@ericsanchezok/synergy-harness/agent/delegation"
import { AgentPermissionContributions } from "@ericsanchezok/synergy-harness/agent/permission-contributions"
import { PrimaryAgentIdentity } from "@ericsanchezok/synergy-harness/agent/primary-identity"
import { getDelegatableAgents } from "@ericsanchezok/synergy-harness/agent/prompt/agent-table"
import { ConfigSource } from "@ericsanchezok/synergy-harness/config/source"
import { PermissionNext } from "@ericsanchezok/synergy-harness/permission/next"
import { RuntimeComponents, type RuntimeComponent } from "@ericsanchezok/synergy-harness/lifecycle"
import { Scope } from "@ericsanchezok/synergy-harness/scope"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { ToolRegistry } from "@ericsanchezok/synergy-harness/tools"
import type { Provider } from "@ericsanchezok/synergy-harness/provider/provider"
import { LLM, ToolResolver } from "@ericsanchezok/synergy-harness/test/support/internals"
import { testRuntime } from "@ericsanchezok/synergy-harness/test/support/runtime"
import { localRuntime } from "@ericsanchezok/synergy-local-runtime/component"
import { blueprint } from "@ericsanchezok/synergy-blueprint/component"
import { BlueprintLoopStore } from "@ericsanchezok/synergy-blueprint/blueprint/loop-store"
import { lightLoop } from "@ericsanchezok/synergy-light-loop/component"
import { note } from "@ericsanchezok/synergy-note/component"
import { media } from "@ericsanchezok/synergy-media/component"
import { codeTools } from "@ericsanchezok/synergy-code-tools/component"
import { browser } from "@ericsanchezok/synergy-browser-runtime/component"
import { mcp } from "@ericsanchezok/synergy-mcp/component"
import { library } from "@ericsanchezok/synergy-library/component"
import { agenda } from "@ericsanchezok/synergy-agenda/component"
import { agendaBlueprint } from "@ericsanchezok/synergy-agenda-blueprint/component"
import { agendaLightLoop } from "@ericsanchezok/synergy-agenda-light-loop/component"
import { boss } from "@ericsanchezok/synergy-boss/component"
import { bossFeishu } from "@ericsanchezok/synergy-boss-feishu/component"
import { channels } from "@ericsanchezok/synergy-channels/component"
import { channelFeishu } from "@ericsanchezok/synergy-channel-feishu/component"
import { plugins } from "@ericsanchezok/synergy-plugin-host/component"

const model: Provider.Model = {
  id: "fixture",
  providerID: "fixture",
  name: "Fixture",
  family: "fixture",
  api: { id: "fixture", url: "https://example.invalid", npm: "@ai-sdk/openai" },
  capabilities: {
    temperature: true,
    reasoning: false,
    attachment: false,
    toolcall: true,
    input: { text: true, audio: false, image: true, video: false, pdf: false },
    output: { text: true, audio: false, image: false, video: false, pdf: false },
    interleaved: false,
  },
  cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
  limit: { context: 100_000, output: 8192 },
  status: "active",
  options: {},
  headers: {},
  release_date: "2026-01-01",
}

async function open(
  components: RuntimeComponent[],
  permission: Record<string, PermissionNext.Action> = {},
  renameReviewers = false,
) {
  const composition = RuntimeComponents.compose([localRuntime({ workers: false, environment: false }), ...components])
  return testRuntime({
    composition: {
      register() {
        composition.register()
        ConfigSource.register({
          resolve: async () => ({
            permission,
            ...(renameReviewers
              ? {
                  agent: {
                    supervisor: { name: "Renamed Blueprint reviewer" },
                    "lightloop-reviewer": { name: "Renamed Light Loop reviewer" },
                  },
                }
              : {}),
          }),
        })
      },
    },
  })
}

function action(agent: Agent.Info, permission: string) {
  return PermissionNext.evaluate(permission, "*", agent.permission).action
}

async function prepared(agent: Agent.Info, session: Session.Info) {
  const available = await ToolResolver.availability({ agent, model, sessionID: session.id, session, includeMCP: false })
  const availableToolIDs = [
    ...available.visible.filter((tool) => !available.diagnostics.has(tool.id)).map((tool) => tool.id),
    ...available.autoExpandable,
  ]
  const result = await LLM.prepare({
    agent,
    model,
    sessionID: session.id,
    tools: {},
    availableToolIDs,
    user: {
      id: "msg_owner_permissions",
      sessionID: session.id,
      role: "user",
      time: { created: Date.now() },
      agent: agent.name,
      model: { providerID: model.providerID, modelID: model.id },
    },
    system: [],
    messages: [],
    abort: new AbortController().signal,
  })
  return { prompt: result.system.join("\n"), availableToolIDs }
}

for (const selected of [false, true]) {
  for (const denied of [false, true]) {
    test(`reviewer optional evidence tools follow their owners and explicit denial (${selected}, ${denied})`, async () => {
      await using runtime = await open(
        [note(), blueprint(), lightLoop(), ...(selected ? [media(), codeTools(), browser()] : [])],
        denied ? { parse_code: "deny", look_at: "deny", scan_document: "deny", "browser_*": "deny" } : {},
        true,
      )
      await runtime.run(() =>
        ScopeContext.provide({
          scope: Scope.home(),
          async fn() {
            for (const name of ["supervisor", "lightloop-reviewer"]) {
              const reviewer = await Agent.get(name)
              expect(action(reviewer, "parse_code"), `${name}:semantic read`).toBe(denied ? "deny" : "allow")
              if (!selected) expect(reviewer.permission.some((rule) => rule.permission === "parse_code")).toBe(denied)
              for (const tool of ["look_at", "scan_document", "browser_navigation", "browser_action", "browser_upload"])
                expect(action(reviewer, tool), `${name}:${tool}`).toBe(selected && !denied ? "allow" : "deny")
              const session = await Session.create({ title: "Reviewer evidence" })
              const result = await prepared(reviewer, session)
              expect(result.prompt).not.toMatch(/\bparse_code\b|\blook_at\b|\bscan_document\b/)
              const registered = await ToolRegistry.ids()
              for (const tool of ["parse_code", "look_at", "scan_document"]) {
                expect(registered.includes(tool), `${name}:${tool}`).toBe(selected)
                if (!selected || denied) expect(result.availableToolIDs).not.toContain(tool)
              }
              expect(result.availableToolIDs.includes("parse_code")).toBe(selected && !denied)
            }
          },
        }),
      )
    }, 30_000)
  }
}

for (const selected of [false, true]) {
  for (const denied of [false, true]) {
    test(`reviewer read-only tools follow selected Note and Agenda owners (${selected}, ${denied})`, async () => {
      const tools = ["note_list", "note_read", "note_search", "agenda_list", "agenda_logs"]
      await using runtime = await open(
        [lightLoop(), ...(selected ? [note(), blueprint(), agenda()] : [])],
        denied ? Object.fromEntries(tools.map((id) => [id, "deny"])) : {},
        true,
      )
      await runtime.run(() =>
        ScopeContext.provide({
          scope: Scope.home(),
          async fn() {
            for (const name of selected ? ["supervisor", "lightloop-reviewer"] : ["lightloop-reviewer"]) {
              const reviewer = await Agent.get(name)
              for (const id of tools) {
                expect(action(reviewer, id), `${name}:${id}`).toBe(selected && !denied ? "allow" : "deny")
                if (!selected && !denied) expect(reviewer.permission.some((rule) => rule.permission === id)).toBe(false)
              }
              for (const id of [
                "note_write",
                "note_edit",
                "note_archive",
                "note_delete",
                "agenda_schedule",
                "agenda_watch",
                "agenda_cancel",
              ])
                expect(action(reviewer, id), `${name}:${id}`).toBe("deny")
            }
          },
        }),
      )
    })
  }
}

for (const kind of ["blueprint", "light-loop"] as const) {
  for (const selected of [false, true]) {
    for (const deniedTool of [undefined, "agenda_cancel", kind === "blueprint" ? "blueprint_loop_stop" : "loop_stop"]) {
      test(`${kind} stop guidance requires the selected Agenda bridge and both permitted tools (${selected}, ${deniedTool ?? "allowed"})`, async () => {
        const stop = kind === "blueprint" ? "blueprint_loop_stop" : "loop_stop"
        const components = kind === "blueprint" ? [note(), blueprint()] : [lightLoop()]
        await using runtime = await open(
          [
            agenda(),
            ...components,
            ...(selected ? [kind === "blueprint" ? agendaBlueprint() : agendaLightLoop()] : []),
          ],
          deniedTool ? { [deniedTool]: "deny" } : {},
        )
        await runtime.run(() =>
          ScopeContext.provide({
            scope: Scope.home(),
            async fn() {
              const created = await Session.create({ title: "Stop guidance" })
              const loop =
                kind === "blueprint"
                  ? await BlueprintLoopStore.create({
                      noteID: "note_guidance",
                      title: "Stop guidance",
                      sessionID: created.id,
                    })
                  : undefined
              if (loop) await BlueprintLoopStore.updateStatus(created.scope.id, loop.id, { status: "running" })
              await Session.update(created.id, (draft) => {
                if (loop) draft.blueprint = { loopID: loop.id, loopRole: "execution" }
                else draft.workflow = { kind: "lightloop", instructions: "Complete task" }
              })
              const agent = await Agent.get(PrimaryAgentIdentity.names.general)
              const result = await prepared(agent, await Session.get(created.id))
              expect((await ToolRegistry.find(stop))?.description).not.toMatch(/Agenda|agenda_cancel/)
              const instruction = `${kind === "blueprint" ? "BlueprintLoop" : "Light Loop"} review requires all active Agenda wakeups`
              expect(result.prompt.includes(instruction)).toBe(selected && !deniedTool)
              if (selected && !deniedTool) {
                expect(result.prompt).toContain("Review is rejected while any wakeup remains")
                expect(result.availableToolIDs).toContain(stop)
                expect(result.availableToolIDs).toContain("agenda_cancel")
              }
            },
          }),
        )
      }, 30_000)
    }
  }
}

test("selected hidden reviewers retain recursive delegation while primary catalogs exclude them", async () => {
  await using runtime = await open([note(), blueprint(), lightLoop()])
  await runtime.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      async fn() {
        const agents = await Agent.list()
        const supervisor = await Agent.get("supervisor")
        const reviewer = await Agent.get("lightloop-reviewer")
        for (const agent of [supervisor, reviewer]) {
          expect(agent.hidden).toBe(true)
          expect(agent.visibleTo).toEqual([agent.name])
          for (const permission of [
            "task",
            "task_list",
            "task_output",
            "task_cancel",
            "dagwrite",
            "dagread",
            "dagpatch",
          ])
            expect(action(agent, permission), `${agent.name}:${permission}`).toBe("allow")
        }
        expect(reviewer.delegationGroups).toEqual(["supervisor"])
        const info = agents.map((agent) => ({ ...agent, description: agent.description ?? "" }))
        for (const primary of [PrimaryAgentIdentity.names.coding, PrimaryAgentIdentity.names.general]) {
          const names = getDelegatableAgents(info, primary).map((agent) => agent.name)
          expect(names).not.toContain("supervisor")
          expect(names).not.toContain("lightloop-reviewer")
          expect(names.length).toBeGreaterThan(0)
        }
        const names = getDelegatableAgents(info, reviewer).map((agent) => agent.name)
        expect(names).toContain("implementation-engineer")
        expect(names).toContain("quality-gatekeeper")
        expect(names).not.toContain("supervisor")
        expect(names).not.toContain("lightloop-reviewer")
        const ordinary = await Agent.get("implementation-engineer")
        expect(AgentDelegation.canDelegateTo(ordinary, undefined)).toBe(false)
        for (const permission of ["task", "task_list", "task_output", "task_cancel", "dagwrite", "dagread", "dagpatch"])
          expect(action(ordinary, permission)).toBe("deny")
      },
    }),
  )
})

test("selected owners preserve the complete subagent permission profiles", async () => {
  await using runtime = await open([note(), library(), media(), codeTools(), browser(), plugins(), mcp()])
  await runtime.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      async fn() {
        const agents = await Agent.list()
        for (const agent of agents.filter(
          (agent) => agent.mode === "subagent" && AgentPermissionContributions.identity(agent)?.subagentProfile,
        )) {
          for (const permission of [
            "bash",
            "process",
            "skill",
            "webfetch",
            "look_at",
            "file_search",
            "list",
            "search_tools",
            "expand_tools",
            "browser_navigation",
            "browser_action",
            "browser_upload",
          ])
            expect(action(agent, permission), `${agent.name}:${permission}`).toBe("allow")
        }
        const readOnly = await Agent.get("code-cartographer")
        expect(action(readOnly, "note_read")).toBe("allow")
        for (const permission of ["note_write", "note_edit", "memory_get", "session_read", "mcp__any_server__any_tool"])
          expect(action(readOnly, permission)).toBe("deny")
        for (const name of ["docs-researcher", "research-scout", "literature-searcher", "literature-analyst"])
          expect(action(await Agent.get(name), "mcp__any_server__any_tool"), name).toBe("allow")
        for (const name of [
          "implementation-engineer",
          "refactoring-engineer",
          "integration-engineer",
          "documentation-engineer",
          "test-strategist",
          "fixture-builder",
          "property-test-engineer",
          "type-test-engineer",
        ]) {
          const agent = await Agent.get(name)
          for (const permission of ["read", "view_file", "scan_files", "file_search", "parse_code"])
            expect(action(agent, permission)).toBe("allow")
          for (const permission of ["edit", "write", "apply_patch", "revise_file", "resolve_conflicts", "save_file"])
            expect(action(agent, permission)).toBe("ask")
          for (const permission of ["grep", "glob", "ast_grep"]) expect(action(agent, permission)).toBe("deny")
        }
        for (const name of [
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
        ]) {
          const agent = await Agent.get(name)
          for (const permission of ["read", "view_file", "scan_files", "file_search", "parse_code"])
            expect(action(agent, permission)).toBe("allow")
          for (const permission of [
            "grep",
            "glob",
            "ast_grep",
            "apply_patch",
            "revise_file",
            "resolve_conflicts",
            "save_file",
            "edit",
            "write",
          ])
            expect(action(agent, permission)).toBe("deny")
        }
        const lightweight = await Agent.get(PrimaryAgentIdentity.names.lightweight)
        expect(action(lightweight, "memory_write")).toBe("allow")
        expect(action(lightweight, "memory_edit")).toBe("allow")
        expect(lightweight.permission.some((rule) => rule.permission === "ast_grep")).toBe(false)
        expect(await ToolRegistry.ids()).not.toContain("ast_grep")
        expect(action(lightweight, "parse_code")).toBe("deny")
      },
    }),
  )
})

for (const denied of [false, true]) {
  test(`Boss Note and channel grants come from selected owners and preserve denial (${denied})`, async () => {
    await using runtime = await open(
      [library(), agenda(), boss(), note(), channels(), channelFeishu(), bossFeishu()],
      denied ? { "note_*": "deny", channel_push: "deny" } : {},
    )
    await runtime.run(() =>
      ScopeContext.provide({
        scope: Scope.home(),
        async fn() {
          const agent = await Agent.get("boss-synergy")
          for (const permission of ["note_list", "note_read", "note_search", "note_write", "note_edit", "channel_push"])
            expect(action(agent, permission), permission).toBe(denied ? "deny" : "allow")
          for (const permission of [
            "note_archive",
            "note_delete",
            "task",
            "runtime_reload",
            "view_file",
            "webfetch",
            "todowrite",
          ])
            expect(action(agent, permission), permission).toBe("deny")
        },
      }),
    )
  })
}
