import { expect, test } from "bun:test"
import { fixture } from "../support/rollout"
import { rolloutTestRuntime } from "../support/rollout-runtime"
import { Storage } from "../../src/storage/storage"
import { StoragePath } from "../../src/storage/path"
import { RolloutArtifact } from "../../src/session/rollout/artifact"
import type { Identifier } from "../../src/id/id"

test("the recording fixture retains real session evidence and deletes its owner during cleanup", async () => {
  const runtime = await rolloutTestRuntime()
  try {
    await runtime.run(async () => {
      let key: string[] | undefined
      await fixture(async ({ session, call }) => {
        key = StoragePath.sessionInfo(call.owner.scopeID as Identifier.ScopeID, session.id as Identifier.SessionID)
        const artifact = await RolloutArtifact.writeText(call.owner, "retained bytes", "text/plain")
        expect(await Storage.read(key)).toMatchObject({ id: session.id })
        const chunks: Uint8Array[] = []
        for await (const chunk of RolloutArtifact.read(call.owner, artifact)) chunks.push(chunk)
        expect(Buffer.concat(chunks).toString()).toBe("retained bytes")
      })
      expect(key).toBeDefined()
      await expect(Storage.read(key!)).rejects.toBeInstanceOf(Storage.NotFoundError)
    })
  } finally {
    await runtime.close()
  }
})
