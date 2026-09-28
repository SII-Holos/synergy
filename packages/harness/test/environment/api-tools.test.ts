import { expect, test } from "bun:test"
import { z } from "zod"
import { testRuntime } from "../support/runtime"
import { Tool } from "../../src/tool/tool"
import { ToolRegistry } from "../../src/tool/registry"
import { ToolResolver } from "../../src/session/tool-resolver"
import { SessionProcessor } from "../../src/session/processor"
import { Session } from "../../src/session"
import { SessionManager } from "../../src/session/manager"
import { Scope } from "../../src/scope"
import { ScopeContext } from "../../src/scope/context"
import { WorkspaceCatalog } from "../../src/workspace/catalog"
import { Provider } from "../../src/provider/provider"
import { Agent } from "../../src/agent/agent"
import { PermissionNext } from "../../src/permission/next"

test("network tools pass real tool resolution without touching an unavailable native Workspace", async () => {
  let calls = 0
  await using runtime = await testRuntime({
    register() {
      ToolRegistry.registerToolProvider("fixture", () => [
        Tool.define(
          "webfetch",
          {
            description: "Business API fixture",
            parameters: z.object({ url: z.string() }),
            async execute() {
              calls++
              return { title: "API", output: "API result", metadata: {} }
            },
          },
          { requiresWorkspace: false },
        ),
      ])
    },
  })
  await runtime.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      workspace: null,
      fn: async () => {
        const workspace = await WorkspaceCatalog.register({
          scopeID: Scope.home().id,
          type: "directory",
          hostID: "unavailable",
          path: "/missing-workspace",
        })
        const session = await Session.create({ workspaceID: workspace.id, controlProfile: "full_access" })
        const model: Provider.Model = {
          id: "fixture",
          providerID: "fixture",
          api: { id: "fixture", url: "https://example.invalid", npm: "fixture" },
          name: "Fixture",
          capabilities: {
            temperature: false,
            reasoning: false,
            attachment: false,
            toolcall: true,
            interleaved: false,
            input: { text: true, audio: false, image: false, video: false, pdf: false },
            output: { text: true, audio: false, image: false, video: false, pdf: false },
          },
          cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
          limit: { context: 8192, output: 1024 },
          status: "active",
          options: {},
          headers: {},
          release_date: "2026-09-27",
          family: "fixture",
        }
        const agent = Agent.Info.parse({
          name: "fixture",
          mode: "primary",
          permission: PermissionNext.fromConfig({ "*": "allow" }),
          options: {},
        })
        await SessionManager.run(session.id, async () => {
          const assistantMessage = {
            id: "msg_fixture",
            sessionID: session.id,
            role: "assistant" as const,
            parentID: "msg_user",
            modelID: model.id,
            providerID: model.providerID,
            mode: "build",
            agent: agent.name,
            path: { cwd: null, root: null },
            cost: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            time: { created: Date.now() },
          }
          await Session.updateMessage(assistantMessage)
          const processor = SessionProcessor.create({
            assistantMessage,
            sessionID: session.id,
            model,
            abort: new AbortController().signal,
          })
          try {
            const resolved = await ToolResolver.resolveWithAvailability({
              agent,
              model,
              sessionID: session.id,
              session,
              processor,
              userTools: { webfetch: true },
              includeMCP: false,
            })
            const execute = resolved.executionTools.webfetch.execute!
            expect(
              await execute({ url: "https://example.invalid" }, { toolCallId: "call_api", messages: [] }),
            ).toMatchObject({ output: "API result" })
          } finally {
            processor.dispose("fixture")
          }
        })
        expect(calls).toBe(1)
      },
    }),
  )
})
