import { expect, spyOn, test } from "bun:test"
import { RuntimeComponents } from "@ericsanchezok/synergy-harness/lifecycle"
import { testRuntime } from "@ericsanchezok/synergy-harness/test/support/runtime"
import { runtimeHome } from "@ericsanchezok/synergy-harness/test/support/runtime-home"
import { Scope } from "@ericsanchezok/synergy-harness/scope"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { SessionDrive } from "@ericsanchezok/synergy-harness/session/drive"
import { SessionLifecycle } from "@ericsanchezok/synergy-harness/session/lifecycle"
import { RolloutLedger } from "@ericsanchezok/synergy-harness/session/rollout/ledger"
import { RolloutLifecycle } from "@ericsanchezok/synergy-harness/session/rollout/lifecycle"
import { Identifier } from "@ericsanchezok/synergy-harness/id/id"
import { localRuntime } from "../../src/component"
import { submitInput } from "../../src/session-api"

for (const paused of [false, true])
  test(`new human input leaves an absent owner's ${paused ? "paused" : "idle"} root untouched`, async () => {
    await using home = await runtimeHome()
    await using runtime = await testRuntime({
      home: home.host.home,
      composition: RuntimeComponents.compose([localRuntime({ workers: false, environment: false })]),
    })
    await runtime.run(() =>
      ScopeContext.provide({
        scope: Scope.home(),
        fn: async () => {
          const session = await Session.create({})
          const rootID = Identifier.ascending("message")
          await Session.updateMessage({
            id: rootID,
            sessionID: session.id,
            role: "user",
            isRoot: true,
            agent: "general",
            model: { providerID: "fixture", modelID: "fixture" },
            time: { created: Date.now() },
            metadata: { source: "agenda" },
          })
          await RolloutLedger.cancelUnopenedRun(RolloutLifecycle.owner(session), rootID, Date.now())
          const previous = await RolloutLedger.getRun(RolloutLifecycle.owner(session), rootID)
          if (paused) await SessionLifecycle.pause({ sessionID: session.id, reason: "interrupted" })
          using drive = spyOn(SessionDrive, "request").mockResolvedValue(false)
          const result = await submitInput({
            sessionID: session.id,
            parts: [{ type: "text", text: "A new ordinary request" }],
          })
          expect(result.status).toBe("queued")
          if (result.status !== "queued") throw new Error("Expected durable queued input")
          expect(result.item.mode).toBe("task")
          expect(result.runID).toBeUndefined()
          expect(await RolloutLedger.getRun(RolloutLifecycle.owner(session), rootID)).toEqual(previous)
          expect(await SessionLifecycle.snapshot(session.id)).toBeUndefined()
          expect(drive).toHaveBeenCalledTimes(1)
        },
      }),
    )
  })
