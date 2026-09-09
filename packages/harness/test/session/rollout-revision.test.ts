import { expect, test } from "bun:test"
import { fixture, complete } from "../support/rollout"
import { readRolloutRevision } from "../../src/session/rollout/revision"

test("rollout revision advances only through committed durable writes", async () => {
  await fixture(async ({ session, call }) => {
    const owner = { kind: "session" as const, scopeID: session.scope.id, sessionID: session.id }
    const before = await readRolloutRevision(owner)
    expect(before).toBeGreaterThan(0)
    await complete(call)
    expect(await readRolloutRevision(owner)).toBeGreaterThan(before)
    expect(await readRolloutRevision({ ...owner, sessionID: "ses_missing_revision" })).toBe(0)
  })
})
