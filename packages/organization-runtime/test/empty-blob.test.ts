import { expect, test } from "bun:test"
import { openMemberConnection } from "../src/connection"
import { executionFixture } from "./support/execution"

test("verified WSS commits a zero-byte shared blob and HTTPS reads its exact empty bytes", async () => {
  await using f = await executionFixture()
  const options = { headers: f.headers, throwOnError: true as const }
  await f.client.orgSessions.share({ sessionID: f.sessionID, orgShareChange: { expectedShareGeneration: 0 } }, options)
  await f.connection.close()
  await using connection = await openMemberConnection({
    home: f.member.home,
    identity: f.member.identity,
    ca: f.ca,
    buildVersion: "empty-blob-fixture",
    sync: true,
  })
  const hash = new Bun.CryptoHasher("sha256").digest("hex")
  const input = { sessionID: f.sessionID, shareGeneration: 1, hash, offset: 0, totalBytes: 0, bytes: new Uint8Array() }
  await expect(connection.uploadBlob(input)).resolves.toMatchObject({
    complete: true,
    bytes: 0,
    receivedBytes: 0,
    hash,
  })
  await expect(connection.uploadBlob(input)).resolves.toMatchObject({ complete: true, bytes: 0, hash })
  const downloaded = await f.client.orgSessionSync.downloadBlob(
    { sessionID: f.sessionID, shareGeneration: 1, hash },
    { ...options, parseAs: "arrayBuffer" },
  )
  expect(downloaded.data).toEqual(new ArrayBuffer(0))
  expect(downloaded.response.headers.get("content-length")).toBe("0")
})
