import { afterAll, expect, test } from "bun:test"
import z from "zod"
import path from "node:path"
import fs from "node:fs/promises"
import { Global } from "@ericsanchezok/synergy-harness/global"
import { RolloutRecordingError } from "@ericsanchezok/synergy-harness/session/rollout/error"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { Identifier } from "@ericsanchezok/synergy-harness/id/id"
import { Tool } from "@ericsanchezok/synergy-harness/tool/tool"
import { ToolRegistry } from "@ericsanchezok/synergy-harness/tool/registry"
import { MessageV2 } from "@ericsanchezok/synergy-harness/session/message-v2"
import { RolloutSnapshot } from "@ericsanchezok/synergy-harness/session/rollout/snapshot"
import { SessionProcessor, ToolScheduler } from "@ericsanchezok/synergy-harness/test/support/internals"
import { Provider } from "@ericsanchezok/synergy-harness/provider/provider"
import { ToolInvocation } from "@ericsanchezok/synergy-harness/tools"
import { invokePluginTool } from "../../src/plugin/host-services"

async function withSession(
  run: (input: { session: Session.Info; assistantID: string; directory: string }) => Promise<void>,
  controlProfile: "full_access" | "autonomous" = "full_access",
) {
  await using directory = await tmpdir({
    config: {
      provider: {
        test: {
          name: "Test",
          npm: "@ai-sdk/openai-compatible",
          models: { model: { name: "Model", limit: { context: 10000, output: 1000 } } },
        },
      },
    },
  })
  await ScopeContext.provide({
    scope: await directory.scope(),
    async fn() {
      const session = await Session.create({
        controlProfile,
        ...(controlProfile === "autonomous"
          ? { permission: [{ permission: "edit", pattern: "*", action: "deny" as const }] }
          : {}),
      })
      const root = await Session.updateMessage({
        id: Identifier.ascending("message"),
        sessionID: session.id,
        role: "user",
        agent: "synergy",
        model: { providerID: "test", modelID: "model" },
        time: { created: Date.now() },
      })
      const assistant = await Session.updateMessage({
        id: Identifier.ascending("message"),
        sessionID: session.id,
        role: "assistant",
        parentID: root.id,
        rootID: root.id,
        agent: "synergy",
        mode: "synergy",
        providerID: "test",
        modelID: "model",
        path: { cwd: directory.path, root: directory.path },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        time: { created: Date.now() },
      })
      await run({ session, assistantID: assistant.id, directory: directory.path })
    },
  })
}

test("plugin host executes a registered file tool and persists its result and rollout evidence", async () => {
  await withSession(async ({ session, assistantID, directory }) => {
    const file = path.join(directory, "evidence.txt")
    await ToolRegistry.register(
      Tool.define("read", {
        description: "Write test evidence",
        parameters: z.object({ text: z.string() }),
        async execute(args, ctx) {
          await ctx.ask({ permission: "edit", patterns: [file], metadata: {} })
          await Bun.write(file, args.text)
          return { title: "Evidence saved", output: await Bun.file(file).text(), metadata: { file } }
        },
      }),
    )
    const result = await invokePluginTool({
      context: { sessionID: session.id, messageID: assistantID, agent: "synergy" },
      request: { tool: "read", args: { text: "reproducible result" } },
    })
    expect(result.output).toBe("reproducible result")
    expect(await Bun.file(file).text()).toBe("reproducible result")
    const message = await MessageV2.get({ scopeID: session.scope.id, sessionID: session.id, messageID: assistantID })
    expect(message.parts.filter((part) => part.type === "tool").map((part) => part.state.status)).toEqual(["completed"])
    const evidence = await RolloutSnapshot.read({ kind: "session", scopeID: session.scope.id, sessionID: session.id })
    expect(evidence.tools).toHaveLength(1)
    expect(evidence.tools[0]).toMatchObject({ tool: "read", status: "completed" })
    expect(evidence.tools[0]?.authorization).toBeDefined()
    expect(evidence.tools[0]?.observation).toBeDefined()
  })
})

test("plugin host rejects denied tools without side effects and records the failure", async () => {
  await withSession(async ({ session, assistantID, directory }) => {
    const file = path.join(directory, "denied.txt")
    await ToolRegistry.register(
      Tool.define("read", {
        description: "Permission probe",
        parameters: z.object({}),
        async execute(_args, ctx) {
          await ctx.ask({ permission: "edit", patterns: [file], metadata: { capability: "file_external_write" } })
          await Bun.write(file, "must not execute")
          return { title: "Denied probe", output: "unexpected", metadata: {} }
        },
      }),
    )
    await expect(
      invokePluginTool({
        context: { sessionID: session.id, messageID: assistantID, agent: "synergy" },
        request: { tool: "read", args: {} },
      }),
    ).rejects.toThrow()
    expect(await Bun.file(file).exists()).toBe(false)
    const message = await MessageV2.get({ scopeID: session.scope.id, sessionID: session.id, messageID: assistantID })
    expect(message.parts.filter((part) => part.type === "tool").map((part) => part.state.status)).toEqual(["error"])
  }, "autonomous")
})

test("plugin host cancellation reaches an active tool and persists interrupted evidence", async () => {
  await withSession(async ({ session, assistantID }) => {
    const started = Promise.withResolvers<void>()
    const controller = new AbortController()
    await ToolRegistry.register(
      Tool.define("read", {
        description: "Cancellation probe",
        parameters: z.object({}),
        async execute(_args, ctx) {
          started.resolve()
          await new Promise<void>((_resolve, reject) => {
            ctx.abort.addEventListener("abort", () => reject(ctx.abort.reason), { once: true })
            if (ctx.abort.aborted) reject(ctx.abort.reason)
          })
          return { title: "Cancelled probe", output: "unexpected", metadata: {} }
        },
      }),
    )
    const pending = invokePluginTool({
      context: { sessionID: session.id, messageID: assistantID, agent: "synergy", abort: controller.signal },
      request: { tool: "read", args: {} },
    })
    const observed = pending.then(
      () => ({ ok: true }),
      (error) => ({ ok: false, error }),
    )
    try {
      expect(await Promise.race([started.promise.then(() => true), observed.then(() => false)])).toBe(true)
    } finally {
      controller.abort(new DOMException("Cancelled by caller", "AbortError"))
    }
    expect((await observed).ok).toBe(false)
    const evidence = await RolloutSnapshot.read({ kind: "session", scopeID: session.scope.id, sessionID: session.id })
    expect(evidence.tools[0]?.status).toBe("interrupted")
    const message = await MessageV2.get({ scopeID: session.scope.id, sessionID: session.id, messageID: assistantID })
    expect(message.parts.filter((part) => part.type === "tool").map((part) => part.state.status)).toEqual(["error"])
  })
})

test("plugin host preserves recording failures when durable output cannot be written", async () => {
  await withSession(async ({ session, assistantID }) => {
    const artifacts = path.join(Global.Path.data, "sessions", session.scope.id, session.id, "rollout", "artifacts")
    const backup = artifacts + "-preserved"
    let blocked = false
    await ToolRegistry.register(
      Tool.define("read", {
        description: "Recording probe",
        parameters: z.object({}),
        async execute() {
          await fs.rename(artifacts, backup)
          await Bun.write(artifacts, "a file blocks artifact directory creation")
          blocked = true
          return { title: "Output", output: "must be recorded", metadata: {} }
        },
      }),
    )
    try {
      const error = await invokePluginTool({
        context: { sessionID: session.id, messageID: assistantID, agent: "synergy" },
        request: { tool: "read", args: {} },
      }).catch((error) => error)
      expect(RolloutRecordingError.isInstance(error)).toBe(true)
      expect(blocked).toBe(true)
    } finally {
      if (blocked) {
        await fs.rm(artifacts)
        await fs.rename(backup, artifacts)
      }
    }
    const evidence = await RolloutSnapshot.read({ kind: "session", scopeID: session.scope.id, sessionID: session.id })
    expect(evidence.runs[0]?.recording).toBe("failed")
  })
})

afterAll(async () => {
  await ToolScheduler.stop()
  ToolScheduler.configure()
})

test("nested plugin invocation retains real tool recording under a single global slot", async () => {
  await ToolScheduler.stop()
  ToolScheduler.configure({ maxConcurrent: 1, executorConcurrency: { plugin: 1, file: 1 } })
  await withSession(async ({ session, assistantID, directory }) => {
    const file = path.join(directory, "nested.txt")
    await ToolRegistry.register(
      Tool.define("read", {
        description: "Nested file evidence",
        parameters: z.object({ text: z.string() }),
        async execute(args, ctx) {
          await ctx.ask({ permission: "edit", patterns: [file], metadata: {} })
          await Bun.write(file, args.text)
          return { title: "Saved", output: await Bun.file(file).text(), metadata: { file } }
        },
      }),
    )
    const message = await MessageV2.get({ scopeID: session.scope.id, sessionID: session.id, messageID: assistantID })
    if (message.info.role !== "assistant") throw new Error("Expected assistant fixture")
    const processor = SessionProcessor.create({
      assistantMessage: message.info,
      sessionID: session.id,
      model: await Provider.getModel("test", "model"),
      abort: new AbortController().signal,
    })
    try {
      const result = await processor.executeToolCall({
        callID: "plugin-parent",
        toolName: "plugin-probe",
        args: {},
        executor: "plugin",
        tool: {
          inputSchema: z.object({}),
          async execute() {
            const result = await invokePluginTool({
              context: { sessionID: session.id, messageID: assistantID, agent: "synergy", callID: "plugin-parent" },
              request: { tool: "read", args: { text: "nested evidence" } },
            })
            processor
              .beginExecution("plugin-parent")
              .complete(
                {},
                { title: result.title ?? "Nested result", output: result.output, metadata: result.metadata ?? {} },
              )
            return result
          },
        },
      })
      expect(result.output).toBe("nested evidence")
      expect(await Bun.file(file).text()).toBe("nested evidence")
      const persisted = await MessageV2.get({
        scopeID: session.scope.id,
        sessionID: session.id,
        messageID: assistantID,
      })
      expect(persisted.parts.filter((part) => part.type === "tool").map((part) => part.state.status)).toEqual([
        "completed",
        "completed",
      ])
      const evidence = await RolloutSnapshot.read({ kind: "session", scopeID: session.scope.id, sessionID: session.id })
      expect(evidence.tools.find((tool) => tool.tool === "read")).toMatchObject({ status: "completed" })
    } finally {
      processor.dispose()
      await ToolScheduler.stop()
      ToolScheduler.configure()
    }
  })
})

test("public invocation respects closed admission and rejects unowned plugin parents", async () => {
  await withSession(async ({ session, assistantID }) => {
    let executed = false
    await ToolRegistry.register(
      Tool.define("read", {
        description: "Admission probe",
        parameters: z.object({}),
        async execute() {
          executed = true
          return { title: "Probe", output: "unexpected", metadata: {} }
        },
      }),
    )
    const input = {
      sessionID: session.id,
      messageID: assistantID,
      agent: "synergy",
      tool: "read",
      args: {},
      signal: new AbortController().signal,
    }
    await expect(ToolInvocation.invoke({ ...input, parentCallID: "forged-parent" })).rejects.toThrow(
      "active plugin parent",
    )
    ToolScheduler.closeAdmission()
    try {
      await expect(ToolInvocation.invoke(input)).rejects.toThrow("Tool scheduler is stopping")
    } finally {
      await ToolScheduler.stop()
      ToolScheduler.configure()
    }
    expect(executed).toBe(false)
  })
})
