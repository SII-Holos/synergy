import { expect, spyOn, test } from "bun:test"
import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import { controlledTempRoot } from "@ericsanchezok/synergy-harness/sandbox/policy"
import { PrimaryAgentIdentity } from "@ericsanchezok/synergy-harness/agent/primary-identity"
import { Environment } from "@ericsanchezok/synergy-harness/environment"
import type { EnvironmentOrigin } from "@ericsanchezok/synergy-harness/environment/origin"
import { EnvironmentResources } from "@ericsanchezok/synergy-harness/environment/resources"
import { EnvironmentExecution } from "@ericsanchezok/synergy-harness/environment/execution"
import { EnvironmentProcess } from "@ericsanchezok/synergy-harness/environment/process"
import { EnvironmentProviders } from "@ericsanchezok/synergy-harness/environment/provider"
import { ExecutionProtocol } from "@ericsanchezok/synergy-harness/environment/executor"
import { Identifier } from "@ericsanchezok/synergy-harness/id/id"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { RolloutLedger } from "@ericsanchezok/synergy-harness/session/rollout/ledger"
import { RolloutLifecycle } from "@ericsanchezok/synergy-harness/session/rollout/lifecycle"
import { RolloutTool } from "@ericsanchezok/synergy-harness/session/rollout/tool"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import { testRuntime } from "../support/runtime"
import { SandboxBackend } from "../../src/sandbox/backend"

async function withNativeTool(body: (session: Session.Info, origin: EnvironmentOrigin.Session) => Promise<void>) {
  const session = await Session.create({ workspace: null, controlProfile: "autonomous" })
  const rootID = Identifier.ascending("message")
  await Session.updateMessage({
    id: rootID,
    sessionID: session.id,
    role: "user",
    rootID,
    isRoot: true,
    agent: PrimaryAgentIdentity.names.general,
    model: { providerID: "fixture", modelID: "fixture" },
    time: { created: Date.now() },
  })
  const messageID = Identifier.ascending("message")
  await Session.updateMessage({
    id: messageID,
    sessionID: session.id,
    role: "assistant",
    rootID,
    parentID: rootID,
    agent: PrimaryAgentIdentity.names.general,
    mode: "default",
    modelID: "fixture",
    providerID: "fixture",
    path: { cwd: null, root: null },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: Date.now() },
  })
  const owner = RolloutLifecycle.owner(session)
  await RolloutLedger.beginRun(owner, rootID)
  let status: "completed" | "failed" = "failed"
  try {
    await RolloutTool.execute(
      { owner, runID: rootID, messageID, toolCallID: "prepare", tool: "bash", args: {} },
      async () => {
        await body(session, {
          kind: "session",
          scopeID: session.scope.id,
          sessionID: session.id,
          rootID,
          runID: rootID,
          messageID,
          callID: "prepare",
          tool: "bash",
        })
        return { output: "Native preparation observed" }
      },
    )
    status = "completed"
  } finally {
    await RolloutLedger.finishRun(owner, rootID, status)
  }
}

test.skipIf(process.platform !== "darwin")(
  "native background preparation remains with its original process until saving completes",
  async () => {
    await using runtime = await testRuntime()
    await runtime.run(async () => {
      await using temporary = await tmpdir()
      await ScopeContext.provide({
        scope: await temporary.scope(),
        workspace: null,
        fn: () =>
          withNativeTool(async (session, origin) => {
            const resources = await EnvironmentResources.select({
              scopeID: session.scope.id,
              ownerID: session.id,
              environmentID: session.environmentID,
              origin,
              needs: { execution: "exec" },
            })
            if (!resources.runtime || !resources.directory || !resources.environment)
              throw new Error("Native background preparation requires its actual admitted Executor")
            const prepared = await EnvironmentResources.prepareSandbox(resources, {
              command: "/bin/sh",
              args: ["-c", 'printf NATIVE_READY; IFS= read -r input; [ "$input" = finish ]; printf NATIVE_FINISHED'],
              workspace: resources.directory,
              sandboxMode: "workspace_write",
              networkMode: "restricted",
            })
            const sandbox = ExecutionProtocol.Sandbox.parse(prepared)
            const policy = sandbox.args[sandbox.args.indexOf("-f") + 1]
            if (!policy || sandbox.args.indexOf("-f") < 0)
              throw new Error("The original native sandbox produced no physical policy")
            const execution = await EnvironmentProcess.prepare({
              id: EnvironmentExecution.operationID(origin),
              scopeID: session.scope.id,
              resources,
              command: {
                command: sandbox.command,
                args: sandbox.args,
                cwd: resources.directory,
                env: {},
                useRoots: [],
                sandboxID: sandbox.id,
              },
            })
            let output = ""
            const ready = Promise.withResolvers<void>()
            const timer = setTimeout(
              () => ready.reject(new Error("The original native child did not become ready")),
              5000,
            )
            execution.child.stdout.on("data", (bytes: Buffer) => {
              output += bytes.toString()
              if (output.includes("NATIVE_READY")) ready.resolve()
            })
            execution.child.stderr.resume()
            try {
              await execution.activate()
              await ready.promise
              const running = await EnvironmentExecution.get(execution.executionID, session.scope.id)
              expect(running.state).toBe("running")
              await resources.release()
              expect(await Bun.file(policy).exists()).toBe(true)
              expect(
                (await Environment.uses(resources.environment.id)).some((use) => use.ownership.kind === "execution"),
              ).toBe(true)
              const copied = { ...resources }
              await expect(EnvironmentResources.retainExecution(copied, running)).rejects.toThrow("original")
              await expect(
                EnvironmentResources.prepareSandbox(copied, {
                  command: "/bin/sh",
                  args: ["-c", "false"],
                  workspace: resources.directory,
                  sandboxMode: "workspace_write",
                }),
              ).rejects.toThrow("original")
              await expect(
                EnvironmentResources.prepareSandbox(resources, {
                  command: "/bin/sh",
                  args: ["-c", "false"],
                  workspace: resources.directory,
                  sandboxMode: "workspace_write",
                }),
              ).rejects.toThrow("closing")
              execution.child.stdin.end("finish\n")
              await execution.completion
              expect(output).toBe("NATIVE_READYNATIVE_FINISHED")
              expect((await EnvironmentExecution.get(execution.executionID, session.scope.id)).state).toBe("completed")
              expect(await Bun.file(policy).exists()).toBe(false)
              expect((await resources.executor!.inspectPreparation!(execution.executionID)).state).toBe("released")
              expect(await Environment.uses(resources.environment.id)).toEqual([])
              if ("cleanup" in prepared) await prepared.cleanup?.()
            } finally {
              clearTimeout(timer)
              execution.child.stdout.resume()
              await execution.stop()
              await resources.release()
            }
          }),
      })
    })
  },
  10000,
)

test.skipIf(process.platform !== "darwin")(
  "native sandbox preparation retains its original operation Use before any command exists",
  async () => {
    await using runtime = await testRuntime()
    await runtime.run(async () => {
      await using temporary = await tmpdir()
      await ScopeContext.provide({
        scope: await temporary.scope(),
        workspace: null,
        fn: () =>
          withNativeTool(async (session, origin) => {
            await using resources = await EnvironmentResources.select({
              scopeID: session.scope.id,
              ownerID: session.id,
              environmentID: session.environmentID,
              origin,
              needs: { execution: "exec" },
            })
            if (!resources.runtime || !resources.directory || !resources.environment)
              throw new Error("Native preparation requires the actual admitted Executor")
            const operationID = createHash("sha256")
              .update(JSON.stringify([origin.scopeID, origin.sessionID, origin.messageID, origin.callID]))
              .digest("hex")
            const input = {
              command: "/bin/sh",
              args: ["-c", "true"],
              workspace: resources.directory,
              sandboxMode: "workspace_write",
              networkMode: "restricted",
            } satisfies Parameters<typeof EnvironmentResources.prepareSandbox>[1]
            const compile = spyOn(SandboxBackend, "prepareWrapper")
            const wrapper = await EnvironmentResources.prepareSandbox(resources, input)
            const sandbox = ExecutionProtocol.Sandbox.parse(wrapper)
            try {
              expect(wrapper.sandboxed).toBe(true)
              const profile = wrapper.args[wrapper.args.indexOf("-f") + 1]
              if (!profile || wrapper.args.indexOf("-f") < 0) throw new Error("Native sandbox returned no real policy")
              expect(await Bun.file(profile).exists()).toBe(true)
              expect(await Storage.list(["environment_execution", session.scope.id])).toEqual([])
              const uses = await Environment.uses(resources.environment.id)
              expect(uses).toContainEqual(
                expect.objectContaining({
                  kind: "operation",
                  ownership: { kind: "execution-preparation", scopeID: session.scope.id, operationID, origin },
                }),
              )
              const duplicate = await EnvironmentResources.prepareSandbox(resources, input)
              expect(ExecutionProtocol.Sandbox.parse(duplicate).id).toBe(sandbox.id)
              expect(compile).toHaveBeenCalledTimes(1)
              if ("cleanup" in wrapper) await wrapper.cleanup?.()
              const final = await EnvironmentResources.prepareSandbox(resources, {
                ...input,
                stripDefaultHomeDenyRoot: true,
                extraReadRoots: [resources.directory],
              })
              expect(ExecutionProtocol.Sandbox.parse(final).id).not.toBe(sandbox.id)
              expect(final.sandboxed).toBe(true)
              expect(compile).toHaveBeenCalledTimes(2)
              await resources.release()
              await expect(
                EnvironmentResources.prepareSandbox(resources, { ...input, networkMode: "full" }),
              ).rejects.toThrow("closing")
              expect(compile).toHaveBeenCalledTimes(2)
            } finally {
              try {
                await resources.release()
              } finally {
                compile.mockRestore()
              }
            }
            expect(await Environment.uses(resources.environment.id)).toEqual([])
          }),
      })
    })
  },
  10_000,
)

test.skipIf(process.platform !== "darwin")(
  "retained native preparation inspects and releases the same policy after its Executor closes",
  async () => {
    await using runtime = await testRuntime()
    await runtime.run(async () => {
      await using temporary = await tmpdir()
      await ScopeContext.provide({
        scope: await temporary.scope(),
        workspace: null,
        fn: () =>
          withNativeTool(async (session, origin) => {
            const resources = await EnvironmentResources.select({
              scopeID: session.scope.id,
              ownerID: session.id,
              environmentID: session.environmentID,
              origin,
              needs: { execution: "exec" },
            })
            if (!resources.runtime || !resources.directory || !resources.environment)
              throw new Error("Missing native allocation")
            const id = EnvironmentExecution.operationID(origin)
            const wrapper = ExecutionProtocol.Sandbox.parse(
              await EnvironmentResources.prepareSandbox(resources, {
                command: "/bin/sh",
                args: ["-c", "true"],
                workspace: resources.directory,
                sandboxMode: "workspace_write",
              }),
            )
            const actualUse = (await Environment.uses(resources.environment.id)).find(
              (use) => use.ownership.kind === "execution-preparation" && use.ownership.operationID === id,
            )
            if (!actualUse) throw new Error("Native preparation lost its actual operation Use")
            const originalPolicy = wrapper.args[wrapper.args.indexOf("-f") + 1]
            await EnvironmentProviders.get(resources.environment.provider).close?.()
            const retained = await EnvironmentExecution.retainedPreparation(actualUse)
            try {
              expect(Object.hasOwn(retained, "prepareSandbox")).toBe(false)
              expect(await Bun.file(originalPolicy).exists()).toBe(true)
              expect(await retained.inspect()).toMatchObject({
                id,
                state: "prepared",
                target: resources.runtime.target,
              })
              expect((await retained.inspect()).sandboxes.map((sandbox) => sandbox.id)).toEqual([wrapper.id])
              expect(await Storage.list(["environment_execution", session.scope.id])).toEqual([])
              await retained.release()
              await retained.release()
              expect((await retained.inspect()).state).toBe("released")
              expect(await Bun.file(originalPolicy).exists()).toBe(false)
              const remaining = await Environment.uses(resources.environment.id)
              expect(remaining.some((use) => use.id === actualUse.id)).toBe(false)
              expect(remaining).toHaveLength(1)
              expect(remaining[0].ownership.kind).toBe("admission")
              await resources.release()
              expect(await Environment.uses(resources.environment.id)).toEqual([])
            } finally {
              await retained.release()
              await resources.release()
            }
          }),
      })
    })
  },
  10_000,
)

test.skipIf(process.platform !== "darwin")(
  "unknown native sandbox preparation retains its Use and never recompiles on cleanup or inspection",
  async () => {
    await using runtime = await testRuntime()
    await runtime.run(async () => {
      await using temporary = await tmpdir()
      await ScopeContext.provide({
        scope: await temporary.scope(),
        workspace: null,
        fn: () =>
          withNativeTool(async (session, origin) => {
            const resources = await EnvironmentResources.select({
              scopeID: session.scope.id,
              ownerID: session.id,
              environmentID: session.environmentID,
              origin,
              needs: { execution: "exec" },
            })
            if (!resources.runtime || !resources.directory || !resources.environment)
              throw new Error("Missing native allocation")
            const original = SandboxBackend.prepareWrapper
            const unavailable = new Error("Original native sandbox result unavailable after materialization")
            const materialized: { wrapper?: ReturnType<typeof original> } = {}
            const compile = spyOn(SandboxBackend, "prepareWrapper").mockImplementation((input) => {
              materialized.wrapper = original(input)
              throw unavailable
            })
            try {
              await expect(
                EnvironmentResources.prepareSandbox(resources, {
                  command: "/bin/sh",
                  args: ["-c", "true"],
                  workspace: resources.directory,
                  sandboxMode: "workspace_write",
                }),
              ).rejects.toBe(unavailable)
              if (!materialized.wrapper?.tempPath)
                throw new Error("Fault injection did not reach real native policy materialization")
              expect(await Bun.file(materialized.wrapper.tempPath).exists()).toBe(true)
              const actualUse = (await Environment.uses(resources.environment.id)).find(
                (use) => use.ownership.kind === "execution-preparation",
              )
              if (!actualUse) throw new Error("Unknown native preparation lost its actual canonical Use")
              expect(actualUse.kind).toBe("operation")
              await expect(resources.release()).rejects.toBeInstanceOf(AggregateError)
              const retained = await EnvironmentExecution.retainedPreparation(actualUse)
              expect((await retained.inspect()).state).toBe("preparing")
              await expect(retained.release()).rejects.toThrow("unknown")
              expect(compile).toHaveBeenCalledTimes(1)
              expect(await Environment.uses(resources.environment.id)).toContainEqual(actualUse)
              expect(await Storage.list(["environment_execution", session.scope.id])).toEqual([])
            } finally {
              compile.mockRestore()
              if (materialized.wrapper) SandboxBackend.cleanupWrapper(materialized.wrapper)
            }
          }),
      })
    })
  },
  10_000,
)

test.skipIf(!["darwin", "linux"].includes(process.platform))(
  "original target sandbox preparation materializes only its approved Session temporary directory",
  async () => {
    await using runtime = await testRuntime()
    await runtime.run(async () => {
      await using temporary = await tmpdir()
      await ScopeContext.provide({
        scope: await temporary.scope(),
        workspace: null,
        fn: () =>
          withNativeTool(async (session, origin) => {
            const resources = await EnvironmentResources.select({
              scopeID: session.scope.id,
              ownerID: session.id,
              environmentID: session.environmentID,
              origin,
              needs: { execution: "exec" },
            })
            if (!resources.directory || !resources.environment) throw new Error("Missing original native target")
            const original = controlledTempRoot(resources.directory, session.id)
            const controlled = path.join(
              path.dirname(original),
              path.basename(original).replace(`synergy-${process.pid}-`, `synergy-${process.pid + 1}-`),
            )
            expect(controlled).not.toBe(original)
            const unrelated = path.join(temporary.path, "unrelated-approved-root")
            await expect(fs.lstat(controlled)).rejects.toMatchObject({ code: "ENOENT" })
            const input = {
              command: "/bin/sh",
              args: ["-c", "true"],
              workspace: resources.directory,
              sandboxMode: "workspace_write" as const,
              extraWritableRoots: [controlled, unrelated],
            }
            let prepared: Awaited<ReturnType<typeof EnvironmentResources.prepareSandbox>> | undefined
            try {
              prepared = await EnvironmentResources.prepareSandbox(resources, input)
              expect((await fs.lstat(controlled)).isDirectory()).toBe(true)
              expect((await fs.lstat(controlled)).isSymbolicLink()).toBe(false)
              await expect(fs.lstat(unrelated)).rejects.toMatchObject({ code: "ENOENT" })
              expect(
                ExecutionProtocol.Sandbox.parse(await EnvironmentResources.prepareSandbox(resources, input)),
              ).toEqual(ExecutionProtocol.Sandbox.parse(prepared))
              const actualUse = (await Environment.uses(resources.environment.id)).find(
                (use) =>
                  use.ownership.kind === "execution-preparation" &&
                  use.ownership.operationID === EnvironmentExecution.operationID(origin),
              )
              expect(actualUse).toBeDefined()
              expect(await Storage.list(["environment_execution", session.scope.id])).toEqual([])
            } finally {
              if (prepared && "cleanup" in prepared) await prepared.cleanup()
              await resources.release()
            }
          }),
      })
    })
  },
  10_000,
)

test.skipIf(!["darwin", "linux"].includes(process.platform))(
  "original native sandbox preparation refuses a symlink in its controlled temporary parents",
  async () => {
    await using runtime = await testRuntime()
    await runtime.run(async () => {
      await using temporary = await tmpdir()
      await ScopeContext.provide({
        scope: await temporary.scope(),
        workspace: null,
        fn: () =>
          withNativeTool(async (session, origin) => {
            const resources = await EnvironmentResources.select({
              scopeID: session.scope.id,
              ownerID: session.id,
              environmentID: session.environmentID,
              origin,
              needs: { execution: "exec" },
            })
            if (!resources.directory || !resources.environment) throw new Error("Missing original native target")
            const outside = path.join(temporary.path, "outside")
            await fs.mkdir(outside)
            await fs.symlink(outside, path.join(resources.directory, ".synergy"))
            const input = {
              command: "/bin/sh",
              args: ["-c", "true"],
              workspace: resources.directory,
              sandboxMode: "workspace_write" as const,
              extraWritableRoots: [controlledTempRoot(resources.directory, session.id)],
            }
            const result = await EnvironmentResources.prepareSandbox(resources, input).then(
              (value) => ({ kind: "prepared" as const, value }),
              (error: unknown) => ({ kind: "refused" as const, error }),
            )
            try {
              expect(result.kind).toBe("refused")
              expect(await fs.readdir(outside)).toEqual([])
              const actualUse = (await Environment.uses(resources.environment.id)).find(
                (use) =>
                  use.ownership.kind === "execution-preparation" &&
                  use.ownership.operationID === EnvironmentExecution.operationID(origin),
              )
              if (!actualUse) throw new Error("Refused native preparation lost its original operation Use")
              const retained = await EnvironmentExecution.retainedPreparation(actualUse)
              expect((await retained.inspect()).state).toBe("preparing")
              await expect(retained.release()).rejects.toThrow("unknown")
              expect(await Storage.list(["environment_execution", session.scope.id])).toEqual([])
            } finally {
              if (result.kind === "prepared") {
                if ("cleanup" in result.value) await result.value.cleanup()
                await resources.release()
              }
            }
          }),
      })
    })
  },
  10_000,
)
