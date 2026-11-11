import { expect, test } from "bun:test"
import { OrganizationApiTokenProtocol as Token } from "@ericsanchezok/synergy-organization-protocol"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { SessionInbox } from "@ericsanchezok/synergy-harness/session/inbox"
import { RolloutLedger } from "@ericsanchezok/synergy-harness/session/rollout/ledger"
import { RolloutLifecycle } from "@ericsanchezok/synergy-harness/session/rollout/lifecycle"
import { executionFixture } from "./support/execution"

test("an external API token creates a native Session, reconciles a lost HTTPS response and cancels its exact queued task", async () => {
  await using f = await executionFixture()
  const human = { headers: f.headers, throwOnError: true as const }
  const directory = (await f.client.orgSessions.get({ sessionID: f.sessionID }, human)).data
  const issued = await f.client.orgApiTokens.create(
    {
      orgApiTokenCreate: {
        requestID: "external-token",
        projectID: directory.projectID,
        label: "Business integration",
        operations: ["sessions.create", "sessions.configure", "sessions.input", "sessions.cancel", "sessions.read"],
        expiresAt: Date.now() + 60_000,
      },
    },
    human,
  )
  expect(issued.response.status).toBe(200)
  const token = Token.Created.parse(issued.data)
  const api = { headers: { authorization: `Bearer ${token.token}` }, throwOnError: true as const }
  const creation = {
    orgCommandCreateRequest: {
      schemaVersion: 1 as const,
      orgID: f.identity.orgID,
      projectID: directory.projectID,
      runtimeID: f.connection.connected.runtimeID,
      requestID: "external-create",
      creation: { operation: "create" as const, title: "External work" },
    },
  }
  const first = await f.client.orgSessions.create(creation, api)
  expect(first.response.status).toBe(202)
  const sessionID = first.data.effect.sessionID
  expect((await f.client.orgSessions.create(creation, api)).data.effect.sessionID).toBe(sessionID)
  await f.client.orgSessionResources.set(
    {
      sessionID,
      orgSessionResourceChange: {
        expectedRevision: 0,
        selection: { modelResourceID: f.model.resourceID, connectionResourceIDs: [] },
      },
    },
    api,
  )
  let responseLost = false
  f.interceptHTTP(async (request) => {
    if (
      responseLost ||
      request.method !== "POST" ||
      new URL(request.url).pathname !== `/org/v1/sessions/${sessionID}/commands`
    )
      return
    responseLost = true
    expect((await f.service.fetch(request)).status).toBe(202)
    return Response.json(
      {
        code: "SERVICE_UNAVAILABLE",
        outcome: "unknown",
        retryable: false,
        message: "Synthetic HTTPS acknowledgement loss",
      },
      { status: 503 },
    )
  })
  const input = {
    sessionID,
    orgCommandInputRequest: {
      schemaVersion: 1 as const,
      orgID: f.identity.orgID,
      projectID: directory.projectID,
      runtimeID: f.connection.connected.runtimeID,
      sessionID,
      requestID: "external-task",
      input: {
        operation: "input" as const,
        mode: "task" as const,
        parts: [{ type: "text" as const, text: "Keep the business record in the upper application" }],
      },
    },
  }
  const unknown = await f.client.orgCommands.input(input, { headers: api.headers })
  expect(unknown.response.status).toBe(503)
  expect(unknown.error).toMatchObject({ outcome: "unknown" })
  const receipt = (await f.client.orgCommands.lookup({ requestID: "external-task" }, api)).data
  expect(receipt.state).toBe("accepted")
  expect(receipt.accepted?.permit.actor).toMatchObject({
    subjectID: f.identity.accountID,
    clientKind: "api",
    tokenID: token.metadata.tokenID,
  })
  expect((await f.client.orgCommands.input(input, api)).response.status).toBe(200)
  const runID = await f.runtime.run(async () => {
    const items = await SessionInbox.list(sessionID)
    expect(items).toHaveLength(1)
    const item = items[0]
    if (!item?.message) throw new Error("Expected one retained native task payload")
    expect(item.message.actor).toMatchObject({
      subjectID: f.identity.accountID,
      clientKind: "api",
      tokenID: token.metadata.tokenID,
    })
    const native = await Session.get(sessionID)
    expect(native.organization?.projectID).toBe(directory.projectID)
    return item.messageID
  })
  const cancellation = {
    sessionID,
    orgCommandControlRequest: {
      schemaVersion: 1 as const,
      orgID: f.identity.orgID,
      projectID: directory.projectID,
      runtimeID: f.connection.connected.runtimeID,
      sessionID,
      requestID: "external-cancel",
      control: { operation: "cancel" as const, runID, controlVersion: 0 },
    },
  }
  const cancelled = (await f.client.orgCommands.control(cancellation, api)).data
  expect(cancelled.effect).toMatchObject({ operation: "cancel", runID, runStatusAtReception: "cancelled" })
  await f.runtime.run(async () => {
    expect(await SessionInbox.list(sessionID)).toHaveLength(0)
    expect((await RolloutLedger.getRun(RolloutLifecycle.owner(await Session.get(sessionID)), runID)).status).toBe(
      "cancelled",
    )
  })
  await f.connection.close()
  expect(
    (
      await f.client.orgSessions.create(
        { orgCommandCreateRequest: { ...creation.orgCommandCreateRequest, requestID: "offline-create" } },
        { headers: api.headers },
      )
    ).response.status,
  ).toBe(503)
  const revoked = await f.client.orgApiTokens.revoke(
    { tokenID: token.metadata.tokenID, orgApiTokenRevoke: { expectedRevision: 1 } },
    human,
  )
  expect(revoked.response.status).toBe(200)
  expect(
    (await f.client.orgCommands.lookup({ requestID: "external-task" }, { headers: api.headers })).response.status,
  ).toBe(401)
})
