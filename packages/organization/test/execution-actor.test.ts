import { expect, test } from "bun:test"
import {
  OrganizationCommandProtocol as Command,
  OrganizationExecutionProtocol as Execution,
} from "@ericsanchezok/synergy-organization-protocol"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { executionFixture } from "./support/execution"
import { OrganizationApiTokens } from "../src/auth/api-tokens"
import { ApiTokenRecord, apiTokenKeys } from "../src/auth/api-token-record"

test("a retained API execution rechecks its original token without imposing interactive-only policy on its task", async () => {
  await using f = await executionFixture({ endpoint: "https://provider.example/v1" })
  const issued = await f.run(() =>
    OrganizationApiTokens.create(f.credentials.alice, {
      requestID: "execution-api-token",
      projectID: "project",
      label: "Accepted task",
      operations: ["sessions.input", "sessions.read"],
      expiresAt: Date.now() + 60_000,
    }),
  )
  if (!issued.token) throw new Error("The actual API token owner did not issue its private credential")
  const token = issued.token
  const admitted = await f.run(() =>
    f.commands.input(
      { kind: "api", token, apiOperation: "sessions.input" },
      {
        ...f.request(),
        requestID: "api-execution-task",
        input: { operation: "input", mode: "task", parts: [{ type: "text", text: "Perform the selected task" }] },
      },
    ),
  )
  if (admitted.kind !== "admitted") throw new Error("The original API task was not admitted")
  const permit = admitted.delivery.authorization.permit
  expect(permit.actor.tokenID).toBe(issued.metadata.tokenID)
  const receipt = Command.InputResult.parse({
    attempt: {
      schemaVersion: 1,
      permit,
      receivedAt: Date.now(),
      status: "accepted",
      acceptedAttemptID: permit.attemptID,
    },
    accepted: {
      schemaVersion: 1,
      permit,
      acceptedAt: Date.now(),
      intakeSeq: 2,
      effect: { kind: "inbox", mode: "task", itemID: "api-task", messageID: "msg_api_task" },
    },
  })
  const proof = Execution.BindingProof.parse({
    ...f.binding.proof,
    receipt,
    rootID: receipt.accepted?.effect.messageID,
  })
  const bound = { proof, signature: await Execution.signBinding(proof, f.machineKeys.privateKey) }
  const grant = await f.run(() => f.execution.bind(bound))
  const { rootID, ...received } = proof
  const description = Execution.DescriptionProof.parse({ ...received, purpose: "execution-resource-description" })
  const request = {
    proof: description,
    signature: await Execution.signDescription(description, f.machineKeys.privateKey),
  }
  expect((await f.run(() => f.execution.describe(request))).grant.grantID).toBe(grant.grantID)
  const original = await f.run(() =>
    Storage.read(apiTokenKeys.record(issued.metadata.tokenID)).then((value) => ApiTokenRecord.parse(value)),
  )
  for (const changed of [
    { ...original, revokedAt: Date.now() },
    { ...original, expiresAt: Date.now() - 1 },
    { ...original, projectID: "another-project" },
    { ...original, operations: ["sessions.read"] },
    { ...original, authRevision: original.authRevision + 1 },
  ]) {
    await f.run(() => Storage.write(apiTokenKeys.record(original.tokenID), ApiTokenRecord.parse(changed)))
    await expect(f.run(() => f.execution.describe(request))).rejects.toMatchObject({
      data: { code: "PERMISSION_DENIED" },
    })
  }
  await f.run(() => Storage.write(apiTokenKeys.record(original.tokenID), original))
  expect((await f.run(() => f.execution.describe(request))).grant.grantID).toBe(grant.grantID)
  await f.run(() =>
    OrganizationApiTokens.revoke(f.credentials.alice, original.tokenID, { expectedRevision: original.revision }),
  )
  const release = Execution.ReleaseProof.parse({
    ...received,
    rootID,
    purpose: "execution-resources-release",
    generation: 1,
    outcome: "cancelled",
    materialized: true,
  })
  const signedRelease = { proof: release, signature: await Execution.signRelease(release, f.machineKeys.privateKey) }
  expect((await f.run(() => f.execution.release(signedRelease))).grantID).toBe(grant.grantID)
})
