import { afterAll, expect, spyOn, test } from "bun:test"
import { testRuntime } from "@ericsanchezok/synergy-harness/test/support/runtime"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { Identifier } from "@ericsanchezok/synergy-harness/id/id"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { Provider } from "@ericsanchezok/synergy-harness/provider/provider"
import { AgentCall } from "@ericsanchezok/synergy-harness/agent/call"
import { RolloutLedger } from "@ericsanchezok/synergy-harness/session/rollout/ledger"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { Agent } from "@ericsanchezok/synergy-harness/agent/agent"
import { digitalTwin } from "../src/component"
import { DigitalTwin } from "../src/service"

const component = digitalTwin()
const runtime = await testRuntime({ register: component.register })
afterAll(async () => {
  await runtime.run(DigitalTwin.close)
  await runtime.close()
})

test(
  "independent calls share in-flight work, retain surviving consumers and reject source edits",
  () =>
    runtime.run(async () => {
      await using tmp = await tmpdir({ git: true })
      await ScopeContext.provide({
        scope: await tmp.scope(),
        fn: async () => {
          expect((await Agent.get("digital-twin"))?.hidden).toBe(true)
          expect(await Storage.queryKeys({ kind: "digital_twin", prefix: ["sessions"] })).toEqual([])
          const session = await Session.create({})
          const root = await Session.updateMessage({
            id: Identifier.ascending("message"),
            sessionID: session.id,
            role: "user",
            isRoot: true,
            time: { created: 1 },
            agent: "synergy",
            model: { providerID: "fixture", modelID: "selected" },
          })
          const part = await Session.updatePart({
            id: Identifier.ascending("part"),
            sessionID: session.id,
            messageID: root.id,
            type: "text",
            text: "先实现 API，再验证边界",
          })
          const reply = await Session.updateMessage({
            id: Identifier.ascending("message"),
            sessionID: session.id,
            rootID: root.id,
            parentID: root.id,
            role: "assistant",
            time: { created: 2, completed: 3 },
            modelID: "selected",
            providerID: "fixture",
            agent: "synergy",
            mode: "synergy",
            path: { cwd: null, root: null },
            cost: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            finish: "stop",
          })
          await Session.updatePart({
            id: Identifier.ascending("part"),
            sessionID: session.id,
            messageID: reply.id,
            type: "text",
            text: "API 已实现，测试通过。",
          })
          const owner = { kind: "session" as const, scopeID: session.scope.id, sessionID: session.id }
          await RolloutLedger.beginRun(owner, root.id)
          await RolloutLedger.finishRun(owner, root.id, "completed")
          const model = {
            providerID: "fixture",
            id: "selected",
            limit: { context: 100_000, output: 8192 },
          } as Provider.Model
          const provider = spyOn(Provider, "getModel").mockResolvedValue(model)
          let release = Promise.withResolvers<void>()
          let entered = Promise.withResolvers<void>()
          const calls: AgentCall.TextInput[] = []
          const pending: Promise<unknown>[] = []
          const sampling = spyOn(AgentCall, "text").mockImplementation(async (input) => {
            calls.push(input)
            entered.resolve()
            await release.promise
            return {
              text: "",
              model,
              toolCalls: [
                {
                  name: "predict_next_input",
                  input: {
                    candidate: "再检查一下 API 的异常路径",
                    grounding: ["current"],
                    targets: ["API"],
                  },
                },
              ],
            }
          })
          try {
            const cancel = new AbortController()
            const input = {
              sessionID: session.id,
              requestID: "one",
              expected: { rootID: root.id, assistantID: reply.id },
            }
            const first = DigitalTwin.predictNextInput({ ...input, signal: cancel.signal })
            const firstResult = first.catch((error) => error)
            pending.push(firstResult)
            await entered.promise
            const survivor = new AbortController()
            const joined = Promise.withResolvers<void>()
            const addListener = survivor.signal.addEventListener.bind(survivor.signal)
            using subscription = spyOn(survivor.signal, "addEventListener").mockImplementation(
              (...args: Parameters<typeof addListener>) => {
                addListener(...args)
                if (args[0] === "abort") joined.resolve()
              },
            )
            const second = DigitalTwin.predictNextInput({ ...input, requestID: "two", signal: survivor.signal })
            pending.push(second.catch(() => {}))
            await joined.promise
            cancel.abort()
            expect((await firstResult).code).toBe("cancelled")
            expect(calls[0]!.signal!.aborted).toBe(false)
            release.resolve()
            expect((await second).candidate).toBe("再检查一下 API 的异常路径")
            expect(calls).toHaveLength(1)
            expect(calls[0]).toMatchObject({ ownership: "operation", small: false, model })
            expect(calls[0]!.sessionId).toBeUndefined()
            release = Promise.withResolvers<void>()
            entered = Promise.withResolvers<void>()
            const stale = DigitalTwin.predictNextInput({ ...input, requestID: "three" })
            const staleResult = stale.catch((error) => error)
            pending.push(staleResult)
            await entered.promise
            await Session.updatePart({
              id: part.id,
              sessionID: session.id,
              messageID: root.id,
              type: "text",
              text: "需求换了",
            })
            release.resolve()
            expect((await staleResult).code).toBe("source_changed")
          } finally {
            release.resolve()
            await Promise.allSettled(pending)
            sampling.mockRestore()
            provider.mockRestore()
            await Session.remove(session.id)
          }
        },
      })
    }),
  15000,
)

test("a core Runtime has no Digital Twin Agent or projection", async () => {
  const core = await testRuntime()
  try {
    await core.run(async () => {
      await using tmp = await tmpdir({ git: true })
      await ScopeContext.provide({
        scope: await tmp.scope(),
        fn: async () => {
          expect(await Agent.get("digital-twin")).toBeUndefined()
          expect(await Storage.queryKeys({ kind: "digital_twin" })).toEqual([])
        },
      })
    })
  } finally {
    await core.close()
  }
})
