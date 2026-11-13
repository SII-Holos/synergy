import { expect, spyOn, test } from "bun:test"
import path from "node:path"
import { randomBytes } from "node:crypto"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { RuntimeMaintenance } from "@ericsanchezok/synergy-harness/storage/runtime-maintenance"
import { EnvironmentExecution } from "@ericsanchezok/synergy-harness/environment/execution"
import { HomeOwnershipFile } from "@ericsanchezok/synergy-harness/lifecycle/home-ownership-file"
import { OrganizationRuntimeProtocol as Runtime } from "@ericsanchezok/synergy-organization-protocol"
import { OrganizationBackupAdministration as Backup } from "../../../organization/src/backup/administration"
import { OrganizationRecoveryAdministration as Recovery } from "../../../organization/src/backup/administration-recovery"
import { OrganizationRecoveryWriters as Writers } from "../../../organization/src/backup/writers"
import { OrganizationAuthorityHistory as Authority } from "../../../organization/src/authority-history"
import { OrganizationRecord as Record } from "../../../organization/src/storage/records"
import { OrganizationStoragePath as Keys } from "../../../organization/src/storage/path"
import { openOrganizationService } from "@ericsanchezok/synergy-organization/service"
import { prepareMemberHome } from "../../src/home"
import { enrollMemberRuntime } from "../../src/enrollment"
import { readMemberRegistration } from "../../src/registration"
import { openMemberRuntime } from "../../src/runtime"
import { fixture } from "../support/organization"

test("preserved idle Member metadata cannot collide with the actual fresh publication incarnation", async () => {
  using submitted = spyOn(EnvironmentExecution, "start")
  await using f = await fixture()
  const options = { headers: f.headers, throwOnError: true as const }
  const project = (await f.client.orgProjects.create({ orgProjectCreate: { name: "Preserved Member fence" } }, options))
    .data
  const enroll = async (deviceID: string) => {
    const home = await prepareMemberHome({
      baseDirectory: path.join(f.root, "members"),
      identity: { ...f.identity, deviceID },
      origin: f.origin,
    })
    await enrollMemberRuntime({
      home: home.home,
      identity: home.identity,
      ca: f.ca,
      ticket: await f.ticket(home.identity.deviceID, home.publicKey),
    })
    const registration = await readMemberRegistration(home.home, home.identity)
    if (!registration) throw new Error("The original Member enrollment did not persist")
    return { ...home, registration }
  }
  const active = await enroll("history-command-device")
  const idle = await enroll("history-idle-device")
  const marker = path.join(idle.home, ".synergy", "home-ownership.json")
  const originalMarker = await Bun.file(marker).text()
  const reservation = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() })
  const port = reservation.port
  if (!port) throw new Error("The task-owned Member listener did not allocate a port")
  await reservation.stop(true)
  const online = Promise.withResolvers<void>()
  f.interceptFrames((_socket, raw) => {
    if (Runtime.ClientFrame.parse(JSON.parse(String(raw))).type === "heartbeat") online.resolve()
    return false
  })
  await using runtime = await openMemberRuntime({
    home: active.home,
    identity: active.identity,
    ca: f.ca,
    listen: { port, token: "f".repeat(64) },
  })
  const timer = setTimeout(() => online.reject(new Error("The original Member bridge did not connect")), 3000)
  try {
    await online.promise
  } finally {
    clearTimeout(timer)
  }
  const created = (
    await f.client.orgSessions.create(
      {
        orgCommandCreateRequest: {
          schemaVersion: 1,
          orgID: f.identity.orgID,
          projectID: project.projectID,
          runtimeID: active.registration.runtimeID,
          requestID: "member-publication-create",
          creation: { operation: "create" },
        },
      },
      options,
    )
  ).data
  const paused = (
    await f.client.orgCommands.control(
      {
        sessionID: created.effect.sessionID,
        orgCommandControlRequest: {
          schemaVersion: 1,
          orgID: f.identity.orgID,
          projectID: project.projectID,
          runtimeID: active.registration.runtimeID,
          sessionID: created.effect.sessionID,
          requestID: "member-publication-pause",
          control: { operation: "pause" },
        },
      },
      options,
    )
  ).data
  expect(paused.effect.operation).toBe("pause")
  const commandKeys = [
    Keys.commandState(created.effect.sessionID),
    ...[created.permit, paused.permit].flatMap((permit) => [
      Keys.commandAttempt(permit.attemptID),
      Keys.commandRequest(permit.actor.subjectID, permit.requestID),
      Keys.sessionCommand(permit.sessionID, permit.commandSeq),
      Keys.requestAttempt(permit.actor.subjectID, permit.requestID, permit.commandSeq),
    ]),
  ]
  const commands = await f.service.maintenance.run(() => Storage.readMany(commandKeys))
  await runtime.close()
  await f.service.close()
  const material = randomBytes(32)
  const keys = {
    async current() {
      return { version: "publication-fence", key: material }
    },
    async resolve() {
      return material
    },
  }
  const directory = path.join(f.root, "publication-h0")
  const targetHome = path.join(f.root, "publication-target")
  try {
    await Backup.capture({ home: f.service.home, directory, keys, buildVersion: "fixture" })
    const restoreID = crypto.randomUUID()
    const target = await Backup.install({ home: targetHome, directory, keys, restoreID })
    expect(target.state).toBe("recovery-held")
    expect(idle.registration.deploymentIncarnation).not.toBe(target.incarnation)
    await using h1 = await openOrganizationService({
      home: f.service.home,
      publicOrigin: "https://organization.example",
    })
    await h1.maintenance.run(() =>
      Authority.system("fixture.member-future-incarnation", async (identify, actionID) => {
        identify({
          kind: "system",
          subjectID: "fixture",
          displayName: "Fixture",
          clientKind: "system",
          requestID: actionID,
        })
        const registration = Record.RuntimeRegistration.parse(
          await Storage.read(Keys.runtime(idle.registration.runtimeID)),
        )
        if (registration.runtimeKind !== "member") throw new Error("The actual idle registration is not a Member")
        const changed = Record.RuntimeRegistration.parse({
          ...registration,
          deploymentIncarnation: target.incarnation,
          revision: registration.revision + 1,
        })
        await Storage.write(Keys.runtime(registration.runtimeID), changed)
        let consumed = 0
        for (const key of await Storage.queryKeys({ prefix: ["organization", "runtime-tickets"], limit: 128 })) {
          const ticket = Record.RuntimeTicket.parse(await Storage.read(key))
          if (ticket.runtimeID !== registration.runtimeID) continue
          if (!ticket.consumed || ticket.consumed.runtimeKind !== "member")
            throw new Error("The actual idle Member ticket was not consumed")
          await Storage.write(
            key,
            Record.RuntimeTicket.parse({
              ...ticket,
              consumed: { ...ticket.consumed, deploymentIncarnation: target.incarnation },
            }),
          )
          consumed++
        }
        expect(consumed).toBe(1)
        expect((await Storage.readMany([Keys.runtimeConnection(registration.runtimeID)]))[0]).toBeUndefined()
        expect(await Storage.readMany(commandKeys)).toEqual(commands)
      }),
    )
    await h1.maintenance.run(() => Writers.assertServiceOnly())
    await h1.close()
    let recoveryCaught = false
    let outcome: unknown
    try {
      await Recovery.recover({
        home: targetHome,
        sourceHome: f.service.home,
        directory,
        restoreID,
        work: path.join(f.root, "publication-work"),
        publicOrigin: "https://recovered.example",
        keys,
        buildVersion: "fixture",
      })
    } catch (error) {
      recoveryCaught = true
      outcome = error
    }
    expect(recoveryCaught).toBe(true)
    expect(RuntimeMaintenance.Blocked.isInstance(outcome)).toBe(true)
    if (!RuntimeMaintenance.Blocked.isInstance(outcome)) throw outcome
    expect(outcome.data.message).toBe(
      "Organization recovery requires reconciliation for Member metadata cannot adopt the fresh publication authority",
    )
    const held = HomeOwnershipFile.RestorationInfo.parse(
      await Bun.file(path.join(targetHome, ".synergy", "home-ownership.json")).json(),
    )
    expect(held.installationID).toBe(target.installationID)
    expect(held.incarnation).toBe(target.incarnation)
    expect(
      HomeOwnershipFile.Info.parse(await Bun.file(path.join(f.service.home, ".synergy", "home-ownership.json")).json())
        .schemaVersion,
    ).toBe(2)
    expect(await Bun.file(marker).text()).toBe(originalMarker)
    expect(submitted).toHaveBeenCalledTimes(0)
  } finally {
    material.fill(0)
  }
}, 30_000)
