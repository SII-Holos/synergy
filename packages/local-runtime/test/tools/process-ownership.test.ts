import { expect, test } from "bun:test"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { Identifier } from "@ericsanchezok/synergy-harness/id/id"
import { MessageV2 } from "@ericsanchezok/synergy-harness/session/message-v2"
import { RolloutTool } from "@ericsanchezok/synergy-harness/session/rollout/tool"
import { RolloutLedger } from "@ericsanchezok/synergy-harness/session/rollout/ledger"
import { ProcessRegistry } from "@ericsanchezok/synergy-harness/process/registry"
import { ProcessAccessSource } from "@ericsanchezok/synergy-harness/process/access-source"
import { PrimaryAgentIdentity } from "@ericsanchezok/synergy-harness/agent/primary-identity"
import type { Tool } from "@ericsanchezok/synergy-harness/tool/tool"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import { testRuntime } from "../support/runtime"
import { LocalBashBackend } from "../../src/tools/bash/local"
import { LocalProcessBackend } from "../../src/tools/process/local"
import { EnvironmentExecution } from "@ericsanchezok/synergy-harness/environment/execution"

async function withRun<T>(
  session: Session.Info,
  body: (run: {
    id: string
    tool<R>(
      name: "bash" | "process",
      args: Record<string, string | number | boolean>,
      body: (context: Tool.Context) => Promise<R>,
    ): Promise<R>
  }) => Promise<T>,
) {
  const owner = { kind: "session" as const, scopeID: session.scope.id, sessionID: session.id }
  const rootID = Identifier.ascending("message")
  await Session.updateMessage({
    id: rootID,
    rootID,
    isRoot: true,
    role: "user",
    sessionID: session.id,
    agent: PrimaryAgentIdentity.names.general,
    model: { providerID: "native-fixture", modelID: "native-fixture" },
    time: { created: Date.now() },
  })
  await RolloutLedger.beginRun(owner, rootID)
  const failures: unknown[] = []
  let result: { value: T } | undefined
  try {
    result = {
      value: await body({
        id: rootID,
        async tool(name, args, execute) {
          const messageID = Identifier.ascending("message"),
            callID = crypto.randomUUID()
          await Session.updateMessage(
            MessageV2.Assistant.parse({
              id: messageID,
              sessionID: session.id,
              role: "assistant",
              rootID,
              parentID: rootID,
              agent: PrimaryAgentIdentity.names.general,
              mode: "default",
              providerID: "native-fixture",
              modelID: "native-fixture",
              path: { cwd: null, root: null },
              cost: 0,
              tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
              time: { created: Date.now() },
            }),
          )
          return RolloutTool.execute({ owner, runID: rootID, messageID, toolCallID: callID, tool: name, args }, () =>
            execute({
              sessionID: session.id,
              messageID,
              callID,
              agent: PrimaryAgentIdentity.names.general,
              environmentID: session.environmentID,
              abort: new AbortController().signal,
              extra: { shellAuthorizationResolved: true, controlProfile: "full_access" },
              metadata() {},
              async ask() {},
              openProcessEvidence: RolloutTool.openProcess,
            }),
          )
        },
      }),
    }
  } catch (error) {
    failures.push(error)
  }
  try {
    await RolloutLedger.finishRun(owner, rootID, failures.length ? "failed" : "completed")
  } catch (error) {
    failures.push(error)
  }
  if (failures.length === 1) throw failures[0]
  if (failures.length) throw new AggregateError(failures, "Native process fixture and Run cleanup failed")
  if (!result) throw new Error("The original native process fixture did not settle")
  return result.value
}

test.skipIf(process.platform === "win32")(
  "a registered process source scopes real background controls to their native caller",
  async () => {
    const callers: string[] = []
    await using runtime = await testRuntime({
      register() {
        ProcessAccessSource.register({
          async resolve({ caller }) {
            callers.push(caller.sessionID)
            return {
              assert() {},
              async recheck() {},
              async allows(original) {
                const recorded = (await RolloutLedger.processes(original.owner, original.runID)).find(
                  (row) => row.id === original.id,
                )
                return (
                  !!recorded &&
                  recorded.toolExecutionID === original.toolExecutionID &&
                  original.owner.kind === "session" &&
                  original.owner.sessionID === caller.sessionID &&
                  original.runID === caller.runID
                )
              },
            }
          },
        })
      },
    })
    await runtime.run(async () => {
      await using directory = await tmpdir()
      await ScopeContext.provide({
        scope: await directory.scope(),
        workspace: null,
        async fn() {
          const alice = await Session.create({ workspace: null, controlProfile: "full_access" })
          const bob = await Session.create({ workspace: null, controlProfile: "full_access" })
          await withRun(alice, async (run) => {
            const script =
              'process.stdin.once("data", data => { process.stdout.write(data); process.exit(0) }); console.log("ORIGINAL_PROCESS_READY")'
            const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'"
            const command = `${quote(process.execPath)} -e ${quote(script)}`
            const ready = Promise.withResolvers<void>()
            const started = await run.tool("bash", { command, yieldSeconds: 0.01 }, (ctx) =>
              LocalBashBackend.execute(
                { command, yieldSeconds: 0.01 },
                {
                  ...ctx,
                  metadata(update) {
                    ctx.metadata(update)
                    if (update.metadata?.output?.includes("ORIGINAL_PROCESS_READY")) ready.resolve()
                  },
                },
              ),
            )
            expect(started.metadata.background).toBe(true)
            const id = started.metadata.processId
            if (!id) throw new Error("Real Bash did not return its owned background process")
            const originalProcess = ProcessRegistry.get(id)
            if (!originalProcess?.child) throw new Error("Original background process has no actual native owner")
            const child = originalProcess.child
            try {
              const deadline = Promise.withResolvers<never>()
              const timer = setTimeout(
                () => deadline.reject(new Error("Original native process did not reach its ready barrier")),
                3000,
              )
              try {
                await Promise.race([ready.promise, deadline.promise])
              } finally {
                clearTimeout(timer)
              }
              expect(ProcessRegistry.recordedOwnership(id)).toMatchObject({
                owner: { sessionID: alice.id },
                runID: run.id,
              })
              const poll = { action: "poll" as const, processId: id }
              expect(
                (await run.tool("process", poll, (ctx) => LocalProcessBackend.execute(poll, ctx))).metadata.status,
              ).toBe("running")
              await withRun(bob, async (other) => {
                const listed = await other.tool("process", { action: "list" }, (ctx) =>
                  LocalProcessBackend.execute({ action: "list" }, ctx),
                )
                expect(listed.metadata.processes?.some((row) => row.processId === id)).toBe(false)
                for (const action of ["log", "write", "kill"] as const) {
                  const args = { action, processId: id, ...(action === "write" && { data: "foreign input" }) }
                  await expect(
                    other.tool("process", args, (ctx) => LocalProcessBackend.execute(args, ctx)),
                  ).rejects.toThrow("unavailable to this caller")
                }
              })
              expect(child.alive?.()).toBe(true)
              const write = { action: "write" as const, processId: id, data: "ORIGINAL_PROCESS_FINISHED\n" }
              expect(
                (await run.tool("process", write, (ctx) => LocalProcessBackend.execute(write, ctx))).metadata.status,
              ).toBe("running")
              const finish = { action: "poll" as const, processId: id, block: true, timeoutSeconds: 5 }
              const result = await run.tool("process", finish, (ctx) => LocalProcessBackend.execute(finish, ctx))
              if (result.metadata.status !== "completed" || result.metadata.exitCode !== 0) {
                try {
                  const owner = { kind: "session" as const, scopeID: alice.scope.id, sessionID: alice.id }
                  const fact = ProcessRegistry.recordedOwnership(id)
                  const tool = (await RolloutLedger.tools(owner, run.id)).find(
                    (tool) => tool.id === fact?.toolExecutionID,
                  )
                  const execution =
                    tool &&
                    (await EnvironmentExecution.get(
                      EnvironmentExecution.operationID({
                        scopeID: alice.scope.id,
                        sessionID: alice.id,
                        messageID: tool.messageID,
                        callID: tool.toolCallID,
                      }),
                      alice.scope.id,
                    ))
                  const current = ProcessRegistry.get(id),
                    finished = ProcessRegistry.getFinished(id)
                  console.error(
                    "Owned process completion metadata",
                    JSON.stringify({
                      caller: { sessionID: alice.id, runID: run.id },
                      producer: fact,
                      poll: { status: result.metadata.status, exitCode: result.metadata.exitCode },
                      native: execution && {
                        id: execution.id,
                        state: execution.state,
                        origin: execution.origin,
                        status: execution.status,
                        outputCursor: execution.outputCursor,
                        checkpointFailures: execution.checkpointFailures,
                      },
                      registry: current && {
                        exited: current.exited,
                        exitCode: current.exitCode,
                        signal: current.exitSignal,
                        stdioState: current.stdioState,
                        exitObservedAt: current.exitObservedAt,
                        drainTimedOut: current.drainTimedOut,
                      },
                      finished: finished && {
                        status: finished.status,
                        exitCode: finished.exitCode,
                        signal: finished.exitSignal,
                        stdioState: finished.stdioState,
                        exitObservedAt: finished.exitObservedAt,
                        drainTimedOut: finished.drainTimedOut,
                      },
                      child: { exitCode: child.exitCode, signal: child.signalCode, alive: child.alive?.() },
                      evidence: (await RolloutLedger.processes(owner, run.id)).map((row) => ({
                        id: row.id,
                        runID: row.runID,
                        toolExecutionID: row.toolExecutionID,
                        status: row.status,
                        exitCode: row.exitCode,
                        signal: row.signal,
                        stream: row.stream.status,
                      })),
                      output: {
                        ready: result.output.includes("ORIGINAL_PROCESS_READY"),
                        finished: result.output.includes("ORIGINAL_PROCESS_FINISHED"),
                      },
                    }),
                  )
                } catch (error) {
                  console.error(
                    "Owned process diagnostic read failed",
                    JSON.stringify({
                      name: error instanceof Error ? error.name : "Error",
                      message: error instanceof Error ? error.message : String(error),
                    }),
                  )
                }
              }
              expect(result.metadata).toMatchObject({ status: "completed", exitCode: 0 })
              expect(result.output).toContain("ORIGINAL_PROCESS_FINISHED")
              expect(callers).toContain(alice.id)
              expect(callers).toContain(bob.id)
            } finally {
              await ProcessRegistry.terminate(originalProcess)
              await child.completion
              ProcessRegistry.remove(id)
            }
          })
        },
      })
    })
  },
  15000,
)
