import { expect, test } from "bun:test"
import { randomBytes } from "node:crypto"
import { SecretEnvelope } from "../../src/secrets/encrypted-store"

test("the canonical secret envelope binds exact recovery identity and rejects altered ciphertext", () => {
  const key = randomBytes(32)
  const identity = {
    authority: ["backup", "archive-one", "namespace-one"],
    id: "record-one",
    keyVersion: "recovery-one",
  }
  const bytes = Buffer.from("fixture recovery material")
  const sealed = SecretEnvelope.seal({ ...identity, key, bytes })
  expect(JSON.stringify(sealed)).not.toContain(bytes.toString())
  expect(SecretEnvelope.open({ ...identity, key, envelope: sealed })).toEqual(bytes)
  expect(() => SecretEnvelope.open({ ...identity, id: "other-record", key, envelope: sealed })).toThrow(
    "authentication",
  )
  expect(() =>
    SecretEnvelope.open({
      ...identity,
      authority: ["backup", "another-archive", "namespace-one"],
      key,
      envelope: sealed,
    }),
  ).toThrow("authentication")
  expect(() => SecretEnvelope.open({ ...identity, key: randomBytes(32), envelope: sealed })).toThrow("authentication")
  expect(() =>
    SecretEnvelope.open({ ...identity, key, envelope: { ...sealed, tag: Buffer.alloc(16).toString("base64") } }),
  ).toThrow("authentication")
  expect(() => SecretEnvelope.seal({ ...identity, key: randomBytes(16), bytes })).toThrow("256-bit")
})
