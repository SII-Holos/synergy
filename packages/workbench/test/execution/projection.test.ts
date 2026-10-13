import { afterAll, expect, test } from "bun:test"
import { fixture } from "@ericsanchezok/synergy-harness/test/support/rollout"
import { testRuntime } from "../support/runtime"
import { ExecutionProjection } from "../../src/execution/projection"
import { ExecutionService } from "../../src/execution/service"
import { applyProjectionPatch } from "@ericsanchezok/synergy-util/projection-patch"

const runtime = await testRuntime()
afterAll(() => runtime.close())
test("execution subscriptions send field changes, use scoped HTTP checkpoints for large snapshots and release them", () =>
  runtime.run(() =>
    fixture(async ({ session }) => {
      const frames: Array<Parameters<Parameters<ReturnType<typeof ExecutionProjection.contribution>["open"]>[1]>[0]> =
        []
      const subscription = await ExecutionProjection.contribution().open(
        { kind: "execution", scopeID: session.scope.id, sessionID: session.id, generation: 7 },
        (frame) => frames.push(frame),
      )
      const summary = await ExecutionService.summary(session.id)
      const large = {
        ...summary,
        rounds: Array.from({ length: 500 }, (_, i) => ({
          id: `round-${i}`,
          title: "context ".repeat(100),
          started: i,
          status: "completed" as const,
          elapsedMs: 1,
          elapsedActive: false,
          elapsedLowerBound: false,
        })),
      }
      const value = {
        sessionID: session.id,
        revision: 8,
        summary: large,
        roundSummaries: [],
        contextUpserts: [],
        upserts: [],
        processUpserts: [],
        processRemoved: [],
        removed: [],
        previousRevision: 7,
      }
      subscription.project({ scopeID: session.scope.id, payload: { type: "execution.updated", properties: value } })
      const reset = frames.at(-1)!.payload.properties
      expect(typeof reset.snapshot).toBe("string")
      expect(ExecutionProjection.checkpoint(session.id, reset.snapshot as string)).toEqual(large)
      expect(() => ExecutionProjection.checkpoint("another-session", reset.snapshot as string)).toThrow()
      let bytes = 0
      for (let i = 0; i < 30; i++) {
        subscription.project({
          scopeID: session.scope.id,
          payload: {
            type: "execution.updated",
            properties: { ...value, summary: { ...large, elapsedMs: i }, revision: 9 + i },
          },
        })
        bytes += JSON.stringify(frames.at(-1)).length
      }
      expect(bytes).toBeLessThan(30000)
      expect(frames.every((frame) => Buffer.byteLength(JSON.stringify(frame)) <= 65536)).toBe(true)
      subscription.dispose()
      expect(() => ExecutionProjection.checkpoint(session.id, reset.snapshot as string)).toThrow()
    }),
  ))

test("visible node interests retain their context updates and omit unrelated nodes", () =>
  runtime.run(() =>
    fixture(async ({ session }) => {
      const frames: Array<Parameters<Parameters<ReturnType<typeof ExecutionProjection.contribution>["open"]>[1]>[0]> =
        []
      const subscription = await ExecutionProjection.contribution().open(
        { kind: "execution", scopeID: session.scope.id, sessionID: session.id, generation: 1, nodeIDs: ["visible"] },
        (frame) => frames.push(frame),
      )
      const summary = await ExecutionService.summary(session.id)
      subscription.project({
        scopeID: session.scope.id,
        payload: {
          type: "execution.updated",
          properties: {
            ...ExecutionProjection.baseline(summary),
            revision: summary.revision + 1,
            contextUpserts: [
              { nodeID: "visible", callID: "call-a" },
              { nodeID: "hidden", callID: "call-b" },
            ],
            upserts: [{ id: "visible" }, { id: "hidden" }],
          },
        },
      })
      let value: unknown
      for (const frame of frames)
        value = applyProjectionPatch(
          value,
          frame.payload.properties.patches as Parameters<typeof applyProjectionPatch>[1],
        )
      expect(value).toMatchObject({
        contextUpserts: [{ nodeID: "visible", callID: "call-a" }],
        upserts: [{ id: "visible" }],
      })
      subscription.dispose()
    }),
  ))
