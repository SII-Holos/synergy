import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { tmpdir } from "../support/fixture"
import { testRuntime } from "../support/runtime"
import { Scope } from "../../src/scope"
import { ScopeContext } from "../../src/scope/context"
import { Session } from "../../src/session"
import { SessionLifecycle } from "../../src/session/lifecycle"
import { Identifier } from "../../src/id/id"
import { Storage } from "../../src/storage/storage"
import { RolloutLedger } from "../../src/session/rollout/ledger"
import { RolloutJournal } from "../../src/session/rollout/journal"
import { RolloutPending } from "../../src/session/rollout/pending"
import { SessionTransferEpochs as Epochs } from "../../src/session/transfer-epochs"

async function digest(sessionID: string) {
  const hash = createHash("sha256")
  for await (const row of Storage.records({ prefix: ["sessions", "home", sessionID], limit: 64 }))
    hash.update(JSON.stringify([row.key, row.value]))
  return hash.digest("hex")
}

test("shutdown and cold evidence preparation retain frozen Rollout records and unresolved recovery coverage", async () => {
  await using home = await tmpdir()
  const runtime = await testRuntime({ home: home.path })
  const frozen = await runtime.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      workspace: null,
      fn: async () => {
        const session = await Session.create({ workspace: null, environmentID: null })
        const rootID = Identifier.ascending("message")
        await Session.updateMessage({
          id: rootID,
          sessionID: session.id,
          role: "user",
          isRoot: true,
          rootID,
          time: { created: 1 },
          agent: "general",
          model: { providerID: "fixture", modelID: "fixture" },
        })
        const owner = { kind: "session" as const, scopeID: "home", sessionID: session.id }
        await RolloutLedger.beginRun(owner, rootID)
        await RolloutLedger.finishRun(owner, rootID, "completed")
        await SessionLifecycle.pause({ sessionID: session.id, reason: "interrupted" })
        const binding = {
          sessionID: session.id,
          scopeID: "home",
          handoffID: "recovery-fence",
          sourceID: "source",
          targetID: "target",
          fromEpoch: 1,
          toEpoch: 2,
        }
        await Epochs.beginSource(binding)
        await Epochs.freeze(binding)
        return { owner, digest: await digest(session.id), binding }
      },
    }),
  )
  await expect(runtime.close()).resolves.toBeUndefined()
  await using reopened = await testRuntime({ home: home.path })
  await reopened.run(async () => {
    await RolloutJournal.prepare(frozen.owner)
    expect(await digest(frozen.owner.sessionID)).toBe(frozen.digest)
    expect(await RolloutPending.needsRecovery(frozen.owner)).toBe(true)
    expect((await Epochs.inspect(frozen.binding)).phase).toBe("frozen")
  })
})
