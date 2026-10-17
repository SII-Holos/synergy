import { expect, test } from "bun:test"
import { RuntimeComponents, type RuntimeComponent } from "@ericsanchezok/synergy-harness/lifecycle"
import { testRuntime } from "@ericsanchezok/synergy-harness/test/support/runtime"
import { ToolResolver, LLM } from "@ericsanchezok/synergy-harness/test/support/internals"
import { Scope } from "@ericsanchezok/synergy-harness/scope"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { Config } from "@ericsanchezok/synergy-harness/config"
import { Agent } from "@ericsanchezok/synergy-harness/agent/agent"
import { PrimaryAgentIdentity } from "@ericsanchezok/synergy-harness/agent/primary-identity"
import { ToolRegistry } from "@ericsanchezok/synergy-harness/tools"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { WorkflowKindRegistry } from "@ericsanchezok/synergy-harness/session/workflow-kind-registry"
import type { Provider } from "@ericsanchezok/synergy-harness/provider/provider"
import { localRuntime } from "@ericsanchezok/synergy-local-runtime/component"
import { Server } from "@ericsanchezok/synergy-server/server/server"
import { server } from "@ericsanchezok/synergy-server/component"
import { note } from "@ericsanchezok/synergy-note/component"
import { library } from "@ericsanchezok/synergy-library/component"
import { workbench } from "@ericsanchezok/synergy-workbench/component"
import { plugins } from "@ericsanchezok/synergy-plugin-host/component"
import { browser } from "@ericsanchezok/synergy-browser-runtime/component"
import { agenda } from "@ericsanchezok/synergy-agenda/component"
import { lightLoop } from "@ericsanchezok/synergy-light-loop/component"
import { blueprint } from "@ericsanchezok/synergy-blueprint/component"
import { email } from "@ericsanchezok/synergy-email/component"
import { channels } from "@ericsanchezok/synergy-channels/component"
import { fullComponents } from "../../src/components"

const imported = [...fullComponents(), browser()]
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
    input: { text: true, audio: false, image: false, video: false, pdf: false },
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

async function open(selected: RuntimeComponent[]) {
  const components = RuntimeComponents.resolve([
    localRuntime({ workers: false, environment: false }),
    ...selected,
    ...(selected.some((component) => component.id === "server") ? [] : [server()]),
  ])
  const composition = RuntimeComponents.compose(components)
  const adapters = await Promise.all(
    components.flatMap((component) => (component.adapters?.http ? [import(component.adapters.http.href)] : [])),
  )
  return testRuntime({
    env: {
      SYNERGY_CONFIG_CONTENT: JSON.stringify({
        anima: { enabled: false },
        library: { experience: { retrieve: false, encode: false } },
        boss: { enabled: false },
        pluginMarketplace: { enabled: false },
      }),
    },
    composition: {
      register() {
        composition.register()
        for (const adapter of adapters) adapter.registerHttp()
      },
    },
  })
}

async function inspect() {
  const capabilities = await (await Server.App().request("/global/capabilities")).json()
  const spec = await Server.openapi()
  return ScopeContext.provide({
    scope: Scope.home(),
    fn: async () => {
      const agents = await Agent.list()
      const agent = await Agent.get(PrimaryAgentIdentity.names.general)
      const session = await Session.create({ title: "Composition evidence", controlProfile: "full_access" })
      const availability = await ToolResolver.availability({ agent, model, sessionID: session.id, includeMCP: false })
      const availableToolIDs = [
        ...availability.visible.filter((item) => !availability.diagnostics.has(item.id)).map((item) => item.id),
        ...availability.autoExpandable,
      ]
      const prepared = await LLM.prepare({
        agent,
        model,
        sessionID: session.id,
        tools: {},
        availableToolIDs,
        user: {
          id: "msg_composition",
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
      return {
        capabilities,
        spec,
        agents: agents.map((agent) => agent.name),
        tools: await ToolRegistry.ids(),
        noteWrite: (await ToolRegistry.find("note_write"))?.description,
        availableToolIDs,
        prompt: prepared.system.join("\n"),
        workflow: WorkflowKindRegistry.ids(),
        config: Object.keys(Config.Info.shape),
      }
    },
  })
}

for (const [name, components] of [
  ["core", []],
  ["note", [note()]],
  ["library", [library()]],
  ["agenda", [agenda()]],
  ["light-loop", [lightLoop()]],
  ["email", [email()]],
  ["channels", [channels()]],
  ["blueprint", [note(), blueprint()]],
  ["workbench", [workbench()]],
  ["full", [plugins(), ...imported.filter((component) => component.id !== "browser-runtime")]],
] satisfies Array<[string, RuntimeComponent[]]>) {
  test(`${name} exposes only selected capabilities after all factories were imported`, async () => {
    await using runtime = await open(components)
    await runtime.run(async () => {
      const state = await inspect()
      const selected = new Set(components.map((component) => component.id))
      expect(state.capabilities.features).toEqual(state.capabilities.features.toSorted())
      for (const owner of [
        "note",
        "library",
        "agenda",
        "light-loop",
        "blueprint",
        "lattice",
        "boss",
        "anima",
        "email",
        "channels",
        "workbench",
        "mcp",
        "lsp",
      ]) {
        expect(state.capabilities.features.includes(owner), `feature ${owner}`).toBe(selected.has(owner))
      }
      for (const [owner, tool] of [
        ["note", "note_read"],
        ["library", "memory_get"],
        ["agenda", "agenda_list"],
        ["light-loop", "loop_stop"],
        ["blueprint", "blueprint_loop_stop"],
      ]) {
        expect(state.tools.includes(tool!), `tool ${tool}`).toBe(selected.has(owner!))
      }
      for (const [owner, agent] of [
        ["blueprint", "supervisor"],
        ["boss", "boss-synergy"],
      ]) {
        expect(state.agents.includes(agent!), `agent ${agent}`).toBe(selected.has(owner!))
      }
      expect(state.workflow.toSorted()).toEqual(
        [
          ...(selected.has("blueprint") ? ["plan"] : []),
          ...(selected.has("light-loop") ? ["lightloop"] : []),
          ...(selected.has("lattice") ? ["lattice"] : []),
          ...(selected.has("boss") ? ["boss"] : []),
        ].sort(),
      )
      for (const [owner, field] of [
        ["library", "library"],
        ["channels", "channel"],
        ["mcp", "mcp"],
        ["lsp", "lsp"],
        ["email", "email"],
        ["boss", "boss"],
        ["anima", "anima"],
      ]) {
        expect(state.config.includes(field!), `configuration ${field}`).toBe(selected.has(owner!))
      }
      for (const [owner, prefix] of [
        ["note", "note."],
        ["agenda", "agenda."],
        ["mcp", "mcp."],
        ["blueprint", "blueprint.loop."],
      ]) {
        const schemas = Object.keys(state.spec.components?.schemas ?? {})
        if (!selected.has(owner!)) expect(schemas.filter((name) => name.startsWith(`Event.${prefix}`))).toEqual([])
      }
      for (const [owner, prefix] of [
        ["note", "/note"],
        ["agenda", "/agenda"],
        ["library", "/library"],
        ["blueprint", "/blueprint"],
      ]) {
        if (!selected.has(owner!))
          expect(Object.keys(state.spec.paths ?? {}).filter((path) => path.startsWith(prefix!))).toEqual([])
      }
      if (!selected.has("library")) expect(state.prompt).not.toMatch(/memory_(?:search|get|write|edit)/)
      if (!selected.has("note")) {
        for (const name of ["NoteInfo", "NoteMetaInfo", "NoteCreateInput", "NotePatchInput"])
          expect(state.spec.components?.schemas?.[name]).toBeUndefined()
      }
      if (!selected.has("agenda")) expect(state.prompt).not.toMatch(/agenda_(?:schedule|watch|list)/)
      if (name === "note") {
        expect(state.noteWrite).not.toMatch(/blueprint/i)
      }
    })
  }, 30_000)
}

test("closing or failing an extended Runtime does not change the interleaved Core HTTP contract", async () => {
  await using core = await open([])
  const before = await core.run(inspect)
  const extended = await open([note(), blueprint()])
  try {
    expect((await extended.run(inspect)).capabilities.features).toEqual(["blueprint", "note"])
    expect((await core.run(inspect)).capabilities).toEqual(before.capabilities)
  } finally {
    await extended.close()
  }
  await expect(
    open([
      {
        id: "failing-owner",
        apiVersion: 1,
        version: "1.0.0",
        register() {
          note().register()
          throw new Error("Failed composition fixture")
        },
      },
    ]),
  ).rejects.toThrow("Failed composition fixture")
  const after = await core.run(inspect)
  expect(after.capabilities).toEqual(before.capabilities)
  expect(after.tools).toEqual(before.tools)
  expect(Object.keys(after.spec.components?.schemas ?? {})).toEqual(Object.keys(before.spec.components?.schemas ?? {}))
}, 30_000)
