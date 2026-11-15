import { expect, test } from "bun:test"
import { z } from "zod"
import { OrganizationQueuedSnapshotProtocol as Queued } from "../src/queued-snapshot"
import { signedProtocol } from "../src/signature"

function item(name: string): Queued.Item {
  return Queued.Item.parse({
    version: 1,
    sessionID: `session-${name}`,
    rootID: `root-${name}`,
    grantID: `grant-${name}`,
    acceptedHash: "a".repeat(64),
    entryID: `entry-${name}`,
    inboxID: `inbox-${name}`,
    inboxRevision: 1,
    inboxHash: "b".repeat(64),
    pausedSince: 2,
    controlVersion: 3,
    commandSeq: 4,
    intakeSeq: 5,
  })
}

test("queued snapshot digests the complete canonical body-free roster without accepting repeated roots or entries", async () => {
  const first = item("a"),
    second = item("b")
  const input = [second, first]
  const before = structuredClone(input)
  const digest = await Queued.digest(input)
  expect(await Queued.digest([first, second])).toBe(digest)
  expect(input).toEqual(before)
  expect(await Queued.digest([first])).not.toBe(digest)
  const changed = Queued.Item.parse({ ...first, inboxRevision: first.inboxRevision + 1 })
  expect(await Queued.digest([changed, second])).not.toBe(digest)
  for (const values of [
    [first, first],
    [first, { ...second, sessionID: first.sessionID, rootID: first.rootID }],
    [first, { ...second, entryID: first.entryID }],
  ]) {
    const result = await (async () => {
      try {
        return { ok: true as const, value: await Queued.digest(values) }
      } catch (error) {
        return { ok: false as const, error }
      }
    })()
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error("Repeated queued roster was accepted")
    expect(result.error).toBeInstanceOf(z.ZodError)
  }
  expect(Queued.Item.safeParse({ ...first, privateBody: "not part of the protocol" }).success).toBe(false)
})

test("queued snapshot real signatures bind the full roster hash, namespace, frozen owner and distinct purpose", async () => {
  const keys = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"])
  const other = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"])
  const publicKey = Buffer.from(await crypto.subtle.exportKey("raw", keys.publicKey)).toString("hex")
  const otherPublicKey = Buffer.from(await crypto.subtle.exportKey("raw", other.publicKey)).toString("hex")
  const items = [item("a"), item("b")]
  const proof = Queued.Proof.parse({
    version: 1,
    purpose: "native-queued-snapshot",
    orgID: "organization",
    deploymentIncarnation: "source-incarnation",
    runtimeID: "source-runtime",
    namespaceHash: "c".repeat(64),
    maintenanceID: "frozen-maintenance",
    count: items.length,
    itemsHash: await Queued.digest(items),
  })
  const signature = await Queued.sign(proof, keys.privateKey)
  expect(Queued.SignedProof.parse({ proof, signature })).toEqual({ proof, signature })
  expect(await Queued.verify(proof, signature, publicKey)).toBe(true)
  const changedItems = [Queued.Item.parse({ ...items[0]!, inboxHash: "d".repeat(64) }), items[1]!]
  const changedHash = await Queued.digest(changedItems)
  expect(changedHash).not.toBe(proof.itemsHash)
  for (const patch of [
    { itemsHash: changedHash },
    { count: proof.count + 1 },
    { namespaceHash: "e".repeat(64) },
    { maintenanceID: "another-maintenance" },
    { orgID: "another-organization" },
    { deploymentIncarnation: "another-incarnation" },
    { runtimeID: "another-runtime" },
  ]) {
    const changed = Queued.Proof.parse({ ...proof, ...patch })
    expect(await Queued.verify(changed, signature, publicKey)).toBe(false)
  }
  expect(await Queued.verify(proof, signature, otherPublicKey)).toBe(false)
  const altered = (signature.startsWith("0") ? "1" : "0") + signature.slice(1)
  expect(Queued.SignedProof.safeParse({ proof, signature: altered }).success).toBe(true)
  expect(await Queued.verify(proof, altered, publicKey)).toBe(false)
  const anotherDomain = signedProtocol(Queued.Proof, "synergy.organization.native-queued-snapshot.other.v1\n")
  const otherSignature = await anotherDomain.sign(proof, keys.privateKey)
  expect(await anotherDomain.verify(proof, otherSignature, publicKey)).toBe(true)
  expect(await Queued.verify(proof, otherSignature, publicKey)).toBe(false)
  expect(Queued.Proof.safeParse({ ...proof, purpose: "execution-retention-inspection" }).success).toBe(false)
})
