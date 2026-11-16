import { expect, test } from "bun:test"
import {
  OrganizationCommandProtocol as Command,
  OrganizationRuntimeProtocol as Runtime,
} from "@ericsanchezok/synergy-organization-protocol"
import { createOrganizationClient } from "@ericsanchezok/synergy-sdk/organization"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { OrganizationStoragePath as Keys } from "../src/storage/path"
import { OrganizationRecord as Record } from "../src/storage/records"
import { organizationOpenApi } from "../src/http"
import { commandFixture } from "./support/commands"

function request(sessionID: string, requestID = "permission-command"): Command.DecisionRequest {
  return {
    schemaVersion: 1,
    orgID: "org",
    sessionID,
    projectID: "project",
    runtimeID: "runtime-alice",
    requestID,
    decision: { operation: "decision", kind: "permission", requestID: "permission-native", reply: "always" },
  }
}

test("shared collaborators keep the same confirmation options in archived projects while readers and private administrators cannot reply", async () => {
  await using f = await commandFixture()
  await f.connect()
  await f.run(async () => {
    await expect(f.commands.decision(f.credentials.admin, request(f.sessionID))).rejects.toMatchObject({
      data: { code: "NOT_FOUND" },
    })
    const session = (await Record.read(Record.SessionDirectory, Keys.session(f.sessionID)))!
    await Storage.write(Keys.session(f.sessionID), { ...session, shareState: "shared" })
    await expect(f.commands.decision(f.credentials.reader, request(f.sessionID))).rejects.toMatchObject({
      data: { code: "PERMISSION_DENIED" },
    })
    const project = (await Record.read(Record.Project, Keys.project("project")))!
    await Storage.write(Keys.project("project"), { ...project, state: "archived", revision: project.revision + 1 })
    const allowed = await f.commands.decision(f.credentials.bob, request(f.sessionID))
    expect(allowed.kind).toBe("admitted")
    if (allowed.kind !== "admitted") throw new Error("Expected native decision admission")
    expect(allowed.delivery.authorization.permit.actor.subjectID).toBe("bob")
    expect(allowed.delivery.decision).toEqual(request(f.sessionID).decision)
    expect(
      await Command.verify(
        allowed.delivery.authorization.permit,
        allowed.delivery.authorization.signature,
        f.signing.identity.publicKey,
      ),
    ).toBeTrue()
  })
})

test("the generated decision API forwards once, preserves winner attribution and keeps question answers out of service receipts", async () => {
  await using f = await commandFixture()
  const socket = await f.connect()
  let deliveries = 0
  socket.onmessage = (event) => {
    const frame = Runtime.ServerFrame.parse(JSON.parse(String(event.data)))
    if (frame.type !== "command" || frame.command.kind !== "decision") return
    deliveries++
    const { permit } = frame.command.delivery.authorization
    const result = Command.DecisionResult.parse({
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
        intakeSeq: 1,
        effect: {
          kind: "decision",
          sourceSessionID: permit.sessionID,
          requestID: frame.command.delivery.decision.requestID,
          decision: {
            status: "resolved",
            winner: {
              sessionID: permit.sessionID,
              requestID: frame.command.delivery.decision.requestID,
              actor: permit.actor,
              decidedAt: Date.now(),
              outcome: { kind: "question", reply: "answer" },
            },
          },
        },
      },
    })
    socket.send(
      JSON.stringify({
        type: "receipt",
        connectionEpoch: frame.connectionEpoch,
        exchangeID: frame.exchangeID,
        reply: { kind: "result", result },
      }),
    )
  }
  const client = createOrganizationClient({ baseUrl: f.baseUrl })
  const input: Command.DecisionRequest = {
    ...request(f.sessionID, "question-command"),
    decision: {
      operation: "decision",
      kind: "question",
      requestID: "question-native",
      reply: "answer",
      answers: [["fixture-private-question-value"]],
    },
  }
  const options = { headers: f.apiHeaders(), throwOnError: true as const }
  const first = (
    await client.orgSessionInteractions.reply({ sessionID: f.sessionID, orgCommandDecisionRequest: input }, options)
  ).data
  expect(first.effect).toMatchObject({
    kind: "decision",
    decision: { status: "resolved", winner: { actor: { subjectID: "alice" } } },
  })
  expect(
    (await client.orgSessionInteractions.reply({ sessionID: f.sessionID, orgCommandDecisionRequest: input }, options))
      .data,
  ).toEqual(first)
  expect(deliveries).toBe(1)
  const altered = await client.orgSessionInteractions.reply(
    {
      sessionID: f.sessionID,
      orgCommandDecisionRequest: {
        ...input,
        decision: {
          operation: "decision",
          kind: "question",
          requestID: input.decision.requestID,
          reply: "answer",
          answers: [["changed-value"]],
        },
      },
    },
    { headers: f.apiHeaders() },
  )
  expect(altered.error).toMatchObject({ code: "REVISION_CONFLICT" })
  await f.run(async () => {
    for await (const record of Storage.records({ limit: 32 }))
      expect(JSON.stringify(record.value)).not.toContain("fixture-private-question-value")
  })
  const spec = await organizationOpenApi()
  expect(spec.paths?.["/org/v1/sessions/{sessionID}/interactions/reply"]?.post).toMatchObject({
    operationId: "orgSessionInteractions.reply",
    requestBody: { required: true },
  })
})
