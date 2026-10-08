import { RolloutExecution } from "@ericsanchezok/synergy-harness/rollout"
import { afterAll, expect, spyOn, test } from "bun:test"
import { z } from "zod"
import { Bus } from "@ericsanchezok/synergy-harness/bus"
import { Identifier } from "@ericsanchezok/synergy-harness/id/id"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { RolloutEvents } from "@ericsanchezok/synergy-harness/rollout"
import { RolloutLedger } from "@ericsanchezok/synergy-harness/session/rollout/ledger"
import { RolloutTransportRecorder } from "@ericsanchezok/synergy-harness/session/rollout/transport-recorder"
import { complete, fixture } from "@ericsanchezok/synergy-harness/test/support/rollout"
import { testRuntime } from "../support/runtime"
import { ExecutionSchema } from "../../src/execution/schema"
import { ExecutionService } from "../../src/execution/service"

const runtime = await testRuntime()
afterAll(() => runtime.close())

function nextUpdate(sessionID: string, predicate: (event: ExecutionSchema.Summary) => boolean) {
  let dispose = () => {}
  const result = new Promise<{ type: string; properties: z.infer<typeof ExecutionSchema.Updated.properties> }>(
    (resolve, reject) => {
      const timer = setTimeout(() => {
        dispose()
        reject(new Error("Execution update did not arrive after the coalescing interval"))
      }, 5000)
      const unsubscribe = Bus.subscribeGlobal(ExecutionSchema.Updated, (event) => {
        if (event.properties.sessionID !== sessionID || !predicate(event.properties.summary)) return
        dispose()
        resolve(event)
      })
      dispose = () => {
        clearTimeout(timer)
        unsubscribe()
      }
    },
  )
  return { result, dispose: () => dispose() }
}

test("persisted delegation status updates the parent's cancellation controls without rollout changes", () =>
  runtime.run(() =>
    fixture(async ({ session, rootID }) => {
      const child = await Session.create({
        parentID: session.id,
        cortex: {
          taskID: Identifier.ascending("cortex"),
          parentSessionID: session.id,
          parentMessageID: rootID,
          description: "Review",
          agent: "reviewer",
          status: "queued",
          startedAt: Date.now(),
          visibility: "hidden",
        },
      })
      const initial = await ExecutionService.summary(session.id)
      expect(initial.tasks.find((task) => task.sessionID === child.id)?.cortex?.status).toBe("queued")
      const updated = nextUpdate(session.id, (summary) =>
        summary.tasks.some((task) => task.sessionID === child.id && task.cortex?.status === "cancelled"),
      )
      try {
        await Session.update(child.id, (info) => {
          if (info.cortex) info.cortex.status = "cancelled"
        })
        const event = await updated.result
        expect(event.properties.revision).toBeGreaterThan(initial.revision)
        expect(event.properties.summary.tasks.find((task) => task.sessionID === child.id)?.cortex?.visibility).toBe(
          "hidden",
        )
      } finally {
        updated.dispose()
      }
    }),
  ))

test(
  "a missed call notification recovers committed evidence and keeps child completion live",
  () =>
    runtime.run(() =>
      fixture(async ({ session, rootID, call }) => {
        await complete(call)
        await RolloutLedger.finishRun(call.owner, rootID, "completed")
        const child = await Session.create({ parentID: session.id, title: "Retained child analysis" })
        const owner = { kind: "session" as const, scopeID: child.scope.id, sessionID: child.id }
        const childRun = Identifier.ascending("message")
        const segment = await RolloutLedger.beginSegment({
          owner,
          runID: childRun,
          input: {},
          parent: { owner: call.owner, runID: rootID, messageID: rootID },
        })
        await RolloutExecution.provide({ owner, runID: childRun }, () => RolloutExecution.start(segment))
        const initial = await ExecutionService.summary(session.id)
        expect(initial.status).toBe("running")
        expect(initial.elapsedActive).toBe(true)

        const publish = Bus.publish
        let missed = 0
        const delivery = spyOn(Bus, "publish").mockImplementation(async (definition, properties) => {
          if (definition.type === RolloutEvents.Updated.type) {
            const event = RolloutEvents.Updated.properties.parse(properties)
            if (event.owner.kind === "session" && event.owner.sessionID === child.id && event.record.kind === "call") {
              missed++
              return
            }
          }
          await publish(definition, properties)
        })
        const running = nextUpdate(session.id, (summary) => summary.tasks[0]?.tokens.unknown === 1)
        try {
          const childCall = await RolloutLedger.beginCall({
            owner,
            runID: childRun,
            purpose: "analysis",
            model: call.model,
            request: {},
          })
          const recorder = RolloutTransportRecorder.create(childCall)
          const attemptID = crypto.randomUUID()
          await recorder.emit({
            type: "attempt-start",
            attemptID,
            url: "https://model.test/responses",
            method: "POST",
            mediaType: "application/json",
          })
          const recovered = await running.result
          expect(missed).toBe(1)
          expect(recovered.properties.revision).toBeGreaterThan(initial.revision)
          expect(recovered.properties.summary.tasks[0].status).toBe("running")
          expect(
            recovered.properties.upserts.some((node) => node.sessionID === child.id && node.kind === "model"),
          ).toBe(true)
          delivery.mockRestore()

          const completed = nextUpdate(session.id, (summary) => summary.status === "completed")
          try {
            await recorder.emit({ type: "attempt-end", attemptID, status: "completed" })
            await RolloutLedger.finishCall(owner, childRun, childCall.id, {
              status: "completed",
              sdkUsage: { inputTokens: 7, outputTokens: 3 },
            })
            await RolloutExecution.stop(segment)
            await RolloutLedger.finishSegment(segment, "completed")
            await RolloutLedger.finishRun(owner, childRun, "completed")
            const update = await completed.result
            expect(update.properties.revision).toBeGreaterThan(recovered.properties.revision)
            expect(update.properties.summary.tasks).toHaveLength(1)
            expect(update.properties.summary.tasks[0].status).toBe("completed")
            expect(
              update.properties.upserts.some((node) => node.kind === "subtask" && node.status === "completed"),
            ).toBe(true)
          } finally {
            completed.dispose()
          }
        } finally {
          running.dispose()
          delivery.mockRestore()
        }
      }),
    ),
  15000,
)
