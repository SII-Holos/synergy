import { afterAll, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { TransactionalStore } from "../../src/storage/transactional-store"
import { RecordCodec } from "../../src/storage/record-codec"

interface Connection {
  query(statement: string, values?: unknown[]): Promise<Array<Record<string, unknown>>>
}
interface DriverInternals extends Connection {
  transaction<T>(body: (connection: Connection) => Promise<T>): Promise<T>
}

const root = await fs.mkdtemp(path.join(process.env.SYNERGY_TEST_ROOT!, "record-body-"))

afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

function driver(store: TransactionalStore) {
  return (store as unknown as { driver: DriverInternals }).driver
}

test("a compressible record survives the store round-trip in whatever form the column holds", async () => {
  const store = await TransactionalStore.open({
    backend: "sqlite",
    namespace: "body",
    filename: path.join(root, "agent.sqlite"),
  })
  try {
    // A body well above the compression floor, so the write path takes the frame
    // branch rather than storing plain JSON.
    const value = { evidence: "durable rollout payload ".repeat(400) }
    expect(RecordCodec.encode(value)).toBeInstanceOf(Uint8Array)
    await store.write(["rollout", "run", "info"], value)

    // The read path must accept the column's own type rather than assuming a
    // string. `strict` mode reports a blob as a Uint8Array, which is exactly what
    // the frame decoder takes.
    const stored = await driver(store).query(
      "SELECT typeof(body) AS kind, length(body) AS bytes FROM storage_records WHERE namespace = ?",
      ["body"],
    )
    expect(stored).toHaveLength(1)
    expect(String(stored[0]!.kind)).toBe("blob")
    expect(await store.read<typeof value>(["rollout", "run", "info"])).toEqual(value)
  } finally {
    await store.close()
  }
})

test("a small record is still stored as text so an earlier reader can parse it", async () => {
  const store = await TransactionalStore.open({
    backend: "sqlite",
    namespace: "body-small",
    filename: path.join(root, "small.sqlite"),
  })
  try {
    await store.write(["small"], { v: 1 })
    const stored = await driver(store).query("SELECT typeof(body) AS kind FROM storage_records WHERE namespace = ?", [
      "body-small",
    ])
    expect(String(stored[0]!.kind)).toBe("text")
    expect(await store.read<{ v: number }>(["small"])).toEqual({ v: 1 })
  } finally {
    await store.close()
  }
})
