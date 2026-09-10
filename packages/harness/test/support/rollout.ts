import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { Identifier } from "@ericsanchezok/synergy-harness/id/id"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { RolloutLedger } from "@ericsanchezok/synergy-harness/session/rollout/ledger"
import { RolloutTransportRecorder } from "@ericsanchezok/synergy-harness/session/rollout/transport-recorder"
import { ProviderPricing } from "@ericsanchezok/synergy-harness/provider/pricing"

export async function fixture(
  fn: (input: {
    session: Session.Info
    rootID: string
    call: Awaited<ReturnType<typeof RolloutLedger.beginCall>>
  }) => Promise<void>,
) {
  await using tmp = await tmpdir({ git: true })
  const scope = await tmp.scope()
  await ScopeContext.provide({
    scope,
    fn: async () => {
      const session = await Session.create({})
      try {
        const rootID = Identifier.ascending("message")
        const root = await Session.updateMessage({
          id: rootID,
          sessionID: session.id,
          role: "user",
          isRoot: true,
          rootID,
          agent: "synergy",
          model: { providerID: "test", modelID: "test" },
          time: { created: Date.now() },
        })
        await Session.updateMessage({
          id: Identifier.ascending("message"),
          sessionID: session.id,
          role: "assistant",
          parentID: root.id,
          rootID: root.id,
          agent: "synergy",
          mode: "synergy",
          modelID: "test",
          providerID: "test",
          time: { created: Date.now(), completed: Date.now() },
          path: { cwd: tmp.path, root: tmp.path },
          cost: 123,
          tokens: { input: 1000, output: 500, reasoning: 100, cache: { read: 0, write: 0 } },
          finish: "stop",
        })
        const call = await RolloutLedger.beginCall({
          owner: { kind: "session", scopeID: scope.id, sessionID: session.id },
          runID: root.id,
          purpose: "summary",
          agent: "summary",
          request: {},
          model: {
            providerID: "test",
            modelID: "test",
            sdk: "@ai-sdk/openai",
            pricing: ProviderPricing.resolve({
              providerID: "test",
              modelID: "test",
              source: "configuration",
              cost: { input: 3, output: 15, cache_read: 1 },
            }),
          },
        })
        await fn({ session: await Session.get(session.id), rootID: root.id, call })
      } finally {
        await Session.remove(session.id)
      }
    },
  })
}

export async function complete(call: Awaited<ReturnType<typeof RolloutLedger.beginCall>>) {
  const recorder = RolloutTransportRecorder.create(call)
  const attemptID = crypto.randomUUID()
  await recorder.emit({
    type: "attempt-start",
    attemptID,
    url: "https://model.test/responses",
    method: "POST",
    mediaType: "application/json",
  })
  await recorder.emit({ type: "body-end", attemptID, channel: "request", complete: true })
  await recorder.emit({ type: "response", attemptID, status: 200, headers: {}, mediaType: "application/json" })
  await recorder.emit({
    type: "chunk",
    attemptID,
    channel: "response",
    data: new TextEncoder().encode(
      JSON.stringify({
        usage: {
          input_tokens: 1000,
          input_tokens_details: { cached_tokens: 0 },
          output_tokens: 500,
          output_tokens_details: { reasoning_tokens: 100 },
        },
      }),
    ),
  })
  await recorder.emit({ type: "body-end", attemptID, channel: "response", complete: true })
  await recorder.emit({ type: "attempt-end", attemptID, status: "completed" })
  await RolloutLedger.finishCall(call.owner, call.runID, call.id, { status: "completed", transportCaptured: true })
}
