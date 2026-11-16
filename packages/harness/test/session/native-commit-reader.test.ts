import { expect, test } from "bun:test"
import { RolloutEvents } from "@ericsanchezok/synergy-harness/session/rollout/events"
import { SessionPartCommit } from "@ericsanchezok/synergy-harness/session/part-commit"
import { RolloutJournal } from "../../src/session/rollout/journal"
import { RolloutArtifact } from "../../src/session/rollout/artifact"
import { Storage } from "../../src/storage/storage"
import { testRuntime } from "../support/runtime"

test("the public committed reader retains the exact original revision after later native publication", async () => {
  await using runtime = await testRuntime()
  await runtime.run(async () => {
    const owner = { kind: "operation", scopeID: "native_scope", operationID: crypto.randomUUID() } as const
    const key = [...RolloutArtifact.root(owner), "runs", "original_run", "info"]
    const value = {
      version: 1,
      id: "original_run",
      owner,
      started: 1,
      status: "running",
      recording: "partial",
    } satisfies Extract<RolloutEvents.Record, { kind: "run" }>["value"]
    const revision = await RolloutJournal.write(owner, key, value)
    await RolloutJournal.write(owner, key, { ...value, ended: 2, status: "completed", recording: "complete" })
    expect(await RolloutEvents.readCommitted(owner, revision)).toEqual({ kind: "run", value })
    const latest = await RolloutEvents.readCommitted(owner, revision + 1)
    expect(latest).toMatchObject({ kind: "run", value: { status: "completed", ended: 2 } })
    expect(await Storage.read(key)).toMatchObject({ status: "completed", recording: "complete" })
    await expect(
      RolloutEvents.readCommitted({ ...owner, operationID: crypto.randomUUID() }, revision),
    ).rejects.toThrow()
    const fact = SessionPartCommit.RecordCommitted.properties.parse({
      scopeID: "native",
      sessionID: "session",
      messageID: "message",
      partID: "part",
      revision: "1",
      removed: false,
    })
    expect(Object.keys(fact)).toEqual(["scopeID", "sessionID", "messageID", "partID", "revision", "removed"])
    expect(JSON.stringify(fact)).not.toContain("text")
  })
})
