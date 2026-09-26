import { afterAll, describe, expect, test } from "bun:test"
import { Session } from "../../src/session"
import { SessionModelSelection } from "../../src/session/model-selection"
import { ScopeContext } from "../../src/scope/context"
import { tmpdir } from "../support/fixture"
import { testRuntime } from "../support/runtime"
import { migrations } from "../../src/session/migration"
import { Storage } from "../../src/storage/storage"
import { StoragePath } from "../../src/storage/path"
import { Identifier } from "../../src/id/id"

const runtime = await testRuntime()
afterAll(() => runtime.close())
const a = { providerID: "selection-test", modelID: "a" }
const b = { providerID: "selection-test", modelID: "b" }

async function fixture(fn: (sessionID: string) => Promise<void>) {
  return runtime.run(async () => {
    await using tmp = await tmpdir({
      git: true,
      config: {
        provider: {
          "anthropic-selection": {
            npm: "@ai-sdk/anthropic",
            env: [],
            options: { apiKey: "fixture" },
            models: {
              "claude-sonnet-4-6": {
                name: "Claude",
                reasoning: true,
                variants: {
                  high: { thinking: { type: "adaptive" }, effort: "high" },
                  low: { thinking: { type: "adaptive" }, effort: "low" },
                  off: { thinking: { type: "disabled" } },
                },
              },
            },
          },
          "selection-test": {
            npm: "@ai-sdk/openai-compatible",
            env: [],
            options: { apiKey: "fixture" },
            models: {
              a: { name: "A", variants: { high: { reasoningEffort: "high" } } },
              b: { name: "B", variants: { low: { reasoningEffort: "low" } } },
            },
          },
        },
      },
    })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => fn((await Session.create({})).id),
    })
  })
}

describe("durable session model selection", () => {
  test("Anthropic tool turns allow effort changes and defer mode or model changes", () =>
    fixture(async (sessionID) => {
      const model = { providerID: "anthropic-selection", modelID: "claude-sonnet-4-6" }
      const root = { id: "msg_first", model, variant: "high" }
      await SessionModelSelection.set(sessionID, { model, thinking: { mode: "variant", variant: "high" } })
      await SessionModelSelection.applied(sessionID, await SessionModelSelection.capture(sessionID, root), "msg_call")
      await SessionModelSelection.set(sessionID, { model, thinking: { mode: "variant", variant: "low" } })
      const low = await SessionModelSelection.capture(sessionID, root, true)
      expect(low.thinking).toEqual({ mode: "variant", variant: "low" })
      await SessionModelSelection.applied(sessionID, low, "msg_call_low")
      await SessionModelSelection.set(sessionID, { model, thinking: { mode: "off" } })
      expect((await SessionModelSelection.capture(sessionID, root, true)).thinking).toEqual(low.thinking)
      expect((await Session.get(sessionID)).modelSelection?.pendingReason).toBe("tool-turn")
      expect((await SessionModelSelection.capture(sessionID, { ...root, id: "msg_second" })).thinking).toEqual({
        mode: "off",
      })
      await SessionModelSelection.set(sessionID, { model: b })
      expect((await SessionModelSelection.capture(sessionID, root, true)).model).toEqual(model)
      expect((await SessionModelSelection.capture(sessionID, { ...root, id: "msg_second" })).model).toEqual(b)
    }))

  test("session migration preserves root choices per model and is idempotent", () =>
    fixture(async (sessionID) => {
      const session = await Session.get(sessionID)
      const owner = { scopeID: session.scope.id, sessionID }
      for (const [index, model] of [a, b].entries()) {
        await Session.updateMessage({
          id: Identifier.ascending("message"),
          sessionID,
          role: "user",
          isRoot: true,
          agent: "synergy",
          model,
          time: { created: index },
          variant: index === 0 ? "high" : "low",
        })
      }
      await Session.update(sessionID, (draft) => {
        draft.modelOverride = a
      })
      const migration = migrations.find((item) => item.id === "20260923-session-model-selection")!
      await migration.upSession!(owner, () => {})
      const key = StoragePath.sessionInfo(Identifier.asScopeID(owner.scopeID), Identifier.asSessionID(sessionID))
      const migrated = await Storage.read<Session.Info>(key)
      expect(migrated.modelSelection?.selected).toEqual({ model: a, thinking: { mode: "variant", variant: "high" } })
      expect(Object.values(migrated.modelSelection!.preferences)).toEqual([
        { mode: "variant", variant: "high" },
        { mode: "variant", variant: "low" },
      ])
      await migration.upSession!(owner, () => {})
      expect((await Storage.read<Session.Info>(key)).modelSelection).toEqual(migrated.modelSelection)
    }))
  test("remembers thinking per model and rejects stale writes without changing state", () =>
    fixture(async (sessionID) => {
      await SessionModelSelection.set(sessionID, {
        model: a,
        thinking: { mode: "variant", variant: "high" },
        expectedRevision: 0,
      })
      const switched = await SessionModelSelection.set(sessionID, { model: b, expectedRevision: 1 })
      expect(switched.modelSelection?.selected.thinking).toEqual({ mode: "provider-default" })
      await SessionModelSelection.set(sessionID, {
        model: b,
        thinking: { mode: "variant", variant: "low" },
        expectedRevision: 2,
      })
      const restored = await SessionModelSelection.set(sessionID, { model: a, expectedRevision: 3 })
      expect(restored.modelSelection?.selected.thinking).toEqual({ mode: "variant", variant: "high" })
      await expect(SessionModelSelection.set(sessionID, { model: b, expectedRevision: 1 })).rejects.toMatchObject({
        name: "SessionModelSelectionConflictError",
      })
      expect((await Session.get(sessionID)).modelSelection).toEqual(restored.modelSelection)
    }))

  test("captures a complete request and preserves it when the next selection changes", () =>
    fixture(async (sessionID) => {
      await SessionModelSelection.set(sessionID, { model: a, thinking: { mode: "variant", variant: "high" } })
      const root = { model: a, variant: "high", id: "msg_root" }
      const first = await SessionModelSelection.capture(sessionID, root)
      await SessionModelSelection.set(sessionID, { model: b, thinking: { mode: "variant", variant: "low" } })
      await SessionModelSelection.applied(sessionID, first, "msg_request_a")
      const saved = (await Session.get(sessionID)).modelSelection!
      expect(saved.selected.model).toEqual(b)
      expect(saved.lastUsed?.model).toEqual(a)
      expect(first.thinking).toEqual({ mode: "variant", variant: "high" })
      const second = await SessionModelSelection.capture(sessionID, root)
      expect(second.model).toEqual(b)
      expect(second.thinking).toEqual({ mode: "variant", variant: "low" })
    }))

  test("rejects unsupported explicit choices and keeps provider default distinct", () =>
    fixture(async (sessionID) => {
      await SessionModelSelection.set(sessionID, { model: a, thinking: { mode: "provider-default" } })
      await expect(SessionModelSelection.set(sessionID, { model: a, thinking: { mode: "off" } })).rejects.toMatchObject(
        {
          name: "SessionThinkingUnavailableError",
        },
      )
      await expect(
        SessionModelSelection.set(sessionID, { model: a, thinking: { mode: "variant", variant: "low" } }),
      ).rejects.toMatchObject({
        name: "ProviderModelVariantUnavailableError",
      })
      expect((await Session.get(sessionID)).modelSelection?.selected.thinking).toEqual({ mode: "provider-default" })
    }))
})
