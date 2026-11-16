import { expect, spyOn, test } from "bun:test"
import { Agent } from "../../src/agent/agent"
import { Cortex } from "../../src/cortex"
import { CortexTypes } from "../../src/cortex/types"
import { TaskTool } from "../../src/cortex/tools/task"
import { registerCortexSessionRuntime } from "../../src/cortex/session-runtime"
import { Identifier } from "../../src/id/id"
import { ScopeContext } from "../../src/scope/context"
import { Session } from "../../src/session"
import { PausedTurnAbort } from "../../src/session/error"
import { SessionLifecycle } from "../../src/session/lifecycle"
import { SessionTransferEpochs as Epochs } from "../../src/session/transfer-epochs"
import { SessionTransferOwners as Owners } from "../../src/session/transfer-owners"
import { withTimeout } from "../../src/util/timeout"
import { fn } from "../../src/util/fn"
import { testRuntime } from "../support/runtime"
import { tmpdir } from "../support/fixture"

for (const mode of ["ordinary", "protected", "cancel-failure"] as const)
  test(`the Task tool drains parent abort cancellation and preserves its actual outcome (${mode})`, async () => {
    await using runtime = await testRuntime({
      register: registerCortexSessionRuntime,
      env: {
        SYNERGY_CONFIG_CONTENT: JSON.stringify({
          model: "fixture/model",
          agent: {
            "abort-child": {
              mode: "subagent",
              model: "fixture/model",
              prompt: "Wait for the synthetic parent abort.",
              permission: { "*": "allow" },
            },
          },
          provider: {
            fixture: {
              npm: "@ai-sdk/openai-compatible",
              options: { apiKey: "synthetic-key", baseURL: "https://fixture.invalid/v1" },
              models: {
                model: { id: "model", name: "Fixture", tool_call: true, limit: { context: 128000, output: 8000 } },
              },
            },
          },
        }),
      },
    })
    await using workspace = await tmpdir({ git: true })
    await runtime.run(async () =>
      ScopeContext.provide({
        scope: await workspace.scope(),
        fn: async () => {
          const parent = await Session.create({})
          const messageID = Identifier.ascending("message")
          await Session.updateMessage({
            id: messageID,
            role: "assistant",
            sessionID: parent.id,
            parentID: messageID,
            rootID: messageID,
            agent: "general",
            providerID: "fixture",
            modelID: "model",
            cost: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            path: { cwd: runtime.host.home, root: runtime.host.home },
            mode: "test",
            time: { created: Date.now(), completed: Date.now() },
          })
          const created = Promise.withResolvers<CortexTypes.Task>()
          const waiting = Promise.withResolvers<void>()
          using launch = spyOn(Cortex, "launch").mockImplementation(
            fn(CortexTypes.LaunchInput, async (input) => {
              const task = await Cortex.prepare(input)
              created.resolve(task)
              return task
            }),
          )
          const tool = await TaskTool.init({
            agent: await Agent.get("general"),
            model: { providerID: "fixture", modelID: "model" },
          })
          const controller = new AbortController()
          const reason = mode === "cancel-failure" ? new Error("Ordinary parent cancellation") : new PausedTurnAbort()
          const execution = tool
            .execute(
              {
                taskTitle: "Retain the actual task",
                taskInstructions: "Wait for this controlled parent abort",
                subagent_type: "abort-child",
              },
              {
                sessionID: parent.id,
                messageID,
                agent: "general",
                abort: controller.signal,
                metadata(value) {
                  if (value.metadata?.sessionId) waiting.resolve()
                },
                async ask() {},
              },
            )
            .then(
              () => undefined,
              (error: unknown) => error,
            )
          try {
            const task = await withTimeout(
              Promise.race([
                created.promise,
                execution.then((error) => {
                  throw error ?? new Error("Task execution ended before launch")
                }),
              ]),
              5000,
            )
            await withTimeout(waiting.promise, 5000)
            if (mode !== "ordinary") {
              await SessionLifecycle.pause({ sessionID: parent.id, reason: "interrupted" })
              const binding = {
                scopeID: ScopeContext.current.scope.id,
                sessionID: task.sessionID,
                rootSessionID: parent.id,
                handoffID: "task-tool-abort",
                sourceID: "source",
                targetID: "target",
                fromEpoch: 1,
                toEpoch: 2,
              }
              await Epochs.beginSource(binding)
              await Cortex.suspendForTransfer(task.id, {
                rootSessionID: parent.id,
                handoffID: binding.handoffID,
                signal: new AbortController().signal,
              })
            }
            const before = (await Session.get(task.sessionID)).cortex
            controller.abort(reason)
            const result = await withTimeout(execution, 5000)
            if (mode === "cancel-failure") {
              expect(result).toBeInstanceOf(Owners.Rejected)
              expect((result as InstanceType<typeof Owners.Rejected>).data.message).toContain("transfer")
            } else expect(result).toBe(reason)
            if (mode === "ordinary") expect((await Session.get(task.sessionID)).cortex?.status).toBe("cancelled")
            else expect((await Session.get(task.sessionID)).cortex).toEqual(before)
          } finally {
            if (!controller.signal.aborted) controller.abort(new Error("Fixture cleanup"))
            await execution
          }
        },
      }),
    )
  }, 15000)
