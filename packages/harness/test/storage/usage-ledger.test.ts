import { expect, test } from "bun:test"
import { testRuntime } from "../support/runtime"
import { RolloutLedger } from "../../src/session/rollout/ledger"
import { Storage } from "../../src/storage/storage"
import { UsageMigration } from "../../src/usage/migration"
import { UsageQuery } from "../../src/usage/query"
import { UsageLedger } from "../../src/usage/ledger"

const url = process.env.SYNERGY_TEST_POSTGRES_URL

test.skipIf(!url)(
  "PostgreSQL rebuild retains operation usage and honors indexed time ranges and explicit clearing",
  async () => {
    await using runtime = await testRuntime({ postgres: url })
    await runtime.run(async () => {
      const owner = { kind: "operation" as const, scopeID: "home", operationID: crypto.randomUUID() }
      const call = await RolloutLedger.beginCall({
        owner,
        runID: "historical",
        purpose: "title",
        request: {},
        model: { providerID: "fixture", modelID: "fixture", sdk: "@ai-sdk/openai", pricing: null, billingMode: "api" },
      })
      await RolloutLedger.finishCall(owner, call.runID, call.id, {
        status: "completed",
        sdkUsage: { inputTokens: 40, outputTokens: 10 },
      })
      await RolloutLedger.finishRun(owner, call.runID, "completed")
      await Storage.removeTree(["usage"])
      await Storage.removeTree(["usage_owner"])
      await UsageMigration.start()
      let progress = await UsageMigration.batch(1)
      for (let i = 0; i < 30 && progress.status !== "completed"; i++) progress = await UsageMigration.batch(8)
      expect(progress.status).toBe("completed")
      const filter = { scopeID: owner.scopeID }
      const summary = await UsageQuery.summary(filter)
      expect(summary.accounting.tokens.total.total).toBe(50)
      expect(
        (await UsageQuery.records({ ...filter, kind: "call", from: call.started, to: call.started + 1 })).items,
      ).toHaveLength(1)
      expect((await UsageQuery.records({ ...filter, kind: "call", to: call.started })).items).toHaveLength(0)
      await UsageLedger.clear(filter, summary.revision)
      await Storage.removeTree(["usage_owner"])
      await UsageLedger.captureOwner(owner)
      expect((await UsageQuery.records(filter)).items).toHaveLength(0)
    })
  },
  30000,
)
