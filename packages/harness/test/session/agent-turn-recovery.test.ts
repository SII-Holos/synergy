import { expect, test } from "bun:test"
import { Identifier } from "../../src/id/id"
import { Provider } from "../../src/provider/provider"
import { Scope } from "../../src/scope"
import { ScopeContext } from "../../src/scope/context"
import { AgentTurn } from "../../src/session/agent-turn"
import { RolloutLedger } from "../../src/session/rollout/ledger"
import { testRuntime } from "../support/runtime"

test.each([
  { outcome: "completed", waiting: "generation" },
  { outcome: "failed", waiting: "generation" },
  { outcome: "completed", waiting: "cleanup" },
  { outcome: "failed", waiting: "cleanup" },
] as const)(
  "a recovered turn waiting for $waiting overlaps another call and retains its $outcome outcome",
  async ({ outcome, waiting }) => {
    const finish = Promise.withResolvers<void>()
    const disposing = Promise.withResolvers<void>()
    const abort = new AbortController()
    const started: string[] = []
    const disposed: string[] = []
    const names = new Map<string, string>()
    const overload = Object.assign(new Error("Our servers are currently overloaded. Please try again later."), {
      code: "server_is_overloaded",
    })
    const catalog = Provider.fromModelsDevProvider({
      id: "recovery-fixture",
      name: "Recovery fixture",
      env: [],
      npm: "fixture-sdk",
      api: "https://recovery.invalid/v1",
      models: {
        chat: {
          id: "chat",
          name: "Chat",
          release_date: "2026-01-01",
          attachment: false,
          reasoning: false,
          temperature: false,
          tool_call: true,
          limit: { context: 32000, output: 8000 },
          options: {},
        },
      },
    })
    await using runtime = await testRuntime({
      register() {
        AgentTurn.setInProcessStream(async (input) => {
          const name = names.get(input.user.id)!
          started.push(name)
          return {
            fullStream: (async function* () {
              if (name === "initial") {
                yield { type: "error" as const, error: overload }
                return
              }
              if (name !== "long" || waiting === "generation")
                yield { type: "text-delta" as const, id: name, text: `${name} started` }
              if (name === "long" && waiting === "generation") {
                await finish.promise
                if (outcome === "failed") {
                  yield { type: "error" as const, error: overload }
                  return
                }
              }
              if (name === "long" && waiting === "cleanup" && outcome === "failed") throw overload
              yield { type: "finish" as const }
            })(),
            usage: Promise.resolve(undefined),
            async dispose() {
              if (name === "long" && waiting === "cleanup") {
                disposing.resolve()
                await finish.promise
              }
              disposed.push(name)
            },
          }
        })
      },
    })
    await runtime.run(() =>
      ScopeContext.provide({
        scope: Scope.home(),
        async fn() {
          const open = async (name: string) => {
            const operationID = crypto.randomUUID()
            const owner = { kind: "operation" as const, scopeID: "home", operationID }
            const id = Identifier.ascending("message")
            const sessionID = Identifier.ascending("session")
            const signal = AbortSignal.any([abort.signal, AbortSignal.timeout(10_000)])
            names.set(id, name)
            const stream = await AgentTurn.stream({
              sessionID,
              user: {
                id,
                sessionID,
                role: "user",
                time: { created: Date.now() },
                agent: "fixture",
                model: { providerID: catalog.id, modelID: "chat" },
              },
              agent: { name: "fixture", mode: "primary", permission: [], options: {} },
              model: catalog.models.chat!,
              system: [],
              messages: [{ role: "user", content: name }],
              abort: signal,
              toolDefinitions: [],
              recording: { owner, runID: operationID, purpose: "test" },
              usageRole: "conversation",
              recovery: { immediate: name === "long" },
            })
            return { stream, signal, calls: () => RolloutLedger.calls(owner, operationID) }
          }
          const initial = await open("initial")
          expect(await Array.fromAsync(initial.stream.fullStream)).toMatchObject([{ type: "error" }])
          expect(await initial.calls()).toMatchObject([{ status: "failed" }])
          const long = await open("long")
          const reader = long.stream.fullStream[Symbol.asyncIterator]()
          let ending: Promise<unknown> | undefined
          try {
            if (waiting === "generation") {
              expect((await reader.next()).value).toMatchObject({ text: "long started" })
            } else {
              ending = (async () => {
                while (!(await reader.next()).done) {}
              })().catch((error: unknown) => error)
              await disposing.promise
            }
            const peer = await open("peer")
            expect(await Array.fromAsync(peer.stream.fullStream)).toMatchObject([
              { type: "text-delta", text: "peer started" },
              { type: "finish" },
            ])
            expect(await peer.calls()).toMatchObject([{ status: "completed" }])
            expect(await long.calls()).toMatchObject([{ status: "running" }])
            expect(long.signal.aborted).toBe(false)
            expect(disposed).not.toContain("long")
            finish.resolve()
            if (ending) expect(await ending).toBe(outcome === "failed" ? overload : undefined)
            else while (!(await reader.next()).done) {}
            expect(await long.calls()).toMatchObject([{ status: outcome }])
            expect(started).toEqual(["initial", "long", "peer"])
            expect(disposed.toSorted()).toEqual(["initial", "long", "peer"])
          } finally {
            finish.resolve()
            abort.abort()
            await ending
            await reader.return?.()
            await AgentTurn.stop()
          }
        },
      }),
    )
  },
  20_000,
)
