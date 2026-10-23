import { composeWithExperiments } from "../support/selected-components"
import { expect, test } from "bun:test"
import type { Provider as SDK } from "ai"
import { RuntimeComponents } from "@ericsanchezok/synergy-harness/lifecycle"
import { testRuntime } from "@ericsanchezok/synergy-harness/test/support/runtime"
import { runtimeHome } from "@ericsanchezok/synergy-harness/test/support/runtime-home"
import { Scope } from "@ericsanchezok/synergy-harness/scope"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { SessionInbox } from "@ericsanchezok/synergy-harness/session/inbox"
import { SessionInvoke } from "@ericsanchezok/synergy-harness/session/invoke"
import { SessionAbort } from "@ericsanchezok/synergy-harness/session/abort"
import { SessionLifecycle } from "@ericsanchezok/synergy-harness/session/lifecycle"
import { SessionExecutionOwners } from "@ericsanchezok/synergy-harness/session/execution-owners"
import { ContinuationKernel } from "@ericsanchezok/synergy-harness/session/continuation-kernel"
import { MessageV2 } from "@ericsanchezok/synergy-harness/session/message-v2"
import { RolloutLifecycle } from "@ericsanchezok/synergy-harness/session/rollout/lifecycle"
import { RolloutLedger } from "@ericsanchezok/synergy-harness/session/rollout/ledger"
import { Provider } from "@ericsanchezok/synergy-harness/provider/provider"
import { ProviderCatalogSource } from "@ericsanchezok/synergy-harness/provider/catalog-source"
import { ProviderSdkSource } from "@ericsanchezok/synergy-harness/provider/sdk-source"
import { ProviderRequestSource } from "@ericsanchezok/synergy-harness/provider/request-source"
import { ConfigSource } from "@ericsanchezok/synergy-harness/config/source"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { Identifier } from "@ericsanchezok/synergy-harness/id/id"
import { localRuntime } from "@ericsanchezok/synergy-local-runtime/component"
import { continueSession } from "@ericsanchezok/synergy-local-runtime/session-api"
import { Agent } from "@ericsanchezok/synergy-harness/agent/agent"
import { PrimaryAgentIdentity } from "@ericsanchezok/synergy-harness/agent/primary-identity"
import { boss } from "@ericsanchezok/synergy-boss/component"
import { library } from "@ericsanchezok/synergy-library/component"
import { agenda } from "@ericsanchezok/synergy-agenda/component"
import { lightLoop } from "@ericsanchezok/synergy-light-loop/component"
import { server } from "@ericsanchezok/synergy-server/component"
import { Server } from "@ericsanchezok/synergy-server/server/server"
import { createSynergyClient } from "@ericsanchezok/synergy-sdk/client"

const model = { providerID: "fixture", modelID: "chat" }
const retainedInstructions = "RETAINED_WORKFLOW_MUST_NOT_OWN_THE_NEW_TASK"
const workflow = { kind: "lightloop" as const, instructions: retainedInstructions }

function within<T>(fn: () => Promise<T>) {
  return ScopeContext.provide({ scope: Scope.home(), fn })
}

function client() {
  const app = Server.App()
  const transport = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) =>
      app.fetch(input instanceof Request ? input : new Request(input, init)),
    { preconnect() {} },
  )
  return createSynergyClient({ baseUrl: "http://independent.test", fetch: transport })
}

function provider() {
  const started = Promise.withResolvers<void>()
  const prompts: string[] = []
  const roots: string[] = []
  let interrupt = false
  const catalog = Provider.fromModelsDevProvider({
    id: "fixture",
    name: "Fixture",
    env: [],
    npm: "fixture-sdk",
    api: "https://example.invalid",
    models: Object.fromEntries(
      ["chat", "helper"].map((id) => [
        id,
        {
          id,
          name: id,
          release_date: "2026-01-01",
          attachment: false,
          reasoning: false,
          temperature: false,
          tool_call: true,
          limit: { context: 32000, output: 8000 },
          options: {},
        },
      ]),
    ),
  })
  const factory: ProviderSdkSource.Factory = () =>
    ({
      languageModel: (modelID: string) => ({
        specificationVersion: "v2",
        provider: "fixture",
        modelId: modelID,
        supportedUrls: {},
        async doGenerate() {
          throw new Error("Only streaming is supported")
        },
        async doStream(input: { prompt: unknown; abortSignal?: AbortSignal }) {
          if (modelID === "chat") prompts.push(JSON.stringify(input.prompt))
          return {
            stream: new ReadableStream({
              start(output) {
                if (modelID === "chat" && interrupt) {
                  interrupt = false
                  input.abortSignal?.addEventListener("abort", () => output.error(input.abortSignal?.reason), {
                    once: true,
                  })
                  output.enqueue({ type: "text-start", id: "text" })
                  output.enqueue({ type: "text-delta", id: "text", delta: "Working on the independent request" })
                  started.resolve()
                  return
                }
                output.enqueue({ type: "text-start", id: "text" })
                output.enqueue({ type: "text-delta", id: "text", delta: "Independent request completed" })
                output.enqueue({ type: "text-end", id: "text" })
                output.enqueue({
                  type: "finish",
                  finishReason: "stop",
                  usage: { inputTokens: 2, outputTokens: 3, totalTokens: 5 },
                })
                output.close()
              },
            }),
          }
        },
      }),
    }) as unknown as SDK
  return {
    started: started.promise,
    prompts,
    roots,
    interruptNext() {
      interrupt = true
    },
    register() {
      ProviderCatalogSource.register({ providers: async () => ({ fixture: catalog }) })
      ProviderSdkSource.register(undefined)
      ProviderSdkSource.register({ load: async () => factory, loadSync: () => factory })
      ProviderRequestSource.register({
        prepare: async ({ user, model }) => {
          if (model.id === "chat") roots.push(user.id)
          return { key: "fixture-key" }
        },
      })
      ConfigSource.register({
        resolve: async () => ({
          model: "fixture/chat",
          small_model: "fixture/helper",
          agent: { title: { model: "fixture/helper" } },
          compaction: { auto: false },
        }),
      })
    },
  }
}

for (const materializeBeforeReinstall of [true, false]) {
  test(`independent admission survives ${materializeBeforeReinstall ? "materialize then reinstall" : "reinstall then materialize"}, interruption and Continue`, async () => {
    await using home = await runtimeHome()
    const modelFixture = provider()
    const open = (installed: boolean) =>
      testRuntime({
        home: home.host.home,
        composition: {
          register: composeWithExperiments([
            localRuntime({ workers: false, environment: false }),
            server(),
            ...(installed ? [lightLoop()] : []),
          ]).register,
        },
        register: modelFixture.register,
      })
    let sessionID = ""
    let oldRootID = ""
    let newRootID = ""
    let humanReply: MessageV2.WithParts
    let materializedControl: MessageV2.WithParts
    let pending: SessionInbox.StoredItem
    let previousRun: Awaited<ReturnType<typeof RolloutLedger.getRun>>
    {
      await using runtime = await open(true)
      await runtime.run(() =>
        within(async () => {
          const session = await Session.create({ title: "Independent task recovery" })
          sessionID = session.id
          const original = await SessionInbox.enqueueUser({
            sessionID,
            model,
            parts: [{ type: "text", text: "Original human task" }],
          })
          oldRootID = original.messageID
          await SessionInbox.materializeNextTask(sessionID)
          await RolloutLifecycle.configuration(session, oldRootID)
          await RolloutLedger.finishRun(RolloutLifecycle.owner(session), oldRootID, "interrupted", {
            detectedAt: Date.now(),
          })
          previousRun = await RolloutLedger.getRun(RolloutLifecycle.owner(session), oldRootID)
          await Session.update(sessionID, (draft) => {
            draft.workflow = workflow
          })
          const replyID = Identifier.ascending("message")
          const reply = {
            id: replyID,
            sessionID,
            role: "user" as const,
            isRoot: false,
            rootID: oldRootID,
            visible: true,
            includeInContext: true,
            origin: { type: "channel" as const },
            agent: PrimaryAgentIdentity.names.general,
            model,
            time: { created: Date.now() },
          }
          await Session.updateMessage(reply)
          await Session.updatePart({
            id: Identifier.ascending("part"),
            sessionID,
            messageID: replyID,
            type: "text",
            origin: "user",
            text: "HUMAN_CHANNEL_REPLY",
          })
          await Session.updatePart({
            id: Identifier.ascending("part"),
            sessionID,
            messageID: replyID,
            type: "attachment",
            mime: "text/plain",
            filename: "reference.txt",
            url: "https://example.invalid/reference.txt",
            model: { mode: "content", text: "HUMAN_ATTACHMENT_CONTENT" },
          })
          humanReply = await MessageV2.get({ sessionID, messageID: replyID })
          const control = await SessionInbox.deliver({
            sessionID,
            mode: "steer",
            message: {
              role: "user",
              origin: { type: "system" },
              metadata: { source: "light_loop_continuation" },
              parts: [{ type: "text", text: "MATERIALIZED_OWNER_CONTROL", origin: "system" }],
            },
          })
          materializedControl = (await SessionInbox.materializeItem(
            await SessionInbox.getStored(sessionID, control.itemID),
            oldRootID,
          ))!
          await SessionInbox.commitReady(sessionID, [control.itemID])
          const queued = await SessionInbox.deliver({
            sessionID,
            mode: "steer",
            message: {
              role: "user",
              metadata: { source: "light_loop_continuation" },
              parts: [{ type: "text", text: "RETAINED_OWNER_QUEUE", origin: "system" }],
            },
          })
          pending = await SessionInbox.getStored(sessionID, queued.itemID)
        }),
      )
    }
    {
      await using runtime = await open(false)
      await runtime.run(() =>
        within(async () => {
          expect(await SessionExecutionOwners.allowsResume(await Session.get(sessionID))).toBe(false)
          await expect(continueSession(sessionID)).rejects.toMatchObject({
            name: "SessionExecutionOwnerUnavailableError",
          })
          const queued = await SessionInbox.enqueueUser({
            sessionID,
            model,
            parts: [{ type: "text", text: "Independent human request" }],
          })
          newRootID = queued.messageID
          expect(await SessionInbox.getStored(sessionID, queued.id)).toMatchObject({
            execution: { version: 1, kind: "independent", previousRootID: oldRootID },
          })
          if (materializeBeforeReinstall)
            expect((await SessionInbox.materializeNextTask(sessionID)).status).toBe("materialized")
        }),
      )
    }
    {
      await using runtime = await open(true)
      await runtime.run(() =>
        within(async () => {
          if (!materializeBeforeReinstall)
            expect(await SessionExecutionOwners.allowsResume(await Session.get(sessionID))).toBe(true)
          modelFixture.interruptNext()
          const running = SessionInvoke.loop(sessionID)
          try {
            await Promise.race([
              modelFixture.started,
              running.then(() => {
                throw new Error("The new root never reached the model")
              }),
            ])
            const message = await MessageV2.get({ sessionID, messageID: newRootID })
            expect(message.info).toMatchObject({
              execution: { version: 1, kind: "independent", previousRootID: oldRootID },
            })
            expect(message.info.metadata?.workflow).toBeUndefined()
            const transported = await client().session.message({ sessionID, messageID: newRootID, scopeID: "home" })
            expect(transported.response.status).toBe(200)
            expect(transported.data?.info).toMatchObject({
              execution: { version: 1, kind: "independent", previousRootID: oldRootID },
            })
          } finally {
            await SessionAbort.abort(sessionID)
            await running
          }
          expect(await SessionLifecycle.snapshot(sessionID)).toBeDefined()
          expect(await SessionInbox.getStored(sessionID, pending.id)).toEqual(pending)
        }),
      )
    }
    {
      await using runtime = await open(true)
      await runtime.run(() =>
        within(async () => {
          const session = await Session.get(sessionID)
          expect(await SessionExecutionOwners.allowsResume(session)).toBe(true)
          expect(await continueSession(sessionID)).toBe(true)
          expect(await SessionInbox.latestRootID(sessionID)).toBe(newRootID)
          expect(await ContinuationKernel.propose(sessionID)).toBeUndefined()
          expect(modelFixture.roots.length).toBeGreaterThanOrEqual(2)
          expect([...new Set(modelFixture.roots)]).toEqual([newRootID])
          expect(modelFixture.prompts.length).toBeGreaterThanOrEqual(2)
          for (const prompt of modelFixture.prompts) {
            expect(prompt).not.toContain(retainedInstructions)
            expect(prompt).not.toContain("<lightloop-user-request>")
            expect(prompt).not.toContain("RETAINED_OWNER_QUEUE")
            expect(prompt).not.toContain("MATERIALIZED_OWNER_CONTROL")
            expect(prompt).toContain("Original human task")
            expect(prompt).toContain("HUMAN_CHANNEL_REPLY")
            expect(prompt).toContain("HUMAN_ATTACHMENT_CONTENT")
          }
          expect(
            (await Storage.read<Record<string, unknown>>(["sessions", "home", sessionID, "info"])).workflow,
          ).toEqual(workflow)
          expect(await SessionInbox.getStored(sessionID, pending.id)).toEqual(pending)
          expect(await MessageV2.get({ sessionID, messageID: materializedControl.info.id })).toEqual(
            materializedControl,
          )
          expect(await MessageV2.get({ sessionID, messageID: humanReply.info.id })).toEqual(humanReply)
          expect(await RolloutLedger.getRun(RolloutLifecycle.owner(session), oldRootID)).toEqual(previousRun)
          const owner = RolloutLifecycle.owner(session)
          expect((await RolloutLedger.getRun(owner, newRootID)).execution?.status).toBe("completed")
          const settlementDeadline = Date.now() + 2000
          while ((await RolloutLedger.getRun(owner, newRootID)).status === "running" && Date.now() < settlementDeadline)
            await Bun.sleep(5)
          expect((await RolloutLedger.getRun(owner, newRootID)).status).toBe("completed")
          await Session.mergeMessageMetadata({
            sessionID,
            messageID: newRootID,
            metadata: { requiredOwners: ["unselected-owner"] },
          })
          expect(await SessionExecutionOwners.allowsResume(await Session.get(sessionID))).toBe(false)
          const next = await SessionInbox.enqueueUser({
            sessionID,
            model,
            parts: [{ type: "text", text: "A separate cancellable request" }],
          })
          expect((await SessionInbox.materializeNextTask(sessionID)).status).toBe("materialized")
          await RolloutLifecycle.configuration(session, next.messageID)
          const feedback = await SessionInbox.deliver({
            sessionID,
            mode: "steer",
            message: {
              role: "user",
              origin: { type: "user" },
              parts: [{ type: "text", text: "Ordinary follow-up", origin: "user" }],
            },
          })
          const cortex = await SessionInbox.deliver({
            sessionID,
            mode: "context",
            message: {
              role: "user",
              origin: { type: "cortex" },
              parts: [{ type: "text", text: "Delegated task result", origin: "system" }],
            },
          })
          expect((await SessionInbox.peekSteer(sessionID)).map((item) => item.id)).toEqual([feedback.itemID])
          expect((await SessionInbox.peekContext(sessionID)).map((item) => item.id)).toEqual([cortex.itemID])
          expect((await RolloutLifecycle.cancel(sessionID, next.messageID)).status).toBe("cancelled")
          expect(
            (await Storage.read<Record<string, unknown>>(["sessions", "home", sessionID, "info"])).workflow,
          ).toEqual(workflow)
          expect(await SessionInbox.getStored(sessionID, pending.id)).toEqual(pending)
        }),
      )
    }
  }, 30_000)
}

test("external metadata cannot turn an existing human root into an independent task", async () => {
  await using runtime = await testRuntime()
  await runtime.run(() =>
    within(async () => {
      const session = await Session.create({ title: "Host admission only" })
      const rootID = Identifier.ascending("message")
      await Session.updateMessage({
        id: rootID,
        sessionID: session.id,
        role: "user",
        isRoot: true,
        origin: { type: "user" },
        agent: PrimaryAgentIdentity.names.general,
        model,
        time: { created: Date.now() },
        metadata: { execution: { version: 1, kind: "independent" }, requiredOwners: [] },
      })
      await Session.updatePart({
        id: Identifier.ascending("part"),
        sessionID: session.id,
        messageID: rootID,
        type: "text",
        text: "Historical human request",
      })
      const key = ["sessions", "home", session.id, "info"]
      await Storage.write(key, { ...(await Storage.read<Record<string, unknown>>(key)), workflow })
      expect(await SessionExecutionOwners.allowsResume(await Session.get(session.id))).toBe(false)
      expect((await MessageV2.get({ sessionID: session.id, messageID: rootID })).info).not.toHaveProperty("execution")
    }),
  )
}, 30_000)

for (const delivery of ["input", "message"] as const) {
  test(`independent ${delivery} admission preserves available agents and fixes unavailable implicit choices before reinstall`, async () => {
    await using home = await runtimeHome()
    const fixture = provider()
    const open = (selected: boolean) =>
      testRuntime({
        home: home.host.home,
        composition: {
          register: composeWithExperiments([
            localRuntime({ workers: false, environment: false }),
            ...(selected ? [library(), agenda(), boss()] : []),
          ]).register,
        },
        register: fixture.register,
      })
    const records: {
      sessionID: string
      old: MessageV2.Info
      override?: string
      expected: string
      item?: SessionInbox.StoredItem
    }[] = []
    const checkFeedback = async (record: (typeof records)[number]) => {
      const feedback = await SessionInbox.enqueueUser({
        sessionID: record.sessionID,
        model,
        noReply: true,
        parts: [{ type: "text", text: "Ordinary human feedback" }],
      })
      expect(
        (
          await SessionInbox.materializeItem(
            await SessionInbox.getStored(record.sessionID, feedback.id),
            record.item!.messageID,
          )
        )?.info.agent,
      ).toBe(record.expected)
      const cortex = await SessionInbox.deliver({
        sessionID: record.sessionID,
        mode: "context",
        message: {
          role: "user",
          origin: { type: "cortex" },
          model,
          parts: [{ type: "text", origin: "system", text: "Cortex feedback" }],
        },
      })
      expect(
        (
          await SessionInbox.materializeItem(
            await SessionInbox.getStored(record.sessionID, cortex.itemID),
            record.item!.messageID,
          )
        )?.info.agent,
      ).toBe(record.expected)
      expect(await SessionInbox.latestRootID(record.sessionID)).toBe(record.item!.messageID)
    }
    {
      await using runtime = await open(true)
      await runtime.run(() =>
        within(async () => {
          expect(await Agent.get("boss-synergy")).toBeDefined()
          for (const choice of [
            { agent: "boss-synergy", override: undefined, expected: PrimaryAgentIdentity.names.lightweight },
            {
              agent: PrimaryAgentIdentity.names.coding,
              override: "boss-synergy",
              expected: PrimaryAgentIdentity.names.lightweight,
            },
            {
              agent: PrimaryAgentIdentity.names.coding,
              override: undefined,
              expected: PrimaryAgentIdentity.names.coding,
            },
            {
              agent: "boss-synergy",
              override: PrimaryAgentIdentity.names.coding,
              expected: PrimaryAgentIdentity.names.coding,
            },
          ]) {
            const session = await Session.create({ title: "Independent agent selection" })
            const old = await Session.updateMessage({
              id: Identifier.ascending("message"),
              sessionID: session.id,
              role: "user",
              isRoot: true,
              origin: { type: "user" },
              agent: choice.agent,
              model,
              time: { created: Date.now() },
            })
            await Session.updatePart({
              id: Identifier.ascending("part"),
              sessionID: session.id,
              messageID: old.id,
              type: "text",
              origin: "user",
              text: "Historical request",
            })
            await Session.update(session.id, (draft) => {
              draft.workflow = { kind: "boss", role: "boss" }
              draft.agentOverride = choice.override
            })
            records.push({ sessionID: session.id, old, override: choice.override, expected: choice.expected })
          }
        }),
      )
    }
    {
      await using runtime = await open(false)
      await runtime.run(() =>
        within(async () => {
          for (const record of records) {
            const parts = [{ type: "text" as const, text: "Explicit new ordinary task" }]
            const id =
              delivery === "input"
                ? (await SessionInbox.enqueueUser({ sessionID: record.sessionID, model, parts })).id
                : (
                    await SessionInbox.deliver({
                      sessionID: record.sessionID,
                      mode: "task",
                      message: { role: "user", model, parts },
                    })
                  ).itemID
            record.item = await SessionInbox.getStored(record.sessionID, id)
            expect(record.item.message?.agent).toBe(record.expected)
            expect(record.item.execution?.kind).toBe("independent")
            if (record.item.input) expect(record.item.input.agent).toBe(record.expected)
            if (record.override === "boss-synergy") {
              await SessionInbox.materializeItem(record.item)
              await checkFeedback(record)
            }
          }
          const sessionID = records[0]!.sessionID
          const parts = [{ type: "text" as const, text: "Explicit selection" }]
          if (delivery === "input") {
            await expect(
              SessionInbox.enqueueUser({ sessionID, model, agent: "unavailable-explicit-agent", parts }),
            ).rejects.toThrow("Agent not found: unavailable-explicit-agent")
          } else {
            const invalid = await SessionInbox.deliver({
              sessionID,
              mode: "task",
              message: { role: "user", model, agent: "unavailable-explicit-agent", parts },
            })
            await expect(
              SessionInbox.materializeItem(await SessionInbox.getStored(sessionID, invalid.itemID)),
            ).rejects.toThrow("Agent not found: unavailable-explicit-agent")
          }
        }),
      )
    }
    {
      await using runtime = await open(true)
      await runtime.run(() =>
        within(async () => {
          for (const record of records) {
            const message = await SessionInbox.materializeItem(record.item!)
            expect(message?.info.agent).toBe(record.expected)
            expect(message?.info).toMatchObject({ execution: { kind: "independent", previousRootID: record.old.id } })
            expect((await MessageV2.get({ sessionID: record.sessionID, messageID: record.old.id })).info).toEqual(
              record.old,
            )
            expect((await Session.get(record.sessionID)).agentOverride).toBe(record.override)
            if (record.override === "boss-synergy") await checkFeedback(record)
          }
        }),
      )
    }
  }, 30_000)
}

test("a materialized independent root without rollout evidence runs before a retained owner task", async () => {
  await using home = await runtimeHome()
  const fixture = provider()
  const open = (selected: boolean) =>
    testRuntime({
      home: home.host.home,
      composition: {
        register: composeWithExperiments([
          localRuntime({ workers: false, environment: false }),
          ...(selected ? [lightLoop()] : []),
        ]).register,
      },
      register: fixture.register,
    })
  let sessionID = ""
  let newRootID = ""
  let retained: SessionInbox.StoredItem
  {
    await using runtime = await open(true)
    await runtime.run(() =>
      within(async () => {
        sessionID = (await Session.create({ title: "Independent root before first segment" })).id
        const queued = await SessionInbox.deliver({
          sessionID,
          mode: "task",
          message: {
            role: "user",
            model,
            metadata: { source: "light_loop_continuation" },
            parts: [{ type: "text", origin: "system", text: "Retained owner task" }],
          },
        })
        retained = await SessionInbox.getStored(sessionID, queued.itemID)
      }),
    )
  }
  {
    await using runtime = await open(false)
    await runtime.run(() =>
      within(async () => {
        const queued = await SessionInbox.deliver({
          sessionID,
          mode: "task",
          message: { role: "user", model, parts: [{ type: "text", text: "A new independent root without a segment" }] },
        })
        newRootID = queued.messageID
        expect((await SessionInbox.materializeNextTask(sessionID)).status).toBe("materialized")
        expect(await SessionExecutionOwners.latestRoot(sessionID)).toMatchObject({ execution: { kind: "independent" } })
        await expect(
          RolloutLedger.getRun(RolloutLifecycle.owner(await Session.get(sessionID)), newRootID),
        ).rejects.toBeInstanceOf(Storage.NotFoundError)
      }),
    )
  }
  {
    await using runtime = await open(true)
    await runtime.run(() =>
      within(async () => {
        fixture.interruptNext()
        const running = SessionInvoke.loop(sessionID)
        try {
          await Promise.race([
            fixture.started,
            running.then(() => {
              throw new Error("No model request")
            }),
          ])
          expect(fixture.roots[0]).toBe(newRootID)
          expect(await SessionInbox.getStored(sessionID, retained.id)).toEqual(retained)
        } finally {
          await SessionAbort.abort(sessionID)
          await running
        }
      }),
    )
  }
}, 30_000)
