import { afterAll, expect, spyOn, test } from "bun:test"
import { fixture } from "@ericsanchezok/synergy-harness/test/support/rollout"
import { testRuntime } from "../support/runtime"
import { ExecutionProjection } from "../../src/execution/projection"
import { ExecutionService } from "../../src/execution/service"
import { applyProjectionPatch } from "@ericsanchezok/synergy-util/projection-patch"
import { SessionHistory } from "@ericsanchezok/synergy-harness/session/history"
import { ExecutionSchema } from "../../src/execution/schema"

const runtime = await testRuntime()
afterAll(() => runtime.close())
test("root demand opens without summary preparation", () =>
  runtime.run(() =>
    fixture(async ({ session }) => {
      using summary = spyOn(ExecutionService, "summary")
      const frames: unknown[] = []
      const lease = await ExecutionProjection.contribution().open(
        { kind: "execution", scopeID: session.scope.id, sessionID: session.id, generation: 1, demands: ["root"] },
        (frame) => frames.push(frame),
      )
      expect(summary).not.toHaveBeenCalled()
      expect(frames.length).toBeGreaterThan(0)
      lease.dispose()
    }),
  ))

test("root readers do not keep abandoned summary work alive and shared readers survive one cancellation", () =>
  runtime.run(() =>
    fixture(async ({ session }) => {
      const entered = Promise.withResolvers<AbortSignal>()
      using facts = spyOn(SessionHistory, "executionMessages").mockImplementation(async (input) => {
        entered.resolve(input.signal!)
        await new Promise<void>((_, reject) =>
          input.signal!.addEventListener("abort", () => reject(input.signal!.reason), { once: true }),
        )
        return []
      })
      const base = { kind: "execution", scopeID: session.scope.id, sessionID: session.id, generation: 1 }
      const root = await ExecutionProjection.contribution().open({ ...base, demands: ["root"] }, () => {})
      const first = await ExecutionProjection.contribution().open({ ...base, demands: ["summary"] }, () => {})
      const signal = await entered.promise
      const second = await ExecutionProjection.contribution().open({ ...base, demands: ["summary"] }, () => {})
      first.dispose()
      await Bun.sleep(10)
      expect(signal.aborted).toBe(false)
      expect(facts).toHaveBeenCalledTimes(1)
      second.dispose()
      await Bun.sleep(10)
      expect(signal.aborted).toBe(true)
      root.dispose()
    }),
  ))

test("typed checkpoints retain a complete immutable projection and expire with their lease", () =>
  runtime.run(() =>
    fixture(async ({ session }) => {
      const frames: Array<Parameters<Parameters<ReturnType<typeof ExecutionProjection.contribution>["open"]>[1]>[0]> =
        []
      const lease = await ExecutionProjection.contribution().open(
        { kind: "execution", scopeID: session.scope.id, sessionID: session.id, generation: 1, demands: ["summary"] },
        (frame) => frames.push(frame),
      )
      const summary = await ExecutionService.summary(session.id)
      const large = {
        ...summary,
        revision: summary.revision + 10,
        rounds: Array.from({ length: 500 }, (_, index) => ({
          id: `round-${index}`,
          title: "large ".repeat(100),
          started: index,
          status: "completed" as const,
          elapsedMs: 1,
          elapsedActive: false,
          elapsedLowerBound: false,
        })),
      }
      lease.project({
        scopeID: session.scope.id,
        payload: {
          type: "execution.updated",
          properties: { ...ExecutionProjection.baseline(large), revision: large.revision },
        },
      })
      const token = frames.at(-1)!.payload.properties.snapshot as string
      const captured = ExecutionProjection.projectionCheckpoint(session.id, token)
      expect(ExecutionSchema.Projection.parse(captured).state).toBe("ready")
      expect(captured.contexts).toEqual([])
      if (captured.state !== "ready") throw new Error("Expected ready checkpoint")
      captured.summary.rounds.splice(0)
      const immutable = ExecutionProjection.projectionCheckpoint(session.id, token)
      expect(immutable.state === "ready" && immutable.summary.rounds.length).toBe(500)
      expect(() => ExecutionProjection.checkpoint(session.id, token)).toThrow()
      expect(() => ExecutionProjection.projectionCheckpoint("other", token)).toThrow()
      lease.dispose()
      expect(() => ExecutionProjection.projectionCheckpoint(session.id, token)).toThrow()
    }),
  ))
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
