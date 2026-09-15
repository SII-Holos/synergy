import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { TransactionalStore } from "../../src/storage/transactional-store"

async function fixture() {
  const root = await fs.mkdtemp(path.join(process.env.SYNERGY_TEST_ROOT!, "verification-"))
  const store = await TransactionalStore.open({
    backend: "sqlite",
    namespace: "verify",
    filename: path.join(root, "agent.sqlite"),
  })
  return {
    store,
    async [Symbol.asyncDispose]() {
      await store.close()
      await fs.rm(root, { recursive: true, force: true })
    },
  }
}

test("verification checks logical identities and reports missing parent records", async () => {
  await using fixtureStore = await fixture()
  const { store } = fixtureStore
  await store.write(["sessions", "scope", "ses_one", "info"], { id: "ses_one", scope: { id: "scope" } })
  await store.write(["sessions", "scope", "ses_one", "messages", "msg_one", "parts", "part_one"], {
    id: "part_one",
    sessionID: "ses_one",
    messageID: "msg_one",
  })
  const broken = await store.verify()
  expect(broken.records).toBe(2)
  expect(broken.issues).toEqual([
    { key: ["sessions", "scope", "ses_one", "messages", "msg_one", "parts", "part_one"], reason: "missing_message" },
  ])
  await store.write(["sessions", "scope", "ses_one", "messages", "msg_one", "info"], {
    id: "msg_one",
    sessionID: "ses_one",
  })
  expect((await store.verify()).issues).toEqual([])
})
