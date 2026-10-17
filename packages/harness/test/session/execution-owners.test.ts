import { expect, test } from "bun:test"
import type { Provider as SDK } from "ai"
import { testRuntime } from "../support/runtime"
import { MessageV2 } from "../../src/session/message-v2"
import { SessionExecutionOwners } from "../../src/session/execution-owners"
import { Session } from "../../src/session"
import { SessionInbox } from "../../src/session/inbox"
import { SessionInvoke } from "../../src/session/invoke"
import { SessionManager } from "../../src/session/manager"
import { RolloutLifecycle } from "../../src/session/rollout/lifecycle"
import { RolloutLedger } from "../../src/session/rollout/ledger"
import { Provider } from "../../src/provider/provider"
import { ProviderCatalogSource } from "../../src/provider/catalog-source"
import { ProviderSdkSource } from "../../src/provider/sdk-source"
import { ProviderRequestSource } from "../../src/provider/request-source"
import { ConfigSource } from "../../src/config/source"
import { Scope } from "../../src/scope"
import { ScopeContext } from "../../src/scope/context"
import { Storage } from "../../src/storage/storage"

for (const source of ["agenda", "blueprint_loop_completed", "light_loop_continuation", "lattice_continuation"]) {
  test(`explicit requirements cannot remove historical ${source} ownership`, () => {
    const owner =
      source === "agenda"
        ? "agenda"
        : source.startsWith("blueprint_")
          ? "blueprint"
          : source.startsWith("light_")
            ? "light-loop"
            : "lattice"
    expect(MessageV2.requiredOwners({ metadata: { source, requiredOwners: [] } })).toEqual([owner])
    expect(MessageV2.requiredOwners({ metadata: { source, requiredOwners: ["unknown-owner"] } })).toEqual(
      [owner, "unknown-owner"].sort(),
    )
    expect(MessageV2.isHumanInput({ origin: { type: "user" }, metadata: { source } })).toBe(false)
  })
}

test("unknown or malformed requirements are retained and cannot execute in Core", async () => {
  await using runtime = await testRuntime()
  await runtime.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      fn: async () => {
        const session = await Session.create({ title: "Unknown owner" })
        for (const requiredOwners of [["uninstalled-owner"], "uninstalled-owner", [42]]) {
          const delivered = await SessionInbox.deliver({
            sessionID: session.id,
            mode: "task",
            message: {
              role: "user",
              metadata: { requiredOwners },
              parts: [{ type: "text", text: "Uninstalled task" }],
            },
          })
          expect(await SessionInbox.peekTask(session.id)).toBeUndefined()
          expect(
            (await SessionInbox.getStored(session.id, delivered.itemID)).message?.metadata?.requiredOwners,
          ).toEqual(requiredOwners)
        }
        expect(MessageV2.requiredOwners({ origin: { type: "user" } })).toEqual([])
        expect(await SessionExecutionOwners.allowsMessage(session, { origin: { type: "user" } })).toBe(true)
      },
    }),
  )
})

test("new human work executes without resuming a retained unavailable root or changing its queue", async () => {
  const requests: string[] = []
  const catalog = Provider.fromModelsDevProvider({
    id: "fixture",
    name: "Fixture",
    env: [],
    npm: "fixture-sdk",
    api: "https://example.invalid",
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
  const factory: ProviderSdkSource.Factory = () =>
    ({
      languageModel: () => ({
        specificationVersion: "v2",
        provider: "fixture",
        modelId: "chat",
        supportedUrls: {},
        async doGenerate() {
          throw new Error("Only streaming is supported")
        },
        async doStream() {
          return {
            stream: new ReadableStream({
              start(output) {
                output.enqueue({ type: "text-start", id: "text" })
                output.enqueue({ type: "text-delta", id: "text", delta: "New request completed" })
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
  await using runtime = await testRuntime({
    register() {
      ProviderCatalogSource.register({ providers: async () => ({ fixture: catalog }) })
      ProviderSdkSource.register({ load: async () => factory, loadSync: () => factory })
      ProviderRequestSource.register({
        prepare: async ({ user }) => {
          requests.push(user.id)
          return { key: "fixture-key" }
        },
      })
      ConfigSource.register({
        resolve: async () => ({ model: "fixture/chat", small_model: "fixture/chat", compaction: { auto: false } }),
      })
    },
  })
  await runtime.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      fn: async () => {
        const session = await Session.create({ title: "Retained task" })
        const first = await SessionInbox.enqueueUser({
          sessionID: session.id,
          model: { providerID: "fixture", modelID: "chat" },
          parts: [{ type: "text", text: "Original request" }],
        })
        await SessionInbox.materializeNextTask(session.id)
        await RolloutLifecycle.configuration(session, first.messageID)
        const key = ["sessions", "home", session.id, "info"]
        const workflow = { kind: "uninstalled-workflow", state: { retained: true } }
        await Storage.write(key, { ...(await Storage.read<Record<string, unknown>>(key)), workflow })
        const pending = await SessionInbox.deliver({
          sessionID: session.id,
          mode: "steer",
          message: {
            role: "user",
            metadata: { requiredOwners: ["uninstalled-owner"] },
            parts: [{ type: "text", text: "Retained control" }],
          },
        })
        const pendingBefore = await SessionInbox.getStored(session.id, pending.itemID)
        const previousRun = await RolloutLedger.getRun(RolloutLifecycle.owner(session), first.messageID)
        await SessionInvoke.loop(session.id)
        expect(requests).toEqual([])
        const manual = await SessionInbox.enqueueUser({
          sessionID: session.id,
          model: { providerID: "fixture", modelID: "chat" },
          parts: [{ type: "text", text: "Independent new request" }],
        })
        await SessionManager.wake(session.id)
        expect(requests).toContain(manual.messageID)
        expect(requests).not.toContain(first.messageID)
        expect(
          (await Session.messages({ sessionID: session.id })).some(
            (message) =>
              message.info.role === "assistant" &&
              message.info.parentID === manual.messageID &&
              message.parts.some((part) => part.type === "text" && part.text === "New request completed"),
          ),
        ).toBe(true)
        expect(await SessionInbox.getStored(session.id, pending.itemID)).toEqual(pendingBefore)
        expect((await Storage.read<Record<string, unknown>>(key)).workflow).toEqual(workflow)
        expect(await RolloutLedger.getRun(RolloutLifecycle.owner(session), first.messageID)).toEqual(previousRun)
      },
    }),
  )
}, 30_000)
