import { expect, test } from "bun:test"
import path from "node:path"
import { createHash } from "node:crypto"
import { OrganizationHandoffObjectProtocol as Objects } from "@ericsanchezok/synergy-organization-protocol"
import { fixture } from "./support/organization"
import { prepareMemberHome } from "../src/home"
import { enrollMemberRuntime } from "../src/enrollment"
import { openMemberConnection } from "../src/connection"

test("the connection privately signs a fresh bounded handoff range for every generated HTTPS call and checks immutable responses", async () => {
  await using f = await fixture()
  const member = await prepareMemberHome({
    baseDirectory: path.join(f.root, "member"),
    identity: f.identity,
    origin: f.origin,
  })
  const registration = await enrollMemberRuntime({
    home: member.home,
    identity: member.identity,
    ticket: await f.ticket(member.identity.deviceID, member.publicKey),
    ca: f.ca,
  })
  await using connection = await openMemberConnection({
    home: member.home,
    identity: member.identity,
    ca: f.ca,
    buildVersion: "object-read-client",
  })
  const content = Buffer.alloc(128 * 1024 + 17, 37)
  const hash = createHash("sha256").update(content).digest("hex")
  const reference = {
    schemaVersion: 1 as const,
    orgID: registration.orgID,
    deploymentIncarnation: registration.deploymentIncarnation,
    handoffID: "private-copy",
    sessionID: "copy-session",
    sourceRuntimeID: "source-machine",
    targetRuntimeID: registration.runtimeID,
    fromEpoch: 1,
    toEpoch: 2,
    mappingPlanRevision: 1,
    shareGeneration: 1,
    manifestHash: "a".repeat(64),
  }
  const proofs: Objects.Proof[] = []
  let mode: "valid" | "changed" | "denied" = "valid"
  f.interceptHTTP(async (request) => {
    if (!request.url.endsWith("/runtime/v1/handoffs/object")) return
    const signed = Objects.Request.parse(await request.json())
    expect(await Objects.verify(signed.proof, signed.signature, member.publicKey)).toBe(true)
    expect(request.headers.get("cookie")).toBeNull()
    expect(request.headers.get("origin")).toBeNull()
    expect(signed.proof).toMatchObject({
      ...reference,
      runtimeID: registration.runtimeID,
      connectionEpoch: connection.connected.connectionEpoch,
    })
    proofs.push(signed.proof)
    if (mode === "denied")
      return Response.json(
        { code: "PERMISSION_DENIED", message: "Destination access was revoked", outcome: "rejected", retryable: false },
        { status: 403 },
      )
    const { range } = signed.proof
    const nextOffset = Math.min(content.length, range.offset + range.length)
    return Response.json({
      hash: mode === "changed" ? "b".repeat(64) : range.hash,
      offset: range.offset,
      nextOffset,
      totalBytes: content.length,
      data: content.subarray(range.offset, nextOffset).toString("base64url"),
      complete: nextOffset === content.length,
    })
  })
  const first = await connection.resources.handoffObject(reference, { hash, offset: 0, length: 128 * 1024 })
  expect(Buffer.from(first.data, "base64url")).toEqual(content.subarray(0, 128 * 1024))
  expect(first.complete).toBe(false)
  expect(
    (await connection.resources.handoffObject(reference, { hash, offset: first.nextOffset, length: 128 * 1024 }))
      .complete,
  ).toBe(true)
  expect(proofs).toHaveLength(2)
  expect(proofs[0].requestID).not.toBe(proofs[1].requestID)
  expect(proofs.every((proof) => proof.expiresAt - proof.issuedAt === 15_000)).toBe(true)
  await expect(
    connection.resources.handoffObject(
      { ...reference, targetRuntimeID: "another-machine" },
      { hash, offset: 0, length: 1 },
    ),
  ).rejects.toThrow()
  await expect(
    connection.resources.handoffObject(reference, { hash, offset: 0, length: 128 * 1024 + 1 }),
  ).rejects.toThrow()
  expect(proofs).toHaveLength(2)
  mode = "changed"
  await expect(connection.resources.handoffObject(reference, { hash, offset: 0, length: 1 })).rejects.toMatchObject({
    data: { code: "PROTOCOL_MISMATCH" },
  })
  mode = "denied"
  await expect(connection.resources.handoffObject(reference, { hash, offset: 0, length: 1 })).rejects.toMatchObject({
    data: { code: "PERMISSION_DENIED", outcome: "rejected" },
  })
}, 15000)
