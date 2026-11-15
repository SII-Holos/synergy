import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { randomBytes } from "node:crypto"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { HomeOwnershipFile } from "@ericsanchezok/synergy-harness/lifecycle/home-ownership-file"
import {
  OrganizationCommandProtocol as Command,
  OrganizationRuntimeProtocol as Runtime,
} from "@ericsanchezok/synergy-organization-protocol"
import { openOrganizationService } from "@ericsanchezok/synergy-organization/service"
import { OrganizationBackupCohort as Cohort } from "../../../organization/src/backup/cohort"
import { OrganizationBackupAdministration as Administration } from "../../../organization/src/backup/administration"
import { OrganizationRecoveryAdministration as Recovery } from "../../../organization/src/backup/administration-recovery"
import { OrganizationRecoveryPublication as Publication } from "../../../organization/src/backup/publication"
import { OrganizationRecord as Record } from "../../../organization/src/storage/records"
import { OrganizationStoragePath as Keys } from "../../../organization/src/storage/path"
import { prepareMemberHome } from "../../src/home"
import { enrollMemberRuntime } from "../../src/enrollment"
import { readMemberRegistration } from "../../src/registration"
import { openMemberRuntime } from "../../src/runtime"
import { fixture } from "../support/organization"

async function signedMemberHistory(f: Awaited<ReturnType<typeof fixture>>) {
  const options = { headers: f.headers, throwOnError: true as const }
  const project = (
    await f.client.orgProjects.create({ orgProjectCreate: { name: "Retained signer history" } }, options)
  ).data
  const home = await prepareMemberHome({
    baseDirectory: path.join(f.root, "members"),
    identity: f.identity,
    origin: f.origin,
  })
  await enrollMemberRuntime({
    home: home.home,
    identity: home.identity,
    ca: f.ca,
    ticket: await f.ticket(home.identity.deviceID, home.publicKey),
  })
  const registration = await readMemberRegistration(home.home, home.identity)
  if (!registration) throw new Error("The actual Member enrollment did not persist")
  const listening = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() })
  const port = listening.port
  if (!port) throw new Error("The task-owned Member listener did not allocate a port")
  await listening.stop(true)
  const online = Promise.withResolvers<void>()
  f.interceptFrames((_socket, raw) => {
    if (Runtime.ClientFrame.parse(JSON.parse(String(raw))).type === "heartbeat") online.resolve()
    return false
  })
  try {
    await using runtime = await openMemberRuntime({
      home: home.home,
      identity: home.identity,
      ca: f.ca,
      listen: { port, token: "d".repeat(64) },
    })
    const timeout = setTimeout(() => online.reject(new Error("The original Member bridge did not connect")), 3000)
    try {
      await online.promise
    } finally {
      clearTimeout(timeout)
    }
    const created = (
      await f.client.orgSessions.create(
        {
          orgCommandCreateRequest: {
            schemaVersion: 1,
            orgID: f.identity.orgID,
            projectID: project.projectID,
            runtimeID: registration.runtimeID,
            requestID: "second-backup-member-create",
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
            runtimeID: registration.runtimeID,
            sessionID: created.effect.sessionID,
            requestID: "second-backup-member-pause",
            control: { operation: "pause" },
          },
        },
        options,
      )
    ).data
    expect(paused.effect.operation).toBe("pause")
    expect(paused.permit.commandSeq).toBe(created.permit.commandSeq + 1)
    return { created, paused }
  } finally {
    f.interceptFrames(undefined)
  }
}

async function retained(service: Awaited<ReturnType<typeof openOrganizationService>>, keys: string[][]) {
  return service.maintenance.run(() =>
    Storage.snapshot(async (tx) => {
      const [raw, ...records] = await tx.readMany([Keys.signingIdentity(), ...keys])
      const signing = Record.SigningIdentity.parse(raw)
      return {
        identity: Command.SigningIdentity.parse({
          schemaVersion: 1,
          orgID: signing.orgID,
          deploymentIncarnation: signing.deploymentIncarnation,
          keyID: signing.keyID,
          publicKey: signing.publicKey,
        }),
        records,
      }
    }),
  )
}

async function recoverMemberHistory(mode: "administrative-capture" | "historical-signer") {
  await using f = await fixture({ connections: { heartbeatMs: 25 } })
  const member = await signedMemberHistory(f)
  const commands = [member.created, member.paused]
  const addresses = commands.flatMap(({ permit }) => [
    Keys.commandAttempt(permit.attemptID),
    Keys.commandRequest(permit.actor.subjectID, permit.requestID),
    Keys.sessionCommand(permit.sessionID, permit.commandSeq),
    Keys.requestAttempt(permit.actor.subjectID, permit.requestID, permit.commandSeq),
  ])
  addresses.push(Keys.commandState(member.created.effect.sessionID))
  const original = await retained(f.service, addresses)
  expect(original.records.every((value) => value !== undefined)).toBe(true)
  for (const [index, command] of commands.entries()) {
    const attempt = Record.CommandAttempt.parse(original.records[index * 4])
    expect(attempt.state).toBe("accepted")
    expect(attempt.authorization.permit).toEqual(command.permit)
    expect(await Command.verify(command.permit, attempt.authorization.signature, original.identity.publicKey)).toBe(
      true,
    )
  }
  await f.stopListener()
  await f.service.close()
  const material = randomBytes(32)
  const keys = {
    async current() {
      return { version: "second-member-backup", key: material }
    },
    async resolve(version: string) {
      if (version !== "second-member-backup") throw new Error("Wrong original recovery key version")
      return material
    },
  }
  async function roundtrip(sourceHome: string, ordinal: number, sourceOrigin: string) {
    const directory = path.join(f.root, `archive-${ordinal}`)
    const home = path.join(f.root, `target-${ordinal}`)
    const restoreID = crypto.randomUUID()
    const target = await Administration.install({ home, directory, restoreID, keys })
    expect(target).toMatchObject({ state: "recovery-held", executionEnabled: false })
    const materialFile = path.join(
      home,
      ".synergy",
      "state",
      "organization-recovery",
      target.installationID,
      "signing-material.json",
    )
    const preparedMaterial = await fs.readFile(materialFile)
    const input = {
      home,
      sourceHome,
      directory,
      restoreID,
      work: path.join(f.root, `work-${ordinal}`),
      buildVersion: "fixture",
      sourceOrigin,
      publicOrigin: `https://member-recovered-${ordinal}.example`,
      keys,
    }
    const result = await Recovery.recover(input)
    expect(result).toMatchObject({ state: "ready", executionEnabled: false, installationID: target.installationID })
    expect(await fs.readFile(materialFile)).toEqual(preparedMaterial)
    expect(await Recovery.recover(input)).toEqual(result)
    expect(await fs.readFile(materialFile)).toEqual(preparedMaterial)
    return { input, result }
  }
  try {
    await Administration.capture({
      home: f.service.home,
      directory: path.join(f.root, "archive-1"),
      buildVersion: "fixture",
      publicOrigin: "https://organization.example",
      keys,
    })
    const first = await roundtrip(f.service.home, 1, "https://organization.example")
    await using ordinary = await openOrganizationService({ home: first.input.home })
    expect((await ordinary.fetch(new Request(first.input.publicOrigin + "/org/v1/ready"))).status).toBe(200)
    const current = await retained(ordinary, addresses)
    expect(current.records).toEqual(original.records)
    expect(current.identity.orgID).toBe(original.identity.orgID)
    expect(current.identity.deploymentIncarnation).toBe(first.result.incarnation)
    expect(current.identity.deploymentIncarnation).not.toBe(original.identity.deploymentIncarnation)
    expect(current.identity.keyID).not.toBe(original.identity.keyID)
    expect(current.identity.publicKey).not.toBe(original.identity.publicKey)
    const firstReceipt = await ordinary.maintenance.run(() => Publication.read(first.result.installationID))
    expect(firstReceipt.identity).toEqual(current.identity)
    for (const [index, command] of commands.entries()) {
      const attempt = Record.CommandAttempt.parse(current.records[index * 4])
      expect(command.permit.deploymentIncarnation).toBe(original.identity.deploymentIncarnation)
      expect(command.permit.keyID).toBe(original.identity.keyID)
      expect(await Command.verify(command.permit, attempt.authorization.signature, current.identity.publicKey)).toBe(
        false,
      )
    }
    const ownership = HomeOwnershipFile.RestorationInfo.parse(
      await Bun.file(path.join(first.input.home, ".synergy", "home-ownership.json")).json(),
    )
    expect(ownership.installationID).toBe(first.result.installationID)
    if (mode === "administrative-capture") {
      await ordinary.close()
      const captured = await Administration.capture({
        home: first.input.home,
        directory: path.join(f.root, "archive-2"),
        buildVersion: "fixture",
        publicOrigin: first.input.publicOrigin,
        keys,
      })
      expect(captured.namespaces).toBe(1)
      return
    }
    await Cohort.capture({
      service: Cohort.service(ordinary.maintenance),
      resolve: async () => undefined,
      directory: path.join(f.root, "archive-2"),
      archiveID: "recovered-member-history-second",
      buildVersion: "fixture",
      keys,
      actor: {
        kind: "system",
        subjectID: "operator",
        displayName: "Operator",
        clientKind: "system",
        requestID: "second-member-recovery",
      },
    })
    await ordinary.close()
    const second = await roundtrip(first.input.home, 2, first.input.publicOrigin)
    await using final = await openOrganizationService({ home: second.input.home })
    expect((await final.fetch(new Request(second.input.publicOrigin + "/org/v1/ready"))).status).toBe(200)
    const latest = await retained(final, addresses)
    expect(latest.records).toEqual(original.records)
    expect(latest.identity.orgID).toBe(original.identity.orgID)
    expect(latest.identity.deploymentIncarnation).toBe(second.result.incarnation)
    expect(latest.identity.deploymentIncarnation).not.toBe(current.identity.deploymentIncarnation)
    expect(latest.identity.keyID).not.toBe(current.identity.keyID)
    expect(latest.identity.publicKey).not.toBe(current.identity.publicKey)
    expect(await final.maintenance.run(() => Publication.read(first.result.installationID))).toEqual(firstReceipt)
    const lastReceipt = await final.maintenance.run(() => Publication.read(second.result.installationID))
    expect(lastReceipt.identity).toEqual(latest.identity)
  } finally {
    material.fill(0)
  }
}

test("administrative backup accepts a genuinely restored ordinary Service Home", async () => {
  await recoverMemberHistory("administrative-capture")
}, 60_000)

test("a second Service-only recovery retains real Member command signatures from the original deployment", async () => {
  await recoverMemberHistory("historical-signer")
}, 60_000)
