import { expect, spyOn, test } from "bun:test"
import { BlueprintLoopStore } from "@ericsanchezok/synergy-blueprint/blueprint/loop-store"
import { BlueprintLoopService } from "@ericsanchezok/synergy-blueprint/blueprint/service"
import { Bus } from "@ericsanchezok/synergy-harness/bus"
import { PrimaryAgentIdentity } from "@ericsanchezok/synergy-harness/agent/primary-identity"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { SessionAbort } from "@ericsanchezok/synergy-harness/session/abort"
import { SessionDrive } from "@ericsanchezok/synergy-harness/session/drive"
import { SessionEvent } from "@ericsanchezok/synergy-harness/session/event"
import { SessionInvoke } from "@ericsanchezok/synergy-harness/session/invoke"
import { SessionLifecycle } from "@ericsanchezok/synergy-harness/session/lifecycle"
import { SessionManager } from "@ericsanchezok/synergy-harness/session/manager"
import { SessionToolContext } from "@ericsanchezok/synergy-harness/session/tool-context"
import type { MessageV2 } from "@ericsanchezok/synergy-harness/session/message-v2"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import { Question } from "@ericsanchezok/synergy-local-runtime/question"
import { continueSession, submitInput } from "@ericsanchezok/synergy-local-runtime/session-api"
import { NoteStore } from "@ericsanchezok/synergy-note"
import { testRuntime } from "../support/runtime"

type ProviderRequest = {
  stream?: boolean
  messages: Array<{ role: string; tool_call_id?: string; content?: unknown }>
  tools?: Array<{ function: { name: string; parameters: { properties?: Record<string, unknown> } } }>
}

type Scenario =
  | "text"
  | "question-wait"
  | "question-timeout"
  | "self-abort"
  | "blueprint-pause"
  | "blueprint-start-pause"
  | "pause-hook-error"
  | "pause-concurrent-input"
  | "pause-sibling-hook-error"
  | "pause-concurrent-self-abort"

const blocker = "External execution is not authorized. I cannot continue; waiting for user authorization."
const question = {
  questions: [
    {
      question: "Execution is not authorized. What should happen next?",
      header: "Blocked",
      options: [{ label: "Keep waiting", description: "Do not authorize execution." }],
    },
  ],
}

function completion(message: Record<string, unknown>, stream: boolean, finishReason: string) {
  const envelope = { id: "blocker-fixture", created: 0, model: "model" }
  const usage = { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 }
  if (!stream)
    return Response.json({
      ...envelope,
      object: "chat.completion",
      choices: [{ index: 0, message, finish_reason: finishReason }],
      usage,
    })
  return new Response(
    [
      { choices: [{ index: 0, delta: message, finish_reason: null }] },
      { choices: [{ index: 0, delta: {}, finish_reason: finishReason }], usage },
    ]
      .map((frame) => `data: ${JSON.stringify({ ...envelope, object: "chat.completion.chunk", ...frame })}\n\n`)
      .join("") + "data: [DONE]\n\n",
    { headers: { "content-type": "text/event-stream" } },
  )
}

async function probe(scenario: Scenario, verify: (probe: Probe) => Promise<void>) {
  const pausesBlueprint = !["text", "question-wait", "question-timeout", "self-abort"].includes(scenario)
  const requests: ProviderRequest[] = []
  const failures: string[] = []
  const held = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  let sessionID = ""
  let closing = false
  using provider = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      try {
        const pathname = new URL(request.url).pathname
        if (pathname === "/embeddings") {
          const body = (await request.json()) as { input: string[] }
          return Response.json({
            object: "list",
            model: "embedding",
            data: body.input.map((_, index) => ({ object: "embedding", index, embedding: [1, ...Array(383).fill(0)] })),
            usage: { prompt_tokens: 1, total_tokens: 1 },
          })
        }
        if (pathname !== "/chat/completions") throw new Error(`Unexpected fixture route: ${pathname}`)
        const body = (await request.json()) as ProviderRequest
        if (!body.tools?.some((tool) => tool.function.name === "question"))
          return completion({ role: "assistant", content: "Fixture auxiliary response" }, !!body.stream, "stop")
        if (closing) throw new Error("A primary request arrived after fixture shutdown")
        requests.push(body)
        const holdAt = scenario === "text" ? 4 : scenario === "question-wait" ? 2 : 3
        if (requests.length >= holdAt) {
          held.resolve()
          await release.promise
        }
        if (requests.length === 1 && scenario !== "text") {
          const name =
            scenario === "self-abort" ? "session_control" : pausesBlueprint ? "blueprint_loop_stop" : "question"
          if (!body.tools.some((tool) => tool.function.name === name)) throw new Error(`Missing actual tool: ${name}`)
          return completion(
            {
              role: "assistant",
              tool_calls: [
                ...(scenario === "pause-sibling-hook-error"
                  ? [
                      {
                        index: 1,
                        id: "sibling_question",
                        type: "function",
                        function: { name: "question", arguments: JSON.stringify(question) },
                      },
                    ]
                  : []),
                ...(scenario === "pause-concurrent-self-abort"
                  ? [
                      {
                        index: 1,
                        id: "sibling_abort",
                        type: "function",
                        function: {
                          name: "session_control",
                          arguments: JSON.stringify({ action: "abort", target: sessionID }),
                        },
                      },
                    ]
                  : []),
                {
                  index: 0,
                  id: "blocker_action",
                  type: "function",
                  function: {
                    name,
                    arguments: JSON.stringify(
                      scenario === "self-abort"
                        ? { action: "abort", target: sessionID }
                        : pausesBlueprint
                          ? { action: "pause", summary: blocker }
                          : question,
                    ),
                  },
                },
              ],
            },
            !!body.stream,
            "tool_calls",
          )
        }
        return completion({ role: "assistant", content: blocker }, !!body.stream, "stop")
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        failures.push(message)
        return Response.json({ error: { message, type: "fixture_protocol_error" } }, { status: 400 })
      }
    },
  })
  await using runtime = await testRuntime({
    env: {
      SYNERGY_CONFIG_CONTENT: JSON.stringify({
        model: "fixture/model",
        nano_model: "fixture/model",
        mini_model: "fixture/model",
        controlProfile: "full_access",
        anima: { enabled: false },
        library: { memory: { enabled: false }, experience: { retrieve: false, encode: false } },
        question: { timeout: scenario === "question-timeout" ? 1 : 0 },
        embedding: { apiKey: "fixture", baseURL: provider.url.toString(), model: "embedding" },
        provider: {
          fixture: {
            name: "Blocker fixture",
            npm: "@ai-sdk/openai-compatible",
            env: [],
            models: { model: { name: "Fixture", tool_call: true, limit: { context: 128000, output: 4096 } } },
            options: { apiKey: "fixture", baseURL: provider.url.toString() },
          },
        },
      }),
    },
  })
  await runtime.run(async () => {
    await using repository = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await repository.scope(),
      fn: async () => {
        const session = await Session.create({ title: `Blueprint blocker: ${scenario}` })
        sessionID = session.id
        const note = await NoteStore.create({ title: "Authorization blocker", kind: "blueprint", blueprint: {} })
        const loop = await BlueprintLoopStore.create({
          noteID: note.id,
          noteVersion: note.version,
          title: note.title,
          sessionID,
          runMode: "current",
          executionAgent: PrimaryAgentIdentity.names.general,
          model: { providerID: "fixture", modelID: "model" },
        })
        if (scenario !== "blueprint-start-pause") {
          await BlueprintLoopStore.updateStatus(session.scope.id, loop.id, { status: "running" })
          await Session.update(sessionID, (draft) => {
            draft.blueprint = { loopID: loop.id, loopRole: "execution", source: "user" }
          })
        }
        const idle = Promise.withResolvers<void>()
        const unsubscribeIdle = Bus.subscribe(SessionEvent.Idle, (event) => {
          if (event.properties.sessionID === sessionID) idle.resolve()
        })
        const asked = Promise.withResolvers<Question.Request>()
        const unsubscribe = Bus.subscribe(Question.Event.Asked, (event) => {
          if (event.properties.sessionID === sessionID) asked.resolve(event.properties)
        })
        const hooks = SessionToolContext.plugin()!
        const originalHook = hooks.triggerToolHooks
        const pauseWindow = Promise.withResolvers<void>()
        const finishPause = Promise.withResolvers<void>()
        const startSelfAbort = Promise.withResolvers<void>()
        const selfAbortEntered = Promise.withResolvers<void>()
        const selfAbortFinished = Promise.withResolvers<void>()
        const originalAbort = SessionAbort.abort
        const observeAbort =
          scenario === "pause-concurrent-self-abort"
            ? spyOn(SessionAbort, "abort").mockImplementation((...args) => {
                selfAbortEntered.resolve()
                const operation = originalAbort(...args)
                void operation.then(
                  () => selfAbortFinished.resolve(),
                  () => selfAbortFinished.resolve(),
                )
                return operation
              })
            : undefined
        if (
          scenario === "pause-hook-error" ||
          scenario === "pause-concurrent-input" ||
          scenario === "pause-sibling-hook-error" ||
          scenario === "pause-concurrent-self-abort"
        ) {
          hooks.triggerToolHooks = async (point, input, output, options) => {
            if (
              scenario === "pause-concurrent-self-abort" &&
              point === "tool.execute.before" &&
              typeof input === "object" &&
              input !== null &&
              "tool" in input &&
              input.tool === "session_control"
            )
              await startSelfAbort.promise
            if (
              point === "tool.execute.after" &&
              typeof input === "object" &&
              input !== null &&
              "tool" in input &&
              input.tool === "blueprint_loop_stop"
            ) {
              if (scenario === "pause-sibling-hook-error") await asked.promise
              if (scenario === "pause-hook-error" || scenario === "pause-sibling-hook-error")
                throw new Error("Injected pause result hook failure")
              pauseWindow.resolve()
              await finishPause.promise
            }
            return originalHook(point, input, output, options)
          }
        }
        const invocation =
          scenario === "blueprint-start-pause"
            ? BlueprintLoopService.start(session.scope.id, loop.id).then(() => idle.promise)
            : SessionInvoke.invoke({
                sessionID,
                agent: PrimaryAgentIdentity.names.general,
                model: { providerID: "fixture", modelID: "model" },
                tools: { "*": false, question: true, session_control: true, blueprint_loop_stop: true },
                parts: [
                  { type: "text", text: "Implement the Blueprint, but do not execute anything without authorization." },
                ],
              })
        const settled = invocation.then(
          () => undefined,
          (error: unknown) => error,
        )
        try {
          await verify({
            sessionID,
            requests,
            held: held.promise,
            asked: asked.promise,
            settled,
            pauseWindow: pauseWindow.promise,
            finishPause: () => finishPause.resolve(),
            startSelfAbort: () => startSelfAbort.resolve(),
            selfAbortEntered: selfAbortEntered.promise,
            selfAbortFinished: selfAbortFinished.promise,
            resume: () => continueSession(sessionID),
            messages: () => Session.messages({ sessionID }),
            loop: () => BlueprintLoopStore.get(session.scope.id, loop.id),
            stop: () => SessionAbort.abort(sessionID),
          })
          expect(failures).toEqual([])
        } finally {
          finishPause.resolve()
          startSelfAbort.resolve()
          observeAbort?.mockRestore()
          closing = true
          unsubscribe()
          unsubscribeIdle()
          hooks.triggerToolHooks = originalHook
          await SessionAbort.abort(sessionID)
          release.resolve()
          await settled
          await SessionManager.waitForIdle(sessionID)
        }
      },
    })
  })
}

test(
  "a durable pause still stops the current loop when a result hook prevents afterPersist",
  () =>
    probe("pause-hook-error", async (probe) => {
      await probe.settled
      await SessionManager.waitForIdle(probe.sessionID)
      const pause = tools(await probe.messages()).find((part) => part.tool === "blueprint_loop_stop")
      expect(pause?.state.status).toBe("error")
      if (pause?.state.status !== "error") throw new Error("The injected failure was not preserved")
      expect(pause.state.error).toContain("Injected pause result hook failure")
      expect(probe.requests).toHaveLength(1)
      expect(continuations(await probe.messages())).toHaveLength(0)
      expect(await SessionLifecycle.snapshot(probe.sessionID)).toMatchObject({
        reason: "workflow",
        description: blocker,
      })
    }),
  30_000,
)

type Probe = {
  sessionID: string
  requests: ProviderRequest[]
  held: Promise<void>
  asked: Promise<Question.Request>
  settled: Promise<unknown>
  pauseWindow: Promise<void>
  finishPause: () => void
  startSelfAbort: () => void
  selfAbortEntered: Promise<void>
  selfAbortFinished: Promise<void>
  resume: () => ReturnType<typeof continueSession>
  messages: () => ReturnType<typeof Session.messages>
  loop: () => ReturnType<typeof BlueprintLoopStore.get>
  stop: () => ReturnType<typeof SessionAbort.abort>
}

function continuations(messages: MessageV2.WithParts[]) {
  return messages.filter(
    (message) => message.info.role === "user" && message.info.metadata?.source === "blueprint_loop_continuation",
  )
}

function tools(messages: MessageV2.WithParts[]) {
  return messages.flatMap((message) => message.parts).filter((part): part is MessageV2.ToolPart => part.type === "tool")
}

test(
  "a textual authorization blocker is repeated through three real Blueprint continuations; host stop gates the next drive",
  () =>
    probe("text", async (probe) => {
      await probe.held
      const messages = await probe.messages()
      expect(probe.requests).toHaveLength(4)
      expect(
        messages.flatMap((message) => message.parts).filter((part) => part.type === "text" && part.text === blocker),
      ).toHaveLength(3)
      expect(continuations(messages)).toHaveLength(3)
      expect((await probe.loop()).status).toBe("running")
      expect(await SessionLifecycle.snapshot(probe.sessionID)).toBeUndefined()
      const stopSchema = probe.requests[0].tools?.find((tool) => tool.function.name === "blueprint_loop_stop")
      expect(stopSchema?.function.parameters.properties).toHaveProperty("summary")
      expect(stopSchema?.function.parameters.properties).not.toHaveProperty("status")

      expect((await probe.stop()).paused).toBe(true)
      await SessionManager.waitForIdle(probe.sessionID)
      expect(SessionManager.isRunning(probe.sessionID)).toBe(false)
      expect(await SessionLifecycle.snapshot(probe.sessionID)).toMatchObject({ reason: "aborted" })
      expect((await probe.loop()).status).toBe("running")
      expect(await SessionDrive.request(probe.sessionID, "paused automatic probe")).toBe(false)
      expect(await SessionDrive.request(probe.sessionID, "paused forced probe", { force: true })).toBe(false)
      expect(probe.requests).toHaveLength(4)
    }),
  30_000,
)

test(
  "a real pending question holds the executing session and prevents Blueprint continuations",
  () =>
    probe("question-wait", async (probe) => {
      const pending = await probe.asked
      expect((await Question.list()).some((item) => item.id === pending.id)).toBe(true)
      expect(SessionManager.isRunning(probe.sessionID)).toBe(true)
      expect(await SessionDrive.request(probe.sessionID, "pending question probe")).toBe(false)
      expect(await SessionDrive.request(probe.sessionID, "pending forced probe", { force: true })).toBe(false)
      expect(probe.requests).toHaveLength(1)
      expect(continuations(await probe.messages())).toHaveLength(0)
      expect((await probe.loop()).status).toBe("running")
      expect(await SessionLifecycle.snapshot(probe.sessionID)).toBeUndefined()
    }),
  30_000,
)

test(
  "a configured question timeout releases the wait and the authorization blocker receives another Blueprint continuation",
  () =>
    probe("question-timeout", async (probe) => {
      await probe.held
      const question = tools(await probe.messages()).find((part) => part.tool === "question")
      expect(question?.state).toMatchObject({ status: "completed", metadata: { timedOut: true, timeout: 1 } })
      expect(
        JSON.stringify(probe.requests[1].messages.find((message) => message.tool_call_id === "blocker_action")),
      ).toContain("Use your best judgment to proceed")
      expect(probe.requests).toHaveLength(3)
      expect(continuations(await probe.messages())).toHaveLength(1)
      expect((await probe.loop()).status).toBe("running")
      expect(await SessionLifecycle.snapshot(probe.sessionID)).toBeUndefined()
    }),
  30_000,
)

test(
  "a running executor's real self-abort stops without reacquiring its own lease",
  () =>
    probe("self-abort", async (probe) => {
      await probe.settled
      await SessionManager.waitForIdle(probe.sessionID)
      const control = tools(await probe.messages()).find((part) => part.tool === "session_control")
      expect(control?.state.status).toBe("error")
      if (control?.state.status !== "error") throw new Error("Self-abort did not produce an error ToolPart")
      expect(control.state.error).not.toContain("busy")
      expect(probe.requests).toHaveLength(1)
      expect(continuations(await probe.messages())).toHaveLength(0)
      expect((await probe.loop()).status).toBe("running")
      expect(await SessionLifecycle.snapshot(probe.sessionID)).toMatchObject({ reason: "aborted" })
    }),
  30_000,
)

for (const scenario of ["blueprint-pause", "blueprint-start-pause"] as const)
  test(
    `${scenario} persists a successful tool result, blocks automatic wakeups, and resumes only after Continue`,
    () =>
      probe(scenario, async (probe) => {
        await probe.settled
        await SessionManager.waitForIdle(probe.sessionID)
        const messages = await probe.messages()
        const pause = tools(messages).find((part) => part.tool === "blueprint_loop_stop")
        expect(pause?.state).toMatchObject({
          status: "completed",
          metadata: { pauseRequested: true, reviewRequested: false },
        })
        expect(probe.requests).toHaveLength(1)
        expect(continuations(messages)).toHaveLength(0)
        expect(await SessionLifecycle.snapshot(probe.sessionID)).toMatchObject({
          reason: "workflow",
          description: blocker,
        })
        const loop = await probe.loop()
        expect(loop.status).toBe("running")
        expect(loop.stopRequest).toBeUndefined()
        expect(loop.auditTaskID).toBeUndefined()
        expect(await SessionDrive.request(probe.sessionID, "late wakeup")).toBe(false)
        expect(await SessionDrive.request(probe.sessionID, "forced wakeup", { force: true })).toBe(false)

        expect(await probe.resume()).toBe(true)
        await probe.held
        expect(await SessionLifecycle.snapshot(probe.sessionID)).toBeUndefined()
        expect(probe.requests).toHaveLength(3)
        expect(tools(await probe.messages()).filter((part) => part.tool === "blueprint_loop_stop")).toHaveLength(1)
        const root = messages.find((message) => message.info.role === "user" && message.info.isRoot)?.info.id
        if (!root) throw new Error("The resumed fixture lost its original task root")
        expect(
          (await probe.messages())
            .filter((message) => message.info.role === "user" && message.info.isRoot)
            .map((message) => message.info.id),
        ).toEqual([root])
      }),
    30_000,
  )
for (const scenario of ["pause-concurrent-input", "pause-concurrent-self-abort"] as const)
  test(
    `${scenario}: user input takes over without a cancelled old abort pausing it again`,
    () =>
      probe(scenario, async (probe) => {
        await probe.pauseWindow
        const waiting = Promise.withResolvers<void>()
        const interrupted = Promise.withResolvers<never>()
        const originalWait = SessionManager.waitForIdle
        const observe = spyOn(SessionManager, "waitForIdle").mockImplementation(async (sessionID) => {
          if (sessionID === probe.sessionID) waiting.resolve()
          await Promise.race([originalWait(sessionID), interrupted.promise])
        })
        const timer = setTimeout(
          () => interrupted.reject(new Error("User input deadlocked with pause settlement")),
          10_000,
        )
        const admission = submitInput({
          sessionID: probe.sessionID,
          parts: [{ type: "text", text: "I am back. Continue this task." }],
        })
        try {
          await waiting.promise
          expect(SessionManager.isRunning(probe.sessionID)).toBe(true)
          expect((await SessionLifecycle.snapshot(probe.sessionID))?.reason).toBe("workflow")
          if (scenario === "pause-concurrent-self-abort") {
            probe.startSelfAbort()
            await probe.selfAbortEntered
          }
          probe.finishPause()
          expect((await admission).status).toBe("queued")
          if (scenario === "pause-concurrent-self-abort") await probe.selfAbortFinished
          expect(await SessionLifecycle.snapshot(probe.sessionID)).toBeUndefined()
          await probe.held
          expect(probe.requests).toHaveLength(3)
          expect(tools(await probe.messages()).filter((part) => part.tool === "blueprint_loop_stop")).toHaveLength(1)
        } finally {
          clearTimeout(timer)
          probe.finishPause()
          observe.mockRestore()
          await admission.catch(() => undefined)
        }
      }),
    30_000,
  )

test(
  "a failed pause receipt cancels a same-batch waiting question before user takeover can stall",
  () =>
    probe("pause-sibling-hook-error", async (probe) => {
      await probe.asked
      let rescued = false
      const timer = setTimeout(() => {
        rescued = true
        SessionInvoke.cancel(probe.sessionID, { pauseTurn: true })
      }, 2_000)
      try {
        await probe.settled
        await SessionManager.waitForIdle(probe.sessionID)
        expect(rescued).toBe(false)
        expect(probe.requests).toHaveLength(1)
        expect((await Question.list()).filter((item) => item.sessionID === probe.sessionID)).toHaveLength(0)
        const parts = tools(await probe.messages())
        expect(parts).toHaveLength(2)
        expect(parts.every((part) => part.state.status === "error")).toBe(true)
        expect(await SessionLifecycle.snapshot(probe.sessionID)).toMatchObject({
          reason: "workflow",
          description: blocker,
        })
      } finally {
        clearTimeout(timer)
      }
    }),
  30_000,
)
