import fs from "node:fs/promises"
import path from "node:path"
import { HomeRestoration } from "@ericsanchezok/synergy-harness/lifecycle/home-restoration"
import { RuntimeMaintenance } from "@ericsanchezok/synergy-harness/storage/runtime-maintenance"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { StorageCheckpoint } from "@ericsanchezok/synergy-harness/storage/checkpoint"
import { OrganizationBackupAdministration as Administration } from "../../src/backup/administration"
import { OrganizationBackupCohort as Cohort } from "../../src/backup/cohort"
import { OrganizationRecoveryArchive as Archive } from "../../src/backup/archive"
import { OrganizationServiceNative as Native } from "../../src/backup/service-native"
import { OrganizationRecoveryAuthority as Authority } from "../../src/backup/authority"
import { OrganizationCurrentAuthority as Current } from "../../src/backup/current-authority"
import { OrganizationRecovery as Recovery } from "../../src/backup/recovery"
import { openOrganizationPendingRetirement, openOrganizationRecovery } from "../../src/service"
import { OrganizationSourceRetirement as Retirement } from "../../src/backup/source-retirement"
import { OrganizationInstallationReference } from "../../src/backup/installation-reference"
import type { z } from "zod"
import { openOrganizationService } from "../../src/service"
const password = "correct horse battery staple"

export const pendingKeys = {
  async current() {
    return { version: "pending", key: Buffer.alloc(32, 23) }
  },
  async resolve(version: string) {
    if (version !== "pending") throw new Error("Unknown synthetic recovery key")
    return Buffer.alloc(32, 23)
  },
}

export async function withPendingTarget<T>(
  directory: string,
  body: (
    target: Recovery.Target,
    reference: z.infer<typeof OrganizationInstallationReference>,
    original: Parameters<typeof Recovery.withTarget>[0],
  ) => Promise<T>,
) {
  const base = path.join(directory, "opened", "namespaces", "0000000000000000")
  const inventory = Cohort.NamespaceInventory.parse(await Bun.file(path.join(base, "namespace.json")).json())
  if (!inventory.native || inventory.identity.kind !== "service") throw new Error("Missing original service facet")
  const expectedNative = inventory.native
  const report = await Archive.verify({ directory: path.join(directory, "h0"), keys: pendingKeys })
  const request = Native.installationRequest({
    restoreID: await fs.readFile(path.join(directory, "restore-id"), "utf8"),
    source: inventory.namespace,
    expected: inventory.native,
    snapshot: inventory.segment.namespace,
    cohort: {
      archiveID: report.archiveID,
      pagesHash: report.pagesHash,
      ordinal: 0,
      source: { orgID: inventory.identity.orgID, deploymentIncarnation: inventory.identity.deploymentIncarnation },
    },
  })
  await using runtime = await openOrganizationRecovery({ home: path.join(directory, "target") })
  return runtime.run(async () => {
    const info = await HomeRestoration.begin(request)
    return HomeRestoration.withTarget(info, (permit) =>
      Native.withInstalled(
        {
          directory: path.join(base, "native"),
          expected: expectedNative,
          source: inventory.namespace,
          keys: pendingKeys,
          permit,
          request,
        },
        async (native) => {
          const prepared = await Authority.reopen({
            permit,
            request,
            native,
            namespaceDirectory: path.join(base, "records"),
            keys: pendingKeys,
          })
          return Recovery.withTarget({ permit, native, request, prepared }, (target) =>
            body(target, Authority.describe(prepared).reference, { permit, native, request, prepared }),
          )
        },
      ),
    )
  })
}

export async function preparePendingRetirement(directory: string) {
  const home = await fs.mkdtemp(path.join(directory, "source-"))
  const running = await openOrganizationService({ home, publicOrigin: "https://organization.example" })
  const service = { service: running }
  const token = await running.bootstrapToken()
  const request = (route: string, body: unknown, headers: Record<string, string> = {}) =>
    running.fetch(
      new Request("https://organization.example/org/v1" + route, {
        method: "POST",
        headers: { "content-type": "application/json", origin: "https://organization.example", ...headers },
        body: JSON.stringify(body),
      }),
    )
  if (
    (
      await request("/setup/bootstrap", {
        token,
        requestID: crypto.randomUUID(),
        organizationName: "Pending recovery",
        loginName: "owner",
        displayName: "Owner",
        password,
      })
    ).status !== 200
  )
    throw new Error("Actual bootstrap failed")
  const login = await request("/auth/login", { loginName: "owner", password })
  const cookie = login.headers.get("set-cookie")?.split(";")[0]
  const csrf = (await login.json()).csrfToken
  if (login.status !== 200 || !cookie || typeof csrf !== "string") throw new Error("Actual login failed")
  const restoreID = crypto.randomUUID()
  await fs.writeFile(path.join(directory, "restore-id"), restoreID)
  if (process.env.SYNERGY_PENDING_UNKNOWN_CALL)
    await running.maintenance.run(() => Storage.write(["unclassified-native-call", "pending"], { state: "unknown" }))
  await Cohort.capture({
    service: Cohort.service(service.service.maintenance),
    async resolve() {
      throw new Error("No Hosted participant")
    },
    directory: path.join(directory, "h0"),
    archiveID: "pending-h0",
    buildVersion: "fixture",
    keys: pendingKeys,
    actor: {
      kind: "system",
      subjectID: "operator",
      displayName: "Host",
      clientKind: "system",
      requestID: "pending-h0",
    },
  })
  await Archive.open({
    directory: path.join(directory, "h0"),
    outputDirectory: path.join(directory, "opened"),
    keys: pendingKeys,
  })
  const changed = await request(
    "/auth/password",
    { currentPassword: password, password: "fixed H1 password" },
    { cookie, "x-csrf-token": csrf },
  )
  if (changed.status !== 200) throw new Error("Actual H1 mutation failed")
  await Administration.install({
    home: path.join(directory, "target"),
    directory: path.join(directory, "h0"),
    restoreID,
    keys: pendingKeys,
  })
  return withPendingTarget(directory, (target, targetReference) =>
    service.service.maintenance.run(async () => {
      const requestID = "pending-source-retirement"
      const lease = await RuntimeMaintenance.begin({
        purpose: "organization-backup",
        requestID,
        actor: { kind: "system", subjectID: "operator", displayName: "Host", clientKind: "system", requestID },
      })
      await RuntimeMaintenance.freeze(lease, await RuntimeMaintenance.drain(lease))
      const h0 = await StorageCheckpoint.Manifest.parse(
        await Bun.file(
          path.join(directory, "opened", "namespaces", "0000000000000000", "records", "manifest.json"),
        ).json(),
      )
      const { AuthorityJournal } = await import("@ericsanchezok/synergy-harness/storage/authority-journal")
      const after = await AuthorityJournal.readArchivedCheckpoint({
        directory: path.join(directory, "opened", "namespaces", "0000000000000000", "records"),
        expected: h0,
        keys: pendingKeys,
      })
      return Current.withSource(
        { lease, after, directory: path.join(directory, "h1"), keys: pendingKeys, buildVersion: "fixture" },
        async (source) => {
          if (!process.env.SYNERGY_PENDING_UNKNOWN_CALL) await Recovery.preflightWriters({ source, target })
          const reference = await Current.retirementReference(source, targetReference)
          const file = await fs.open(path.join(directory, "selector.json"), "wx", 0o600)
          await file.writeFile(JSON.stringify({ home: service.service.home, reference }))
          await file.sync()
          await file.close()
          const parent = await fs.open(directory, "r")
          await parent.sync()
          await parent.close()
          if (process.env.SYNERGY_PENDING_WRITER_LIVE) {
            process.stdout.write("selector-ready\n")
            await new Promise(() => setInterval(() => {}, 1000))
          }
          process.exit(0)
        },
      )
    }),
  )
}

const pendingDirectory = process.env.SYNERGY_PENDING_RETIREMENT_DIRECTORY
if (pendingDirectory) {
  if (process.env.SYNERGY_PENDING_RESERVATION_CRASH) {
    const selector = await Bun.file(path.join(pendingDirectory, "selector.json")).json()
    const reference = Retirement.Reference.parse(selector.reference)
    const cold = await openOrganizationPendingRetirement({ home: selector.home, reference })
    const facet = async (name: string) => ({
      directory: path.join(pendingDirectory, "h1", name),
      expected: StorageCheckpoint.Manifest.parse(
        await Bun.file(path.join(pendingDirectory, "h1", name, "manifest.json")).json(),
      ),
    })
    const namespace = await facet("records")
    const native = await facet("native")
    Retirement.complete = () => process.exit(0)
    await withPendingTarget(pendingDirectory, (_target, _reference, target) =>
      Current.resumeRetirement({ source: cold.source, target, namespace, native, keys: pendingKeys }),
    )
    throw new Error("Original reservation did not reach the native fence boundary")
  }
  await preparePendingRetirement(pendingDirectory)
}
