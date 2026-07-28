import { describe, expect, test } from "bun:test"
import { assertBrowserHostArchive } from "../script/browser-host-archive.js"

const archive = Buffer.from(
  "UEsDBBQAAAAIAFCz+1z9EyfPBgAAAAQAAAAUAAAAc3luZXJneS1icm93c2VyLWhvc3TLyC8uAQBQSwECFAMUAAAACABQs/tc/RMnzwYAAAAEAAAAFAAAAAAAAAAAAAAAgAEAAAAAc3luZXJneS1icm93c2VyLWhvc3RQSwUGAAAAAAEAAQBCAAAAOAAAAAAA",
  "base64",
)

describe("Browser Host release archive", () => {
  test("contains the executable declared by its signed manifest", async () => {
    await expect(assertBrowserHostArchive(archive, "synergy-browser-host")).resolves.toBeUndefined()
  })

  test("rejects a manifest executable absent from the archive", async () => {
    await expect(assertBrowserHostArchive(archive, "wrong-browser-host")).rejects.toThrow(
      "Browser Host archive does not contain its manifest executable",
    )
  })
})
