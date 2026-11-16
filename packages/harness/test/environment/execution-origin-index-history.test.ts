import { expect, test } from "bun:test"
import { z } from "zod"
import { testRuntime } from "../support/runtime"
import { Storage } from "../../src/storage/storage"
import { StoragePath } from "../../src/storage/path"
import { EnvironmentExecutionSchema as Schema } from "../../src/environment/execution-schema"
import { EnvironmentExecutionOriginIndex as Index } from "../../src/environment/execution-origin-index"

async function records() {
  await using runtime = await testRuntime()
  return await runtime.run(async () => {
    for (const state of ["submitted", "completed"] as const) {
      const id = state,
        target = { environmentID: "environment", allocationID: "allocation", generation: 1 }
      const info = Schema.Info.parse({
        id,
        scopeID: "scope",
        target,
        digest: "command",
        state,
        outputCursor: 0,
        createdAt: 1,
        updatedAt: 1,
        origin:
          state === "completed"
            ? { kind: "host", owner: "fixture", invocationID: id }
            : {
                kind: "session",
                scopeID: "scope",
                sessionID: "session",
                rootID: "root",
                runID: "root",
                messageID: "message",
                callID: "call",
                tool: "bash",
              },
      })
      await Storage.transaction(async () => {
        await Storage.write(
          StoragePath.environmentExecution(info.scopeID, info.id),
          Schema.Record.parse({ schemaVersion: 2, execution: info }),
        )
        await Index.update(info)
        await Index.sealCoverage()
      })
    }
    const rows = new Map<string, unknown>()
    await Storage.snapshot(async (tx) => {
      for await (const entry of tx.exportEntries())
        if (entry.type === "record") rows.set(JSON.stringify(entry.key), entry.value)
    })
    return rows
  })
}
function inspect(rows: Map<string, unknown>) {
  const accepted: string[] = []
  Index.history(
    {
      read<T>(schema: z.ZodType<T>, key: string[]) {
        if (!rows.has(JSON.stringify(key))) throw new Error("Missing canonical historical record")
        return schema.parse(rows.get(JSON.stringify(key)))
      },
      *entries(prefix: string[]) {
        for (const [id, value] of rows) {
          const key = JSON.parse(id) as string[]
          if (prefix.every((part, index) => key[index] === part)) yield { key, value }
        }
      },
    },
    (key) => accepted.push(JSON.stringify(key)),
  )
  return accepted
}

test("historical origin indexes reuse their native producer and never accept execution bodies as index authority", async () => {
  const rows = await records()
  const accepted = inspect(rows)
  expect(accepted).toContain(JSON.stringify(["environment_execution_origin_index", "coverage"]))
  expect(accepted).toContain(JSON.stringify(["environment_execution_session", "scope", "session", "root", "submitted"]))
  expect(accepted).toContain(JSON.stringify(["environment_execution_environment", "environment", "scope", "submitted"]))
  expect(accepted).not.toContain(JSON.stringify(StoragePath.environmentExecution("scope", "completed")))
})

test("missing coverage and an unknown coverage version reject historical execution indexes", async () => {
  const rows = await records(),
    marker = JSON.stringify(["environment_execution_origin_index", "coverage"])
  rows.delete(marker)
  expect(() => inspect(rows)).toThrow("coverage")
  rows.set(marker, { version: 2 })
  expect(() => inspect(rows)).toThrow()
})

test("wrong historical locators, missing indexes and completed active entries remain blocked", async () => {
  const original = await records()
  const session = JSON.stringify(["environment_execution_session", "scope", "session", "root", "submitted"])
  const rows = new Map(original)
  rows.set(session, { version: 1, scopeID: "scope", operationID: "completed" })
  expect(() => inspect(rows)).toThrow()
  rows.delete(session)
  expect(() => inspect(rows)).toThrow()
  rows.set(session, original.get(session))
  rows.set(JSON.stringify(["environment_execution_environment", "environment", "scope", "completed"]), {
    version: 1,
    scopeID: "scope",
    operationID: "completed",
  })
  expect(() => inspect(rows)).toThrow("completed")
})
