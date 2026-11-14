import { PermissionNext } from "@ericsanchezok/synergy-harness/permission/next"
import { ProcessRegistry } from "@ericsanchezok/synergy-harness/process/registry"
import { PrimaryAgentIdentity } from "@ericsanchezok/synergy-harness/agent/primary-identity"
import { expect, spyOn, test } from "bun:test"
import { testRuntime } from "../support/runtime"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { Environment } from "@ericsanchezok/synergy-harness/environment"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { BashTool } from "../../src/tools/bash"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import path from "node:path"
import { Identifier } from "@ericsanchezok/synergy-harness/id/id"
import { RolloutLedger } from "@ericsanchezok/synergy-harness/session/rollout/ledger"
import { RolloutTool } from "@ericsanchezok/synergy-harness/session/rollout/tool"
import { EnvironmentExecution } from "@ericsanchezok/synergy-harness/environment/execution"
import { EnvironmentProviders } from "@ericsanchezok/synergy-harness/environment/provider"
import { SessionLifecycle } from "@ericsanchezok/synergy-harness/session/lifecycle"
import { RolloutContext } from "@ericsanchezok/synergy-harness/session/rollout/context"

function nativeBashPermission(sessionID: string, patterns: string[]) {
  const ruleset = patterns.map((pattern) => ({ permission: "bash", pattern, action: "allow" as const }))
  return async (input: Omit<PermissionNext.Request, "id" | "sessionID" | "tool">) => {
    expect(input.permission).toBe("bash")
    expect(input.patterns).toEqual(patterns)
    await PermissionNext.ask({ ...input, sessionID, ruleset })
  }
}

async function withBashOrigin<T>(session: Session.Info, callID: string, fn: (messageID: string) => Promise<T>) {
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
    path: { cwd: ScopeContext.current.workspace?.path ?? null, root: ScopeContext.current.workspace?.path ?? null },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: Date.now() },
  })
  const owner = { kind: "session" as const, scopeID: session.scope.id, sessionID: session.id }
  await RolloutLedger.beginRun(owner, rootID)
  let status: "completed" | "failed" = "failed"
  try {
    const result = await RolloutTool.execute(
      { owner, runID: rootID, messageID, toolCallID: callID, tool: "bash", args: {} },
      async () => ({ value: await fn(messageID) }),
    )
    status = "completed"
    return result.value
  } finally {
    await RolloutLedger.finishRun(owner, rootID, status)
  }
}

test("Bash uses the selected Environment without requiring a Workspace", async () => {
  await using runtime = await testRuntime()
  await runtime.run(async () => {
    await using tmp = await tmpdir()
    await ScopeContext.provide({
      scope: await tmp.scope(),
      workspace: null,
      async fn() {
        const session = await Session.create({ workspace: null, controlProfile: "full_access" })
        const tool = await BashTool.init()
        const context = {
          sessionID: session.id,
          messageID: "message",
          callID: "call",
          agent: PrimaryAgentIdentity.names.general,
          abort: new AbortController().signal,
          environmentID: session.environmentID,
          extra: { shellBypassSandbox: true, controlProfile: "full_access" },
          metadata() {},
          ask: nativeBashPermission(session.id, ["printf environment"]),
        }
        const result = await withBashOrigin(session, context.callID, (messageID) =>
          tool.execute(
            { command: "printf environment" },
            { ...context, messageID, workBrief: "Execute without files" },
          ),
        )
        expect(result.output).toBe("environment\n\nShell exited with code 0.")
        expect(result.metadata.output).toBe("environment")
        expect(result.metadata.exit).toBe(0)
        const keys = await Storage.list(["environment_execution", session.scope.id])
        expect(keys).toHaveLength(1)
        expect(await EnvironmentExecution.get(keys[0]![2]!, session.scope.id)).toMatchObject({
          state: "completed",
          origin: { kind: "session", sessionID: session.id, callID: context.callID, tool: "bash" },
        })
        await expect(
          withBashOrigin(session, "other", (messageID) =>
            tool.execute(
              { command: "printf refused" },
              {
                ...{ ...context, messageID, callID: "other", environmentID: null },
                workBrief: "No execution authority",
              },
            ),
          ),
        ).rejects.toMatchObject({ name: "EnvironmentUnavailable" })
        expect(await Environment.uses(session.environmentID!)).toHaveLength(0)
      },
    })
  })
}, 20_000)

test.skipIf(process.platform === "win32")(
  "Bash preserves UTF-8 characters split independently across output streams",
  async () => {
    await using runtime = await testRuntime()
    await runtime.run(async () => {
      await using tmp = await tmpdir()
      await Bun.write(
        path.join(tmp.path, "output.js"),
        `
      process.stdout.write(Buffer.from([0xe4]));
      process.stderr.write(Buffer.from([0xe6]));
      setTimeout(() => {
        process.stdout.write(Buffer.from([0xb8, 0xad]));
        process.stderr.write(Buffer.from([0x96, 0x87]));
      }, 150);
    `,
      )
      await ScopeContext.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const session = await Session.create({ controlProfile: "full_access" })
          const result = await withBashOrigin(session, "utf8", async (messageID) =>
            (await BashTool.init()).execute(
              { command: `"${process.execPath}" output.js` },
              {
                ...{
                  sessionID: session.id,
                  messageID,
                  callID: "utf8",
                  agent: PrimaryAgentIdentity.names.general,
                  abort: new AbortController().signal,
                  environmentID: session.environmentID,
                  extra: { shellBypassSandbox: true, controlProfile: "full_access" },
                  metadata() {},
                  ask: nativeBashPermission(session.id, [`"${process.execPath}" output.js`]),
                },
                workBrief: "Read split text",
              },
            ),
          )
          expect(result.output).toContain("中")
          expect(result.output).toContain("文")
          expect(result.output).not.toContain("�")
        },
      })
    })
  },
  20_000,
)

test("a submitted native operation cannot first start after its Session pauses during connection", async () => {
  await using runtime = await testRuntime()
  await runtime.run(async () => {
    await using directory = await tmpdir()
    await ScopeContext.provide({
      scope: await directory.scope(),
      workspace: null,
      fn: async () => {
        const session = await Session.create({ workspaceID: null, controlProfile: "full_access" })
        const marker = path.join(directory.path, "must-not-start")
        const provider = EnvironmentProviders.get("native")
        if (!provider.connect) throw new Error("Native provider requires its actual Executor")
        const original = provider.connect.bind(provider)
        const entered = Promise.withResolvers<void>()
        const release = Promise.withResolvers<void>()
        const connect = spyOn(provider, "connect").mockImplementation(async (...args) => {
          const executor = await original(...args)
          entered.resolve()
          await release.promise
          return executor
        })
        const id = "paused-before-start"
        try {
          await withBashOrigin(session, "paused-call", async (messageID) => {
            const root = RolloutContext.current()
            if (!root || !session.environmentID) throw new Error("Native fixture lost its canonical execution owner")
            const pending = EnvironmentExecution.start({
              id,
              scopeID: session.scope.id,
              environmentID: session.environmentID,
              origin: {
                kind: "session",
                scopeID: session.scope.id,
                sessionID: session.id,
                rootID: root.runID,
                runID: root.runID,
                messageID,
                callID: "paused-call",
                tool: "bash",
              },
              command: {
                command: process.execPath,
                args: ["-e", `await Bun.write(${JSON.stringify(marker)}, 'started')`],
                cwd: directory.path,
                env: {},
                useRoots: [directory.path],
              },
            }).then(
              (value) => ({ value }),
              (error: unknown) => ({ error }),
            )
            await entered.promise
            try {
              await SessionLifecycle.pause({ sessionID: session.id, reason: "interrupted" })
              release.resolve()
              const result = await pending
              expect(result).toHaveProperty("error")
              expect(await Bun.file(marker).exists()).toBeFalse()
              expect(await EnvironmentExecution.get(id, session.scope.id)).toMatchObject({
                state: "completed",
                status: { state: "cancelled", effectsStarted: false },
              })
              expect(await Environment.uses(session.environmentID)).toEqual([])
            } finally {
              release.resolve()
              await pending
              const info = await EnvironmentExecution.get(id, session.scope.id)
              if (info.state !== "completed") {
                await EnvironmentExecution.cancel(id, session.scope.id)
                await EnvironmentExecution.complete(id, session.scope.id)
              }
            }
          })
        } finally {
          release.resolve()
          connect.mockRestore()
        }
      },
    })
  })
}, 15_000)

test.skipIf(process.platform === "win32")(
  "explicit background Bash returns its native process before stdin completes",
  async () => {
    await using runtime = await testRuntime()
    await runtime.run(async () => {
      await using directory = await tmpdir()
      await ScopeContext.provide({
        scope: await directory.scope(),
        workspace: null,
        fn: async () => {
          const session = await Session.create({ workspace: null, controlProfile: "full_access" })
          const controller = new AbortController()
          const command = "printf BACKGROUND_READY; read original_input; printf '%s' \"$original_input\""
          let process: ReturnType<typeof ProcessRegistry.get>
          const pending = withBashOrigin(session, "explicit-background", async (messageID) =>
            (await BashTool.init()).execute(
              { command, background: true },
              {
                sessionID: session.id,
                messageID,
                callID: "explicit-background",
                agent: PrimaryAgentIdentity.names.general,
                abort: controller.signal,
                environmentID: session.environmentID,
                extra: { shellBypassSandbox: true, controlProfile: "full_access" },
                metadata() {},
                ask: nativeBashPermission(session.id, [
                  "printf BACKGROUND_READY",
                  "read original_input",
                  `printf '%s' "$original_input"`,
                ]),
              },
            ),
          )
          const settled = pending.then((result) => ({ kind: "returned" as const, result }))
          try {
            const deadline = Date.now() + 4000
            for (;;) {
              for (const entry of ProcessRegistry.listActive()) {
                if (entry.command === command) process = ProcessRegistry.get(entry.id)
              }
              if (process?.output.includes("BACKGROUND_READY")) break
              if (Date.now() >= deadline) throw new Error("The actual background child did not reach its stdin barrier")
              await Bun.sleep(5)
            }
            const timeout = Promise.withResolvers<{ kind: "still_waiting" }>()
            const timer = setTimeout(() => timeout.resolve({ kind: "still_waiting" }), 200)
            const outcome = await Promise.race([settled, timeout.promise]).finally(() => clearTimeout(timer))
            expect(outcome.kind).toBe("returned")
            if (outcome.kind !== "returned") throw new Error("The public background option still waited for stdin")
            expect(outcome.result.metadata).toMatchObject({ background: true, processId: process!.id })
            expect(process!.exited).toBe(false)
            const operations = await Storage.list(["environment_execution", session.scope.id])
            expect(operations).toHaveLength(1)
            expect(await EnvironmentExecution.get(operations[0][2], session.scope.id)).toMatchObject({
              state: "running",
            })
          } finally {
            controller.abort(new Error("Owned background behavior test finished"))
            if (process && !process.exited) await ProcessRegistry.terminate(process)
            await pending
          }
        },
      })
    })
  },
  15_000,
)
