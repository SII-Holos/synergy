import assert from "node:assert/strict"
import fs from "node:fs/promises"
import path from "node:path"
import { openOrganizationRecovery, openOrganizationService } from "@ericsanchezok/synergy-organization/service"
import {
  OrganizationBackupCohort as Cohort,
  OrganizationRecoveryArchive as Archive,
} from "@ericsanchezok/synergy-organization/backup"
import {
  OrganizationCurrentAuthority as Current,
  OrganizationServiceNative as ServiceNative,
  OrganizationRecoveryAuthority as Authority,
  OrganizationRecovery as Recovery,
  OrganizationSourceRetirement as Retirement,
  OrganizationRecoveryPublication as Publication,
} from "@ericsanchezok/synergy-organization/backup/recovery"
import { prepareHostedHome, readHostedHome } from "@ericsanchezok/synergy-organization-runtime/home"
import { enrollHostedRuntime } from "@ericsanchezok/synergy-organization-runtime/enrollment"
import { readRuntimeRegistration } from "@ericsanchezok/synergy-organization-runtime/registration"
import { openHostedRuntime } from "@ericsanchezok/synergy-organization-runtime/runtime"
import { OrganizationRuntimeNative as Native } from "@ericsanchezok/synergy-organization-runtime/backup"
import {
  OrganizationHostedRecovery as HostedRecovery,
  openHostedRecovery,
  openHostedSourceRetirement,
} from "@ericsanchezok/synergy-organization-runtime/backup/recovery"
import { OrganizationRuntimeProtocol } from "@ericsanchezok/synergy-organization-protocol"
import { createOrganizationClient } from "@ericsanchezok/synergy-sdk/organization"
import { NamespaceRetirement } from "@ericsanchezok/synergy-harness/lifecycle/namespace-retirement"
import { HomeRestoration } from "@ericsanchezok/synergy-harness/lifecycle/home-restoration"
import { RuntimeMaintenance } from "@ericsanchezok/synergy-harness/storage/runtime-maintenance"
import { SnapshotMaintenance } from "@ericsanchezok/synergy-harness/session/snapshot-maintenance"
import { StorageCheckpoint } from "@ericsanchezok/synergy-harness/storage/checkpoint"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { WorkspaceCoordinator } from "@ericsanchezok/synergy-local-runtime/workspace/coordinator"

const { assertInstalledPackageBoundaries } = await import("./package-boundary")
await assertInstalledPackageBoundaries()

const root = path.resolve("homes")
await fs.mkdir(root, { recursive: true, mode: 0o700 })
const physical = await fs.realpath(root)
const tls = (await Bun.file("tls.json").json()) as { cert: string; key: string }
const keys = {
  async current() {
    return { version: "installed-recovery", key: Buffer.alloc(32, 29) }
  },
  async resolve() {
    return Buffer.alloc(32, 29)
  },
}
const actor = {
  kind: "system" as const,
  subjectID: "deployment-operator",
  displayName: "Deployment operator",
  clientKind: "system" as const,
  requestID: "installed-cohort",
}
const coordinator = new WorkspaceCoordinator({ directory: path.join(physical, "coordination") })
const service = await openOrganizationService({
  home: path.join(physical, "service"),
  publicOrigin: "https://organization.example",
  connections: { heartbeatMs: 25 },
})
await using serviceCleanup = { [Symbol.asyncDispose]: () => service.close() }
let heartbeat = Promise.withResolvers<void>()
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  tls,
  websocket: {
    ...service.websocket,
    message(socket, frame) {
      if (OrganizationRuntimeProtocol.ClientFrame.parse(JSON.parse(String(frame))).type === "heartbeat")
        heartbeat.resolve()
      return service.websocket.message(socket, frame)
    },
  },
  fetch: service.fetch,
})
await using listenerCleanup = { [Symbol.asyncDispose]: () => server.stop(true) }
const transport = new Bun.FetchSession({ tls: { ca: tls.cert, rejectUnauthorized: true }, proxy: false })
await using transportCleanup = { [Symbol.asyncDispose]: () => transport.close() }
const client = createOrganizationClient({
  baseUrl: server.url.origin,
  fetch: Object.assign(transport.fetch, { preconnect() {} }),
  headers: { origin: "https://organization.example" },
})
const password = "installed deployment acceptance password"
const account = (
  await client.orgSetup.bootstrap(
    {
      orgBootstrapInput: {
        token: await service.bootstrapToken(),
        requestID: crypto.randomUUID(),
        organizationName: "Installed deployment",
        loginName: "owner",
        displayName: "Owner",
        password,
      },
    },
    { throwOnError: true },
  )
).data
const login = await client.orgAuth.login({ orgLoginInput: { loginName: "owner", password } }, { throwOnError: true })
const headers = {
  cookie: login.response.headers.get("set-cookie")!.split(";")[0]!,
  "x-csrf-token": login.data.csrfToken,
}
const home = await prepareHostedHome({
  baseDirectory: path.join(physical, "hosted"),
  identity: { orgID: account.orgID, hostID: "installed-host" },
  origin: server.url.origin,
})
const ticket = (
  await client.orgRuntime.registerHosted(
    { orgHostedRuntimeRegistration: { name: "Installed host", publicKey: home.publicKey } },
    { headers, throwOnError: true },
  )
).data
const registration = await enrollHostedRuntime({ home: home.home, identity: home.identity, ticket, ca: tls.cert })
const runtime = await openHostedRuntime({
  home: home.home,
  identity: home.identity,
  ca: tls.cert,
  workspaceCoordinator: coordinator,
  listen: await runtimeListener(),
})
await using runtimeCleanup = { [Symbol.asyncDispose]: () => runtime.close() }
await waitHeartbeat(heartbeat.promise, "Source")
const bytes = Buffer.from("installed Hosted native bytes\u0000\u00ff")
await runtime.run(() => Storage.writeBinary(["recovery", "installed-proof"], bytes))
const packed = path.join(physical, "cohort")
const report = await Cohort.capture({
  service: Cohort.service(service.maintenance),
  resolve: async () => Cohort.hosted(runtime, { native: Native.capture }),
  directory: packed,
  archiveID: "installed-cohort",
  buildVersion: "installed-acceptance",
  keys,
  actor,
})
assert.equal(report.namespaceCheckpointsComplete, true)
const opened = path.join(physical, "opened")
await Archive.open({ directory: packed, outputDirectory: opened, keys })
await fs.rm(packed, { recursive: true })
const serviceBase = path.join(opened, "namespaces", "0000000000000000")
const inventory = Cohort.NamespaceInventory.parse(await Bun.file(path.join(serviceBase, "namespace.json")).json())
const hostedInventory = Cohort.NamespaceInventory.parse(
  await Bun.file(path.join(opened, "namespaces", "0000000000000001", "namespace.json")).json(),
)
assert.ok(inventory.native)
assert.ok(hostedInventory.hostedNative)
assert.equal(
  (
    await Native.verify({
      directory: path.join(opened, "namespaces", "0000000000000001", "hosted-native"),
      expected: hostedInventory.hostedNative,
      source: hostedInventory.namespace,
      keys,
    })
  ).registration.runtimeID,
  registration.runtimeID,
)
const targetHome = path.join(physical, "service-target")
const target = await openOrganizationRecovery({ home: targetHome })
await using targetCleanup = { [Symbol.asyncDispose]: () => target.close() }
const request = ServiceNative.installationRequest({
  restoreID: "installed-service-target",
  source: inventory.namespace,
  expected: inventory.native,
  snapshot: inventory.segment.namespace,
  cohort: {
    archiveID: report.archiveID,
    pagesHash: report.pagesHash,
    ordinal: inventory.ordinal,
    source: { orgID: inventory.identity.orgID, deploymentIncarnation: inventory.identity.deploymentIncarnation },
  },
})
const h0 = await target.run(async () => {
  const installation = await HomeRestoration.begin(request)
  return HomeRestoration.withTarget(installation, (permit) =>
    ServiceNative.withInstalled(
      {
        permit,
        request,
        directory: path.join(serviceBase, "native"),
        expected: inventory.native!,
        source: inventory.namespace,
        keys,
      },
      (native) =>
        SnapshotMaintenance.withInstalledSegment(
          {
            permit,
            request,
            namespaceDirectory: path.join(serviceBase, "records"),
            directory: path.join(serviceBase, "snapshots"),
            source: inventory.namespace,
            expected: inventory.segment.namespace,
            keys,
          },
          async (snapshot) => {
            await StorageCheckpoint.restoreArchive({
              directory: path.join(serviceBase, "records"),
              expected: inventory.namespace,
              keys,
              restoreID: request.restoreID,
              finalize: (tx, archive) =>
                ServiceNative.adoptRestoration(tx, { permit, request, native, snapshot, archive }),
            })
            const prepared = await Authority.prepare({
              permit,
              request,
              native,
              namespaceDirectory: path.join(serviceBase, "records"),
              keys,
            })
            return { installation, ...Authority.describe(prepared) }
          },
        ),
    ),
  )
})
const withTarget = <T>(body: (value: Recovery.Target) => Promise<T>) =>
  target.run(() =>
    HomeRestoration.withTarget(h0.installation, (permit) =>
      ServiceNative.withInstalled(
        {
          permit,
          request,
          directory: path.join(serviceBase, "native"),
          expected: inventory.native!,
          source: inventory.namespace,
          keys,
        },
        async (native) => {
          const prepared = await Authority.reopen({
            permit,
            request,
            native,
            namespaceDirectory: path.join(serviceBase, "records"),
            keys,
          })
          return Recovery.withTarget({ permit, request, native, prepared }, body)
        },
      ),
    ),
  )
let source: NamespaceRetirement.Reference | undefined
let material: { native: StorageCheckpoint.Manifest; snapshot: StorageCheckpoint.Manifest } | undefined
await service.maintenance.run(async () => {
  const lease = await RuntimeMaintenance.begin({
    purpose: "organization-backup",
    requestID: "installed-current-service",
    actor: { ...actor, requestID: "installed-current-service" },
  })
  await RuntimeMaintenance.freeze(lease, await RuntimeMaintenance.drain(lease))
  await Current.withSource(
    {
      lease,
      after: h0.checkpoint,
      directory: path.join(physical, "current-service"),
      buildVersion: "installed-acceptance",
      keys,
    },
    async (current) => {
      await runtime.run(async () => {
        const lease = await RuntimeMaintenance.begin({
          purpose: "organization-backup",
          requestID: "installed-current-hosted",
          actor: { ...actor, requestID: "installed-current-hosted" },
        })
        await RuntimeMaintenance.freeze(lease, await RuntimeMaintenance.drain(lease))
        await RuntimeMaintenance.withFrozen(lease, () =>
          SnapshotMaintenance.withCapture(async (capture) => {
            const archive = await capture.exportArchive({
              directory: path.join(physical, "current-records"),
              archiveID: "installed-current-hosted",
              namespaceID: "hosted",
              buildVersion: "installed-acceptance",
              keys,
              protect: () => true,
            })
            const evidence = await capture.validateArchive(archive)
            const native = await Native.capture({
              archive: evidence,
              lease,
              directory: path.join(physical, "current-native"),
              keys,
            })
            const snapshots = await capture.exportSnapshots({
              archive,
              directory: path.join(physical, "current-snapshots"),
            })
            material = { native: native.namespace, snapshot: snapshots.namespace }
            await withTarget((policyTarget) =>
              service.maintenance.run(() => Recovery.preflightWriters({ source: current, target: policyTarget })),
            )
            await NamespaceRetirement.withSource(
              {
                archive: evidence,
                lease,
                native,
                target: { request, installationID: h0.reference.installationID, incarnation: h0.reference.incarnation },
              },
              async (currentHosted) => {
                source = NamespaceRetirement.describeSource(currentHosted)
                const reference = source
                const request = HostedRecovery.request({
                  restoreID: "installed-hosted-target",
                  source: reference,
                  snapshot: snapshots.namespace,
                })
                await using restored = await openHostedRecovery({
                  request,
                  home: path.join(physical, "hosted-target"),
                  identity: home.identity,
                })
                const receipt = await NamespaceRetirement.retire(currentHosted)
                await assert.rejects(readHostedHome(home.home, home.identity))
                assert.deepEqual(NamespaceRetirement.describe(await NamespaceRetirement.complete(reference)), reference)
                await NamespaceRetirement.withVerified(receipt, (inspection) =>
                  restored.run(() =>
                    HomeRestoration.withTarget(restored.target, async (permit) => {
                      await restored.withRestorationBase((base) =>
                        HostedRecovery.restore({
                          base,
                          permit,
                          request,
                          source: inspection,
                          namespaceDirectory: path.join(physical, "current-records"),
                          native: { directory: native.directory, expected: native.namespace },
                          snapshot: { directory: snapshots.directory, expected: snapshots.namespace },
                          keys,
                        }),
                      )
                      assert.deepEqual(Buffer.from(await Storage.readBinary(["recovery", "installed-proof"])), bytes)
                      assert.equal((await RuntimeMaintenance.status())?.phase, "recovery-held")
                    }),
                  ),
                )
                await assert.rejects(readHostedHome(path.join(physical, "hosted-target"), home.identity))
              },
            )
          }),
        )
      })
      assert.ok(source)
      await runtime.close()
      await using original = await openHostedSourceRetirement({
        home: home.home,
        identity: home.identity,
        reference: source,
      })
      await original.run(async () => {
        await assert.rejects(Storage.write(["unauthorized", "writer"], true))
        const receipt = await NamespaceRetirement.read(source!)
        await NamespaceRetirement.withVerified(receipt, (inspection) =>
          withTarget((policyTarget) =>
            service.maintenance.run(() =>
              Current.withCaptured(current, async (captured) => {
                const policy = await Recovery.reconstruct({ source: current, target: policyTarget })
                const physical = await Retirement.complete(policy.source)
                await Recovery.publishReconciled({
                  source: physical,
                  target: policyTarget,
                  namespace: captured.namespace,
                  native: captured.native,
                  keys,
                  writers: [inspection],
                  publicOrigin: "https://organization.example",
                })
              }),
            ),
          ),
        )
      })
    },
  )
})
await target.run(() => Recovery.completeServicePublication(h0.reference.installationID))
assert.ok(source)
assert.ok(material)
const hostedRequest = HostedRecovery.request({
  restoreID: "installed-hosted-target",
  source,
  snapshot: material.snapshot,
})
await using publishing = await openHostedRecovery({
  home: path.join(physical, "hosted-target"),
  identity: home.identity,
  request: hostedRequest,
})
await target.run(() =>
  Publication.withPublishedHosted(
    { installationID: h0.reference.installationID, runtimeID: registration.runtimeID },
    (service) =>
      publishing.run(() =>
        HomeRestoration.withTarget(publishing.target, (permit) =>
          HostedRecovery.publish({
            permit,
            request: hostedRequest,
            service,
            native: { directory: path.join(physical, "current-native"), expected: material!.native },
            keys,
          }),
        ),
      ),
  ),
)
await publishing.run(async () =>
  HostedRecovery.complete((await HomeRestoration.inspect(publishing.target)).installationID),
)
await publishing.close()
await target.close()
await service.close()
const port = server.port!
await server.stop(true)
const normal = await openOrganizationService({ home: targetHome })
await using normalCleanup = { [Symbol.asyncDispose]: () => normal.close() }
heartbeat = Promise.withResolvers<void>()
const restoredServer = Bun.serve({
  hostname: "127.0.0.1",
  port,
  tls,
  websocket: {
    ...normal.websocket,
    message(socket, frame) {
      if (OrganizationRuntimeProtocol.ClientFrame.parse(JSON.parse(String(frame))).type === "heartbeat")
        heartbeat.resolve()
      return normal.websocket.message(socket, frame)
    },
  },
  fetch: normal.fetch,
})
await using restoredListenerCleanup = { [Symbol.asyncDispose]: () => restoredServer.stop(true) }
await using ordinary = await openHostedRuntime({
  home: path.join(physical, "hosted-target"),
  identity: home.identity,
  ca: tls.cert,
  workspaceCoordinator: coordinator,
  listen: await runtimeListener(),
})
await waitHeartbeat(heartbeat.promise, "Restored")
assert.equal(
  (await readRuntimeRegistration(path.join(physical, "hosted-target"), home.identity))?.runtimeID,
  registration.runtimeID,
)
assert.equal((await readHostedHome(path.join(physical, "hosted-target"), home.identity)).publicKey, home.publicKey)
assert.deepEqual(Buffer.from(await ordinary.run(() => Storage.readBinary(["recovery", "installed-proof"]))), bytes)
assert.equal((await normal.fetch(new Request("https://organization.example/org/v1/ready"))).status, 200)
console.log(
  JSON.stringify({
    cohort: "service-and-hosted",
    recoveredBytes: bytes.length,
    coldHostedReconnected: true,
    serviceReady: true,
  }),
)

async function waitHeartbeat(work: Promise<void>, phase: "Source" | "Restored") {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${phase} installed Hosted writer did not connect`)), 5_000)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

async function runtimeListener() {
  const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() })
  const port = probe.port!
  await probe.stop(true)
  return { port, token: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex") }
}
