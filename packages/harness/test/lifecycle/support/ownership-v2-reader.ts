import fs from "node:fs/promises"
import path from "node:path"
import { z } from "zod"

// Retain the ownership formats from 68fba4592 instead of importing a newer reader's refusal.
const fields = {
  owner: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
  identity: z.string().regex(/^[a-f0-9]{64}$/),
}
const released = z.discriminatedUnion("schemaVersion", [
  z.strictObject({ schemaVersion: z.literal(1), ...fields }),
  z.strictObject({
    schemaVersion: z.literal(2),
    ...fields,
    readerContract: z.string().regex(/^[a-z][a-z0-9-]{0,127}$/),
  }),
])
const [root, operation, probe, storage] = process.argv.slice(2)
released.parse(JSON.parse(await fs.readFile(path.join(root!, "home-ownership.json"), "utf8")))
if (operation === "credentials") {
  await fs.readFile(path.join(root!, "auth", "organization-runtime.json"))
  await fs.writeFile(probe!, "credentials-read")
} else {
  await fs.writeFile(probe!, "database-open")
  const { TransactionalStore }: typeof import("../../../src/storage/transactional-store") = await import(storage!)
  const store = await TransactionalStore.open({
    backend: "sqlite",
    namespace: "restoration",
    filename: path.join(root!, "data", "restore.sqlite"),
  })
  try {
    await store.write(["released-reader", "publication"], "legacy-write")
  } finally {
    await store.close()
  }
}
