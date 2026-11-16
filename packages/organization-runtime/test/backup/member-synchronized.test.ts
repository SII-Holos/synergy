import { expect, spyOn, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { createHash, randomBytes } from "node:crypto"
import { z } from "zod"
import { createOrganizationClient } from "@ericsanchezok/synergy-sdk/organization"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { RolloutArtifact } from "@ericsanchezok/synergy-harness/session/rollout/artifact"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { EnvironmentExecution } from "@ericsanchezok/synergy-harness/environment/execution"
import { HomeOwnershipFile } from "@ericsanchezok/synergy-harness/lifecycle/home-ownership-file"
import {
  OrganizationRuntimeProtocol as Runtime,
  OrganizationSyncProtocol as Sync,
  OrganizationResourceProtocol as Resource,
  OrganizationProtocol,
} from "@ericsanchezok/synergy-organization-protocol"
import { cert, key as tlsKey } from "@ericsanchezok/synergy-testing/organization-tls"
import { OrganizationBackupAdministration as Backup } from "../../../organization/src/backup/administration"
import { OrganizationRecoveryAdministration as Recovery } from "../../../organization/src/backup/administration-recovery"
import { OrganizationBackupCohort as Cohort } from "../../../organization/src/backup/cohort"
import { OrganizationRecoveryArchive as Archive } from "../../../organization/src/backup/archive"
import { openOrganizationService } from "@ericsanchezok/synergy-organization/service"
import { prepareMemberHome } from "../../src/home"
import { enrollMemberRuntime } from "../../src/enrollment"
import { readMemberRegistration } from "../../src/registration"
import { openMemberRuntime } from "../../src/runtime"
import { OrganizationSyncPath } from "../../src/storage/path"
import { fixture } from "../support/organization"
import { OrganizationRecord } from "../../../organization/src/storage/records"
import { OrganizationStoragePath } from "../../../organization/src/storage/path"

const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex")
function binary(value: unknown) {
  if (!(value instanceof ArrayBuffer)) throw new Error("Shared attachment download did not return actual bytes")
  return new Uint8Array(value)
}

async function port() {
  const listener = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() })
  const selected = listener.port!
  await listener.stop(true)
  return selected
}

async function login(client: ReturnType<typeof createOrganizationClient>, loginName: string, password: string) {
  const result = await client.orgAuth.login({ orgLoginInput: { loginName, password } }, { throwOnError: true })
  const cookie = result.response.headers.get("set-cookie")?.split(";")[0]
  if (!cookie) throw new Error("Fresh restored login did not establish its actual session")
  return { cookie, "x-csrf-token": result.data.csrfToken }
}

test("ACKed Member projections and attachments recover without owning its offline private Home", async () => {
  using submitted = spyOn(EnvironmentExecution, "start")
  await using service = await fixture()
  const ownerOptions = { headers: service.headers, throwOnError: true as const }
  const project = (
    await service.client.orgProjects.create({ orgProjectCreate: { name: "Member checkpoint" } }, ownerOptions)
  ).data
  const invitation = (await service.client.orgInvites.create({ orgInviteCreate: { role: "member" } }, ownerOptions))
    .data
  const password = "a separate synchronized reader password"
  const reader = (
    await service.client.orgInvites.consume(
      {
        orgInviteConsume: {
          token: invitation.token,
          requestID: "member-recovery-reader",
          loginName: "checkpoint-reader",
          displayName: "Checkpoint reader",
          password,
        },
      },
      { throwOnError: true },
    )
  ).data
  const readerHeaders = await login(service.client, "checkpoint-reader", password)
  await service.client.orgProjects.member(
    {
      projectID: project.projectID,
      accountID: reader.accountID,
      orgProjectMemberChange: { expectedRevision: project.revision, role: "reader" },
    },
    ownerOptions,
  )
  const member = await prepareMemberHome({
    baseDirectory: path.join(service.root, "members"),
    identity: service.identity,
    origin: service.origin,
  })
  await enrollMemberRuntime({
    home: member.home,
    identity: member.identity,
    ca: service.ca,
    ticket: await service.ticket(member.identity.deviceID, member.publicKey),
  })
  const registration = await readMemberRegistration(member.home, member.identity)
  if (!registration) throw new Error("Original Member enrollment is missing")
  const privateFile = path.join(member.home, "unuploaded-private-sentinel.txt")
  const privateBytes = Buffer.from("Member-only bytes are excluded from organization backup")
  await Bun.write(privateFile, privateBytes)
  const online = Promise.withResolvers<void>()
  let forwarded = 0
  service.interceptFrames((_socket, raw) => {
    const frame = Runtime.ClientFrame.parse(JSON.parse(String(raw)))
    if (frame.type === "heartbeat") online.resolve()
    return false
  })
  await using runtime = await openMemberRuntime({
    home: member.home,
    identity: member.identity,
    ca: service.ca,
    listen: { port: await port(), token: "c".repeat(64) },
  })
  const timeout = setTimeout(() => online.reject(new Error("Original Member did not connect")), 3000)
  try {
    await online.promise
  } finally {
    clearTimeout(timeout)
  }
  const created = (
    await service.client.orgSessions.create(
      {
        orgCommandCreateRequest: {
          schemaVersion: 1,
          orgID: member.identity.orgID,
          projectID: project.projectID,
          runtimeID: registration.runtimeID,
          requestID: "member-acknowledged-session",
          creation: { operation: "create", title: "Uploaded checkpoint" },
        },
      },
      ownerOptions,
    )
  ).data
  const sessionID = created.effect.sessionID
  using model = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      forwarded++
      return new Response("Unexpected model execution", { status: 500 })
    },
  })
  const selectedModel = (
    await service.client.orgResources.create(
      {
        orgResourceCreate: {
          name: "Never replayed",
          scope: { kind: "project", projectID: project.projectID },
          configuration: {
            protocol: "openai-compatible",
            endpoint: new URL("/v1", model.url).href,
            model: Resource.Model.parse({
              id: "checkpoint",
              name: "Checkpoint",
              limit: { context: 8192, output: 1024 },
            }),
          },
          credential: { kind: "none" },
        },
      },
      ownerOptions,
    )
  ).data
  await service.client.orgResourceGrants.set(
    {
      resourceID: selectedModel.resourceID,
      kind: "project",
      subjectID: project.projectID,
      orgResourceGrantChange: { expectedRevision: 0, enabled: true },
    },
    ownerOptions,
  )
  await service.client.orgSessionResources.set(
    {
      sessionID,
      orgSessionResourceChange: {
        expectedRevision: 0,
        selection: {
          modelResourceID: selectedModel.resourceID,
          connectionResourceIDs: [],
          infrastructure: { workspace: null, environment: null },
        },
      },
    },
    ownerOptions,
  )
  const paused = (
    await service.client.orgCommands.control(
      {
        sessionID,
        orgCommandControlRequest: {
          schemaVersion: 1,
          orgID: member.identity.orgID,
          projectID: project.projectID,
          runtimeID: registration.runtimeID,
          sessionID,
          requestID: "pause-member-checkpoint",
          control: { operation: "pause" },
        },
      },
      ownerOptions,
    )
  ).data
  if (paused.effect.operation !== "pause") throw new Error("Expected actual original pause receipt")
  const control = paused.effect
  const text = "Shared Member checkpoint text"
  const attachmentBytes = Buffer.from([0, 255, 37, 128, 10, 42])
  const hash = digest(attachmentBytes)
  await runtime.run(async () => {
    const session = await Session.get(sessionID)
    await ScopeContext.provide({
      scope: session.scope,
      workspace: session.workspace,
      fn: async () => {
        const messageID = "msg_member_checkpoint"
        await Session.updateMessage({
          id: messageID,
          sessionID,
          role: "user",
          agent: "general",
          model: { providerID: "fixture", modelID: "checkpoint" },
          time: { created: Date.now() },
        })
        await Session.updatePart({ id: "prt_member_text", sessionID, messageID, type: "text", text })
        const artifact = await RolloutArtifact.write(
          { kind: "session", scopeID: session.scope.id, sessionID },
          (async function* () {
            yield attachmentBytes
          })(),
          "application/octet-stream",
        )
        await Session.updatePart({
          id: "prt_member_attachment",
          sessionID,
          messageID,
          type: "attachment",
          artifact,
          filename: "checkpoint.bin",
          mime: "application/octet-stream",
          url: "attachment://member-checkpoint",
        })
        await Session.flushPartWrites(sessionID)
      },
    })
  })
  const shared = (
    await service.client.orgSessions.share({ sessionID, orgShareChange: { expectedShareGeneration: 0 } }, ownerOptions)
  ).data
  let events: Sync.Event[] = []
  const deadline = Date.now() + 15_000
  for (;;) {
    const page = (await service.client.orgSessionSync.events({ sessionID, limit: 128 }, ownerOptions)).data
    events = Sync.Event.array().parse(page.items)
    const acknowledged = await runtime.run(async () => {
      const [state, pending] = await Storage.readMany([
        OrganizationSyncPath.state(member.identity.orgID, sessionID),
        OrganizationSyncPath.batch(member.identity.orgID, sessionID),
      ])
      return (
        z
          .object({ syncState: z.literal("synced") })
          .passthrough()
          .safeParse(state).success &&
        pending === undefined &&
        (await Storage.queryKeys({ prefix: OrganizationSyncPath.drafts(member.identity.orgID, sessionID), limit: 1 }))
          .length === 0
      )
    })
    if (
      acknowledged &&
      events.some(
        (event) =>
          event.type === "part" &&
          event.part?.type === "text" &&
          event.part.content.kind === "inline" &&
          event.part.content.text === text,
      ) &&
      events.some((event) => event.type === "attachment" && event.hash === hash && event.state === "available")
    )
      break
    if (Date.now() >= deadline) throw new Error("Original Member text/attachment were not actually ACKed")
    await Bun.sleep(25)
  }
  const originalBlob = await service.client.orgSessionSync.downloadBlob(
    { sessionID, hash, shareGeneration: shared.shareGeneration },
    { ...ownerOptions, parseAs: "arrayBuffer" },
  )
  expect(digest(binary(originalBlob.data))).toBe(hash)
  expect(
    (
      await service.client.orgSessionSync.events(
        { sessionID, limit: 128 },
        { headers: readerHeaders, throwOnError: true },
      )
    ).data.items,
  ).toEqual(events)
  await runtime.close()
  events = Sync.Event.array().parse(
    (await service.client.orgSessionSync.events({ sessionID, limit: 128 }, ownerOptions)).data.items,
  )
  const checkpoint = (await service.client.orgSessions.shareState({ sessionID }, ownerOptions)).data
  const memberMarker = path.join(member.home, ".synergy", "home-ownership.json")
  const originalMarker = await Bun.file(memberMarker).text()
  const material = randomBytes(32)
  const keys = {
    async current() {
      return { version: "member-checkpoint", key: material }
    },
    async resolve() {
      return material
    },
  }
  const directory = path.join(service.root, "member-h0")
  const targetHome = path.join(service.root, "restored-service")
  try {
    await service.service.close()
    await Backup.capture({ home: service.service.home, directory, buildVersion: "fixture", keys })
    const opened = path.join(service.root, "opened-h0")
    await Archive.open({ directory, outputDirectory: opened, keys })
    const inventory = Cohort.Inventory.parse(await Bun.file(path.join(opened, "cohort.json")).json())
    expect(inventory.namespaces).toBe(1)
    expect(inventory.memberCoverage).toBe("uploaded-service-data-only")
    expect(inventory.restoredExecution).toBe("blocked-until-reconciled")
    const restoreID = crypto.randomUUID()
    const target = await Backup.install({ home: targetHome, directory, restoreID, keys })
    expect(target.state).toBe("recovery-held")
    await using h1 = await openOrganizationService({
      home: service.service.home,
      publicOrigin: "https://organization.example",
    })
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      tls: { cert, key: tlsKey },
      fetch: h1.fetch,
      websocket: h1.websocket,
    })
    const transport = new Bun.FetchSession({ tls: { ca: cert, rejectUnauthorized: true }, proxy: false })
    try {
      const client = createOrganizationClient({
        baseUrl: server.url.origin,
        fetch: Object.assign(transport.fetch, { preconnect() {} }),
        headers: { origin: "https://organization.example" },
      })
      const headers = await login(client, "owner", "a long integration password")
      const current = (await client.orgProjects.get({ projectID: project.projectID }, { headers, throwOnError: true }))
        .data
      await client.orgProjects.member(
        {
          projectID: project.projectID,
          accountID: reader.accountID,
          orgProjectMemberChange: { expectedRevision: current.revision, role: null },
        },
        { headers, throwOnError: true },
      )
    } finally {
      await transport.close()
      await server.stop(true)
      await h1.close()
    }
    let recovered: Awaited<ReturnType<typeof Recovery.recover>>
    try {
      recovered = await Recovery.recover({
        home: targetHome,
        sourceHome: service.service.home,
        directory,
        restoreID,
        work: path.join(service.root, "member-recovery-work"),
        publicOrigin: "https://recovered.example",
        keys,
        buildVersion: "fixture",
      })
    } catch (error) {
      expect(await Bun.file(memberMarker).text()).toBe(originalMarker)
      expect(await Bun.file(privateFile).bytes()).toEqual(new Uint8Array(privateBytes))
      throw error
    }
    expect(recovered.state).toBe("ready")
    expect(recovered.executionEnabled).toBe(false)
    await using restored = await openOrganizationService({ home: targetHome })
    const published = await restored.maintenance.run(async () => ({
      deployment: OrganizationProtocol.Deployment.parse(await Storage.read(OrganizationStoragePath.deployment())),
      member: await OrganizationRecord.read(
        OrganizationRecord.RuntimeRegistration,
        OrganizationStoragePath.runtime(registration.runtimeID),
      ),
    }))
    expect(published.deployment.deploymentIncarnation).toBe(target.incarnation)
    expect(published.member?.deploymentIncarnation).toBe(registration.deploymentIncarnation)
    expect(published.member?.deploymentIncarnation).not.toBe(published.deployment.deploymentIncarnation)
    const listener = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      tls: { cert, key: tlsKey },
      fetch: restored.fetch,
      websocket: restored.websocket,
    })
    const pool = new Bun.FetchSession({ tls: { ca: cert, rejectUnauthorized: true }, proxy: false })
    try {
      const client = createOrganizationClient({
        baseUrl: listener.url.origin,
        fetch: Object.assign(pool.fetch, { preconnect() {} }),
        headers: { origin: "https://recovered.example" },
      })
      const headers = await login(client, "owner", "a long integration password")
      expect(
        (await client.orgSessionSync.events({ sessionID, limit: 128 }, { headers: service.headers })).response.status,
      ).toBe(401)
      expect(
        (await client.orgSessionSync.events({ sessionID, limit: 128 }, { headers, throwOnError: true })).data.items,
      ).toEqual(events)
      const restoredCheckpoint = (await client.orgSessions.shareState({ sessionID }, { headers, throwOnError: true }))
        .data
      expect(restoredCheckpoint.nextSeq).toBe(checkpoint.nextSeq)
      expect(restoredCheckpoint.shareGeneration).toBe(checkpoint.shareGeneration)
      const blob = await client.orgSessionSync.downloadBlob(
        { sessionID, hash, shareGeneration: shared.shareGeneration },
        { headers, throwOnError: true, parseAs: "arrayBuffer" },
      )
      expect(digest(binary(blob.data))).toBe(hash)
      const deniedHeaders = await login(client, "checkpoint-reader", password)
      expect([403, 404]).toContain(
        (await client.orgSessionSync.events({ sessionID, limit: 128 }, { headers: deniedHeaders })).response.status,
      )
      const continued = await client.orgCommands.control(
        {
          sessionID,
          orgCommandControlRequest: {
            schemaVersion: 1,
            orgID: member.identity.orgID,
            projectID: project.projectID,
            runtimeID: registration.runtimeID,
            sessionID,
            requestID: "unreconciled-member-continue",
            control: {
              operation: "continue",
              pausedSince: control.pausedSince,
              controlVersion: control.controlVersion,
            },
          },
        },
        { headers },
      )
      expect([409, 503]).toContain(continued.response.status)
      expect((await client.orgSessions.get({ sessionID }, { headers, throwOnError: true })).data.bindingEpoch).toBe(
        shared.bindingEpoch,
      )
      expect((await restored.capabilities()).executesAgents).toBe(false)
    } finally {
      await pool.close()
      await listener.stop(true)
    }
    expect(await Bun.file(memberMarker).text()).toBe(originalMarker)
    expect(await Bun.file(privateFile).bytes()).toEqual(new Uint8Array(privateBytes))
    expect(HomeOwnershipFile.Info.parse(JSON.parse(originalMarker)).schemaVersion).not.toBe(4)
    expect(forwarded).toBe(0)
    expect(submitted).toHaveBeenCalledTimes(0)
  } finally {
    material.fill(0)
  }
}, 30_000)
