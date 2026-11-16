import { expect, test } from "bun:test"
import { ProcessAccessSource } from "../../src/process/access-source"
import { ProcessRegistry } from "../../src/process/registry"
import { RolloutTool } from "../../src/session/rollout/tool"
import { RolloutLedger } from "../../src/session/rollout/ledger"
import { Identifier } from "../../src/id/id"
import { Session } from "../../src/session"
import { ScopeContext } from "../../src/scope/context"
import { PrimaryAgentIdentity } from "../../src/agent/primary-identity"
import { tmpdir } from "../support/fixture"
import { testRuntime } from "../support/runtime"

async function inTool<T>(
  body: (input: { sessionID: string; messageID: string; callID: string; signal: AbortSignal }) => Promise<T>,
) {
  await using directory = await tmpdir()
  return ScopeContext.provide({
    scope: await directory.scope(),
    workspace: null,
    async fn() {
      const session = await Session.create({ workspace: null })
      const rootID = Identifier.ascending("message")
      await Session.updateMessage({
        id: rootID,
        rootID,
        sessionID: session.id,
        role: "user",
        isRoot: true,
        agent: PrimaryAgentIdentity.names.general,
        model: { providerID: "contract", modelID: "contract" },
        time: { created: Date.now() },
      })
      const owner = { kind: "session" as const, scopeID: session.scope.id, sessionID: session.id }
      await RolloutLedger.beginRun(owner, rootID)
      const failures: unknown[] = []
      let result: { value: T } | undefined
      try {
        await RolloutTool.execute(
          {
            owner,
            runID: rootID,
            messageID: rootID,
            toolCallID: "contract-call",
            tool: "process",
            args: {},
          },
          async () => {
            result = {
              value: await body({
                sessionID: session.id,
                messageID: rootID,
                callID: "contract-call",
                signal: new AbortController().signal,
              }),
            }
            return { output: "Process access contract completed" }
          },
        )
      } catch (error) {
        failures.push(error)
      }
      try {
        await RolloutLedger.finishRun(owner, rootID, failures.length ? "failed" : "completed")
      } catch (error) {
        failures.push(error)
      }
      if (failures.length === 1) throw failures[0]
      if (failures.length) throw new AggregateError(failures, "Process contract and native Run cleanup failed")
      if (!result) throw new Error("The process contract did not produce a native tool result")
      return result.value
    },
  })
}

test("a process source preserves unregistered personal access and receives detached native process facts", async () => {
  await using personal = await testRuntime()
  expect(await personal.run(() => ProcessAccessSource.withAccess({}, async (access) => access.allows(undefined)))).toBe(
    true,
  )
  let seen: ProcessAccessSource.Caller | undefined
  let checks = 0
  await using guarded = await testRuntime({
    register() {
      ProcessAccessSource.register({
        async resolve({ caller }) {
          seen = caller
          return {
            assert() {},
            async recheck() {
              checks++
            },
            async allows(original) {
              return original.owner.kind === "session" && original.owner.sessionID === caller.sessionID
            },
          }
        },
      })
    },
  })
  await guarded.run(() =>
    inTool(async (input) => {
      const process = ProcessRegistry.create({ command: "contract process; no native command dispatched" })
      const writer = await RolloutTool.openProcess(process.id)
      try {
        const original = ProcessRegistry.recordedOwnership(process.id)
        if (!original) throw new Error("Native process evidence did not bind its Registry entry")
        expect(original).toMatchObject({ id: process.id, owner: { kind: "session", sessionID: input.sessionID } })
        await ProcessAccessSource.withAccess(input, async (access) => {
          expect(await access.allows(undefined)).toBe(false)
          expect(await access.allows(original)).toBe(true)
          original.owner = { kind: "operation", scopeID: "other", operationID: "other" }
          expect(await access.allows(original)).toBe(false)
        })
        expect(seen).toMatchObject({ sessionID: input.sessionID, messageID: input.messageID, callID: input.callID })
        expect(checks).toBe(1)
        await writer.finish({ interrupted: false, exitCode: 0, signal: null })
        ProcessRegistry.markExited(process, 0, null)
        expect(ProcessRegistry.recordedOwnership(process.id)).toMatchObject({
          owner: { kind: "session", sessionID: input.sessionID },
        })
      } finally {
        await writer.finish({ interrupted: false, exitCode: 0, signal: null })
        ProcessRegistry.remove(process.id)
      }
    }),
  )
})

test("a registered process source rejects missing native callers and expired callback scopes", async () => {
  let resolved = 0
  await using runtime = await testRuntime({
    register() {
      ProcessAccessSource.register({
        async resolve() {
          resolved++
          return {
            assert() {},
            async recheck() {},
            async allows() {
              return true
            },
          }
        },
      })
    },
  })
  await runtime.run(async () => {
    await expect(ProcessAccessSource.withAccess({}, async () => {})).rejects.toThrow("genuine current Session Run")
    expect(resolved).toBe(0)
    await inTool(async (input) => {
      let retained: Parameters<Parameters<typeof ProcessAccessSource.withAccess>[1]>[0] | undefined
      await ProcessAccessSource.withAccess(input, async (access) => {
        retained = access
      })
      const original = retained
      if (!original) throw new Error("The original callback did not run")
      await expect(original.recheck()).rejects.toThrow("callback has ended")
      expect(() => original.assert()).toThrow("callback has ended")
    })
    expect(resolved).toBe(1)
  })
})

test("process source reads retain their call-time signal and do not return after cancellation", async () => {
  const entered = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>()
  await using runtime = await testRuntime({
    register() {
      ProcessAccessSource.register({
        async resolve() {
          return {
            assert() {},
            async allows() {
              return true
            },
            async recheck() {
              entered.resolve()
              await release.promise
            },
          }
        },
      })
    },
  })
  await runtime.run(() =>
    inTool(async (input) => {
      const abort = new AbortController()
      input.signal = abort.signal
      const reason = new Error("original process observer ended")
      const pending = ProcessAccessSource.withAccess(input, async () => "must not be returned").then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      )
      try {
        await entered.promise
        input.signal = new AbortController().signal
        abort.abort(reason)
        release.resolve()
        expect(await pending).toEqual({ error: reason })
      } finally {
        release.resolve()
        await pending
      }
    }),
  )
})
