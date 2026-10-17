import { expect, test } from "bun:test"
import { z } from "zod"
import { PrimaryAgentIdentity } from "../../src/agent/primary-identity"
import { Agent } from "../../src/agent/agent"
import { Config } from "../../src/config/config"
import { PermissionNext } from "../../src/permission/next"
import { Scope } from "../../src/scope"
import { ScopeContext } from "../../src/scope/context"
import { ToolDiscovery } from "../../src/tool/discovery"
import { ToolRegistry } from "../../src/tool/registry"
import { Tool } from "../../src/tool/tool"
import { testRuntime } from "../support/runtime"
import { ToolResolver } from "../../src/session/tool-resolver"
import { Provider } from "../../src/provider/provider"
import { Session } from "../../src/session"
import { tmpdir } from "../support/fixture"
import path from "node:path"

const members = {
  read: ["replace", "patch"],
  edit: ["replace"],
  write: ["replace"],
  view_file: ["hashline"],
  scan_files: ["hashline"],
  revise_file: ["hashline"],
  save_file: ["hashline"],
  resolve_conflicts: ["hashline"],
  apply_patch: ["patch"],
} as const

for (const group of [undefined, "replace", "hashline", "patch"] as const) {
  test(`scoped file interface ${group ?? "default"} narrows before initialization and discovery`, async () => {
    const initialized: string[] = []
    await using runtime = await testRuntime({
      env: { SYNERGY_CONFIG_CONTENT: JSON.stringify(group ? { fileToolGroup: group } : {}) },
      register() {
        ToolRegistry.registerToolProvider("file-fixture", () =>
          Object.entries(members).map(([id, fileToolGroups]) =>
            Tool.define(
              id,
              async (context) => {
                initialized.push(id)
                return {
                  description: `File interface ${context?.fileToolGroup}`,
                  parameters: z.object({}),
                  async execute() {
                    return { title: id, output: id, metadata: {} }
                  },
                }
              },
              { fileToolGroups },
            ),
          ),
        )
      },
    })
    await runtime.run(() =>
      ScopeContext.provide({
        scope: Scope.home(),
        workspace: null,
        fn: async () => {
          const effective = group ?? "patch"
          expect((await Config.current()).fileToolGroup).toBe(effective)
          const expected = Object.entries(members)
            .filter(([, groups]) => (groups as readonly string[]).includes(effective))
            .map(([id]) => id)
            .sort()
          for (const name of [...Object.values(PrimaryAgentIdentity.names), "custom"]) {
            const agent = Agent.Info.parse({
              name,
              mode: "primary",
              options: {},
              permission: PermissionNext.fromConfig({ "*": "allow" }),
            })
            const catalog = await ToolRegistry.catalog("fixture", agent)
            expect(
              catalog
                .filter((x) => x.id in members)
                .map((x) => x.id)
                .sort(),
            ).toEqual(expected)
            expect(catalog.filter((x) => x.id in members).every((x) => x.description.endsWith(effective))).toBe(true)
            const discovery = await ToolDiscovery.collect({
              providerID: "fixture",
              agent,
              includeMCP: false,
              userTools: { "*": true },
            })
            expect(
              discovery.tools
                .filter((x) => x.id in members)
                .map((x) => x.id)
                .sort(),
            ).toEqual(expected)
          }
          expect([...new Set(initialized)].sort()).toEqual(expected)
        },
      }),
    )
  })
}

test("file semantic and concrete rules retain ordered precedence in visibility and evaluation", async () => {
  await using runtime = await testRuntime()
  await runtime.run(() => {
    for (const [semantic, ids] of Object.entries({
      read: ["read", "view_file", "scan_files", "file_search", "parse_code"],
      edit: ["edit", "write", "revise_file", "save_file", "resolve_conflicts", "apply_patch"],
    })) {
      for (const id of ids) {
        const denied = PermissionNext.fromConfig({ "*": "allow", [semantic]: "deny" })
        expect(PermissionNext.disabled([id], denied).has(id)).toBe(true)
        expect(PermissionNext.evaluate(id, "src/main.ts", denied).action).toBe("deny")
        const allowed = [...denied, { permission: id, pattern: "src/*", action: "allow" as const }]
        expect(PermissionNext.disabled([id], allowed).has(id)).toBe(false)
        expect(PermissionNext.evaluate(id, "src/main.ts", allowed).action).toBe("allow")
        expect(PermissionNext.evaluate(id, "private/key", allowed).action).toBe("deny")
        expect(
          PermissionNext.evaluate(id, "src/main.ts", allowed, [{ permission: semantic, pattern: "*", action: "deny" }])
            .action,
        ).toBe("deny")
      }
    }
  })
})

test("primary, writer, reviewer and internal roles preserve authority across file interfaces", async () => {
  await using runtime = await testRuntime()
  await runtime.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      workspace: null,
      fn: async () => {
        for (const name of [...Object.values(PrimaryAgentIdentity.names), "developer", "implementation-engineer"]) {
          const agent = await Agent.get(name)
          expect(agent).toBeDefined()
          expect([...PermissionNext.disabled(Object.keys(members), agent!.permission)]).toEqual([])
        }
        const reviewer = await Agent.get("explore")
        const disabled = PermissionNext.disabled(Object.keys(members), reviewer!.permission)
        expect(disabled.has("read")).toBe(false)
        expect(disabled.has("view_file")).toBe(false)
        expect(disabled.has("apply_patch")).toBe(true)
        const internal = await Agent.get("title")
        expect(PermissionNext.disabled(Object.keys(members), internal!.permission).size).toBe(
          Object.keys(members).length,
        )
      },
    }),
  )
})

test("scoped domain precedence, clear and reload preserve the universal fallback", async () => {
  await using runtime = await testRuntime()
  await runtime.run(async () => {
    await using project = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await project.scope(),
      fn: async () => {
        expect((await Config.current()).fileToolGroup).toBe("patch")
        await Config.domainUpdate("agents", { fileToolGroup: "replace" })
        expect((await Config.current()).fileToolGroup).toBe("replace")
        const root = path.join(project.path, ".synergy")
        await Config.domainUpdate("agents", { fileToolGroup: "hashline" }, { root })
        expect((await Config.current()).fileToolGroup).toBe("hashline")
        await Config.domainUpdate("agents", {}, { root, mode: "replace-domain" })
        await Config.reload("project")
        expect((await Config.current()).fileToolGroup).toBe("replace")
        await Config.domainUpdate("agents", {}, { mode: "replace-domain" })
        expect((await Config.current()).fileToolGroup).toBe("patch")
        expect(Config.Info.safeParse({ fileToolGroup: "automatic" }).success).toBe(false)
      },
    })
  })
})

test("old deferred expansion and full-access overrides cannot recover unselected writers", async () => {
  let loaded = 0
  await using runtime = await testRuntime({
    env: { SYNERGY_CONFIG_CONTENT: JSON.stringify({ provider: { openai: { options: { apiKey: "fixture-key" } } } }) },
    register() {
      ToolRegistry.registerToolProvider("file-lazy", () => [
        {
          ...Tool.lazy({ id: "edit", fileToolGroups: ["replace"] }, async () => {
            loaded++
            return Tool.define(
              "edit",
              {
                description: "Replace text",
                parameters: z.object({}),
                async execute() {
                  throw new Error("Unexpected execution")
                },
              },
              { fileToolGroups: ["replace"] },
            )
          }),
          catalogDescription: "Replace text",
          exposure: { mode: "group", group: "editing" },
        },
        Tool.define(
          "read",
          {
            description: "Read",
            parameters: z.object({}),
            async execute() {
              throw new Error("Unexpected execution")
            },
          },
          { fileToolGroups: ["patch"] },
        ),
        Tool.define(
          "apply_patch",
          {
            description: "Patch",
            parameters: z.object({ patch: z.string() }),
            async execute() {
              throw new Error("Unexpected execution")
            },
          },
          { fileToolGroups: ["patch"], exposure: { mode: "resident", companions: ["read"] } },
        ),
      ])
    },
  })
  await runtime.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      workspace: null,
      fn: async () => {
        const agent = Agent.Info.parse({
          name: "fixture",
          mode: "primary",
          options: {},
          permission: PermissionNext.fromConfig({ "*": "allow" }),
          controlProfile: "full_access",
        })
        const session = {
          ...(await Session.create({ workspaceID: null })),
          toolState: { expandedGroups: ["editing"], activatedTools: ["edit"] },
        }
        const input = {
          agent,
          model: await Provider.getModel("openai", "gpt-4o"),
          session,
          sessionID: session.id,
          includeMCP: false,
          userTools: { edit: true, apply_patch: true, read: false },
        }
        const available = await ToolResolver.availability(input)
        expect(available.visible.map((item) => item.id)).not.toContain("edit")
        expect(available.visible.map((item) => item.id)).not.toContain("apply_patch")
        expect(available.autoExpandable.has("edit")).toBe(false)
        const discovery = await ToolDiscovery.collect({ ...input, providerID: input.model.providerID })
        expect(discovery.tools.map((item) => item.id)).not.toContain("edit")
        expect(discovery.disabled.has("apply_patch")).toBe(true)
        expect(loaded).toBe(0)
      },
    }),
  )
})
