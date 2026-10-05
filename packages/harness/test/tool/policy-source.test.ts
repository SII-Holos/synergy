import { expect, test } from "bun:test"
import { ToolPolicySource } from "../../src/tool/policy-source"
import { Scope } from "../../src/scope"
import { ScopeContext } from "../../src/scope/context"
import { PermissionNext } from "../../src/permission/next"
import { z } from "zod"
import { Tool } from "../../src/tool/tool"
import { ToolRegistry } from "../../src/tool/registry"
import { ToolDiscovery } from "../../src/tool/discovery"
import { Session } from "../../src/session"
import { SessionManager } from "../../src/session/manager"
import { SessionProcessor } from "../../src/session/processor"
import { ToolResolver } from "../../src/session/tool-resolver"
import type { Agent } from "../../src/agent/agent"
import type { Provider } from "../../src/provider/provider"
import { testRuntime } from "../support/runtime"

const agent: Agent.Info = {
  name: "fixture",
  mode: "primary",
  native: true,
  options: {},
  permission: PermissionNext.fromConfig({ "*": "allow" }),
}
const model: Provider.Model = {
  id: "fixture",
  providerID: "fixture",
  name: "Fixture",
  family: "fixture",
  api: { id: "fixture", url: "https://example.invalid", npm: "fixture" },
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
  release_date: "",
}

test("host tool policy is isolated, sealed, and cannot widen the candidate catalog", async () => {
  await using guarded = await testRuntime({
    register() {
      ToolPolicySource.register({
        async select(input) {
          return input.toolIDs.filter((id) => id !== "write")
        },
      })
    },
  })
  await using independent = await testRuntime()
  const input = { sessionID: "session", agent, model, toolIDs: ["read", "write"] }
  expect(await guarded.run(() => ToolPolicySource.select(input))).toEqual(["read"])
  expect(await independent.run(() => ToolPolicySource.select(input))).toEqual(["read", "write"])
  expect(() => guarded.run(() => ToolPolicySource.register({}))).toThrow("before opening")
  await using invalid = await testRuntime({
    register() {
      ToolPolicySource.register({
        async select() {
          return ["unregistered"]
        },
      })
    },
  })
  await expect(invalid.run(() => ToolPolicySource.select(input))).rejects.toThrow("host tool policy")
})

test("manual discovery and expansion candidates obey host selection", async () => {
  await using runtime = await testRuntime({
    register() {
      ToolRegistry.registerToolProvider("discovery-policy-fixture", () => [
        Tool.define(
          "denied_probe",
          {
            description: "Deferred capability denied by the host",
            parameters: z.object({}),
            async execute() {
              throw new Error("must not execute")
            },
          },
          { exposure: { mode: "search" } },
        ),
      ])
      ToolPolicySource.register({
        async select(input) {
          return input.toolIDs.filter((id) => id !== "denied_probe")
        },
      })
    },
  })
  await runtime.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      fn: async () => {
        const session = await Session.create({ workspace: null })
        const catalog = await ToolDiscovery.collect({
          providerID: model.providerID,
          model,
          agent,
          session,
          includeMCP: false,
        })
        expect(catalog.disabled.has("denied_probe")).toBe(true)
        expect(ToolDiscovery.nonResidentEntries(catalog).some((entry) => entry.id === "denied_probe")).toBe(false)
        expect(ToolDiscovery.visibleTools(catalog, [], ["denied_probe"])).not.toContain("denied_probe")
        await expect(
          ToolDiscovery.collect({ providerID: model.providerID, agent, session, includeMCP: false }),
        ).rejects.toThrow("host tool policy")
      },
    }),
  )
})

test("host selection removes deferred expansion candidates as well as visible tools", async () => {
  await using runtime = await testRuntime({
    register() {
      ToolRegistry.registerToolProvider("deferred-fixture", () => [
        Tool.define(
          "deferred_probe",
          {
            description: "Deferred probe",
            parameters: z.object({}),
            async execute() {
              throw new Error("must not execute")
            },
          },
          { exposure: { mode: "search" } },
        ),
      ])
      ToolPolicySource.register({
        async select(input) {
          expect(input.toolIDs).toContain("probe")
          expect(input.toolIDs).toContain("deferred_probe")
          return []
        },
      })
    },
  })
  await runtime.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      fn: async () => {
        const result = await ToolResolver.availability({
          sessionID: "session",
          agent,
          model,
          includeMCP: false,
          userTools: { probe: true },
          ephemeralTools: [
            {
              id: "probe",
              description: "probe",
              inputSchema: { type: "object" },
              async execute() {
                throw new Error("must not execute")
              },
            },
          ],
        })
        expect(result.visible).toHaveLength(0)
        expect(result.autoExpandable.size).toBe(0)
        expect(result.diagnostics.get("probe")?.code).toBe("permission_denied")
      },
    }),
  )
})

test("a resolved execution tool is denied before resource acquisition or dispatch", async () => {
  let calls = 0
  const authorized: ToolPolicySource.ExecutionInput[] = []
  await using runtime = await testRuntime({
    register() {
      ToolRegistry.registerToolProvider("execution-fixture", () => [
        Tool.define(
          "compute_probe",
          {
            description: "Requires compute",
            parameters: z.object({ value: z.string() }),
            async execute() {
              calls++
              return { title: "probe", output: "effect", metadata: {} }
            },
          },
          { requiresExecution: "exec", exposure: { mode: "resident" } },
        ),
      ])
      ToolPolicySource.register({
        async authorize(input) {
          authorized.push(input)
          throw new Error("lease no longer owns this root")
        },
      })
    },
  })
  await runtime.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      workspace: null,
      fn: async () => {
        const session = await Session.create({ workspace: null })
        await SessionManager.run(session.id, async () => {
          const assistant = {
            id: "msg_probe",
            sessionID: session.id,
            role: "assistant" as const,
            parentID: "msg_root",
            modelID: model.id,
            providerID: model.providerID,
            mode: "fixture",
            agent: agent.name,
            path: { cwd: null, root: null },
            cost: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            time: { created: Date.now() },
          }
          await Session.updateMessage(assistant)
          const processor = SessionProcessor.create({
            assistantMessage: assistant,
            sessionID: session.id,
            model,
            abort: new AbortController().signal,
          })
          try {
            const resolved = await ToolResolver.resolveWithAvailability({
              agent,
              model,
              session,
              sessionID: session.id,
              processor,
              includeMCP: false,
            })
            await expect(
              resolved.executionTools.compute_probe.execute!(
                { value: "input" },
                { toolCallId: "call_probe", messages: [] },
              ),
            ).rejects.toBeInstanceOf(ToolPolicySource.DeniedError)
            expect(calls).toBe(0)
            expect(authorized).toHaveLength(1)
            expect(authorized[0]).toMatchObject({
              messageID: assistant.id,
              callID: "call_probe",
              args: { value: "input" },
            })
          } finally {
            processor.dispose("fixture")
          }
        })
      },
    }),
  )
})

test("tool authorization preserves exact origin, detached input and abort semantics", async () => {
  const seen: ToolPolicySource.ExecutionInput[] = []
  await using runtime = await testRuntime({
    register() {
      ToolPolicySource.register({
        async authorize(input) {
          seen.push(input)
          ;(input.args as { nested: { value: string } }).nested.value = "detached"
          throw new Error("private upstream response")
        },
      })
    },
  })
  const args = { nested: { value: "original" } }
  const input = { toolID: "probe", sessionID: "session", messageID: "assistant", callID: "call", args }
  await expect(runtime.run(() => ToolPolicySource.authorize(input))).rejects.toThrow("host tool policy")
  expect(args.nested.value).toBe("original")
  expect(seen[0]).toMatchObject({ toolID: "probe", sessionID: "session", messageID: "assistant", callID: "call" })
  const abort = new AbortController()
  abort.abort(new Error("cancelled before authorization"))
  await expect(runtime.run(() => ToolPolicySource.authorize({ ...input, signal: abort.signal }))).rejects.toThrow(
    "cancelled before authorization",
  )
  expect(seen).toHaveLength(1)
})

test("host consent receives detached origin and preserves default, denial and cancellation", async () => {
  const seen: ToolPolicySource.PermissionInput[] = []
  let handled = true
  let failure: Error | undefined
  await using runtime = await testRuntime({
    register() {
      ToolPolicySource.register({
        async requestPermission(input) {
          seen.push(input)
          input.request.metadata.targets = ["changed inside host"]
          if (failure) throw failure
          return handled
        },
      })
    },
  })
  await using independent = await testRuntime()
  const abort = new AbortController()
  const input: ToolPolicySource.PermissionInput = {
    toolID: "domain_probe",
    request: { permission: "domain_mutation", patterns: ["personal:exact"], metadata: { targets: ["original"] } },
    context: { sessionID: "session", messageID: "assistant", callID: "call", agent: agent.name, abort: abort.signal },
  }
  expect(await independent.run(() => ToolPolicySource.requestPermission(input))).toBe(false)
  expect(await runtime.run(() => ToolPolicySource.requestPermission(input))).toBe(true)
  expect(input.request.metadata.targets).toEqual(["original"])
  expect(seen[0]).toMatchObject({
    toolID: input.toolID,
    context: { sessionID: "session", messageID: "assistant", callID: "call" },
  })
  handled = false
  expect(await runtime.run(() => ToolPolicySource.requestPermission(input))).toBe(false)
  failure = new PermissionNext.RejectedError()
  await expect(runtime.run(() => ToolPolicySource.requestPermission(input))).rejects.toBe(failure)
  abort.abort(new Error("cancelled before consent"))
  await expect(runtime.run(() => ToolPolicySource.requestPermission(input))).rejects.toThrow("cancelled before consent")
  expect(seen).toHaveLength(3)
})

test("host consent cancellation after its callback cannot admit execution", async () => {
  const abort = new AbortController()
  await using runtime = await testRuntime({
    register() {
      ToolPolicySource.register({
        async requestPermission() {
          abort.abort(new Error("cancelled during consent"))
          return true
        },
      })
    },
  })
  await expect(
    runtime.run(() =>
      ToolPolicySource.requestPermission({
        toolID: "domain_probe",
        request: { permission: "domain_mutation", patterns: ["exact"], metadata: {} },
        context: {
          sessionID: "session",
          messageID: "assistant",
          callID: "call",
          agent: agent.name,
          abort: abort.signal,
        },
      }),
    ),
  ).rejects.toThrow("cancelled during consent")
})
