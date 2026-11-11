import fs from "node:fs/promises"
import path from "node:path"
import { createHash } from "node:crypto"
import { z } from "zod"
import { readCredentials } from "../../src/credentials"
import { readRecord } from "../../src/record"

// The version-1 startup reader is retained to exercise the real previous strict file contract in Node.
const Owner = z.strictObject({ schemaVersion: z.literal(1), owner: z.string(), identity: z.string() })
const Identity = z.union([
  z.strictObject({ orgID: z.string(), hostID: z.string() }),
  z.strictObject({ orgID: z.string(), accountID: z.string(), deviceID: z.string() }),
])
const Binding = z.strictObject({
  schemaVersion: z.literal(1),
  identity: Identity,
  origin: z.string(),
  state: z.literal("ready"),
  publicKey: z.string(),
})
const home = process.argv[2]
const expected = Identity.parse(JSON.parse(process.argv[3]))
const root = path.join(home, ".synergy")
const owner = Owner.parse(JSON.parse(await fs.readFile(path.join(root, "home-ownership.json"), "utf8")))
const binding = await readRecord(path.join(root, "organization.json"), Binding, "identity records")
const digest = createHash("sha256")
  .update(
    JSON.stringify(
      "accountID" in expected
        ? [expected.orgID, expected.accountID, expected.deviceID]
        : ["hosted", expected.orgID, expected.hostID],
    ),
  )
  .digest("hex")
if (
  !binding ||
  owner.owner !== "organization-runtime" ||
  owner.identity !== digest ||
  JSON.stringify(binding.identity) !== JSON.stringify(expected)
)
  throw new Error("Legacy Runtime identity changed")
const credentials = await readCredentials(root)
if (credentials?.publicKey !== binding.publicKey) throw new Error("Legacy Runtime credentials changed")
process.stdout.write("ready")
