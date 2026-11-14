import { expect, test } from "bun:test"
import path from "node:path"
import { RuntimeContext } from "@ericsanchezok/synergy-harness/lifecycle/context"
import { testRuntime } from "@ericsanchezok/synergy-harness/test/support/runtime"
import { OrganizationSyncProtocol as Sync } from "@ericsanchezok/synergy-organization-protocol"
import { createCommandIntake } from "../src/command-intake"
import { openMemberConnection } from "../src/connection"
import { enrollMemberRuntime } from "../src/enrollment"
import { prepareMemberHome } from "../src/home"
import { registerSessionSchema } from "../src/session-schema"
import { fixture } from "./support/organization"

function batch(
  events: Sync.Event[],
  input: Omit<Sync.Batch, "schemaVersion" | "firstSeq" | "lastSeq" | "events" | "payloadHash">,
) {
  const firstSeq = events[0]!.sequence
  const lastSeq = events.at(-1)!.sequence
  return Sync.Batch.parse({
    ...input,
    schemaVersion: 1,
    firstSeq,
    lastSeq,
    events,
    payloadHash: new Bun.CryptoHasher("sha256").update(JSON.stringify({ firstSeq, lastSeq, events })).digest("hex"),
  })
}

test("creator HTTP credentials cannot replace the current Runtime shared projection producer", async () => {
  await using f = await fixture()
  const member = await prepareMemberHome({
    baseDirectory: path.join(f.root, "members"),
    identity: f.identity,
    origin: f.origin,
  })
  await enrollMemberRuntime({
    home: member.home,
    identity: member.identity,
    ca: f.ca,
    ticket: await f.ticket(member.identity.deviceID, member.publicKey),
  })
  await using runtime = await testRuntime({
    home: path.join(f.root, "agent"),
    register: () => registerSessionSchema({ orgID: f.identity.orgID }),
  })
  const context = await runtime.run(() => RuntimeContext.current())
  await using connection = await openMemberConnection({
    home: member.home,
    identity: member.identity,
    ca: f.ca,
    buildVersion: "sync-writer-fixture",
    sync: true,
    commands(current, signal) {
      const intake = createCommandIntake({
        identity: current.signingIdentity,
        runtimeID: current.runtimeID,
        accountID: f.identity.accountID,
        connectionEpoch: current.connectionEpoch,
        signal,
      })
      return {
        create: context.bind(intake.create),
        input: context.bind(intake.input),
        decision: context.bind(intake.decision),
        control: context.bind(intake.control),
        query: context.bind(intake.query),
        skip: context.bind(intake.skip),
      }
    },
  })
  const options = { headers: f.headers, throwOnError: true as const }
  const project = (
    await f.client.orgProjects.create({ orgProjectCreate: { name: "Sync writer", description: "" } }, options)
  ).data
  const created = (
    await f.client.orgSessions.create(
      {
        orgCommandCreateRequest: {
          schemaVersion: 1,
          orgID: f.identity.orgID,
          requestID: "create-sync-writer",
          projectID: project.projectID,
          runtimeID: connection.connected.runtimeID,
          creation: { operation: "create" },
        },
      },
      options,
    )
  ).data
  const sessionID = created.effect.sessionID
  const shared = (
    await f.client.orgSessions.share({ sessionID, orgShareChange: { expectedShareGeneration: 0 } }, options)
  ).data
  const directory = (await f.client.orgSessions.get({ sessionID }, options)).data
  const binding = {
    sessionID,
    projectID: project.projectID,
    bindingEpoch: shared.bindingEpoch,
    shareGeneration: shared.shareGeneration,
  }
  const projection = Sync.Event.parse({
    type: "session",
    sequence: shared.nextSeq,
    session: {
      ...binding,
      creatorID: f.identity.accountID,
      driverRuntimeID: connection.connected.runtimeID,
      createdAt: directory.createdAt,
      title: "Runtime projection",
    },
  })
  const pending = batch([projection], binding)
  const transport = new Bun.FetchSession({ tls: { ca: f.ca, rejectUnauthorized: true }, proxy: false })
  try {
    const headers = { ...f.headers, origin: "https://organization.example" }
    const projectionWrite = await transport.fetch(`${f.origin}/org/v1/sessions/${sessionID}/sync/batches`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify(pending),
    })
    const checkpoint = (await f.client.orgSessions.shareState({ sessionID }, options)).data
    const rejectedEvents = (await f.client.orgSessionSync.events({ sessionID, limit: 10 }, options)).data
    await projectionWrite.arrayBuffer()

    expect([403, 404, 405]).toContain(projectionWrite.status)
    expect(checkpoint).toEqual(shared)
    expect(rejectedEvents.items).toEqual([])

    await expect(connection.sync(pending)).resolves.toMatchObject({
      nextSeq: shared.nextSeq + 1,
      shareGeneration: shared.shareGeneration,
      syncState: "synced",
    })
    const events = (await f.client.orgSessionSync.events({ sessionID, limit: 10 }, options)).data
    expect(events.items).toEqual([projection])
    expect(events.nextSeq).toBe(shared.nextSeq + 1)
  } finally {
    await transport.close()
  }
})
