import { afterAll, expect, test } from "bun:test"
import { testRuntime } from "../support/runtime"
import { fixture } from "../support/rollout"
import { RolloutTransportRecorder } from "../../src/session/rollout/transport-recorder"
import { RolloutSchema } from "../../src/session/rollout/schema"
import { RolloutArtifact } from "../../src/session/rollout/artifact"
import { RolloutMigration } from "../../src/session/rollout/migration"
import { Storage } from "../../src/storage/storage"
import { migrations } from "../../src/session/migration"

const runtime = await testRuntime()
afterAll(() => runtime.close())
test("historical price migration preserves saved estimates and rates and is idempotent", () =>
  runtime.run(() =>
    fixture(async ({ call }) => {
      const recorder = RolloutTransportRecorder.create(call)
      const attemptID = crypto.randomUUID()
      await recorder.emit({
        type: "attempt-start",
        attemptID,
        url: "https://api.deepseek.com/v1/chat/completions",
        method: "POST",
        mediaType: "application/json",
      })
      await recorder.emit({ type: "attempt-end", attemptID, status: "cancelled" })
      await recorder.finish()
      const key = [...RolloutArtifact.root(call.owner), "runs", call.runID, "attempts", call.id, attemptID]
      const current = RolloutSchema.AttemptRecord.parse(await Storage.read(key))
      const { pricingEvidence: _pricing, ...old } = current
      await Storage.write(key, old)
      await RolloutMigration.pricing(call.owner)
      const migrated = await Storage.read<typeof current>(key)
      expect(migrated.pricingEvidence).toEqual({ version: 1, source: "historical", pricing: call.model.pricing })
      expect(migrated.estimate).toEqual(old.estimate)
      await RolloutMigration.pricing(call.owner)
      expect(await Storage.read<typeof current>(key)).toEqual(migrated)
      expect(migrations).toContain(RolloutMigration.pricingMigration)
    }),
  ))
test("fresh attempts already contain immutable pricing evidence before settlement", () =>
  runtime.run(() =>
    fixture(async ({ call }) => {
      const recorder = RolloutTransportRecorder.create(call)
      const id = crypto.randomUUID()
      await recorder.emit({
        type: "attempt-start",
        attemptID: id,
        url: "https://fixture.test",
        method: "POST",
        mediaType: "application/json",
      })
      expect(
        RolloutSchema.AttemptRecord.parse(
          await Storage.read([...RolloutArtifact.root(call.owner), "runs", call.runID, "attempts", call.id, id]),
        ).pricingEvidence?.source,
      ).toBe("attempt")
      await recorder.finish()
    }),
  ))
