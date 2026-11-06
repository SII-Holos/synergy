import { expect, spyOn, test } from "bun:test"
import { PrimaryAgentIdentity } from "@ericsanchezok/synergy-harness/agent/primary-identity"
import { Identifier } from "@ericsanchezok/synergy-harness/id/id"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { SessionInbox } from "@ericsanchezok/synergy-harness/session/inbox"
import { SessionInvoke } from "@ericsanchezok/synergy-harness/session/invoke"
import { SessionLifecycle } from "@ericsanchezok/synergy-harness/session/lifecycle"
import { SessionManager } from "@ericsanchezok/synergy-harness/session/manager"
import { SessionRecovery } from "@ericsanchezok/synergy-harness/session/recovery"
import { Bus } from "@ericsanchezok/synergy-harness/bus"
import { SessionEvent } from "@ericsanchezok/synergy-harness/session/event"
import { RolloutLedger } from "@ericsanchezok/synergy-harness/session/rollout/ledger"
import { RolloutLifecycle } from "@ericsanchezok/synergy-harness/session/rollout/lifecycle"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import { resumeSession } from "@ericsanchezok/synergy-local-runtime/session-api"
import { BlueprintLoopStore } from "@ericsanchezok/synergy-blueprint/blueprint/loop-store"
import { NoteStore } from "@ericsanchezok/synergy-note"
import { testRuntime } from "../support/runtime"

function completion(message: Record<string, unknown>, stream: boolean, finish: string) {
  const base = { id: "resume-fixture", created: 0, model: "model" }
  const usage = { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 }
  if (!stream)
    return Response.json({
      ...base,
      object: "chat.completion",
      choices: [{ index: 0, message, finish_reason: finish }],
      usage,
    })
  return new Response(
    [
      { choices: [{ index: 0, delta: message, finish_reason: null }] },
      { choices: [{ index: 0, delta: {}, finish_reason: finish }], usage },
    ]
      .map((part) => `data: ${JSON.stringify({ ...base, object: "chat.completion.chunk", ...part })}\n\n`)
      .join("") + "data: [DONE]\n\n",
    { headers: { "content-type": "text/event-stream" } },
  )
}

for (const blueprint of [false, true])
  for (const phase of ["live", "paused", "queued", "consumed"] as const) {
    test(`${blueprint ? "BlueprintLoop" : "ordinary task"} continues once with retained evidence from ${phase}`, async () => {
      const requests: unknown[] = []
      using provider = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        async fetch(request) {
          const body = (await request.json()) as {
            stream?: boolean
            input?: string[]
            tools?: Array<{ function: { name: string } }>
          }
          if (new URL(request.url).pathname === "/embeddings")
            return Response.json({
              object: "list",
              model: "embedding",
              data: (body.input ?? []).map((_, index) => ({
                object: "embedding",
                index,
                embedding: [1, ...Array(383).fill(0)],
              })),
              usage: { prompt_tokens: 1, total_tokens: 1 },
            })
          if (!body.tools?.some((tool) => tool.function.name === "question"))
            return completion({ role: "assistant", content: "Fixture metadata" }, !!body.stream, "stop")
          requests.push(body)
          if (!blueprint)
            return completion({ role: "assistant", content: "Recovered original task" }, !!body.stream, "stop")
          return completion(
            {
              role: "assistant",
              tool_calls: [
                {
                  index: 0,
                  id: `pause_${requests.length}`,
                  type: "function",
                  function: {
                    name: "blueprint_loop_stop",
                    arguments: JSON.stringify({ action: "pause", summary: "Recovered loop; awaiting fixture input" }),
                  },
                },
              ],
            },
            !!body.stream,
            "tool_calls",
          )
        },
      })
      await using home = await tmpdir()
      await using repository = await tmpdir({ git: true })
      const env = {
        SYNERGY_CONFIG_CONTENT: JSON.stringify({
          model: "fixture/model",
          nano_model: "fixture/model",
          mini_model: "fixture/model",
          controlProfile: "full_access",
          anima: { enabled: false },
          library: { memory: { enabled: false }, experience: { retrieve: false, encode: false } },
          embedding: { apiKey: "fixture", baseURL: provider.url.toString(), model: "embedding" },
          provider: {
            fixture: {
              npm: "@ai-sdk/openai-compatible",
              env: [],
              options: { apiKey: "fixture", baseURL: provider.url.toString() },
              models: { model: { name: "Fixture", tool_call: true, limit: { context: 128000, output: 4096 } } },
            },
          },
        }),
      }
      let runtime = await testRuntime({ home: home.path, env })
      try {
        const saved = await runtime.run(async () =>
          ScopeContext.provide({
            scope: await repository.scope(),
            fn: async () => {
              using schedule = spyOn(SessionManager, "scheduleWake").mockImplementation(() => {})
              const session = await Session.create({})
              const item = await SessionInbox.enqueueUser({
                sessionID: session.id,
                agent: PrimaryAgentIdentity.names.general,
                parts: [{ type: "text", text: "Resume the saved fixture task" }],
              })
              await SessionInbox.materializeNextTask(session.id)
              const owner = RolloutLifecycle.owner(session)
              const segment = await RolloutLedger.beginSegment({ owner, runID: item.messageID, input: {} })
              await RolloutLedger.finishSegment(segment, "failed")
              await RolloutLedger.finishRun(owner, item.messageID, "failed")
              const failedID = Identifier.ascending("message")
              await Session.updateMessage({
                id: failedID,
                sessionID: session.id,
                role: "assistant",
                parentID: item.messageID,
                rootID: item.messageID,
                agent: PrimaryAgentIdentity.names.general,
                mode: PrimaryAgentIdentity.names.general,
                providerID: "fixture",
                modelID: "model",
                path: { cwd: repository.path, root: repository.path },
                time: { created: Date.now(), completed: Date.now() },
                finish: "error",
                error: {
                  name: "UnknownError",
                  data: {
                    message:
                      "ProviderRecoveryTimeoutError: Provider recovery did not complete within the waiting limit. Try again later.",
                  },
                },
                cost: 0,
                tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
              })
              let loopID: string | undefined
              if (blueprint) {
                const note = await NoteStore.create({ title: "Recovery fixture", kind: "blueprint", blueprint: {} })
                const loop = await BlueprintLoopStore.create({
                  noteID: note.id,
                  noteVersion: note.version,
                  title: note.title,
                  sessionID: session.id,
                  runMode: "current",
                  executionAgent: PrimaryAgentIdentity.names.general,
                  model: { providerID: "fixture", modelID: "model" },
                })
                loopID = loop.id
                await BlueprintLoopStore.updateStatus(session.scope.id, loop.id, { status: "running" })
                await Session.update(session.id, (draft) => {
                  draft.blueprint = { loopID: loop.id, loopRole: "execution", source: "user" }
                })
              }
              await SessionLifecycle.pause({ sessionID: session.id, reason: "failed" })
              if (phase === "queued" || phase === "consumed") {
                await resumeSession({ sessionID: session.id, requestID: "before-restart" })
                if (phase === "consumed") {
                  const [queued] = await SessionInbox.peekSteer(session.id)
                  await SessionInbox.materializeItem(queued!, item.messageID, { guiding: true })
                }
              }
              return { session, failedID, rootID: item.messageID, loopID }
            },
          }),
        )
        if (phase !== "live") {
          await runtime.close()
          runtime = await testRuntime({ home: home.path, env })
        }
        await runtime.run(async () =>
          ScopeContext.provide({
            scope: await repository.scope(),
            fn: async () => {
              await SessionInvoke.reconcilePausedSessions(saved.session.scope.id)
              const restored = await Session.get(saved.session.id)
              expect(restored.working?.status).toBe("paused")
              expect((await SessionRecovery.recoverableStatuses(restored.scope.id))[restored.id]?.type).toBe("paused")
              expect(requests).toHaveLength(0)
              const completed = Promise.withResolvers<void>()
              const unsubscribe = Bus.subscribe(SessionEvent.RootCompleted, (event) => {
                if (event.properties.sessionID === restored.id && event.properties.rootID === saved.rootID)
                  completed.resolve()
              })
              const input = { sessionID: restored.id, requestID: "resume-click", pausedSince: restored.paused!.since }
              const [accepted, duplicate] = await Promise.all([resumeSession(input), resumeSession(input)])
              expect(accepted.outcome).toBe("accepted")
              expect(duplicate.outcome).toBe("already_accepted")
              await SessionManager.wake(restored.id).catch(async (error: unknown) => {
                if ((await Session.get(restored.id)).paused?.reason !== "workflow") throw error
              })
              await SessionManager.waitForIdle(restored.id)
              try {
                if (!blueprint) await completed.promise
              } finally {
                unsubscribe()
              }
              expect(requests).toHaveLength(1)
              const messages = await Session.messages({ sessionID: restored.id })
              expect(messages.filter((message) => message.info.role === "user" && message.info.isRoot)).toHaveLength(1)
              expect(messages.find((message) => message.info.id === saved.failedID)?.info).toMatchObject({
                finish: "error",
              })
              expect(messages.at(-1)?.info).toMatchObject({ role: "assistant", rootID: saved.rootID })
              const current = await Session.get(restored.id)
              expect(current.resume?.state).toBe("consumed")
              if (saved.loopID) {
                expect(current.paused?.reason).toBe("workflow")
                expect((await BlueprintLoopStore.get(current.scope.id, saved.loopID)).status).toBe("running")
              } else {
                expect(current.paused).toBeUndefined()
                expect(current.working).toBeUndefined()
                expect((await RolloutLedger.getRun(RolloutLifecycle.owner(current), saved.rootID)).status).toBe(
                  "completed",
                )
              }
            },
          }),
        )
      } finally {
        await runtime.close()
      }
    }, 30_000)
  }
